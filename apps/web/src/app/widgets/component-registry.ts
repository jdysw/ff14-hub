/**
 * 静态组件映射（HUB-044）——**契约与可执行组件的分离点**。
 *
 * 硬约束（INV-12 / 规划 4.3）：
 * - 这个映射是写死在代码里的 `Map` 查找，**不是**按客户端字符串 `import()` 的动态加载，
 *   也绝不执行任何远程 JS。未知 widgetId 一律走「不受支持」降级卡片。
 * - 配置 Schema / 迁移函数来自 `@ff14-hub/shared`（纯契约），组件来自本包。
 *   两侧通过 configSchemaVersion 对齐，避免「契约改了组件没跟上」。
 * - `requiredCapabilities` 取所属模块 Manifest 声明的能力：Host 在渲染前与服务端授予结果比对，
 *   缺少能力就降级，而不是照常执行。
 */
import {
  BUILTIN_MODULE_MANIFESTS,
  BUILTIN_WIDGET_CONFIG_CONTRACTS,
  DEMO_WIDGET_IDS,
  type ModuleCapability,
  type ModuleManifest,
  type WidgetConfigContract,
} from '@ff14-hub/shared';
import type { ComponentType } from 'react';
import type { ZodType } from 'zod';
import { eventsWidgetComponents } from '../events/events-widget-components';
import { fishWidgetComponents } from '../fish/FishingPanel';
import { reminderWidgetComponents } from '../reminders/ReminderPanel';
import { navWidgetComponents } from '../nav/nav-widget-components';
import { DemoCounterWidget, DemoFaultWidget, DemoSoloWidget } from './demo-widgets';
import type { WidgetLookupEntry } from './instance-store';
import type { WidgetRuntimeProps } from './types';

export interface WidgetComponentEntry {
  readonly widgetId: string;
  readonly moduleId: string;
  readonly displayName: string;
  readonly allowMultiple: boolean;
  readonly defaultSize: { readonly w: number; readonly h: number };
  readonly configSchemaVersion: number;
  readonly schema: ZodType;
  readonly defaultConfig: unknown;
  readonly migrations: Readonly<Record<number, (raw: unknown) => unknown>>;
  /** 所属模块声明的能力（Host 会与服务端授予结果比对）。 */
  readonly requiredCapabilities: readonly ModuleCapability[];
  readonly Component: ComponentType<WidgetRuntimeProps>;
}

export interface WidgetComponentRegistry {
  find(widgetId: string): WidgetComponentEntry | null;
  entries(): readonly WidgetComponentEntry[];
}

/**
 * 演示组件映射：`widgetId → React 组件`。写死，不做任何动态解析。
 * 阶段 04 起，真实业务模块的组件表分散在各自目录（导航 / 活动），在这里静态合并：
 * 合并的是「静态对象字面量」，因此仍然不存在按不可信字符串执行代码的路径。
 */
const DEMO_WIDGET_COMPONENTS: Readonly<Record<string, ComponentType<WidgetRuntimeProps>>> = {
  [DEMO_WIDGET_IDS.counter]: DemoCounterWidget,
  [DEMO_WIDGET_IDS.fault]: DemoFaultWidget,
  [DEMO_WIDGET_IDS.solo]: DemoSoloWidget,
};

const BUILTIN_WIDGET_COMPONENTS: Readonly<Record<string, ComponentType<WidgetRuntimeProps>>> = {
  ...DEMO_WIDGET_COMPONENTS,
  ...navWidgetComponents,
  ...eventsWidgetComponents,
  ...fishWidgetComponents,
  ...reminderWidgetComponents,
};

export interface ComponentRegistryInput {
  readonly manifests: readonly ModuleManifest[];
  readonly contracts: readonly WidgetConfigContract[];
  readonly components: Readonly<Record<string, ComponentType<WidgetRuntimeProps>>>;
}

/**
 * 由「Manifest + 配置契约 + 组件表」构造注册表。
 *
 * 只有三者都存在时才会产生条目：缺少组件或缺少配置契约的 Widget 会被**跳过**，
 * 于是 Host 对它渲染「不受支持」降级卡片，而不是猜一个实现出来。
 * 测试用这个函数注入小型注册表，从而在不引入假业务模块的前提下验证权限/版本分支。
 */
export function createWidgetComponentRegistry(input: ComponentRegistryInput): WidgetComponentRegistry {
  const byId = new Map<string, WidgetComponentEntry>();
  for (const manifest of input.manifests) {
    for (const widget of manifest.widgets) {
      const contract = input.contracts.find((candidate) => candidate.widgetId === widget.id);
      // Object.hasOwn：不能把 Object.prototype 上的成员（如 'constructor'）当成已注册的组件。
      const Component = Object.hasOwn(input.components, widget.id) ? input.components[widget.id] : undefined;
      if (contract === undefined || Component === undefined) {
        continue;
      }
      byId.set(widget.id, {
        widgetId: widget.id,
        moduleId: manifest.id,
        displayName: widget.displayName,
        allowMultiple: widget.allowMultiple,
        defaultSize: widget.defaultSize,
        configSchemaVersion: contract.configSchemaVersion,
        schema: contract.schema,
        defaultConfig: contract.defaultConfig,
        migrations: contract.migrations,
        requiredCapabilities: [...manifest.capabilities],
        Component,
      });
    }
  }
  return {
    find: (widgetId) => byId.get(widgetId) ?? null,
    entries: () => [...byId.values()],
  };
}

/** 内置演示组件注册表（应用实际使用的那个）。 */
export const widgetComponentRegistry: WidgetComponentRegistry = createWidgetComponentRegistry({
  manifests: BUILTIN_MODULE_MANIFESTS,
  contracts: BUILTIN_WIDGET_CONFIG_CONTRACTS,
  components: BUILTIN_WIDGET_COMPONENTS,
});

/**
 * 供实例存储使用的查表函数：只有注册表里存在的组件类型才能新建实例。
 * 未知 widgetId 返回 null，实例存储据此拒绝，界面显示「不受支持」。
 */
export function builtinWidgetLookup(widgetId: string): WidgetLookupEntry | null {
  const entry = widgetComponentRegistry.find(widgetId);
  if (entry === null) {
    return null;
  }
  return {
    moduleId: entry.moduleId,
    allowMultiple: entry.allowMultiple,
    configSchemaVersion: entry.configSchemaVersion,
  };
}

export type ConfigResolution =
  | {
      readonly ok: true;
      readonly config: unknown;
      /** 非 null 表示本次经过了显式迁移，值是从哪个版本迁过来的。 */
      readonly migratedFrom: number | null;
    }
  | {
      readonly ok: false;
      readonly reason: 'unsupported_widget' | 'version_ahead' | 'no_migration' | 'invalid_config';
      readonly detail: string;
    };

/**
 * 配置版本检查 + **显式**迁移。
 *
 * 规则（不允许任何隐式猜测）：
 * - 未知 widgetId → unsupported_widget（不动态加载）。
 * - 实例版本高于组件当前版本 → version_ahead（降级不自动「回退」，必须人工处理）。
 * - 实例版本低于当前版本 → 逐级调用注册的迁移函数；缺少某级迁移即 no_migration，
 *   **不执行**该组件（宁可显示配置错误卡片，也不要拿错形状的配置去渲染）。
 * - 迁移后仍不通过 Schema → invalid_config。
 */
export function resolveWidgetConfig(
  registry: WidgetComponentRegistry,
  widgetId: string,
  rawConfig: unknown,
  configVersion: number,
): ConfigResolution {
  const entry = registry.find(widgetId);
  if (entry === null) {
    return { ok: false, reason: 'unsupported_widget', detail: `未注册的组件类型：${widgetId}` };
  }
  if (!Number.isInteger(configVersion) || configVersion < 0) {
    return { ok: false, reason: 'invalid_config', detail: '配置版本必须是非负整数' };
  }
  if (configVersion > entry.configSchemaVersion) {
    return {
      ok: false,
      reason: 'version_ahead',
      detail: `实例配置版本 ${configVersion} 高于组件当前版本 ${entry.configSchemaVersion}`,
    };
  }

  let current: unknown = rawConfig;
  let version = configVersion;
  let migratedFrom: number | null = null;
  while (version < entry.configSchemaVersion) {
    const migrate = entry.migrations[version];
    if (migrate === undefined) {
      return {
        ok: false,
        reason: 'no_migration',
        detail: `缺少从版本 ${version} 到 ${version + 1} 的显式迁移`,
      };
    }
    current = migrate(current);
    version += 1;
    migratedFrom ??= configVersion;
  }

  const parsed = entry.schema.safeParse(current);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_config', detail: '配置不满足该组件的配置 Schema' };
  }
  return { ok: true, config: parsed.data, migratedFrom };
}
