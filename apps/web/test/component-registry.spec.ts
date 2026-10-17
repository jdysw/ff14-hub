/**
 * 静态组件注册表与配置迁移测试（HUB-044）。
 *
 * 重点：这里断言的是**行为**——哪一类配置会被拒绝、迁移后到底变成什么——
 * 而不是把实现里的常量抄一遍。
 */
import { BUILTIN_MODULE_MANIFESTS, BUILTIN_WIDGET_CONFIG_CONTRACTS, DEMO_WIDGET_IDS } from '@ff14-hub/shared';
import { describe, expect, it } from 'vitest';
import {
  createWidgetComponentRegistry,
  resolveWidgetConfig,
  widgetComponentRegistry,
} from '../src/app/widgets/component-registry';

describe('内置组件注册表', () => {
  it('每个 Manifest Widget 都有对应的组件与配置契约（不存在「有契约没组件」的洞）', () => {
    const manifestWidgets = BUILTIN_MODULE_MANIFESTS.flatMap((manifest) => manifest.widgets);
    expect(widgetComponentRegistry.entries()).toHaveLength(manifestWidgets.length);
    for (const widget of manifestWidgets) {
      const entry = widgetComponentRegistry.find(widget.id);
      expect(entry, `缺少组件条目：${widget.id}`).not.toBeNull();
      expect(entry?.moduleId).toBe(widget.moduleId);
      expect(entry?.allowMultiple).toBe(widget.allowMultiple);
      expect(entry?.configSchemaVersion).toBe(widget.configSchemaVersion);
      // 默认配置必须能通过自己的 Schema，否则新建实例会立刻变成配置错误。
      expect(entry?.schema.safeParse(entry.defaultConfig).success).toBe(true);
    }
  });

  it('未知 widgetId 返回 null（不动态加载、不猜实现）', () => {
    expect(widgetComponentRegistry.find('not-a-widget')).toBeNull();
  });

  it('缺少组件的 Widget 会被跳过，而不是伪造一个条目', () => {
    const registry = createWidgetComponentRegistry({
      manifests: BUILTIN_MODULE_MANIFESTS,
      contracts: BUILTIN_WIDGET_CONFIG_CONTRACTS,
      components: { [DEMO_WIDGET_IDS.solo]: widgetComponentRegistry.find(DEMO_WIDGET_IDS.solo)?.Component ?? ((): null => null) },
    });
    expect(registry.find(DEMO_WIDGET_IDS.counter)).toBeNull();
    expect(registry.find(DEMO_WIDGET_IDS.solo)).not.toBeNull();
  });
});

describe('配置版本检查与显式迁移', () => {
  it('当前版本的合法配置直接通过，且不报告迁移', () => {
    const result = resolveWidgetConfig(widgetComponentRegistry, DEMO_WIDGET_IDS.counter, { step: 2 }, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBeNull();
      expect(result.config).toMatchObject({ step: 2 });
    }
  });

  it('旧版本配置按注册的迁移函数升级（0 → 1 的旧 increment 形状）', () => {
    const result = resolveWidgetConfig(widgetComponentRegistry, DEMO_WIDGET_IDS.counter, { increment: 4 }, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migratedFrom).toBe(0);
      expect(result.config).toMatchObject({ step: 4 });
    }
  });

  it('没有可用迁移时拒绝执行（不猜形状）', () => {
    const result = resolveWidgetConfig(widgetComponentRegistry, DEMO_WIDGET_IDS.solo, { legacy: true }, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_migration');
    }
  });

  it('实例版本高于组件当前版本时拒绝（不做隐式回退）', () => {
    const result = resolveWidgetConfig(widgetComponentRegistry, DEMO_WIDGET_IDS.counter, { step: 1 }, 99);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('version_ahead');
    }
  });

  it('迁移后仍不满足 Schema 时拒绝', () => {
    // 旧形状的 increment 超出合法范围 → 迁移函数回退为 1（合法），因此这里用非法字段类型构造。
    const result = resolveWidgetConfig(widgetComponentRegistry, DEMO_WIDGET_IDS.counter, { step: 'many' }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_config');
    }
  });

  it('未知组件类型被标记为不受支持', () => {
    const result = resolveWidgetConfig(widgetComponentRegistry, 'ghost-widget', {}, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_widget');
    }
  });

  it('非法的配置版本号被拒绝', () => {
    const result = resolveWidgetConfig(widgetComponentRegistry, DEMO_WIDGET_IDS.counter, {}, -1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_config');
    }
  });
});
