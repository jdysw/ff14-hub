/** 与玩家工作空间隔离的管理员内存会话。浏览器刷新即失效，不持久化凭证。 */
import { useSyncExternalStore } from 'react';
let token: string | null = null;
let version = 0;
let snapshot = { version, authenticated: false };
const listeners = new Set<() => void>();
function update(value: string | null) {
  token = value;
  version++;
  snapshot = { version, authenticated: token !== null };
  for (const listener of listeners) listener();
}
export const calendarAdminSession = {
  get: (): string | null => token,
  set: (value: string): void => update(value),
  clear: (): void => update(null),
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  getSnapshot: () => snapshot,
};
export function useCalendarAdminSession() {
  return useSyncExternalStore(calendarAdminSession.subscribe,calendarAdminSession.getSnapshot);
}
