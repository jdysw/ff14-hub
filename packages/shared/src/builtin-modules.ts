/**
 * 内置**演示模块**与 Widget 配置契约（阶段 02 验收用）。
 *
 * 重要声明：这里的模块与组件**没有任何游戏业务语义**，名字一律以 `demo.` 前缀标注，
 * 不得被当成真实鱼类 / 活动 / 导航数据。它们的唯一目的是证明：
 *   多实例配置互不串扰、加载/空/错误态、配置版本迁移、错误隔离、模块启停联动。
 * 真实业务模块（ff14.fishing / ff14.navigation 等）属于阶段 04–05。
 *
 * 与「可执行组件」的边界：
 * - 本文件只放**纯契约**（Manifest 常量 + Zod 配置 Schema + 显式迁移函数），无 React、无 DOM、无 D1。
 * - 真正渲染这些组件的 React 映射在 apps/web/src/app/widgets/component-registry.ts。
 * - 服务端生命周期 handler 映射在 worker/modules/registry/builtin-modules.ts。
 *   三者都不允许按不可信字符串动态加载或执行远程 JS。
 */
import { z } from 'zod';
import type { ModuleManifest } from './module-manifest';

/** 演示模块 ID（`demo.` 前缀即「非游戏业务」的可见标记）。 */
export const DEMO_BASICS_MODULE_ID = 'demo.basics';
export const DEMO_SOLO_MODULE_ID = 'demo.solo';

/** 演示 Widget 类型 ID。 */
export const DEMO_WIDGET_IDS = {
  counter: 'demo-counter',
  fault: 'demo-fault',
  solo: 'demo-solo',
} as const;

export type DemoWidgetId = (typeof DEMO_WIDGET_IDS)[keyof typeof DEMO_WIDGET_IDS];

/**
 * 失效演示组件的可选模式（`demo-fault`）。
 * 这些模式是**故意**制造错误/空态的手段，用来证明错误隔离与状态卡片是真的生效。
 */
export const DEMO_FAULT_MODES = ['none', 'empty', 'render-error', 'async-error'] as const;
export type DemoFaultMode = (typeof DEMO_FAULT_MODES)[number];

/** 单个 Widget 类型的配置契约：客户端据此校验、迁移并渲染实例配置。 */
export interface WidgetConfigContract {
  readonly widgetId: string;
  /** 必须与 Manifest 中同名 Widget 的 `configSchemaVersion` 一致（有测试保证）。 */
  readonly configSchemaVersion: number;
  readonly schema: z.ZodType;
  /** 新建实例时使用的默认配置（必须能通过 schema 校验）。 */
  readonly defaultConfig: unknown;
  /**
   * 配置迁移表：键为「来源版本 N」，值为把 N 升到 N+1 的**显式**迁移函数。
   * 没有对应条目即表示「没有可用迁移」——Host 必须拒绝执行该实例，而不是猜。
   */
  readonly migrations: Readonly<Record<number, (raw: unknown) => unknown>>;
}

/** 便于迁移函数安全读取旧配置。 */
function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export const DEMO_COUNTER_CONFIG_VERSION = 1;
export const DEMO_FAULT_CONFIG_VERSION = 1;
export const DEMO_SOLO_CONFIG_VERSION = 1;

/** `demo-counter`：多实例演示，每个实例有独立步长与标签。 */
export const demoCounterConfigSchema = z
  .object({
    step: z.number().int().min(1).max(10).default(1),
    label: z.string().min(1).max(40).default('演示计数'),
    /** 用于观察加载态：模拟一段异步初始化。 */
    initDelayMs: z.number().int().min(0).max(2000).default(0),
  })
  .strict();

/** `demo-fault`：失效/空态演示。 */
export const demoFaultConfigSchema = z
  .object({
    mode: z.enum(DEMO_FAULT_MODES).default('none'),
    delayMs: z.number().int().min(0).max(2000).default(0),
  })
  .strict();

/** `demo-solo`：`allowMultiple: false` 的单例演示。 */
export const demoSoloConfigSchema = z
  .object({
    title: z.string().min(1).max(40).default('单例演示'),
  })
  .strict();

// 组件实现（apps/web）需要这些类型；集中在这里导出，避免各处重复 z.infer。
export type DemoCounterConfig = z.infer<typeof demoCounterConfigSchema>;
export type DemoFaultConfig = z.infer<typeof demoFaultConfigSchema>;
export type DemoSoloConfig = z.infer<typeof demoSoloConfigSchema>;

/** 全部内置 Widget 配置契约（前端静态映射与服务端 Manifest 的一致性基线）。 */
export const BUILTIN_WIDGET_CONFIG_CONTRACTS: readonly WidgetConfigContract[] = [
  {
    widgetId: DEMO_WIDGET_IDS.counter,
    configSchemaVersion: DEMO_COUNTER_CONFIG_VERSION,
    schema: demoCounterConfigSchema,
    defaultConfig: { step: 1, label: '演示计数', initDelayMs: 0 },
    migrations: {
      // 版本 0 的旧形状使用 `increment`；这是一次**显式**迁移，不做隐式猜测。
      0: (raw) => {
        const source = asRecord(raw);
        const legacy = source['increment'];
        return {
          step: typeof legacy === 'number' && Number.isInteger(legacy) && legacy >= 1 && legacy <= 10 ? legacy : 1,
          label: typeof source['label'] === 'string' && source['label'].length > 0 ? source['label'] : '演示计数',
          initDelayMs: 0,
        };
      },
    },
  },
  {
    widgetId: DEMO_WIDGET_IDS.fault,
    configSchemaVersion: DEMO_FAULT_CONFIG_VERSION,
    schema: demoFaultConfigSchema,
    defaultConfig: { mode: 'none', delayMs: 0 },
    migrations: {},
  },
  {
    widgetId: DEMO_WIDGET_IDS.solo,
    configSchemaVersion: DEMO_SOLO_CONFIG_VERSION,
    schema: demoSoloConfigSchema,
    defaultConfig: { title: '单例演示' },
    migrations: {},
  },
];

export function findWidgetConfigContract(widgetId: string): WidgetConfigContract | null {
  return BUILTIN_WIDGET_CONFIG_CONTRACTS.find((contract) => contract.widgetId === widgetId) ?? null;
}

/**
 * 内置演示模块 Manifest。
 * 这些常量会被 `worker/modules/registry` 用 Zod **真实校验**一遍后注册；
 * 校验失败即应用启动期失败，而不是「约定俗成」。
 */
export const BUILTIN_MODULE_MANIFESTS: readonly ModuleManifest[] = [
  {
    id: DEMO_BASICS_MODULE_ID,
    version: '1.0.0',
    displayName: '演示·基础组件集（无游戏业务语义）',
    // 演示模块刻意不申请任何能力：能力是权限面，不该为了演示而放宽。
    capabilities: [],
    widgets: [
      {
        id: DEMO_WIDGET_IDS.counter,
        moduleId: DEMO_BASICS_MODULE_ID,
        displayName: '演示计数（可多实例）',
        allowMultiple: true,
        defaultSize: { w: 4, h: 3 },
        minSize: { w: 2, h: 2 },
        configSchemaVersion: DEMO_COUNTER_CONFIG_VERSION,
      },
      {
        id: DEMO_WIDGET_IDS.fault,
        moduleId: DEMO_BASICS_MODULE_ID,
        displayName: '演示失效态（可多实例）',
        allowMultiple: true,
        defaultSize: { w: 4, h: 3 },
        minSize: { w: 2, h: 2 },
        configSchemaVersion: DEMO_FAULT_CONFIG_VERSION,
      },
    ],
    routes: [{ path: '/demo/basics', viewId: 'demo-basics' }],
    settingsSchemaVersion: 1,
    lifecycle: {
      // 只允许引用**静态注册表**中的 handler 名，禁止内联代码或远程地址。
      onEnable: 'demo.basics.enable',
      onDisable: 'demo.basics.disable',
      onUninstall: 'demo.basics.uninstall',
    },
  },
  {
    id: DEMO_SOLO_MODULE_ID,
    version: '1.0.0',
    displayName: '演示·单例组件（无游戏业务语义）',
    capabilities: [],
    widgets: [
      {
        id: DEMO_WIDGET_IDS.solo,
        moduleId: DEMO_SOLO_MODULE_ID,
        displayName: '演示单例（allowMultiple=false）',
        allowMultiple: false,
        defaultSize: { w: 3, h: 2 },
        minSize: { w: 2, h: 2 },
        configSchemaVersion: DEMO_SOLO_CONFIG_VERSION,
      },
    ],
    settingsSchemaVersion: 1,
    // 刻意不给生命周期 handler：证明 handler 是可选的，不会因此被注册表拒绝。
    lifecycle: {},
  },
];
