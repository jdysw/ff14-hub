/**
 * `workspace_modules` / `workspace_module_operations` / `..._claims` 的读写（HUB-050）。
 *
 * 安全前提：
 * - 所有语句都带 `workspace_id = ?`，且 workspace_id **只能**来自认证中间件。
 * - `settings_json` 在读取时**防御性解析**：某一行损坏不应该让整个接口 500，
 *   但也不能伪造出「有设置」的假象 —— 解析失败即回退为空对象。
 *
 * **一致性快照（复核要求）**：状态与「是否有待完成操作」必须在**同一条 SQL** 里取回。
 * 分成两次查询（即使包在 Promise.all 里）会在两次读之间被一次准入切开，
 * 组合出「enabled + 无 pending」的假快照，从而让 Host 绕过 `transitioning` 门禁。
 * 因此本文件只暴露 `readModuleSnapshot()` / `listModuleSnapshots()`（单条 LEFT JOIN），
 * 以及基于同一快照推导的 `readModuleGateStatus()`。
 */
import {
  effectiveModuleStatus,
  moduleGateStatusFromPresence,
  type ModuleEffectiveStatus,
  type ModuleGateStatus,
  type ModulePersistedStatus,
  type ModulePendingOperation,
  type ModuleSupportedAction,
  type WorkspaceModuleStatus,
} from '@ff14-hub/shared';

export interface WorkspaceModuleRow {
  readonly module_id: string;
  readonly status: ModulePersistedStatus;
  readonly settings_json: string;
  readonly settings_version: number;
  readonly revision: number;
  readonly installed_at: number;
  readonly enabled_at: number | null;
  readonly disabled_at: number | null;
  readonly uninstalled_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface WorkspaceModuleOperationRow {
  readonly module_id: string;
  readonly action: ModuleSupportedAction;
  readonly target_status: ModulePersistedStatus;
  readonly revision: number;
  readonly started_at: number;
  readonly attempts: number;
  readonly last_error: string | null;
}

/** 一次查询取回的**一致**快照：模块行 + 它当前（可能不存在的）待完成操作。 */
export interface ModuleSnapshot {
  readonly row: WorkspaceModuleRow;
  readonly pendingRow: WorkspaceModuleOperationRow | null;
}

interface JoinedRow {
  readonly module_id: string;
  readonly status: ModulePersistedStatus;
  readonly settings_json: string;
  readonly settings_version: number;
  readonly revision: number;
  readonly installed_at: number;
  readonly enabled_at: number | null;
  readonly disabled_at: number | null;
  readonly uninstalled_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly pending_action: ModuleSupportedAction | null;
  readonly pending_target_status: ModulePersistedStatus | null;
  readonly pending_revision: number | null;
  readonly pending_started_at: number | null;
  readonly pending_attempts: number | null;
  readonly pending_last_error: string | null;
}

/**
 * 单条 LEFT JOIN 的列清单。
 * 注意：这里刻意**不**再提供「单独读模块行 / 单独读操作行」的导出函数，
 * 避免有人再次拼出不一致的两次读。
 */
const SNAPSHOT_COLUMNS = `
  m.module_id            AS module_id,
  m.status               AS status,
  m.settings_json        AS settings_json,
  m.settings_version     AS settings_version,
  m.revision             AS revision,
  m.installed_at         AS installed_at,
  m.enabled_at           AS enabled_at,
  m.disabled_at          AS disabled_at,
  m.uninstalled_at       AS uninstalled_at,
  m.created_at           AS created_at,
  m.updated_at           AS updated_at,
  o.action               AS pending_action,
  o.target_status        AS pending_target_status,
  o.revision             AS pending_revision,
  o.started_at           AS pending_started_at,
  o.attempts             AS pending_attempts,
  o.last_error           AS pending_last_error
`;

const SNAPSHOT_FROM = `
  FROM workspace_modules m
  LEFT JOIN workspace_module_operations o
    ON o.workspace_id = m.workspace_id AND o.module_id = m.module_id
`;

function toSnapshot(row: JoinedRow): ModuleSnapshot {
  return {
    row: {
      module_id: row.module_id,
      status: row.status,
      settings_json: row.settings_json,
      settings_version: row.settings_version,
      revision: row.revision,
      installed_at: row.installed_at,
      enabled_at: row.enabled_at,
      disabled_at: row.disabled_at,
      uninstalled_at: row.uninstalled_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    pendingRow:
      row.pending_action === null ||
      row.pending_target_status === null ||
      row.pending_revision === null ||
      row.pending_started_at === null ||
      row.pending_attempts === null
        ? null
        : {
            module_id: row.module_id,
            action: row.pending_action,
            target_status: row.pending_target_status,
            revision: row.pending_revision,
            started_at: row.pending_started_at,
            attempts: row.pending_attempts,
            last_error: row.pending_last_error,
          },
  };
}

/** 取单个模块的一致快照；模块尚无状态行时返回 null。 */
export async function readModuleSnapshot(
  db: D1Database,
  workspaceId: string,
  moduleId: string,
): Promise<ModuleSnapshot | null> {
  const row = await db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} ${SNAPSHOT_FROM} WHERE m.workspace_id = ? AND m.module_id = ?`)
    .bind(workspaceId, moduleId)
    .first<JoinedRow>();
  return row === null ? null : toSnapshot(row);
}

/** 取本工作空间全部模块的一致快照（单条查询，列表接口使用）。 */
export async function listModuleSnapshots(db: D1Database, workspaceId: string): Promise<ModuleSnapshot[]> {
  const result = await db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} ${SNAPSHOT_FROM} WHERE m.workspace_id = ? ORDER BY m.module_id ASC`)
    .bind(workspaceId)
    .all<JoinedRow>();
  return result.results.map((row) => toSnapshot(row));
}

/**
 * 读取模块的**门禁状态**与 revision（调度端口使用）。
 * 与快照同源（同一条 LEFT JOIN），因此「有待完成操作」不会被读到半截。
 */
export async function readModuleGateStatus(
  db: D1Database,
  workspaceId: string,
  moduleId: string,
): Promise<{ readonly status: ModuleGateStatus; readonly revision: number }> {
  const snapshot = await readModuleSnapshot(db, workspaceId, moduleId);
  if (snapshot === null) {
    // 行缺失 → not_installed；没有行就没有 revision（调度会因此被拒绝）。
    return { status: effectiveModuleStatus(null), revision: 0 };
  }
  const status: ModuleEffectiveStatus = effectiveModuleStatus(snapshot.row.status);
  return {
    status: moduleGateStatusFromPresence(status, snapshot.pendingRow !== null),
    revision: snapshot.row.revision,
  };
}

/** 当前执行认领（tests 与运维诊断用）。 */
export interface OperationClaimRow {
  readonly token: string;
  readonly claimed_at: number;
  readonly expires_at: number;
}

export async function readOperationClaim(
  db: D1Database,
  workspaceId: string,
  moduleId: string,
): Promise<OperationClaimRow | null> {
  return await db
    .prepare(
      `SELECT token, claimed_at, expires_at FROM workspace_module_operation_claims
        WHERE workspace_id = ? AND module_id = ?`,
    )
    .bind(workspaceId, moduleId)
    .first<OperationClaimRow>();
}

/** 防御性解析设置 JSON。 */
export function parseStoredSettings(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 落到下面的空对象：损坏的行不阻断接口，也不被当成有效设置。
  }
  return {};
}

/** 待完成操作行 → 对外结构。 */
export function toPendingOperation(row: WorkspaceModuleOperationRow | null): ModulePendingOperation | null {
  if (row === null) {
    return null;
  }
  return {
    action: row.action,
    revision: row.revision,
    targetStatus: row.target_status,
    startedAt: row.started_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/**
 * 快照 → 对外状态。行缺失即 not_installed 且 revision 为 0。
 * `pendingOperation` 非 null 表示状态已提交但副作用尚未完成（待重试）。
 */
export function snapshotToStatus(moduleId: string, snapshot: ModuleSnapshot | null): WorkspaceModuleStatus {
  if (snapshot === null) {
    return {
      moduleId,
      status: 'not_installed',
      settings: {},
      settingsVersion: 0,
      revision: 0,
      installedAt: null,
      enabledAt: null,
      disabledAt: null,
      uninstalledAt: null,
      updatedAt: null,
      pendingOperation: null,
    };
  }
  const { row } = snapshot;
  return {
    moduleId,
    status: effectiveModuleStatus(row.status),
    settings: parseStoredSettings(row.settings_json),
    settingsVersion: row.settings_version,
    revision: row.revision,
    installedAt: row.installed_at,
    enabledAt: row.enabled_at,
    disabledAt: row.disabled_at,
    uninstalledAt: row.uninstalled_at,
    updatedAt: row.updated_at,
    pendingOperation: toPendingOperation(snapshot.pendingRow),
  };
}
