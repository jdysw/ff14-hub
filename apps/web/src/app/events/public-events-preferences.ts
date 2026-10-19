/**
 * 无账号模式下的公开首页模块偏好，限定于显示与顺序两项。
 * 只在本机浏览器保存非敏感偏好；与私有工作台及设备会话彻底隔离。
 */
export const PUBLIC_EVENTS_PREF_KEY = 'ff14hub:public-events:layout:v1';
export const PUBLIC_EVENTS_PREF_CHANGE = 'ff14hub:public-events:layout-changed';

export interface PublicEventsPreference {
  readonly visible: boolean;
  readonly position: 'before-nav' | 'after-nav';
}
const DEFAULT: PublicEventsPreference = { visible: true, position: 'before-nav' };

export function readPublicEventsPreference(): PublicEventsPreference {
  try {
    const value = window.localStorage.getItem(PUBLIC_EVENTS_PREF_KEY);
    if (value === null) return DEFAULT;
    const data: unknown = JSON.parse(value);
    if (!data || typeof data !== 'object') return DEFAULT;
    const raw = data as Record<string, unknown>;
    return {
      visible: typeof raw.visible === 'boolean' ? raw.visible : true,
      position: raw.position === 'after-nav' ? 'after-nav' : 'before-nav',
    };
  } catch {
    return DEFAULT;
  }
}
export function savePublicEventsPreference(value: PublicEventsPreference): void {
  try { window.localStorage.setItem(PUBLIC_EVENTS_PREF_KEY, JSON.stringify(value)); }
  catch { /* 隐私模式下的存储拒绝不阻止当前页面使用 */ }
  window.dispatchEvent(new Event(PUBLIC_EVENTS_PREF_CHANGE));
}
