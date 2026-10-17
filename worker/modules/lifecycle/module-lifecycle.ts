/**
 * 模块生命周期服务（HUB-050）。
 *
 * 语义（规划规则 7；**五种操作不得混为一谈**）：
 *
 * | 操作 | 页面/实例 | 后台行为 | 个人数据与设置 |
 * |---|---|---|---|
 * | `hideWidget` / `removeWidget` | 仅影响该实例（**纯前端**，不经过本服务） | 不受影响 | 保留 |
 * | `disableModule` | 组件与入口停用 | **暂停并取消已排队任务** | 保留 |
 * | `uninstallModule` | 移除当前 Host 的全部实例 + 停用 | 停止并取消任务 | **默认保留**，可 `restore` |
 * | `purgeModuleData` | —— | —— | 本阶段**显式拒绝**（501），绝不静默删除 |
 *
 * 因此：卸载 ≠ 清数据。本服务里不存在任何删除数据行的路径。
 *
 * ── 执行协议：原子准入 → **独占执行认领** → 受 fence 保护的副作用 → 收尾 ──
 *
 * 1. **原子准入**（一个 D1 batch）：条件 CAS（`WHERE revision = ?` **且** 该模块当前没有待完成操作）
 *    提交目标状态，并在同一事务里写入 `workspace_module_operations`（待完成标记）
 *    与 `workspace_module_operation_claims`（本请求的执行 token）。
 *    抢输的一方在这里以 409 退出，**此前此后都没有任何可变副作用**。
 * 2. **独占认领**：续做路径必须先 `INSERT ... ON CONFLICT DO NOTHING` 抢到 claim（或原子抢占过期租约）。
 *    抢不到 → `operation_in_progress`（409），**同样没有任何副作用**。
 * 3. **副作用**：handler → 移除实例 → 取消已排队任务；
 *    每一步前后都校验「我仍然是当前 token 的持有者」。
 *    写入（收尾 / 失败记录）全部以 `token` 为条件，因此被取代的执行者写不进去；
 *    端口清理还额外带 **revision fence**（`maxRevision` / `upToRevision`），
 *    所以即便旧执行者越过了检查，也删不掉 restore 之后（revision 更大）的新任务与新实例。
 * 4. **收尾**：条件删除待完成标记（必须仍持有 token）。删除影响 0 行**不是**成功，
 *    而是「执行权已被取代」（`operation_superseded`，409）。
 *
 * 租约（`EXECUTION_LEASE_MS`）只解决「执行者崩溃后无人收尾」的活性问题；
 * 它**不**保证 TTL 到期旧执行者已经停止 —— 这正是第 3 步 fence 存在的原因。
 * 失败时立即释放认领，因此客户端可以马上重试；恢复路径只有一条且显式。
 */
import {
  MODULE_SETTINGS_MAX_BYTES,
  MODULE_STATUS_LABELS,
  type ModuleEffectiveStatus,
  type ModuleGateStatus,
  type ModuleMutationEffect,
  type ModuleMutationRequest,
  type ModulePendingOperation,
  type ModulePersistedStatus,
  type ModuleSupportedAction,
  type WorkspaceModuleStatus,
} from '@ff14-hub/shared';
import { stableStringify } from '../../lib/util';
import type { ModuleInstanceStore, ModuleLifecycleContext, ModuleSchedulerPort } from '../ports';
import type { ModuleRegistry, RegisteredModule } from '../registry/module-registry';
import { createModuleScopedScheduler } from './scheduler';
import {
  listModuleSnapshots,
  parseStoredSettings,
  readModuleGateStatus,
  readModuleSnapshot,
  snapshotToStatus,
  toPendingOperation,
  type ModuleSnapshot,
  type WorkspaceModuleOperationRow,
  type WorkspaceModuleRow,
} from './workspace-modules';

/** 执行租约：只用于崩溃后的原子抢占，不代表「到期即安全」。 */
export const EXECUTION_LEASE_MS = 15_000;

/** 变更被拒绝（或技术性失败）的原因。路由层把它映射成错误码，服务层不关心 HTTP。 */
export type MutationRejection =
  | 'module_unknown'
  | 'purge_unsupported'
  | 'status_conflict'
  | 'revision_conflict'
  | 'pending_conflict'
  /** 该待完成操作正被另一个执行者持有（未过期租约）。 */
  | 'operation_in_progress'
  /** 该待完成操作已被其他请求完成（认领失败且 marked 行已消失）。 */
  | 'operation_already_completed'
  /** 本次执行权已被取代：不能继续清理，也不能冒充成功。 */
  | 'operation_superseded'
  | 'settings_invalid'
  | 'settings_version_mismatch'
  | 'settings_too_large'
  /** 准入写入本身失败：什么都没提交（因此可以安全重试）。 */
  | 'persist_failed'
  /** 状态与待完成标记不一致（本不应发生）：必须让调用方重新读取，而不是猜。 */
  | 'inconsistent_state';

export type MutationOutcome =
  | { readonly ok: true; readonly module: WorkspaceModuleStatus; readonly effect: ModuleMutationEffect }
  | { readonly ok: false; readonly reason: MutationRejection; readonly detail: string };

export interface ModuleLifecycle {
  listStatuses(workspaceId: string): Promise<WorkspaceModuleStatus[]>;
  readStatus(workspaceId: string, moduleId: string): Promise<WorkspaceModuleStatus>;
  /** 门禁状态（含待完成操作）；调度端口与前端 Host 共用同一判定。 */
  gateStatus(workspaceId: string, moduleId: string): Promise<ModuleGateStatus>;
  mutate(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly request: ModuleMutationRequest;
  }): Promise<MutationOutcome>;
}

export interface ModuleLifecycleDeps {
  readonly db: D1Database;
  readonly registry: ModuleRegistry;
  /** 平台内部实例清理端口；**不交给模块代码**。 */
  readonly instanceStore: ModuleInstanceStore;
  /** 平台内部管理调度端口（带任意作用域）；**不交给模块代码**。 */
  readonly scheduler: ModuleSchedulerPort;
  /** 可注入时钟（租约与时间戳都用它），便于测试确定性交错。 */
  readonly now?: () => number;
}

type TransitionDecision =
  | { readonly kind: 'apply'; readonly next: ModulePersistedStatus }
  | { readonly kind: 'noop' }
  | { readonly kind: 'reject'; readonly detail: string };

/**
 * 状态迁移矩阵。刻意把「幂等 no-op」与「非法迁移」区分开：
 * 重复调用同一动作是幂等成功（不 bump revision），而语义上说不通的动作是冲突（409）。
 * 只在**没有待完成操作**时使用（有待完成操作时走「续做」路径）。
 */
export function decideTransition(action: ModuleSupportedAction, current: ModuleEffectiveStatus): TransitionDecision {
  switch (action) {
    case 'enable':
      if (current === 'uninstalled') {
        return { kind: 'reject', detail: '模块处于已卸载状态，请使用 restore 恢复而不是 enable' };
      }
      if (current === 'enabled') {
        return { kind: 'noop' };
      }
      return { kind: 'apply', next: 'enabled' };
    case 'disable':
      if (current === 'enabled') {
        return { kind: 'apply', next: 'disabled' };
      }
      if (current === 'disabled') {
        return { kind: 'noop' };
      }
      return { kind: 'reject', detail: '只有已启用的模块才需要停用' };
    case 'uninstall':
      if (current === 'uninstalled') {
        return { kind: 'noop' };
      }
      if (current === 'not_installed') {
        return { kind: 'reject', detail: '模块尚未安装，无需卸载' };
      }
      return { kind: 'apply', next: 'uninstalled' };
    case 'restore':
      if (current === 'uninstalled') {
        return { kind: 'apply', next: 'enabled' };
      }
      if (current === 'enabled') {
        return { kind: 'noop' };
      }
      return { kind: 'reject', detail: '只有已卸载的模块才能恢复；未安装请用 enable' };
  }
}

/** 动作 → Manifest 里引用的 handler 名（enable 与 restore 共用 onEnable）。 */
function handlerNameFor(module: RegisteredModule, action: ModuleSupportedAction): string | undefined {
  switch (action) {
    case 'enable':
    case 'restore':
      return module.manifest.lifecycle.onEnable;
    case 'disable':
      return module.manifest.lifecycle.onDisable;
    case 'uninstall':
      return module.manifest.lifecycle.onUninstall;
  }
}

function targetStatusOf(action: ModuleSupportedAction): ModulePersistedStatus {
  switch (action) {
    case 'enable':
    case 'restore':
      return 'enabled';
    case 'disable':
      return 'disabled';
    case 'uninstall':
      return 'uninstalled';
  }
}

/** 当前状态对应的时间戳：同一时刻只有一个非空（其余为 NULL）。 */
function timestampsFor(status: ModulePersistedStatus, now: number): {
  readonly enabledAt: number | null;
  readonly disabledAt: number | null;
  readonly uninstalledAt: number | null;
} {
  return {
    enabledAt: status === 'enabled' ? now : null,
    disabledAt: status === 'disabled' ? now : null,
    uninstalledAt: status === 'uninstalled' ? now : null,
  };
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function settingsBytes(settings: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(settings)).length;
}

interface SideEffectInput {
  readonly workspaceId: string;
  readonly moduleId: string;
  readonly module: RegisteredModule;
  readonly action: ModuleSupportedAction;
  readonly targetStatus: ModulePersistedStatus;
  readonly timestamp: number;
  /** 本次准入后的 revision：既是执行权的核对依据，也是端口清理的 fence 上界。 */
  readonly admissionRevision: number;
  /** 本次执行的 token（绑定进模块调度视图，作为可变调用的归属依据）。 */
  readonly token: string;
}

interface SideEffectResult {
  readonly handlersRun: readonly string[];
  readonly instancesRemoved: number;
  readonly scheduledTasksCancelled: number;
  readonly failure: string | null;
  /** true 表示执行权已被取代：调用方必须立即停止，不得收尾。 */
  readonly superseded: boolean;
}

interface OutcomeDescriptionInput {
  readonly action: ModuleSupportedAction | undefined;
  readonly resume: boolean;
  readonly pending: ModulePendingOperation | null;
  readonly instancesRemoved: number;
  readonly scheduledTasksCancelled: number;
  readonly settingsChanged: boolean;
}

function describeOutcome(input: OutcomeDescriptionInput): string {
  const counts =
    `移除 ${String(input.instancesRemoved)} 个当前实例、取消 ${String(input.scheduledTasksCancelled)} 项待执行任务`;
  if (input.pending !== null) {
    return (
      `状态已提交为「${MODULE_STATUS_LABELS[input.pending.targetStatus]}」，但收尾未完成` +
      `（原因：${input.pending.lastError ?? '未知'}）。个人数据与设置保留；` +
      `请用同样的动作「${input.pending.action}」重试以完成清理（当前尝试次数 ${String(input.pending.attempts)}）。`
    );
  }
  const base = ((): string => {
    if (input.resume) {
      return `上一次操作的收尾已完成：${counts}；个人数据与设置保留。`;
    }
    switch (input.action) {
      case 'enable':
        return '模块已启用。';
      case 'restore':
        return '模块已恢复启用，沿用原有设置与个人数据。';
      case 'disable':
        return `模块已停用：后台行为已暂停（取消 ${String(input.scheduledTasksCancelled)} 项待执行任务），个人数据与设置保留。`;
      case 'uninstall':
        return `模块已卸载：${counts}；个人数据与设置保留，可随时恢复。`;
      case undefined:
        return '模块设置已保存。';
    }
  })();
  return input.settingsChanged && input.action !== undefined ? `${base} 模块设置也已更新。` : base;
}

export function createModuleLifecycle(deps: ModuleLifecycleDeps): ModuleLifecycle {
  const now = deps.now ?? ((): number => Date.now());

  function newExecutionToken(): string {
    return crypto.randomUUID();
  }

  /**
   * 抢占本次执行的独占权。
   * - 无认领行 → `INSERT ... ON CONFLICT DO NOTHING`，只有一方能成功。
   * - 有认领行但租约过期 → 原子 `UPDATE ... WHERE expires_at <= now`，同样只有一方能成功。
   * 两种成功都会在**同一事务**里把 attempts +1（`changes()` 链式判定，不做无条件的自增）。
   * 返回 null 表示「别人正在执行」→ 调用方必须立即 409 且不得产生副作用。
   */
  async function claimExecution(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly admissionRevision: number;
  }): Promise<string | null> {
    const token = newExecutionToken();
    const claimedAt = now();
    const expiresAt = claimedAt + EXECUTION_LEASE_MS;

    const inserted = await deps.db.batch([
      deps.db
        .prepare(
          `INSERT INTO workspace_module_operation_claims (workspace_id, module_id, token, claimed_at, expires_at)
           SELECT ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM workspace_module_operations
                           WHERE workspace_id = ? AND module_id = ? AND revision = ?)
           ON CONFLICT (workspace_id, module_id) DO NOTHING`,
        )
        .bind(
          input.workspaceId,
          input.moduleId,
          token,
          claimedAt,
          expiresAt,
          input.workspaceId,
          input.moduleId,
          input.admissionRevision,
        ),
      deps.db
        .prepare(
          `UPDATE workspace_module_operations SET attempts = attempts + 1, last_error = NULL
            WHERE workspace_id = ? AND module_id = ? AND revision = ? AND changes() = 1`,
        )
        .bind(input.workspaceId, input.moduleId, input.admissionRevision),
    ]);
    if ((inserted[0]?.meta.changes ?? 0) === 1) {
      return token;
    }

    // 租约过期才允许抢占；抢占成功后旧 token 立即失效（旧执行者的写入会被 fence 挡住）。
    const taken = await deps.db.batch([
      deps.db
        .prepare(
          `UPDATE workspace_module_operation_claims SET token = ?, claimed_at = ?, expires_at = ?
            WHERE workspace_id = ? AND module_id = ? AND expires_at <= ?
              AND EXISTS (SELECT 1 FROM workspace_module_operations
                           WHERE workspace_id = ? AND module_id = ? AND revision = ?)`,
        )
        .bind(
          token,
          claimedAt,
          expiresAt,
          input.workspaceId,
          input.moduleId,
          claimedAt,
          input.workspaceId,
          input.moduleId,
          input.admissionRevision,
        ),
      deps.db
        .prepare(
          `UPDATE workspace_module_operations SET attempts = attempts + 1, last_error = NULL
            WHERE workspace_id = ? AND module_id = ? AND revision = ? AND changes() = 1`,
        )
        .bind(input.workspaceId, input.moduleId, input.admissionRevision),
    ]);
    return (taken[0]?.meta.changes ?? 0) === 1 ? token : null;
  }

  /** 释放认领（失败后立即释放，便于客户端马上重试）。被取代者的删除会影响 0 行。 */
  async function releaseClaim(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly token: string;
  }): Promise<void> {
    await deps.db
      .prepare(
        'DELETE FROM workspace_module_operation_claims WHERE workspace_id = ? AND module_id = ? AND token = ?',
      )
      .bind(input.workspaceId, input.moduleId, input.token)
      .run();
  }

  /** 「我是否仍然是当前 token 的持有者，且待完成操作仍是本次准入」。 */
  async function ownsExecution(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly token: string;
    readonly admissionRevision: number;
  }): Promise<boolean> {
    const row = await deps.db
      .prepare(
        `SELECT 1 AS owned
           FROM workspace_module_operation_claims c
           JOIN workspace_module_operations o
             ON o.workspace_id = c.workspace_id AND o.module_id = c.module_id
          WHERE c.workspace_id = ? AND c.module_id = ? AND c.token = ? AND o.revision = ?`,
      )
      .bind(input.workspaceId, input.moduleId, input.token, input.admissionRevision)
      .first<{ owned: number }>();
    return row !== null;
  }

  /**
   * 阶段 2：执行副作用。每一步前后都校验执行权。
   * handler 失败**不**跳过平台清理（安全不变量优先）。
   * 端口清理一律带 revision fence，因此即便执行权在这之后丢失，也伤不到新一代数据。
   */
  async function runSideEffects(
    input: SideEffectInput,
    assertOwned: () => Promise<boolean>,
  ): Promise<SideEffectResult> {
    const handlersRun: string[] = [];
    let instancesRemoved = 0;
    let scheduledTasksCancelled = 0;
    const failures: string[] = [];

    const superseded = (): SideEffectResult => ({
      handlersRun,
      instancesRemoved,
      scheduledTasksCancelled,
      failure: null,
      superseded: true,
    });

    if (!(await assertOwned())) {
      return superseded();
    }

    const handlerName = handlerNameFor(input.module, input.action);
    if (handlerName !== undefined) {
      // Object.hasOwn：绝不能把 Object.prototype.constructor 之流当成「已注册的 handler」。
      const handler = Object.hasOwn(input.module.handlers, handlerName)
        ? input.module.handlers[handlerName]
        : undefined;
      if (typeof handler !== 'function') {
        failures.push(`生命周期 handler 未在静态注册表中定义：${handlerName}`);
      } else {
        const ownInit =
          input.action === 'enable' || input.action === 'restore'
            ? { action: input.action, revision: input.admissionRevision }
            : null;
        const context: ModuleLifecycleContext = {
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          now: input.timestamp,
          services: {
            scheduler: createModuleScopedScheduler({
              workspaceId: input.workspaceId,
              moduleId: input.moduleId,
              management: deps.scheduler,
              // 授权判定来自注册表的授予集合；Manifest 的声明不参与。
              canSchedule: deps.registry.hasCapability(input.moduleId, 'scheduled:own'),
              ownInit,
              readPendingOperation: async () => {
                const snapshot = await readModuleSnapshot(deps.db, input.workspaceId, input.moduleId);
                const pending = snapshot?.pendingRow ?? null;
                return pending === null ? null : { action: pending.action, revision: pending.revision };
              },
              // 执行归属：handler 在 await 中跨租约被取代后，其内部的 schedule/cancel
              // 都会得到 execution_superseded，无法破坏新一代的任务集合（见 ADR-0002 D4/D15）。
              execution: { token: input.token, admissionRevision: input.admissionRevision },
              isExecutionCurrent: assertOwned,
            }),
          },
        };
        try {
          await handler(context);
          handlersRun.push(handlerName);
        } catch (error) {
          failures.push(`生命周期 handler 失败：${handlerName}（${errorNameOf(error)}）`);
        }
      }
    }

    // 平台清理是安全不变量：即使 handler 失败也必须尝试。
    if (!(await assertOwned())) {
      return superseded();
    }
    if (input.targetStatus === 'uninstalled') {
      try {
        const removed = await deps.instanceStore.removeInstancesForModule({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          reason: 'module_uninstalled',
          // fence：只移除这一代及更早创建的实例。
          maxRevision: input.admissionRevision,
        });
        instancesRemoved = removed.removed;
      } catch (error) {
        failures.push(`实例清理失败（${errorNameOf(error)}）`);
      }
      if (!(await assertOwned())) {
        return superseded();
      }
    }

    if (input.targetStatus === 'uninstalled' || input.targetStatus === 'disabled') {
      if (!(await assertOwned())) {
        return superseded();
      }
      try {
        const cancelled = await deps.scheduler.cancelAllForModule({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          reason: input.targetStatus === 'uninstalled' ? 'module_uninstalled' : 'module_disabled',
          // fence：只取消这一代及更早登记的任务。
          upToRevision: input.admissionRevision,
        });
        scheduledTasksCancelled = cancelled.cancelled;
      } catch (error) {
        failures.push(`平台清理失败（${errorNameOf(error)}）`);
      }
    }

    return {
      handlersRun,
      instancesRemoved,
      scheduledTasksCancelled,
      failure: failures.length > 0 ? failures.join('；') : null,
      superseded: false,
    };
  }

  /** 记录失败原因（条件：仍持有 token）。返回 false 表示已被取代。 */
  async function recordFailure(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly admissionRevision: number;
    readonly token: string;
    readonly failure: string;
  }): Promise<boolean> {
    const updated = await deps.db
      .prepare(
        `UPDATE workspace_module_operations SET last_error = ?
          WHERE workspace_id = ? AND module_id = ? AND revision = ?
            AND EXISTS (SELECT 1 FROM workspace_module_operation_claims c
                         WHERE c.workspace_id = ? AND c.module_id = ? AND c.token = ?)`,
      )
      .bind(
        input.failure,
        input.workspaceId,
        input.moduleId,
        input.admissionRevision,
        input.workspaceId,
        input.moduleId,
        input.token,
      )
      .run();
    return (updated.meta.changes ?? 0) === 1;
  }

  /**
   * 阶段 3：收尾 —— 条件删除待完成标记（必须仍持有 token）。
   * 影响 0 行**不是**幂等成功，而是「执行权已被取代」。
   * 刻意不再 bump revision：revision 表示已提交的状态修订号（见 ADR-0002 D13）。
   */
  async function completeAdmission(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly admissionRevision: number;
    readonly token: string;
  }): Promise<boolean> {
    const deleted = await deps.db
      .prepare(
        `DELETE FROM workspace_module_operations
          WHERE workspace_id = ? AND module_id = ? AND revision = ?
            AND EXISTS (SELECT 1 FROM workspace_module_operation_claims c
                         WHERE c.workspace_id = ? AND c.module_id = ? AND c.token = ?)`,
      )
      .bind(
        input.workspaceId,
        input.moduleId,
        input.admissionRevision,
        input.workspaceId,
        input.moduleId,
        input.token,
      )
      .run();
    // 注意：D1 的 meta.changes 把**级联删除**（认领行）也计入，因此这里判定 `>= 1`，
    // 不能写成 `=== 1`（否则成功的收尾会被误判为「执行权被取代」）。
    return (deleted.meta.changes ?? 0) >= 1;
  }

  async function buildOutcome(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly action: ModuleSupportedAction | undefined;
    readonly resume: boolean;
    readonly changed: boolean;
    readonly settingsChanged: boolean;
    readonly sideEffects: SideEffectResult;
  }): Promise<MutationOutcome> {
    // **一致快照**：状态与待完成操作来自同一条 LEFT JOIN，不会组合出「enabled 且无 pending」。
    const snapshot: ModuleSnapshot | null = await readModuleSnapshot(deps.db, input.workspaceId, input.moduleId);
    const pending = toPendingOperation(snapshot?.pendingRow ?? null);
    return {
      ok: true,
      module: snapshotToStatus(input.moduleId, snapshot),
      effect: {
        changed: input.changed,
        instancesRemoved: input.sideEffects.instancesRemoved,
        scheduledTasksCancelled: input.sideEffects.scheduledTasksCancelled,
        handlersRun: [...input.sideEffects.handlersRun],
        userDataRetained: true,
        pending: pending !== null,
        failure: input.sideEffects.failure,
        message: describeOutcome({
          action: input.action,
          resume: input.resume,
          pending,
          instancesRemoved: input.sideEffects.instancesRemoved,
          scheduledTasksCancelled: input.sideEffects.scheduledTasksCancelled,
          settingsChanged: input.settingsChanged,
        }),
      },
    };
  }

  function pendingOf(snapshot: ModuleSnapshot | null): WorkspaceModuleOperationRow | null {
    return snapshot?.pendingRow ?? null;
  }

  async function listStatuses(workspaceId: string): Promise<WorkspaceModuleStatus[]> {
    // 一次查询取回全部模块 + 待完成操作（同一快照）。
    const snapshots = await listModuleSnapshots(deps.db, workspaceId);
    const byId = new Map(snapshots.map((snapshot) => [snapshot.row.module_id, snapshot]));
    // 只返回**注册表里存在**的模块：数据库里不属于任何已注册模块的残留行不对外暴露。
    return deps.registry
      .list()
      .map((module) => snapshotToStatus(module.manifest.id, byId.get(module.manifest.id) ?? null));
  }

  async function readStatus(workspaceId: string, moduleId: string): Promise<WorkspaceModuleStatus> {
    if (deps.registry.get(moduleId) === undefined) {
      return snapshotToStatus(moduleId, null);
    }
    return snapshotToStatus(moduleId, await readModuleSnapshot(deps.db, workspaceId, moduleId));
  }

  async function mutate(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly request: ModuleMutationRequest;
  }): Promise<MutationOutcome> {
    const module = deps.registry.get(input.moduleId);
    if (module === undefined) {
      return { ok: false, reason: 'module_unknown', detail: `模块未注册：${input.moduleId}` };
    }
    const { request } = input;

    // ── 校验（全部是纯读/纯计算，没有任何副作用）────────────────────────────
    if (request.action === 'purge') {
      return {
        ok: false,
        reason: 'purge_unsupported',
        detail: 'purge 在本阶段被显式拒绝：清数据需要先备份并二次确认，且与卸载是不同语义。',
      };
    }
    const action: ModuleSupportedAction | undefined = request.action;

    if (request.settingsVersion !== undefined && request.settingsVersion !== module.settingsSchemaVersion) {
      return {
        ok: false,
        reason: 'settings_version_mismatch',
        detail: `设置版本不匹配：客户端 ${String(request.settingsVersion)}，当前 ${String(module.settingsSchemaVersion)}`,
      };
    }
    let validatedSettings: Record<string, unknown> | undefined;
    if (request.settings !== undefined) {
      const validation = deps.registry.validateSettings(input.moduleId, request.settings);
      if (!validation.ok) {
        return { ok: false, reason: 'settings_invalid', detail: validation.issues.join('；') };
      }
      if (settingsBytes(validation.settings) > MODULE_SETTINGS_MAX_BYTES) {
        return {
          ok: false,
          reason: 'settings_too_large',
          detail: `模块设置超过 ${String(MODULE_SETTINGS_MAX_BYTES)} 字节上限`,
        };
      }
      validatedSettings = validation.settings;
    }

    // **一致快照**：状态与待完成操作必须同时可见，否则会误判「无 pending 可以正常迁移」。
    const snapshot = await readModuleSnapshot(deps.db, input.workspaceId, input.moduleId);
    const row: WorkspaceModuleRow | null = snapshot?.row ?? null;
    const pendingRow = pendingOf(snapshot);
    const currentStatus: ModuleEffectiveStatus = row === null ? 'not_installed' : row.status;
    const currentRevision = row?.revision ?? 0;
    if (request.expectedRevision !== currentRevision) {
      return {
        ok: false,
        reason: 'revision_conflict',
        detail: `revision 不匹配：客户端 ${String(request.expectedRevision)}，当前 ${String(currentRevision)}`,
      };
    }

    // ── 有待完成操作：只允许「同动作续做」，且不允许夹带设置 ────────────────
    if (pendingRow !== null) {
      if (action !== pendingRow.action || validatedSettings !== undefined) {
        return {
          ok: false,
          reason: 'pending_conflict',
          detail:
            `模块有待完成操作「${pendingRow.action}」（revision ${String(pendingRow.revision)}，` +
            `已尝试 ${String(pendingRow.attempts)} 次）。请用同一动作、不带设置地重试以完成收尾。`,
        };
      }
      const admissionRevision = pendingRow.revision;
      const token = await claimExecution({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        admissionRevision,
      });
      if (token === null) {
        // 认领失败有两种可能：别人正在执行（租约未过期），或这一轮已经被别人收尾完成。
        const afterFailedClaim = await readModuleSnapshot(deps.db, input.workspaceId, input.moduleId);
        if (afterFailedClaim === null || afterFailedClaim.pendingRow === null) {
          return {
            ok: false,
            reason: 'operation_already_completed',
            detail: '该待完成操作已由其他请求完成收尾，请重新读取状态。',
          };
        }
        return {
          ok: false,
          reason: 'operation_in_progress',
          detail: '该待完成操作正由另一次请求执行（独占认领未过期），本次未执行任何副作用。',
        };
      }
      const timestamp = now();
      const assertOwned = (): Promise<boolean> =>
        ownsExecution({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          token,
          admissionRevision,
        });
      const sideEffects = await runSideEffects(
        {
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          module,
          action: pendingRow.action,
          targetStatus: pendingRow.target_status,
          timestamp,
          admissionRevision,
          token,
        },
        assertOwned,
      );

      if (sideEffects.superseded) {
        return {
          ok: false,
          reason: 'operation_superseded',
          detail: '本次执行权已被其他重试取代，已停止继续清理（未重复执行任何副作用）。',
        };
      }
      if (sideEffects.failure !== null) {
        const recorded = await recordFailure({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          admissionRevision,
          token,
          failure: sideEffects.failure,
        });
        // 无论记录成功与否都释放认领：失败后应允许立刻重试。
        await releaseClaim({ workspaceId: input.workspaceId, moduleId: input.moduleId, token });
        if (!recorded) {
          return {
            ok: false,
            reason: 'operation_superseded',
            detail: '本次执行权已被取代，未能记录失败原因；请重新读取状态后重试。',
          };
        }
        return await buildOutcome({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          action: pendingRow.action,
          resume: true,
          changed: false,
          settingsChanged: false,
          sideEffects,
        });
      }

      const completed = await completeAdmission({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        admissionRevision,
        token,
      });
      if (!completed) {
        return {
          ok: false,
          reason: 'operation_superseded',
          detail: '本次执行权已被取代：收尾未提交（状态未被改动）。',
        };
      }
      return await buildOutcome({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        action: pendingRow.action,
        resume: true,
        changed: true,
        settingsChanged: false,
        sideEffects,
      });
    }

    if (action === undefined && row === null) {
      return {
        ok: false,
        reason: 'status_conflict',
        detail: '模块尚未安装，不能只写设置；请先执行 enable。',
      };
    }

    // ── 计算目标状态与目标设置 ───────────────────────────────────────────────
    let nextStatus: ModulePersistedStatus | undefined;
    let statusChanged = false;
    if (action !== undefined) {
      const decision = decideTransition(action, currentStatus);
      if (decision.kind === 'reject') {
        return { ok: false, reason: 'status_conflict', detail: decision.detail };
      }
      if (decision.kind === 'apply') {
        nextStatus = decision.next;
        statusChanged = true;
      }
    }

    const existingSettings = row === null ? undefined : parseStoredSettings(row.settings_json);
    let nextSettings: Record<string, unknown>;
    let nextSettingsVersion: number;
    if (validatedSettings !== undefined) {
      nextSettings = validatedSettings;
      nextSettingsVersion = module.settingsSchemaVersion;
    } else if (existingSettings !== undefined) {
      nextSettings = existingSettings;
      // 状态变更**不**改写设置版本：否则会在没有迁移设置内容的情况下谎报版本。
      nextSettingsVersion = row?.settings_version ?? module.settingsSchemaVersion;
    } else {
      // 首次安装：把 Schema 物化出的默认值写进去，而不是留一个需要后端猜的空对象。
      const defaults = deps.registry.validateSettings(input.moduleId, {});
      nextSettings = defaults.ok ? defaults.settings : {};
      nextSettingsVersion = module.settingsSchemaVersion;
    }
    const settingsChanged =
      validatedSettings !== undefined && stableStringify(validatedSettings) !== stableStringify(existingSettings ?? {});

    if (!statusChanged && !settingsChanged) {
      // 幂等：什么都不写，也不 bump revision，客户端无需重新读取。
      return {
        ok: true,
        module: snapshotToStatus(input.moduleId, snapshot),
        effect: {
          changed: false,
          instancesRemoved: 0,
          scheduledTasksCancelled: 0,
          handlersRun: [],
          userDataRetained: true,
          pending: false,
          failure: null,
          message: describeOutcome({
            action,
            resume: false,
            pending: null,
            instancesRemoved: 0,
            scheduledTasksCancelled: 0,
            settingsChanged: false,
          }),
        },
      };
    }

    const timestamp = now();
    const settingsJson = JSON.stringify(nextSettings);

    // ── 仅设置变更：没有副作用，因此只需一次条件更新，不产生待完成标记 ────────
    if (!statusChanged) {
      try {
        const updated = await deps.db
          .prepare(
            `UPDATE workspace_modules
                SET settings_json = ?, settings_version = ?, revision = revision + 1, updated_at = ?
              WHERE workspace_id = ? AND module_id = ? AND revision = ?`,
          )
          .bind(settingsJson, nextSettingsVersion, timestamp, input.workspaceId, input.moduleId, currentRevision)
          .run();
        if ((updated.meta.changes ?? 0) !== 1) {
          return {
            ok: false,
            reason: 'revision_conflict',
            detail: '并发写入：revision 已被其他请求改变，本次修改未提交',
          };
        }
      } catch (error) {
        return {
          ok: false,
          reason: 'persist_failed',
          detail: `写入模块设置失败（${errorNameOf(error)}）`,
        };
      }
      return await buildOutcome({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        action,
        resume: false,
        changed: true,
        settingsChanged: true,
        sideEffects: {
          handlersRun: [],
          instancesRemoved: 0,
          scheduledTasksCancelled: 0,
          failure: null,
          superseded: false,
        },
      });
    }

    // ── 阶段 1：原子准入（状态 CAS + 待完成标记 + 执行认领，同一事务）──────────
    const targetStatus = nextStatus ?? targetStatusOf(action ?? 'enable');
    const stamps = timestampsFor(targetStatus, timestamp);
    const admissionRevision = currentRevision + 1;
    const token = newExecutionToken();
    const claimedAt = timestamp;
    const expiresAt = claimedAt + EXECUTION_LEASE_MS;

    // 状态写入与「是否已有待完成操作」在**同一个条件**里互斥：
    // 已有 pending 时 CAS 影响 0 行 → 409，不会出现「状态提交了、pending 却没被匹配」。
    const noPendingGuard = `NOT EXISTS (SELECT 1 FROM workspace_module_operations g
                                          WHERE g.workspace_id = ? AND g.module_id = ?)`;
    try {
      let casChanges: number;
      let operationChanges: number;
      let claimChanges: number;
      if (row === null) {
        const results = await deps.db.batch([
          deps.db
            .prepare(
              `INSERT INTO workspace_modules (
                 workspace_id, module_id, status, settings_json, settings_version, revision,
                 installed_at, enabled_at, disabled_at, uninstalled_at, created_at, updated_at
               )
               SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?
                WHERE ${noPendingGuard}
               ON CONFLICT (workspace_id, module_id) DO NOTHING`,
            )
            .bind(
              input.workspaceId,
              input.moduleId,
              targetStatus,
              settingsJson,
              nextSettingsVersion,
              timestamp,
              stamps.enabledAt,
              stamps.disabledAt,
              stamps.uninstalledAt,
              timestamp,
              timestamp,
              input.workspaceId,
              input.moduleId,
            ),
          deps.db
            .prepare(
              `INSERT INTO workspace_module_operations (
                 workspace_id, module_id, action, target_status, revision, started_at, attempts, last_error
               )
               SELECT ?, ?, ?, ?, 1, ?, 1, NULL WHERE changes() = 1
               ON CONFLICT (workspace_id, module_id) DO NOTHING`,
            )
            .bind(input.workspaceId, input.moduleId, action ?? 'enable', targetStatus, timestamp),
          deps.db
            .prepare(
              `INSERT INTO workspace_module_operation_claims (workspace_id, module_id, token, claimed_at, expires_at)
               SELECT ?, ?, ?, ?, ? WHERE changes() = 1
               ON CONFLICT (workspace_id, module_id) DO NOTHING`,
            )
            .bind(input.workspaceId, input.moduleId, token, claimedAt, expiresAt),
        ]);
        casChanges = results[0]?.meta.changes ?? 0;
        operationChanges = results[1]?.meta.changes ?? 0;
        claimChanges = results[2]?.meta.changes ?? 0;
      } else {
        const results = await deps.db.batch([
          deps.db
            .prepare(
              `UPDATE workspace_modules
                  SET status = ?, settings_json = ?, settings_version = ?, revision = revision + 1,
                      enabled_at = ?, disabled_at = ?, uninstalled_at = ?, updated_at = ?
                WHERE workspace_id = ? AND module_id = ? AND revision = ? AND ${noPendingGuard}`,
            )
            .bind(
              targetStatus,
              settingsJson,
              nextSettingsVersion,
              stamps.enabledAt,
              stamps.disabledAt,
              stamps.uninstalledAt,
              timestamp,
              input.workspaceId,
              input.moduleId,
              currentRevision,
              input.workspaceId,
              input.moduleId,
            ),
          deps.db
            .prepare(
              `INSERT INTO workspace_module_operations (
                 workspace_id, module_id, action, target_status, revision, started_at, attempts, last_error
               )
               SELECT ?, ?, ?, ?, ?, ?, 1, NULL WHERE changes() = 1
               ON CONFLICT (workspace_id, module_id) DO NOTHING`,
            )
            .bind(input.workspaceId, input.moduleId, action ?? 'enable', targetStatus, admissionRevision, timestamp),
          deps.db
            .prepare(
              `INSERT INTO workspace_module_operation_claims (workspace_id, module_id, token, claimed_at, expires_at)
               SELECT ?, ?, ?, ?, ? WHERE changes() = 1
               ON CONFLICT (workspace_id, module_id) DO NOTHING`,
            )
            .bind(input.workspaceId, input.moduleId, token, claimedAt, expiresAt),
        ]);
        casChanges = results[0]?.meta.changes ?? 0;
        operationChanges = results[1]?.meta.changes ?? 0;
        claimChanges = results[2]?.meta.changes ?? 0;
      }
      if (casChanges !== 1) {
        // **抢输：在任何一个可变副作用之前退出。**
        return {
          ok: false,
          reason: 'revision_conflict',
          detail: '并发写入：revision 已被其他请求改变或该模块已有待完成操作，本次未提交（未执行任何副作用）',
        };
      }
      if (operationChanges !== 1 || claimChanges !== 1) {
        // 事务里 CAS 成功却不匹配到待完成标记/认领：条件互斥本应阻止它，因此视为内部不一致。
        return {
          ok: false,
          reason: 'inconsistent_state',
          detail: '状态已提交但待完成标记/执行认领未落库，请重新读取状态后重试',
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'persist_failed',
        detail: `写入模块状态失败（${errorNameOf(error)}）；未执行任何副作用`,
      };
    }

    const resolveAction: ModuleSupportedAction = action ?? 'enable';
    const assertOwned = (): Promise<boolean> =>
      ownsExecution({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        token,
        admissionRevision,
      });
    const sideEffects = await runSideEffects(
      {
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        module,
        action: resolveAction,
        targetStatus,
        timestamp,
        admissionRevision,
        token,
      },
      assertOwned,
    );

    if (sideEffects.superseded) {
      return {
        ok: false,
        reason: 'operation_superseded',
        detail: '本次执行权已被其他重试取代，已停止继续清理（未重复执行任何副作用）。',
      };
    }
    if (sideEffects.failure !== null) {
      const recorded = await recordFailure({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        admissionRevision,
        token,
        failure: sideEffects.failure,
      });
      await releaseClaim({ workspaceId: input.workspaceId, moduleId: input.moduleId, token });
      if (!recorded) {
        return {
          ok: false,
          reason: 'operation_superseded',
          detail: '本次执行权已被取代，未能记录失败原因；请重新读取状态后重试。',
        };
      }
      return await buildOutcome({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        action,
        resume: false,
        changed: true,
        settingsChanged,
        sideEffects,
      });
    }

    const completed = await completeAdmission({
      workspaceId: input.workspaceId,
      moduleId: input.moduleId,
      admissionRevision,
      token,
    });
    if (!completed) {
      return {
        ok: false,
        reason: 'operation_superseded',
        detail: '本次执行权已被取代：收尾未提交（状态未被改动）。',
      };
    }
    return await buildOutcome({
      workspaceId: input.workspaceId,
      moduleId: input.moduleId,
      action,
      resume: false,
      changed: true,
      settingsChanged,
      sideEffects,
    });
  }

  return {
    listStatuses,
    readStatus,
    gateStatus: async (workspaceId, moduleId) => (await readModuleGateStatus(deps.db, workspaceId, moduleId)).status,
    mutate,
  };
}
