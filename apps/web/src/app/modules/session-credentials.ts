/**
 * 会话凭证（HUB-050 的最小鉴权入口 + 会话隔离）。
 *
 * 硬约束（规划 6.3 / 9.2）：
 * - **仅存在于本次页面会话的内存中**：不写 localStorage / sessionStorage / IndexedDB，
 *   不进 URL（绝不用 query 参数），不进日志、不进分析系统、不进错误信息。
 * - 界面上只显示「是否已保存」的事实，**从不回显凭证本身**。
 * - 对外的快照**不含明文凭证**（只有 `generation` 与 `authenticated`）。
 *   这是刻意的：如果把 token 放进 React 的 props / state / 依赖数组，
 *   它就会出现在 React DevTools 与任何组件序列化里。明文只能经由 `get()` 被 API 客户端内部读取。
 * - `generation` 是**会话代际**：凭证身份真正变化时 +1。UI 用它做 React key，
 *   于是「切换凭证 / 退出」会立刻整棵重挂会话子树，旧会话的私有数据与实例同步消失。
 * - 这里是阶段 02 的最小可用入口，不是完整身份界面；配对 / 恢复 / 设备管理的 UI 属于后续阶段。
 */
import { useSyncExternalStore } from 'react';

/** 对外快照：**不含任何凭证内容**。 */
export interface SessionSnapshot {
  /** 单调递增的会话代际；凭证身份变化时 +1。 */
  readonly generation: number;
  readonly authenticated: boolean;
}

export interface SessionCredentialStore {
  /** 明文凭证只经由这里交给 API 客户端；**不得**进入 React props/state/deps 或任何日志。 */
  readonly get: () => string | null;
  readonly getSnapshot: () => SessionSnapshot;
  readonly set: (token: string) => void;
  readonly clear: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSessionCredentialStore(): SessionCredentialStore {
  let token: string | null = null;
  let generation = 0;
  let snapshot: SessionSnapshot = { generation, authenticated: false };
  const listeners = new Set<() => void>();

  function emit(next: string | null): void {
    // 只有「会话身份真的变了」才推进代际：重复保存同一个凭证不该清空当前会话的实例。
    const normalized = next !== null && next.length > 0 ? next : null;
    if (normalized === token) {
      return;
    }
    token = normalized;
    generation += 1;
    snapshot = { generation, authenticated: token !== null };
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    get: () => token,
    getSnapshot: () => snapshot,
    set: (next) => {
      emit(next);
    },
    clear: () => {
      emit(null);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 订阅会话快照。组件**只**能拿到 `{ generation, authenticated }`，
 * 因此明文凭证不可能通过 props / state / 依赖数组泄漏出去。
 */
export function useSession(store: SessionCredentialStore): SessionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
