/**
 * 模块运行时契约（HUB-043 Module Registry / HUB-044 Widget Host / HUB-050 生命周期）。
 *
 * 边界声明（与 docs/module-widget-boundaries.md 一致）：
 * - 本文件与 `./module-manifest.ts` 一样只放**纯契约**：无 React、无 DOM、无 D1。
 *   可执行组件映射是**前端静态表**（apps/web/src/app/widgets/component-registry.ts），
 *   生命周期 handler 映射是**服务端静态表**（worker/modules/registry/builtin-modules.ts）。
 *   两者都不在这里，也都不允许按不可信字符串动态加载或执行远程 JS。
 * - 「声明能力」不等于「被授权」：Manifest 里写的能力必须同时落在
 *   `MODULE_CAPABILITIES` 白名单与注册表的授予集合内，否则注册失败（默认拒绝）。
 * - 「卸载」不等于「清数据」：`uninstall` 只移除当前 Host 实例并停止行为，
 *   个人数据与设置默认保留，可再次 `restore`。清数据（purge）在本阶段**显式拒绝**。
 */
import { z } from 'zod';
import { MODULE_CAPABILITIES, moduleRouteSchema, widgetDefinitionSchema } from './module-manifest';

/**
 * 数据库中真实存在的模块状态（`workspace_modules.status`，受 CHECK 约束）。
 * 刻意与「有效状态」分开：没有行 ≠ 有一行写着某个状态。
 */
export const MODULE_PERSISTED_STATUSES = ['enabled', 'disabled', 'uninstalled'] as const;
export type ModulePersistedStatus = (typeof MODULE_PERSISTED_STATUSES)[number];

/**
 * 对外暴露的**有效状态**。
 * `not_installed` 是派生值：`workspace_modules` 中还没有该模块的行时才有意义，
 * 因此它**永远不会**被写进数据库（CHECK 约束会拒绝）。
 */
export const MODULE_EFFECTIVE_STATUSES = ['not_installed', ...MODULE_PERSISTED_STATUSES] as const;
export type ModuleEffectiveStatus = (typeof MODULE_EFFECTIVE_STATUSES)[number];

export const modulePersistedStatusSchema = z.enum(MODULE_PERSISTED_STATUSES);
export const moduleEffectiveStatusSchema = z.enum(MODULE_EFFECTIVE_STATUSES);

/** 本阶段支持的生命周期动作。 */
export const MODULE_SUPPORTED_ACTIONS = ['enable', 'disable', 'uninstall', 'restore'] as const;
/** 已知但本阶段**显式拒绝**的动作：清数据必须与卸载分离，且需要备份 + 二次确认。 */
export const MODULE_UNSUPPORTED_ACTIONS = ['purge'] as const;
export const MODULE_ACTIONS = [...MODULE_SUPPORTED_ACTIONS, ...MODULE_UNSUPPORTED_ACTIONS] as const;

export const moduleActionSchema = z.enum(MODULE_ACTIONS);
export type ModuleAction = (typeof MODULE_ACTIONS)[number];
export type ModuleSupportedAction = (typeof MODULE_SUPPORTED_ACTIONS)[number];

/**
 * **门禁状态**：所有「这个模块现在能不能跑」的判断都必须用它。
 *
 * 它比「有效状态」多一个 `transitioning`：当 `workspace_module_operations` 里还有一条
 * 待完成的准入操作时，即便已提交的状态是 `enabled`，也**不得**执行组件、不得排入后台任务——
 * 因为该操作的清理/初始化副作用还没结束，或已经失败等待重试。
 *
 * 这个派生只允许有一处实现（`moduleGateStatus()`），服务端调度门禁与前端 Host 共用它。
 */
export const MODULE_GATE_STATUSES = [
  'not_installed',
  'enabled',
  'disabled',
  'uninstalled',
  'transitioning',
] as const;
export type ModuleGateStatus = (typeof MODULE_GATE_STATUSES)[number];
export const moduleGateStatusSchema = z.enum(MODULE_GATE_STATUSES);

/** 中文状态标签（前端与测试共用同一份，避免各处各写一遍）。 */
export const MODULE_STATUS_LABELS: Readonly<Record<ModuleGateStatus, string>> = {
  not_installed: '未安装',
  enabled: '已启用',
  disabled: '已停用',
  uninstalled: '已卸载',
  transitioning: '正在完成操作',
};

/** 状态标签 → 短说明，用于模块管理界面的可见文案。 */
export const MODULE_STATUS_HINTS: Readonly<Record<ModuleGateStatus, string>> = {
  not_installed: '尚未在本工作空间启用。',
  enabled: '组件可用，后台行为可运行。',
  disabled: '组件与入口停用，后台行为暂停；个人数据与设置保留。',
  uninstalled: '组件实例已移除、后台行为停止；个人数据与设置保留，可恢复。',
  transitioning: '上一个启停/卸载操作的状态已提交，但清理或初始化尚未完成（或已失败）。模块暂停执行，可重试完成。',
};

/** 判定任意字符串是否为可持久化状态。 */
export function isPersistedModuleStatus(value: string): value is ModulePersistedStatus {
  return (MODULE_PERSISTED_STATUSES as readonly string[]).includes(value);
}

/** 行缺失 → not_installed；有行 → 该行的状态。这是唯一的「有效状态」推导入口。 */
export function effectiveModuleStatus(status: ModulePersistedStatus | null | undefined): ModuleEffectiveStatus {
  return status ?? 'not_installed';
}

/**
 * 有效状态 + 待完成操作 → **门禁状态**。
 * 唯一的实现：只要存在待完成操作，就不允许执行/排程（`transitioning`）。
 */
export function moduleGateStatus(
  status: ModuleEffectiveStatus,
  pending: ModulePendingOperation | null | undefined,
): ModuleGateStatus {
  return moduleGateStatusFromPresence(status, pending !== null && pending !== undefined);
}

/**
 * 同上，但以「是否存在待完成操作」的布尔值表达。
 * 服务端在 SQL 里只查「有没有这一行」，用这个入口可以避免把整行拼成对象。
 */
export function moduleGateStatusFromPresence(status: ModuleEffectiveStatus, hasPending: boolean): ModuleGateStatus {
  return hasPending ? 'transitioning' : status;
}

/** 模块设置（settings_json）的字节上限，避免把 D1 行写成无限大的 JSON 垃圾桶。 */
export const MODULE_SETTINGS_MAX_BYTES = 8 * 1024;

/**
 * 公开目录里的 Widget 描述。
 * 直接复用 Manifest 里的 Widget 定义，因此目录与 Manifest 不可能漂移。
 */
export const moduleWidgetDescriptorSchema = widgetDefinitionSchema;
export type ModuleWidgetDescriptor = z.infer<typeof moduleWidgetDescriptorSchema>;

/**
 * 公开模块目录条目（GET /api/v1/modules/catalog，匿名可读）。
 * 只包含非敏感元数据：模块 ID、版本、展示名、能力、Widget 定义、路由与设置版本。
 * **不含**生命周期 handler 名——那是服务端内部注册细节，不进公开响应。
 */
export const moduleDescriptorSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  /** Manifest 里声明使用的能力（⊆ 授予集合 ⊆ 白名单，由注册表在启动期保证）。 */
  capabilities: z.array(z.enum(MODULE_CAPABILITIES)),
  widgets: z.array(moduleWidgetDescriptorSchema),
  routes: z.array(moduleRouteSchema),
  settingsSchemaVersion: z.number().int().nonnegative(),
});

export type ModuleDescriptor = z.infer<typeof moduleDescriptorSchema>;

export const moduleCatalogResponseSchema = z.object({
  modules: z.array(moduleDescriptorSchema),
});

export type ModuleCatalogResponse = z.infer<typeof moduleCatalogResponseSchema>;

/**
 * 待完成的模块操作（`workspace_module_operations`，migration 0004）。
 *
 * 为什么需要这个持久事实：生命周期变更采用「**先原子准入提交状态，再执行副作用**」。
 * 状态一旦提交，副作用（模块 handler、实例清理、任务取消）就可能失败或被打断，
 * 因此必须有持久记录说明「这一次操作还没做完、失败原因是什么、重试到第几次」。
 * 幂等重试（同一 action + 同一 expectedRevision）会**继续**完成它。
 *
 * 注意：`status` 仍是已提交的目标状态；待完成操作存在时，门禁状态是 `transitioning`，
 * 因此「待完成」不会被误当成「可以运行」。
 */
export const modulePendingOperationSchema = z.object({
  /** 正在完成的操作。 */
  action: z.enum(MODULE_SUPPORTED_ACTIONS),
  /** 本次准入对应的 revision（幂等重试的判定依据之一）。 */
  revision: z.number().int().positive(),
  /** 准入时提交的目标状态（也就是当前 `status`）。 */
  targetStatus: modulePersistedStatusSchema,
  startedAt: z.number().int().nonnegative(),
  /** 已尝试次数（含首次准入）。 */
  attempts: z.number().int().nonnegative(),
  /** 最近一次副作用失败原因（面向用户、已脱敏）；成功过则为 null。无敏感值。 */
  lastError: z.string().nullable(),
});

export type ModulePendingOperation = z.infer<typeof modulePendingOperationSchema>;

/**
 * 当前工作空间的单个模块状态（GET /api/v1/me/modules）。
 * `status` 是**有效状态**；`revision` 是乐观并发用的单调修订号；行不存在时为 0。
 */
export const workspaceModuleStatusSchema = z.object({
  moduleId: z.string().min(1),
  status: moduleEffectiveStatusSchema,
  /** 已校验并持久化的模块设置；未安装时为空对象。 */
  settings: z.record(z.string(), z.unknown()),
  /** 该设置当前对应的 Settings Schema 版本（等于 Manifest.settingsSchemaVersion）。 */
  settingsVersion: z.number().int().nonnegative(),
  /** 乐观并发修订号；`not_installed` 时为 0。 */
  revision: z.number().int().nonnegative(),
  installedAt: z.number().int().nonnegative().nullable(),
  enabledAt: z.number().int().nonnegative().nullable(),
  disabledAt: z.number().int().nonnegative().nullable(),
  uninstalledAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative().nullable(),
  /** 非 null 表示有一次已提交但尚未完成（或失败待重试）的生命周期操作。 */
  pendingOperation: modulePendingOperationSchema.nullable(),
});

export type WorkspaceModuleStatus = z.infer<typeof workspaceModuleStatusSchema>;

export const myModulesResponseSchema = z.object({
  modules: z.array(workspaceModuleStatusSchema),
});

export type MyModulesResponse = z.infer<typeof myModulesResponseSchema>;

/** 单个模块状态的响应（GET /api/v1/me/modules/:id）。 */
export const workspaceModuleStatusResponseSchema = z.object({
  module: workspaceModuleStatusSchema,
});

export type WorkspaceModuleStatusResponse = z.infer<typeof workspaceModuleStatusResponseSchema>;

/** purge 被拒绝时对外的可读原因（安全前提：说清「没有删除任何数据」）。 */
export const PURGE_UNSUPPORTED_MESSAGE =
  '本阶段不支持清除模块数据（purge）。清除数据与卸载是两种不同语义，且必须先在服务端完成备份并由用户作二次确认；' +
  '本次请求没有删除任何数据，模块状态与个人数据均保持不变。';

/**
 * 生命周期变更请求（PATCH /api/v1/me/modules/:id）。
 *
 * - `expectedRevision` 必填：服务端据此做条件更新，**防止静默覆盖**并发修改。
 *   首次变更（还没有行）时有效 revision 为 0。
 * - `settings` 与 `action` 至少给一个。
 * - `settingsVersion` 给出时必须与当前 Settings Schema 版本一致，否则 409。
 */
export const moduleMutationRequestSchema = z
  .object({
    action: moduleActionSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    settingsVersion: z.number().int().nonnegative().optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.action !== undefined || value.settings !== undefined, {
    message: '至少要提供 action 或 settings 其中之一',
  });

export type ModuleMutationRequest = z.infer<typeof moduleMutationRequestSchema>;

/**
 * 本次生命周期操作实际发生的副作用，用于让客户端**看见**语义差异：
 * 卸载会移除实例、停止后台任务，但 `userDataRetained` 恒为 true —— 个人数据与设置没有被删。
 * 清数据（purge）在本阶段被显式拒绝，因此不存在任何会让它为 false 的路径。
 *
 * `pending` / `failure` 是**诚实性**字段：
 * 状态在准入阶段就已经提交，因此即使副作用失败，也**不能**把它伪装成「什么也没发生」。
 * 此时返回 200 + `pending: true` + 已提交的新状态 + `failure` 原因，
 * 客户端据此展示「待重试」，并在同 action 下幂等重试以完成清理。
 */
export const moduleMutationEffectSchema = z.object({
  /** 本次请求是否写入了新的状态（含待完成标记的写入与清除）。 */
  changed: z.boolean(),
  /** 本次实际移除的当前 Host 实例数。 */
  instancesRemoved: z.number().int().nonnegative(),
  /** 本次实际取消的后台任务数。 */
  scheduledTasksCancelled: z.number().int().nonnegative(),
  /** 本次实际执行的静态 handler 名。 */
  handlersRun: z.array(z.string().min(1)),
  /** 契约级保证：生命周期操作不删除个人数据与设置。 */
  userDataRetained: z.literal(true),
  /** 状态已提交但副作用尚未完成（等待幂等重试）。 */
  pending: z.boolean(),
  /** 副作用未完成的原因（已脱敏、可展示）；无失败则为 null。 */
  failure: z.string().nullable(),
  /** 面向用户的中文说明。 */
  message: z.string().min(1),
});

export type ModuleMutationEffect = z.infer<typeof moduleMutationEffectSchema>;

/** 变更成功后的响应体：最新模块状态 + 本次副作用。 */
export const moduleMutationResponseSchema = z.object({
  module: workspaceModuleStatusSchema,
  effect: moduleMutationEffectSchema,
});

export type ModuleMutationResponse = z.infer<typeof moduleMutationResponseSchema>;
