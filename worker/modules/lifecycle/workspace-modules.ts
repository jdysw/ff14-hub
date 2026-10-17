/**
 * `workspace_modules` / `workspace_module_operations` 的读写（HUB-050）。
 *
 * 安全前提：
 * - 所有语句都带 `workspace_id = ?`，且 workspace_id **只能**来自认证中间件。
 *   拿 A 工作空间的凭证去动 B 工作空间的模块，条件更新会影响 0 行 → 冲突/不存在，
 *   不会泄露 B 的状态。
 * - `settings_json` 在读取时**防御性解析**：某一行损坏不应该让整个接口 500，
 *   但也不能伪造出「有设置」的假象 —— 解析失败即回退为空对象，而写入路径永远只写
 *   JSON.stringify 的结果，因此损坏只可能来自人工改库。
 *
 * 门禁状态：`readModuleGateStatus()` 是**唯一**的门禁读取入口，
 * 它把「有效状态」与「是否存在待完成操作」合并成 `ModuleGateStatus`（有待完成即 transitioning）。
 * 服务端调度门禁与前端 Host 都使用同一个共享函数 `moduleGateStatus()`。
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

const SELECT_MODULE_COLUMNS =
  'module_id, status, settings_json, settings_version, revision, installed_at, enabled_at, disabled_at, uninstalled_at, created_at, updated_at';

const SELECT_OPERATION_COLUMNS =
  'module_id, action, target_status, revision, started_at, attempts, last_error';

/** 读取单个模块的行；不存在返回 null（有效状态为 not_installed）。 */
export async function readWorkspaceModuleRow(
  db: D1Database,
  workspaceId: string,
  moduleId: string,
): Promise<WorkspaceModuleRow | null> {
  return await db
    .prepare(`SELECT ${SELECT_MODULE_COLUMNS} FROM workspace_modules WHERE workspace_id = ? AND module_id = ?`)
    .bind(workspaceId, moduleId)
    .first<WorkspaceModuleRow>();
}

/** 列出本工作空间的全部模块行。 */
export async function listWorkspaceModuleRows(db: D1Database, workspaceId: string): Promise<WorkspaceModuleRow[]> {
  const result = await db
    .prepare(`SELECT ${SELECT_MODULE_COLUMNS} FROM workspace_modules WHERE workspace_id = ? ORDER BY module_id ASC`)
    .bind(workspaceId)
    .all<WorkspaceModuleRow>();
  return result.results;
}

/** 读取某个模块的待完成操作；没有则返回 null。 */
export async function readWorkspaceModuleOperation(
  db: D1Database,
  workspaceId: string,
  moduleId: string,
): Promise<WorkspaceModuleOperationRow | null> {
  return await db
    .prepare(
      `SELECT ${SELECT_OPERATION_COLUMNS} FROM workspace_module_operations WHERE workspace_id = ? AND module_id = ?`,
    )
    .bind(workspaceId, moduleId)
    .first<WorkspaceModuleOperationRow>();
}

/** 列出本工作空间的全部待完成操作（供列表接口一次读完，避免 N+1）。 */
export async function listWorkspaceModuleOperations(
  db: D1Database,
  workspaceId: string,
): Promise<WorkspaceModuleOperationRow[]> {
  const result = await db
    .prepare(`SELECT ${SELECT_OPERATION_COLUMNS} FROM workspace_module_operations WHERE workspace_id = ?`)
    .bind(workspaceId)
    .all<WorkspaceModuleOperationRow>();
  return result.results;
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
 * 行 → 对外状态。行缺失即 not_installed 且 revision 为 0。
 * `pendingOperation` 非 null 表示状态已提交但副作用尚未完成（待重试）。
 */
export function toWorkspaceModuleStatus(
  moduleId: string,
  row: WorkspaceModuleRow | null,
  pendingRow: WorkspaceModuleOperationRow | null = null,
): WorkspaceModuleStatus {
  const pendingOperation = toPendingOperation(pendingRow);
  if (row === null) {
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
      pendingOperation,
    };
  }
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
    pendingOperation,
  };
}

/**
 * 读取模块的**门禁状态**。这是调度端口门禁的唯一数据来源：
 * 状态判定只看数据库（含待完成操作），不看任何调用方传参或进程内缓存。
 */
export async function readModuleGateStatus(
  db: D1Database,
  workspaceId: string,
  moduleId: string,
): Promise<ModuleGateStatus> {
  const row = await db
    .prepare(
      `SELECT m.status AS status,
              o.module_id AS pending_module_id
         FROM workspace_modules m
         LEFT JOIN workspace_module_operations o
           ON o.workspace_id = m.workspace_id AND o.module_id = m.module_id
        WHERE m.workspace_id = ? AND m.module_id = ?`,
    )
    .bind(workspaceId, moduleId)
    .first<{ status: ModulePersistedStatus; pending_module_id: string | null }>();
  if (row === null) {
    return effectiveModuleStatus(null);
  }
  const status: ModuleEffectiveStatus = effectiveModuleStatus(row.status);
  return moduleGateStatusFromPresence(status, row.pending_module_id !== null);
}
