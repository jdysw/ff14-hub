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
 * 因此：卸载 ≠ 清数据。本服务里不存在任何 DELETE 数据行的路径，
 * 卸载只写 `status = 'uninstalled'`，`settings_json` 原样保留。
 *
 * 执行顺序（刻意固定，且被测试断言）：
 *   1. 校验（模块已注册、动作合法、settings 合法、版本一致、expectedRevision 匹配）
 *   2. 模块自己的生命周期 handler（静态表里的函数）
 *   3. 平台级副作用：移除当前 Host 实例、取消已排队任务（真实计数）
 *   4. 条件写库（`WHERE revision = ?`）提交新状态
 *
 * 为什么是这个顺序：
 * - 第 2 步失败 → 什么都不落库，状态不变，重试安全（要求 handler 自身幂等）。
 * - 第 3 步失败 → 同上：已执行的 handler 必须幂等，重试后仍收敛到同一结果。
 * - 第 4 步失败（并发抢输）→ 返回 409；此时第 2/3 步的副作用已经发生，
 *   但它们都是「暂停/移除」这类幂等操作，且抢赢的那次也会做同样的事，
 *   所以最终状态一致，客户端只需带着新 revision 重试。
 * - 反过来（先落库再执行副作用）会产生「状态说已卸载，但实例还在」的窗口，因此不采用。
 */
import {
  MODULE_SETTINGS_MAX_BYTES,
  type ModuleEffectiveStatus,
  type ModuleMutationEffect,
  type ModuleMutationRequest,
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
import {
  listWorkspaceModuleRows,
  parseStoredSettings,
  readWorkspaceModuleRow,
  toWorkspaceModuleStatus,
  type WorkspaceModuleRow,
} from './workspace-modules';

/** 变更被拒绝（或技术性失败）的原因。路由层把它映射成错误码，服务层不关心 HTTP。 */
export type MutationRejection =
  | 'module_unknown'
  | 'purge_unsupported'
  | 'status_conflict'
  | 'revision_conflict'
  | 'settings_invalid'
  | 'settings_version_mismatch'
  | 'settings_too_large'
  | 'handler_failed'
  | 'side_effect_failed'
  | 'persist_failed';

export type MutationOutcome =
  | { readonly ok: true; readonly module: WorkspaceModuleStatus; readonly effect: ModuleMutationEffect }
  | { readonly ok: false; readonly reason: MutationRejection; readonly detail: string };

export interface ModuleLifecycle {
  listStatuses(workspaceId: string): Promise<WorkspaceModuleStatus[]>;
  readStatus(workspaceId: string, moduleId: string): Promise<WorkspaceModuleStatus>;
  mutate(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly request: ModuleMutationRequest;
  }): Promise<MutationOutcome>;
}

export interface ModuleLifecycleDeps {
  readonly db: D1Database;
  readonly registry: ModuleRegistry;
  readonly instanceStore: ModuleInstanceStore;
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

function describeAction(
  action: ModuleSupportedAction | undefined,
  changed: boolean,
  settingsChanged: boolean,
  effect: { readonly instancesRemoved: number; readonly scheduledTasksCancelled: number },
): string {
  if (!changed) {
    return action === undefined ? '模块设置没有变化，未写入。' : '模块状态与设置都没有变化，未写入。';
  }
  const base = ((): string => {
    switch (action) {
      case 'enable':
        return '模块已启用。';
      case 'restore':
        return '模块已恢复启用，沿用原有设置与个人数据。';
      case 'disable':
        return `模块已停用：后台行为暂停（取消 ${effect.scheduledTasksCancelled} 项待执行任务），个人数据与设置保留。`;
      case 'uninstall':
        return (
          `模块已卸载：移除 ${effect.instancesRemoved} 个当前实例、取消 ${effect.scheduledTasksCancelled} 项待执行任务；` +
          '个人数据与设置保留，可随时恢复。'
        );
      case undefined:
        return '模块设置已保存。';
    }
  })();
  return settingsChanged && action !== undefined ? `${base} 模块设置也已更新。` : base;
}

function settingsBytes(settings: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(settings)).length;
}

export function createModuleLifecycle(deps: ModuleLifecycleDeps): ModuleLifecycle {
  const now = deps.now ?? ((): number => Date.now());

  function notInstalledStatus(moduleId: string): WorkspaceModuleStatus {
    return toWorkspaceModuleStatus(moduleId, null);
  }

  async function listStatuses(workspaceId: string): Promise<WorkspaceModuleStatus[]> {
    const rows = await listWorkspaceModuleRows(deps.db, workspaceId);
    const byId = new Map(rows.map((row) => [row.module_id, row]));
    // 只返回**注册表里存在**的模块：数据库里不属于任何已注册模块的残留行不对外暴露，
    // 避免把未注册的 ID 呈现成「用户可管理的模块」。
    return deps.registry.list().map((module) => {
      const row = byId.get(module.manifest.id);
      return toWorkspaceModuleStatus(module.manifest.id, row ?? null);
    });
  }

  async function readStatus(workspaceId: string, moduleId: string): Promise<WorkspaceModuleStatus> {
    if (deps.registry.get(moduleId) === undefined) {
      return notInstalledStatus(moduleId);
    }
    const row = await readWorkspaceModuleRow(deps.db, workspaceId, moduleId);
    return toWorkspaceModuleStatus(moduleId, row);
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

    // 1) 校验：本阶段显式拒绝清数据。
    if (request.action === 'purge') {
      return {
        ok: false,
        reason: 'purge_unsupported',
        detail: 'purge 在本阶段被显式拒绝：清数据需要先备份并二次确认，且与卸载是不同语义。',
      };
    }
    const action: ModuleSupportedAction | undefined = request.action;

    // 2) 校验：设置版本与设置内容（服务端 Schema 是唯一权威）。
    if (request.settingsVersion !== undefined && request.settingsVersion !== module.settingsSchemaVersion) {
      return {
        ok: false,
        reason: 'settings_version_mismatch',
        detail: `设置版本不匹配：客户端 ${request.settingsVersion}，当前 ${module.settingsSchemaVersion}`,
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

    // 3) 读取当前状态并做乐观并发检查。
    const row: WorkspaceModuleRow | null = await readWorkspaceModuleRow(deps.db, input.workspaceId, input.moduleId);
    const currentStatus: ModuleEffectiveStatus = row === null ? 'not_installed' : row.status;
    const currentRevision = row?.revision ?? 0;
    if (request.expectedRevision !== currentRevision) {
      return {
        ok: false,
        reason: 'revision_conflict',
        detail: `revision 不匹配：客户端 ${request.expectedRevision}，当前 ${currentRevision}`,
      };
    }
    if (action === undefined && row === null) {
      return {
        ok: false,
        reason: 'status_conflict',
        detail: '模块尚未安装，不能只写设置；请先执行 enable。',
      };
    }

    // 4) 计算目标状态与目标设置。
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
        module: toWorkspaceModuleStatus(input.moduleId, row),
        effect: {
          changed: false,
          instancesRemoved: 0,
          scheduledTasksCancelled: 0,
          handlersRun: [],
          userDataRetained: true,
          message: describeAction(action, false, false, { instancesRemoved: 0, scheduledTasksCancelled: 0 }),
        },
      };
    }

    const timestamp = now();
    // 目标状态：要么本次有状态迁移，要么沿用已有行（只改设置）。两者都不成立属于内部不一致。
    let targetStatus: ModulePersistedStatus;
    if (nextStatus !== undefined) {
      targetStatus = nextStatus;
    } else if (row !== null) {
      targetStatus = row.status;
    } else {
      return { ok: false, reason: 'status_conflict', detail: '内部状态不一致：缺少目标状态' };
    }
    const handlersRun: string[] = [];
    let instancesRemoved = 0;
    let scheduledTasksCancelled = 0;

    // 5) 模块自己的 handler（只拿得到受限上下文）。
    if (statusChanged && action !== undefined) {
      const handlerName = handlerNameFor(module, action);
      if (handlerName !== undefined) {
        const handler = module.handlers[handlerName];
        if (typeof handler !== 'function') {
          // 注册表保证存在；走到这里说明内存中的注册表被人为改坏。
          return { ok: false, reason: 'handler_failed', detail: `handler 缺失：${handlerName}` };
        }
        const context: ModuleLifecycleContext = {
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          now: timestamp,
          services: { scheduler: deps.scheduler },
        };
        try {
          await handler(context);
        } catch (error) {
          return {
            ok: false,
            reason: 'handler_failed',
            detail: `生命周期 handler 失败：${handlerName}（${error instanceof Error ? error.name : 'UnknownError'}）`,
          };
        }
        handlersRun.push(handlerName);
      }
    }

    // 6) 平台级副作用：真实计数，且必须在写库之前完成。
    try {
      if (targetStatus === 'uninstalled' && statusChanged) {
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
      } else if (targetStatus === 'disabled' && statusChanged) {
        const cancelled = await deps.scheduler.cancelAllForModule({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          reason: 'module_disabled',
        });
        scheduledTasksCancelled = cancelled.cancelled;
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'side_effect_failed',
        detail: `生命周期副作用失败（${error instanceof Error ? error.name : 'UnknownError'}）`,
      };
    }

    // 7) 条件写库（防静默覆盖）。
    const stamps = timestampsFor(targetStatus, timestamp);
    const settingsJson = JSON.stringify(nextSettings);
    try {
      if (row === null) {
        const inserted = await deps.db
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
          )
          .run();
        if ((inserted.meta.changes ?? 0) !== 1) {
          return {
            ok: false,
            reason: 'revision_conflict',
            detail: '并发写入：该模块状态已被另一个请求创建',
          };
        }
      } else {
        const updated = await deps.db
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
          )
          .run();
        if ((updated.meta.changes ?? 0) !== 1) {
          return {
            ok: false,
            reason: 'revision_conflict',
            detail: '并发写入：revision 已被其他请求改变，本次修改未提交',
          };
        }
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'persist_failed',
        detail: `写入模块状态失败（${error instanceof Error ? error.name : 'UnknownError'}）`,
      };
    }

    const refreshed = await readWorkspaceModuleRow(deps.db, input.workspaceId, input.moduleId);
    const effectCounts = { instancesRemoved, scheduledTasksCancelled };
    return {
      ok: true,
      module: toWorkspaceModuleStatus(input.moduleId, refreshed),
      effect: {
        changed: true,
        instancesRemoved,
        scheduledTasksCancelled,
        handlersRun,
        userDataRetained: true,
        message: describeAction(action, true, settingsChanged, effectCounts),
      },
    };
  }

  return { listStatuses, readStatus, mutate };
}
