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
 * 因此：卸载 ≠ 清数据。本服务里不存在任何删除数据行的路径，
 * 卸载只写 `status = 'uninstalled'`，`settings_json` 原样保留。
 *
 * ── 执行协议：**先原子准入，再执行副作用**（这是本文件最重要的不变量）──
 *
 * 阶段 1「原子准入」：只做校验与一次数据库事务（D1 batch）：
 *   条件 CAS 提交目标状态（`WHERE revision = ?`）**并**在同一事务里写入
 *   `workspace_module_operations` 待完成标记。
 *   - 抢输的一方（changes() = 0）在这里就以 409 退出，**此前此后都没有任何可变副作用**。
 *   - 因此「谁是赢家」由数据库唯一决定，不依赖 isolate 内互斥（Workers 多 isolate 不共享内存）。
 *
 * 阶段 2「副作用」：模块 handler、当前 Host 实例清理、已排队任务取消。
 *   - handler 只拿到**闭包绑定作用域**且经能力门禁的调度视图（见 ports.ts）。
 *   - 平台清理是安全不变量，**不因 handler 失败而跳过**。
 *   - 任一步失败：状态**已经**提交（这是事实，不能被响应伪装成没发生），
 *     待完成标记保留并记录 attempts / last_error。
 *   - 实例清理成功但任务取消失败时，也绝不会出现「enabled 但实例已删」：
 *     状态在准入阶段就已经是目标状态（uninstalled/disabled），且待完成标记就在库里。
 *
 * 阶段 3「收尾」：条件删除待完成标记（`AND revision = ?`）并把 revision +1。
 *   删除影响 0 行表示已被并发的重试完成 → 视为幂等成功。
 *
 * 重试：客户端用**同一 action + 同一 expectedRevision** 重发即可继续（不是重做）。
 *   存在待完成标记时，任何其他动作/带设置的请求都会被 409 拒绝，避免交错。
 *   本阶段刻意不引入通用分布式任务框架，也没有后台自动重试或 Cron。
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
import type {
  ModuleInstanceStore,
  ModuleLifecycleContext,
  ModuleSchedulerPort,
} from '../ports';
import type { ModuleRegistry, RegisteredModule } from '../registry/module-registry';
import { createModuleScopedScheduler } from './scheduler';
import {
  listWorkspaceModuleOperations,
  listWorkspaceModuleRows,
  parseStoredSettings,
  readModuleGateStatus,
  readWorkspaceModuleOperation,
  readWorkspaceModuleRow,
  toWorkspaceModuleStatus,
  type WorkspaceModuleOperationRow,
  type WorkspaceModuleRow,
} from './workspace-modules';

/** 变更被拒绝（或技术性失败）的原因。路由层把它映射成错误码，服务层不关心 HTTP。 */
export type MutationRejection =
  | 'module_unknown'
  | 'purge_unsupported'
  | 'status_conflict'
  | 'revision_conflict'
  | 'pending_conflict'
  | 'settings_invalid'
  | 'settings_version_mismatch'
  | 'settings_too_large'
  /** 准入写入本身失败：什么都没提交（因此可以安全重试）。 */
  | 'persist_failed';

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
  /** 可注入时钟，便于测试断言时间戳语义。 */
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
  /** 本次准入后的 revision（用于初始化豁免的数据库核对）。 */
  readonly admissionRevision: number;
}

interface SideEffectResult {
  readonly handlersRun: readonly string[];
  readonly instancesRemoved: number;
  readonly scheduledTasksCancelled: number;
  readonly failure: string | null;
}

interface OutcomeDescriptionInput {
  readonly action: ModuleSupportedAction | undefined;
  readonly resume: boolean;
  readonly pending: ModulePendingOperation | null;
  readonly targetStatus: ModulePersistedStatus;
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

  /**
   * 阶段 2：执行副作用。
   *
   * handler 只拿到受限上下文；调度视图的**作用域由闭包绑定**，
   * 且 `schedule` 的授权判定来自注册表的授予集合（`scheduled:own`），
   * 因此模块无法操作其他 workspace/module，也无法绕过能力授予。
   */
  async function runSideEffects(input: SideEffectInput): Promise<SideEffectResult> {
    const handlersRun: string[] = [];
    let instancesRemoved = 0;
    let scheduledTasksCancelled = 0;
    const failures: string[] = [];

    const handlerName = handlerNameFor(input.module, input.action);
    if (handlerName !== undefined) {
      // Object.hasOwn：绝不能把 Object.prototype.constructor 之流当成「已注册的 handler」。
      const handler = Object.hasOwn(input.module.handlers, handlerName)
        ? input.module.handlers[handlerName]
        : undefined;
      if (typeof handler !== 'function') {
        failures.push(`生命周期 handler 未在静态注册表中定义：${handlerName}`);
      } else {
        // 只有「模块正在完成自己的启用/恢复初始化」才可能豁免 transitioning 门禁，
        // 且作用域与豁免都必须经数据库事实核对（见 createModuleScopedScheduler）。
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
                const row = await readWorkspaceModuleOperation(deps.db, input.workspaceId, input.moduleId);
                return row === null ? null : { action: row.action, revision: row.revision };
              },
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

    // 平台清理是安全不变量：即使 handler 失败也必须尝试，否则会留下「状态已停用但行为还在跑」。
    try {
      if (input.targetStatus === 'uninstalled') {
        const removed = await deps.instanceStore.removeInstancesForModule({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          reason: 'module_uninstalled',
        });
        instancesRemoved = removed.removed;
        const cancelled = await deps.scheduler.cancelAllForModule({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          reason: 'module_uninstalled',
        });
        scheduledTasksCancelled = cancelled.cancelled;
      } else if (input.targetStatus === 'disabled') {
        const cancelled = await deps.scheduler.cancelAllForModule({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          reason: 'module_disabled',
        });
        scheduledTasksCancelled = cancelled.cancelled;
      }
    } catch (error) {
      failures.push(`平台清理失败（${errorNameOf(error)}）`);
    }

    return {
      handlersRun,
      instancesRemoved,
      scheduledTasksCancelled,
      failure: failures.length > 0 ? failures.join('；') : null,
    };
  }

  /**
   * 阶段 3：收尾 —— 条件删除待完成标记。
   *
   * 刻意**不**再 bump revision：revision 表示「已提交的状态/设置修订号」，
   * 一次生命周期操作只在准入时 +1；收尾只是清掉瞬态标记，
   * 「是否有待完成操作」由 `pendingOperation` 字段本身表达。
   * 这样客户端拿到的 revision 语义稳定（一次操作一次递增），不会因为重试次数而漂移。
   *
   * 删除影响 0 行表示并发的重试已经收尾完成 → 视为幂等成功。
   */
  async function completeAdmission(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly admissionRevision: number;
  }): Promise<boolean> {
    const deleted = await deps.db
      .prepare('DELETE FROM workspace_module_operations WHERE workspace_id = ? AND module_id = ? AND revision = ?')
      .bind(input.workspaceId, input.moduleId, input.admissionRevision)
      .run();
    return (deleted.meta.changes ?? 0) === 1;
  }

  /** 开始一次副作用尝试：续做时累加 attempts 并清掉上一次错误。 */
  async function beginAttempt(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly admissionRevision: number;
    readonly resume: boolean;
  }): Promise<void> {
    if (!input.resume) {
      return;
    }
    await deps.db
      .prepare(
        `UPDATE workspace_module_operations SET attempts = attempts + 1, last_error = NULL
          WHERE workspace_id = ? AND module_id = ? AND revision = ?`,
      )
      .bind(input.workspaceId, input.moduleId, input.admissionRevision)
      .run();
  }

  /** 记录本次尝试的失败原因（保留待完成标记，等待幂等重试）。 */
  async function recordFailure(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly admissionRevision: number;
    readonly failure: string;
  }): Promise<void> {
    await deps.db
      .prepare(
        `UPDATE workspace_module_operations SET last_error = ?
          WHERE workspace_id = ? AND module_id = ? AND revision = ?`,
      )
      .bind(input.failure, input.workspaceId, input.moduleId, input.admissionRevision)
      .run();
  }

  async function buildOutcome(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly action: ModuleSupportedAction | undefined;
    readonly resume: boolean;
    readonly changed: boolean;
    readonly settingsChanged: boolean;
    readonly sideEffects: SideEffectResult;
    readonly timestamp: number;
  }): Promise<MutationOutcome> {
    const [row, pendingRow] = await Promise.all([
      readWorkspaceModuleRow(deps.db, input.workspaceId, input.moduleId),
      readWorkspaceModuleOperation(deps.db, input.workspaceId, input.moduleId),
    ]);
    const pending = toPendingFromRow(pendingRow);
    const targetStatus: ModulePersistedStatus = pending?.targetStatus ?? row?.status ?? 'disabled';
    return {
      ok: true,
      module: toWorkspaceModuleStatus(input.moduleId, row, pendingRow),
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
          targetStatus,
          instancesRemoved: input.sideEffects.instancesRemoved,
          scheduledTasksCancelled: input.sideEffects.scheduledTasksCancelled,
          settingsChanged: input.settingsChanged,
        }),
      },
    };
  }

  function toPendingFromRow(row: WorkspaceModuleOperationRow | null): ModulePendingOperation | null {
    return row === null
      ? null
      : {
          action: row.action,
          revision: row.revision,
          targetStatus: row.target_status,
          startedAt: row.started_at,
          attempts: row.attempts,
          lastError: row.last_error,
        };
  }

  async function listStatuses(workspaceId: string): Promise<WorkspaceModuleStatus[]> {
    const [rows, operations] = await Promise.all([
      listWorkspaceModuleRows(deps.db, workspaceId),
      listWorkspaceModuleOperations(deps.db, workspaceId),
    ]);
    const rowById = new Map(rows.map((row) => [row.module_id, row]));
    const operationById = new Map(operations.map((row) => [row.module_id, row]));
    // 只返回**注册表里存在**的模块：数据库里不属于任何已注册模块的残留行不对外暴露，
    // 避免把未注册的 ID 呈现成「用户可管理的模块」。
    return deps.registry.list().map((module) =>
      toWorkspaceModuleStatus(
        module.manifest.id,
        rowById.get(module.manifest.id) ?? null,
        operationById.get(module.manifest.id) ?? null,
      ),
    );
  }

  async function readStatus(workspaceId: string, moduleId: string): Promise<WorkspaceModuleStatus> {
    if (deps.registry.get(moduleId) === undefined) {
      return toWorkspaceModuleStatus(moduleId, null);
    }
    const [row, pendingRow] = await Promise.all([
      readWorkspaceModuleRow(deps.db, workspaceId, moduleId),
      readWorkspaceModuleOperation(deps.db, workspaceId, moduleId),
    ]);
    return toWorkspaceModuleStatus(moduleId, row, pendingRow);
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
    // 清数据在任何状态下都被显式拒绝，因此这个判断必须最先做。
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

    const row: WorkspaceModuleRow | null = await readWorkspaceModuleRow(deps.db, input.workspaceId, input.moduleId);
    const pendingRow: WorkspaceModuleOperationRow | null = await readWorkspaceModuleOperation(
      deps.db,
      input.workspaceId,
      input.moduleId,
    );
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
      const resumeTimestamp = now();
      await beginAttempt({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        admissionRevision: pendingRow.revision,
        resume: true,
      });
      const sideEffects = await runSideEffects({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        module,
        action: pendingRow.action,
        targetStatus: pendingRow.target_status,
        timestamp: resumeTimestamp,
        admissionRevision: pendingRow.revision,
      });
      if (sideEffects.failure !== null) {
        await recordFailure({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          admissionRevision: pendingRow.revision,
          failure: sideEffects.failure,
        });
        return await buildOutcome({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          action: pendingRow.action,
          resume: true,
          changed: false,
          settingsChanged: false,
          sideEffects,
          timestamp: resumeTimestamp,
        });
      }
      const completed = await completeAdmission({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        admissionRevision: pendingRow.revision,
      });
      return await buildOutcome({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        action: pendingRow.action,
        resume: true,
        changed: completed,
        settingsChanged: false,
        sideEffects,
        timestamp: resumeTimestamp,
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
        module: toWorkspaceModuleStatus(input.moduleId, row, null),
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
            targetStatus: row?.status ?? 'disabled',
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
        sideEffects: { handlersRun: [], instancesRemoved: 0, scheduledTasksCancelled: 0, failure: null },
        timestamp,
      });
    }

    // ── 阶段 1：原子准入（条件 CAS 提交状态 **并** 写入待完成标记，同一事务）──
    const targetStatus = nextStatus ?? targetStatusOf(action ?? 'enable');
    const stamps = timestampsFor(targetStatus, timestamp);
    const admissionRevision = currentRevision + 1;
    try {
      let casChanges: number;
      if (row === null) {
        const results = await deps.db.batch([
          deps.db
            .prepare(
              `INSERT INTO workspace_modules (
                 workspace_id, module_id, status, settings_json, settings_version, revision,
                 installed_at, enabled_at, disabled_at, uninstalled_at, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
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
        ]);
        casChanges = results[0]?.meta.changes ?? 0;
      } else {
        const results = await deps.db.batch([
          deps.db
            .prepare(
              `UPDATE workspace_modules
                  SET status = ?, settings_json = ?, settings_version = ?, revision = revision + 1,
                      enabled_at = ?, disabled_at = ?, uninstalled_at = ?, updated_at = ?
                WHERE workspace_id = ? AND module_id = ? AND revision = ?`,
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
        ]);
        casChanges = results[0]?.meta.changes ?? 0;
      }
      if (casChanges !== 1) {
        // **抢输：在任何一个可变副作用之前退出。**
        return {
          ok: false,
          reason: 'revision_conflict',
          detail: '并发写入：revision 已被其他请求改变，本次修改未提交（未执行任何副作用）',
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'persist_failed',
        detail: `写入模块状态失败（${errorNameOf(error)}）；未执行任何副作用`,
      };
    }

    // ── 阶段 2：副作用（状态已提交，失败则保留待完成标记等待重试）────────────
    const resolveAction: ModuleSupportedAction = action ?? 'enable';
    const sideEffects = await runSideEffects({
      workspaceId: input.workspaceId,
      moduleId: input.moduleId,
      module,
      action: resolveAction,
      targetStatus,
      timestamp,
      admissionRevision,
    });
    if (sideEffects.failure !== null) {
      await recordFailure({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        admissionRevision,
        failure: sideEffects.failure,
      });
      return await buildOutcome({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        action,
        resume: false,
        changed: true,
        settingsChanged,
        sideEffects,
        timestamp,
      });
    }

    // ── 阶段 3：收尾 ────────────────────────────────────────────────────────
    await completeAdmission({
      workspaceId: input.workspaceId,
      moduleId: input.moduleId,
      admissionRevision,
    });
    return await buildOutcome({
      workspaceId: input.workspaceId,
      moduleId: input.moduleId,
      action,
      resume: false,
      changed: true,
      settingsChanged,
      sideEffects,
      timestamp,
    });
  }

  return {
    listStatuses,
    readStatus,
    gateStatus: (workspaceId, moduleId) => readModuleGateStatus(deps.db, workspaceId, moduleId),
    mutate,
  };
}
