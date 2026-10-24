/** 公开活动是匿名内容，可在浏览器本地保存经共享契约验证的最后一次响应。 */
import {eventCalendarResponseSchema,type EventCalendarResponse} from '@ff14-hub/shared';

export const PUBLIC_CALENDAR_CACHE_KEY = 'ff14-hub:public-calendar:v1';
/** 超过 30 天的旧公告不再作为离线日历使用。 */
const MAX_STALE_MS = 30 * 24 * 60 * 60_000;

export function saveCachedPublicCalendar(value:EventCalendarResponse):void {
  try {
    const validated=eventCalendarResponseSchema.parse(value);
    if(typeof localStorage==='undefined')return;
    localStorage.setItem(PUBLIC_CALENDAR_CACHE_KEY,JSON.stringify({at:Date.now(),value:validated}));
  } catch {
    // 存储空间耗尽、隐私浏览或存储被阻止时不影响公开网络响应。
  }
}

/** 缓存只用于网络失败后的降级；必须明确标记 stale，绝不冒充实时活动。 */
export function readCachedPublicCalendar():EventCalendarResponse|null {
  try {
    if(typeof localStorage==='undefined')return null;
    const raw=localStorage.getItem(PUBLIC_CALENDAR_CACHE_KEY);
    if(!raw)return null;
    const record:unknown=JSON.parse(raw);
    if(!record||typeof record!=='object')return null;
    const {at,value}=record as {at?:unknown;value?:unknown};
    if(typeof at!=='number'||!Number.isFinite(at)||at>Date.now()+60_000||Date.now()-at>MAX_STALE_MS)return null;
    const parsed=eventCalendarResponseSchema.safeParse(value);
    return parsed.success?{...parsed.data,source:{...parsed.data.source,stale:true}}:null;
  }catch{return null;}
}
