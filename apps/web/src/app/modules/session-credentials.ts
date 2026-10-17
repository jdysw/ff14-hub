/**
 * 会话凭证（HUB-050 的最小鉴权入口）。
 *
 * 硬约束（规划 6.3 / 9.2）：
 * - **仅存在于本次页面会话的内存中**：不写 localStorage / sessionStorage / IndexedDB，
 *   不进 URL（绝不用 query 参数），不进日志、不进分析系统、不进错误信息。
 * - 界面上只显示「是否已保存」的事实，**从不回显凭证本身**。
 * - 这里是阶段 02 的最小可用入口，不是完整身份界面；配对 / 恢复 / 设备管理的 UI 属于后续阶段。
 */
/**
 * 会话凭证的读写接口。
 * 刻意写成**属性形式的函数类型**而不是方法简写：方法简写会带上 `this` 语境，
 * 被当作值传给 `useSyncExternalStore` 时既触发 `unbound-method` 警告，也真的可能丢 `this`。
 */
export interface SessionCredentialStore {
  readonly get: () => string | null;
  readonly set: (token: string) => void;
  readonly clear: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSessionCredentialStore(): SessionCredentialStore {
  let token: string | null = null;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    get: () => token,
    set: (next) => {
      // 只接受非空字符串；空串等同于清除，避免把「空凭证」当成已登录。
      token = next.length > 0 ? next : null;
      emit();
    },
    clear: () => {
      token = null;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
