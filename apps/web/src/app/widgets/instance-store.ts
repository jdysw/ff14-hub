/**
 * Widget 实例存储（HUB-044 / HUB-050 的「当前 Host 实例」）。
 *
 * 阶段 02 的诚实性：还没有持久页面 / `widget_instances` 表（那是阶段 03），
 * 因此实例只存在于**浏览器内存**里，刷新即丢失。服务端的卸载语义通过
 * `ModuleInstanceStore` 端口请求清理，真正生效的这一侧就是本文件的
 * `removeInstancesForModule`。
 *
 * 关键语义（规划规则 7，不得混淆）：
 * - `hide` / `remove` **只影响实例**：不改模块状态、不动后台行为、不删个人数据。
 *   因此这里没有任何模块级副作用，也不会去调用模块 API。
 * - 快照是不可变的：每次变更都换一个新的数组引用，保证 `useSyncExternalStore`
 *   能可靠地察觉到变化（原地 splice 会让 React 认为没变）。
 */
import type { ModuleEffectiveStatus } from '@ff14-hub/shared';

export interface WidgetInstance {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly widgetId: string;
  readonly config: unknown;
  readonly configVersion: number;
  readonly hidden: boolean;
}

/** 判断某个 Widget 类型能否再加实例所需的最小信息（来自注册表 / 目录）。 */
export interface WidgetLookupEntry {
  readonly moduleId: string;
  readonly allowMultiple: boolean;
  readonly configSchemaVersion: number;
}

export type WidgetLookup = (widgetId: string) => WidgetLookupEntry | null;

export type AddInstanceResult =
  | { readonly ok: true; readonly instance: WidgetInstance }
  | { readonly ok: false; readonly reason: 'unsupported_widget' | 'single_instance_only' };

/**
 * 实例存储接口。
 * 与凭证存储同理：用**属性形式的函数类型**而非方法简写，避免把方法当值传递时丢 `this`
 * （`useSyncExternalStore(store.subscribe, store.list)` 正是这种传法）。
 */
export interface WidgetInstanceStore {
  /** 当前快照；未变更时返回同一个引用（供 useSyncExternalStore 使用）。 */
  readonly list: () => readonly WidgetInstance[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly add: (input: {
    readonly widgetId: string;
    readonly config?: unknown;
    readonly configVersion?: number;
  }) => AddInstanceResult;
  readonly remove: (instanceId: string) => boolean;
  readonly setHidden: (instanceId: string, hidden: boolean) => boolean;
  readonly updateConfig: (instanceId: string, config: unknown, configVersion: number) => boolean;
  /** 卸载模块时由 Host 调用：移除该模块的**全部实例**（不触碰个人数据）。 */
  readonly removeInstancesForModule: (moduleId: string) => number;
  readonly listByModule: (moduleId: string) => readonly WidgetInstance[];
}

export interface InstanceStoreDeps {
  readonly lookup: WidgetLookup;
  /** 可注入的 ID 生成器，便于测试得到稳定 ID。 */
  readonly nextId?: () => string;
  readonly initial?: readonly WidgetInstance[];
}

export function createWidgetInstanceStore(deps: InstanceStoreDeps): WidgetInstanceStore {
  let snapshot: readonly WidgetInstance[] = [...(deps.initial ?? [])];
  const listeners = new Set<() => void>();
  let counter = 0;
  const nextId =
    deps.nextId ??
    ((): string => {
      counter += 1;
      return `inst-${String(counter)}`;
    });

  function commit(next: readonly WidgetInstance[]): void {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function replace(instanceId: string, patch: Partial<WidgetInstance>): boolean {
    const index = snapshot.findIndex((instance) => instance.instanceId === instanceId);
    if (index < 0) {
      return false;
    }
    const next = [...snapshot];
    const current = next[index];
    if (current === undefined) {
      return false;
    }
    next[index] = { ...current, ...patch };
    commit(next);
    return true;
  }

  return {
    list: () => snapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    add: (input) => {
      const entry = deps.lookup(input.widgetId);
      if (entry === null) {
        return { ok: false, reason: 'unsupported_widget' };
      }
      if (!entry.allowMultiple && snapshot.some((instance) => instance.widgetId === input.widgetId)) {
        // allowMultiple=false：该**类型**最多一个实例。这是类型级策略，不是实例级。
        return { ok: false, reason: 'single_instance_only' };
      }
      const instance: WidgetInstance = {
        instanceId: nextId(),
        moduleId: entry.moduleId,
        widgetId: input.widgetId,
        config: input.config,
        configVersion: input.configVersion ?? entry.configSchemaVersion,
        hidden: false,
      };
      commit([...snapshot, instance]);
      return { ok: true, instance };
    },

    remove: (instanceId) => {
      const next = snapshot.filter((instance) => instance.instanceId !== instanceId);
      if (next.length === snapshot.length) {
        return false;
      }
      commit(next);
      return true;
    },

    setHidden: (instanceId, hidden) => replace(instanceId, { hidden }),

    updateConfig: (instanceId, config, configVersion) => replace(instanceId, { config, configVersion }),

    removeInstancesForModule: (moduleId) => {
      const next = snapshot.filter((instance) => instance.moduleId !== moduleId);
      const removed = snapshot.length - next.length;
      if (removed > 0) {
        commit(next);
      }
      return removed;
    },

    listByModule: (moduleId) => snapshot.filter((instance) => instance.moduleId === moduleId),
  };
}

/** 模块状态 → 该模块的实例是否可以被渲染（未启用一律不执行组件）。 */
export function isModuleUsableForRendering(status: ModuleEffectiveStatus): boolean {
  return status === 'enabled';
}
