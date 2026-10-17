/**
 * Widget 实例存储测试（HUB-044）。
 *
 * 断言的是实例级语义：`allowMultiple` 策略、隐藏/移除只影响实例、
 * 以及卸载时按模块整批清理；并确认快照是不可变的（`useSyncExternalStore` 依赖这一点）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createWidgetInstanceStore, type WidgetLookup } from '../src/app/widgets/instance-store';

const lookup: WidgetLookup = (widgetId) => {
  if (widgetId === 'multi') {
    return { moduleId: 'demo.basics', allowMultiple: true, configSchemaVersion: 1 };
  }
  if (widgetId === 'solo') {
    return { moduleId: 'demo.solo', allowMultiple: false, configSchemaVersion: 1 };
  }
  return null;
};

function createStore(): ReturnType<typeof createWidgetInstanceStore> {
  let counter = 0;
  return createWidgetInstanceStore({
    lookup,
    nextId: () => {
      counter += 1;
      return `inst-${String(counter)}`;
    },
  });
}

describe('实例存储', () => {
  it('拒绝未注册的组件类型', () => {
    const store = createStore();
    expect(store.add({ widgetId: 'ghost' })).toEqual({ ok: false, reason: 'unsupported_widget' });
    expect(store.list()).toHaveLength(0);
  });

  it('allowMultiple=false 的组件类型最多一个实例', () => {
    const store = createStore();
    const first = store.add({ widgetId: 'solo' });
    expect(first.ok).toBe(true);
    expect(store.add({ widgetId: 'solo' })).toEqual({ ok: false, reason: 'single_instance_only' });
    expect(store.list()).toHaveLength(1);
  });

  it('allowMultiple=true 可以多实例，且各自保留独立配置', () => {
    const store = createStore();
    store.add({ widgetId: 'multi', config: { step: 1 }, configVersion: 1 });
    store.add({ widgetId: 'multi', config: { step: 5 }, configVersion: 1 });
    const instances = store.list();
    expect(instances).toHaveLength(2);
    expect(instances[0]?.config).toEqual({ step: 1 });
    expect(instances[1]?.config).toEqual({ step: 5 });
  });

  it('隐藏 / 移除只影响目标实例，不动其他实例与模块归属', () => {
    const store = createStore();
    const a = store.add({ widgetId: 'multi' });
    const b = store.add({ widgetId: 'multi' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      return;
    }

    expect(store.setHidden(a.instance.instanceId, true)).toBe(true);
    expect(store.list()).toHaveLength(2);
    expect(store.list().find((instance) => instance.instanceId === a.instance.instanceId)?.hidden).toBe(true);
    expect(store.list().find((instance) => instance.instanceId === b.instance.instanceId)?.hidden).toBe(false);

    expect(store.remove(a.instance.instanceId)).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.listByModule('demo.basics')).toHaveLength(1);
  });

  it('卸载模块时按模块整批清理，且不影响其他模块的实例', () => {
    const store = createStore();
    store.add({ widgetId: 'multi' });
    store.add({ widgetId: 'multi' });
    store.add({ widgetId: 'solo' });

    expect(store.removeInstancesForModule('demo.basics')).toBe(2);
    expect(store.listByModule('demo.basics')).toHaveLength(0);
    expect(store.listByModule('demo.solo')).toHaveLength(1);
  });

  it('快照在变更时更换引用（否则 useSyncExternalStore 不会重新渲染）', () => {
    const store = createStore();
    const before = store.list();
    store.add({ widgetId: 'multi' });
    expect(store.list()).not.toBe(before);
    const afterAdd = store.list();
    // 未变更时必须是同一个引用。
    expect(store.list()).toBe(afterAdd);
  });

  it('订阅在变更时被通知，取消订阅后不再通知', () => {
    const store = createStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.add({ widgetId: 'multi' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.add({ widgetId: 'multi' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('更新配置只改目标实例', () => {
    const store = createStore();
    const a = store.add({ widgetId: 'multi', config: { step: 1 }, configVersion: 1 });
    const b = store.add({ widgetId: 'multi', config: { step: 1 }, configVersion: 1 });
    if (!a.ok || !b.ok) {
      throw new Error('实例创建失败');
    }
    expect(store.updateConfig(b.instance.instanceId, { step: 9 }, 1)).toBe(true);
    expect(store.list().find((instance) => instance.instanceId === a.instance.instanceId)?.config).toEqual({ step: 1 });
    expect(store.list().find((instance) => instance.instanceId === b.instance.instanceId)?.config).toEqual({ step: 9 });
  });

  it('对不存在的实例操作返回 false（不静默创建）', () => {
    const store = createStore();
    expect(store.remove('nope')).toBe(false);
    expect(store.setHidden('nope', true)).toBe(false);
    expect(store.updateConfig('nope', {}, 1)).toBe(false);
  });
});
