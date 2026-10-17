/**
 * Module / Widget 契约（规划 4.3、2.3）——阶段 01 只定义**静态契约**，不实现运行时。
 *
 * 明确边界（INV-02 / INV-03 / INV-12）：
 * - 阶段 01 不实现 Module Registry 运行时、不实现 Widget Host、不实现导航与鱼王逻辑。
 * - 这里的 Schema 是阶段 02（HUB-043/044/050）必须满足的接口，先固定形状以免后续重构前端。
 * - Widget 一律通过**静态注册表**映射到可执行组件；**禁止**根据不可信字符串动态执行远程 JS。
 * - 模块生命周期动作的语义差异（隐藏 / 移除 / 停用 / 卸载 / 清数据）必须按 MODULE_OPERATION_SEMANTICS
 *   执行，不得混为一谈（规划规则 7）。
 */
import { z } from 'zod';

/** 稳定唯一模块 ID，例如 ff14.fishing、ff14.navigation。 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
/** Widget 类型 ID，例如 fish-next-windows。 */
export const WIDGET_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** 语义版本。 */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 能力白名单。模块 Manifest 里声明的 capabilities 必须落在该集合内，
 * 未在白名单中的能力不得被授予（默认拒绝）。
 */
export const MODULE_CAPABILITIES = [
  'storage:own', // 读写模块自己的表
  'scheduled:own', // 注册自己的后台任务
  'notifications:push', // 请求发送 Web Push
  'navigation:read-catalog', // 读取系统推荐导航目录
  'network:external', // 访问声明过的外部数据源（仍需 Adapter 审查）
] as const;
export type ModuleCapability = (typeof MODULE_CAPABILITIES)[number];

const gridSizeSchema = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

export const widgetDefinitionSchema = z
  .object({
    id: z.string().regex(WIDGET_ID_PATTERN),
    moduleId: z.string().regex(MODULE_ID_PATTERN),
    displayName: z.string().min(1).max(80),
    allowMultiple: z.boolean(),
    defaultSize: gridSizeSchema,
    minSize: gridSizeSchema,
    maxSize: gridSizeSchema.optional(),
    configSchemaVersion: z.number().int().nonnegative(),
  })
  .refine(
    (widget) => widget.minSize.w <= widget.defaultSize.w && widget.minSize.h <= widget.defaultSize.h,
    { message: 'minSize 不得大于 defaultSize' },
  )
  .refine(
    (widget) =>
      widget.maxSize === undefined ||
      (widget.maxSize.w >= widget.defaultSize.w && widget.maxSize.h >= widget.defaultSize.h),
    { message: 'maxSize 不得小于 defaultSize' },
  );

export type WidgetDefinition = z.infer<typeof widgetDefinitionSchema>;

export const moduleRouteSchema = z.object({
  path: z.string().startsWith('/'),
  viewId: z.string().min(1),
});

export const moduleManifestSchema = z
  .object({
    id: z.string().regex(MODULE_ID_PATTERN),
    version: z.string().regex(SEMVER_PATTERN),
    displayName: z.string().min(1).max(80),
    capabilities: z.array(z.enum(MODULE_CAPABILITIES)).max(MODULE_CAPABILITIES.length),
    widgets: z.array(widgetDefinitionSchema),
    routes: z.array(moduleRouteSchema).optional(),
    settingsSchemaVersion: z.number().int().nonnegative(),
    lifecycle: z.object({
      // 仅允许引用静态注册表中的处理器名，禁止内联代码或远程地址。
      onEnable: z.string().min(1).optional(),
      onDisable: z.string().min(1).optional(),
      onUninstall: z.string().min(1).optional(),
    }),
  })
  .superRefine((manifest, ctx) => {
    const seenWidgetIds = new Set<string>();
    for (const widget of manifest.widgets) {
      if (widget.moduleId !== manifest.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['widgets'],
          message: `Widget ${widget.id} 的 moduleId 必须等于所属 Module 的 id`,
        });
      }
      if (seenWidgetIds.has(widget.id)) {
        ctx.addIssue({ code: 'custom', path: ['widgets'], message: `Widget id 重复：${widget.id}` });
      }
      seenWidgetIds.add(widget.id);
    }
  });

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

export type ManifestValidation =
  | { readonly ok: true; readonly manifest: ModuleManifest }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * 校验 Manifest。返回结构化问题列表而不是抛异常，便于 Registry 汇总诊断。
 * 未知 capability 会被 Schema 直接拒绝（默认拒绝，而非静默忽略）。
 */
export function validateModuleManifest(input: unknown): ManifestValidation {
  const parsed = moduleManifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
  };
}

/**
 * 模块生命周期操作语义表（规划 4.3）。
 * 这张表是硬约束：实现阶段 02/03 时，任何一种操作都不得越界影响其他两列。
 */
export const MODULE_OPERATION_SEMANTICS = {
  hideWidget: { affectsPage: '隐藏该 Widget 实例', affectsBackground: false, affectsUserData: false },
  removeWidget: { affectsPage: '移除当前页面的该实例', affectsBackground: false, affectsUserData: false },
  disableModule: { affectsPage: '隐藏或禁用其组件与入口', affectsBackground: true, affectsUserData: false },
  uninstallModule: { affectsPage: '移除该模块全部 Widget 实例并停用', affectsBackground: true, affectsUserData: false },
  purgeModuleData: { affectsPage: '不受影响', affectsBackground: false, affectsUserData: true },
} as const;

export type ModuleOperation = keyof typeof MODULE_OPERATION_SEMANTICS;

/** 布局断点（规划 ADR-010：桌面/平板/手机各自独立修订）。 */
export const LAYOUT_BREAKPOINTS = ['desktop', 'tablet', 'mobile'] as const;
export type LayoutBreakpoint = (typeof LAYOUT_BREAKPOINTS)[number];

/** 各断点网格列数基线（规划 9.1）。 */
export const BREAKPOINT_COLUMNS: Readonly<Record<LayoutBreakpoint, number>> = {
  desktop: 12,
  tablet: 8,
  mobile: 4,
};
