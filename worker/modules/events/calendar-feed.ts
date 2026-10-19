/**
 * 国服活动日历的只读适配器。固定上游 URL，绝不接收客户端指定地址，避免 SSRF。
 * 参考日历为社区汇总数据，不代表盛趣官方 API，也不自动赋予 verified 状态。
 */
import type { EventCalendarItem, EventCalendarResponse } from '@ff14-hub/shared';

export const CN_CALENDAR_ICS_URL = 'https://ff14-calendar.pages.dev/ff14.ics';
const SOURCE_NAME = 'FF14 国服活动日历（社区整理）';
const CACHE_MS = 10 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
const MAX_BYTES = 1_000_000;
let cached: { checkedAtMs: number; events: EventCalendarItem[] } | null = null;
let inFlight: Promise<EventCalendarItem[]> | null = null;

/** 仅接受国内日历常见的北京时间与 UTC，未识别的 TZID 不猜测。 */
function calendarTime(value: string | undefined, parameters: string): { ms: number; allDay: boolean } | null {
  if (!value) return null;
  const allDay = /^\\d{8}$/.test(value);
  const match = /^(\\d{4})(\\d{2})(\\d{2})(?:T(\\d{2})(\\d{2})(\\d{2})(Z)?)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', zone] = match;
  const tzid = /(?:^|;)TZID=([^;]+)/i.exec(parameters)?.[1]?.replace(/^"|"$/g, '');
  if (tzid && !['Asia/Shanghai', 'Asia/Chongqing', 'PRC', 'UTC', 'Etc/UTC'].includes(tzid)) return null;
  const offset = zone === 'Z' || tzid === 'UTC' || tzid === 'Etc/UTC' ? 0 : 8 * 60;
  const y = Number(year), m = Number(month), d = Number(day);
  const h = Number(hour), min = Number(minute), sec = Number(second);
  const utc = Date.UTC(y, m - 1, d, h, min, sec);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d ||
      check.getUTCHours() !== h || check.getUTCMinutes() !== min || check.getUTCSeconds() !== sec) return null;
  return { ms: utc - offset * 60_000, allDay };
}

function textValue(value: string | undefined): string {
  return (value ?? '').replace(/\\\\[nN]/g, ' ').replace(/\\\\([,;\\\\])/g, '$1').replace(/\\s+/g, ' ').trim();
}
function safeLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(textValue(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
type Cell = { value: string; parameters: string };
function field(cells: Map<string, Cell>, key: string): Cell | undefined { return cells.get(key); }

/** RFC5545 折行、转义、UTC / Asia/Shanghai / 全天结束日期(不含)处理。 */
export function parseCnCalendarIcs(ics: string): EventCalendarItem[] {
  if (!ics.includes('BEGIN:VCALENDAR') || !ics.includes('BEGIN:VEVENT')) return [];
  const unfolded = ics.replace(/\\r?\\n[ \\t]/g, '');
  const lines = unfolded.split(/\\r?\\n/);
  const result: EventCalendarItem[] = [];
  const seen = new Set<string>();
  let event: Map<string, Cell> | null = null;
  for (const line of lines) {
    const row = line.trim();
    if (row === 'BEGIN:VEVENT') { event = new Map(); continue; }
    if (row === 'END:VEVENT') {
      if (event) {
        const start = field(event, 'DTSTART');
        const end = field(event, 'DTEND');
        const startTime = start ? calendarTime(start.value, start.parameters) : null;
        const endTime = end ? calendarTime(end.value, end.parameters) : null;
        const title = textValue(field(event, 'SUMMARY')?.value).slice(0, 120);
        if (startTime && title) {
          // RFC5545 全天 DTEND 是不含当日；未标明结束时间则视为未知，不能推测。
          const endMs = endTime ? endTime.ms - (startTime.allDay && endTime.allDay ? 1 : 0) : null;
          if (endMs === null || endMs >= startTime.ms) {
            const uid = textValue(field(event, 'UID')?.value).slice(0, 220);
            const key = uid || `${title}:${startTime.ms}`;
            if (!seen.has(key)) {
              seen.add(key);
              result.push({
                id: key, region: 'cn', title, startsAt: startTime.ms, endsAt: endMs,
                allDay: startTime.allDay,
                description: textValue(field(event, 'DESCRIPTION')?.value).slice(0, 600),
                category: textValue(field(event, 'CATEGORIES')?.value).split(',')[0]?.slice(0, 32) || '官方活动',
                sourceUrl: safeLink(field(event, 'URL')?.value),
                location: textValue(field(event, 'LOCATION')?.value).slice(0, 120),
              });
            }
          }
        }
      }
      event = null; continue;
    }
    if (!event) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const left = line.slice(0, colon);
    const [name = '', ...params] = left.split(';');
    const key = name.toUpperCase();
    if (!event.has(key)) event.set(key, { value: line.slice(colon + 1), parameters: params.join(';') });
  }
  return result.sort((a, b) => a.startsAt - b.startsAt || a.title.localeCompare(b.title));
}

async function refresh(): Promise<EventCalendarItem[]> {
  const response = await fetch(CN_CALENDAR_ICS_URL, {
    method: 'GET', redirect: 'error', headers: { Accept: 'text/calendar' },
    signal: AbortSignal.timeout(9_000),
  });
  if (!response.ok) throw new Error('upstream_error');
  const declaredLength = Number(response.headers.get('Content-Length') ?? 0);
  if (declaredLength > MAX_BYTES) throw new Error('upstream_too_large');
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error('upstream_too_large');
  if (!body.includes('BEGIN:VCALENDAR')) throw new Error('invalid_calendar');
  const items = parseCnCalendarIcs(body);
  // 空日历不覆盖先前的可信快照，避免上游临时输出空响应造成活动消失。
  if (items.length === 0) throw new Error('empty_calendar');
  cached = { checkedAtMs: Date.now(), events: items };
  return items;
}

/** 没有缓存时只共享并发请求；有缓存时先返回最新/可接受的过期快照。 */
export async function readCnCalendar(nowMs = Date.now()): Promise<EventCalendarResponse> {
  if (cached && nowMs - cached.checkedAtMs < CACHE_MS) return shape(cached, nowMs, false);
  try {
    inFlight ??= refresh().finally(() => { inFlight = null; });
    await inFlight;
  } catch {
    if (cached && nowMs - cached.checkedAtMs < STALE_MS) return shape(cached, nowMs, true);
    throw new Error('活动数据源暂时不可用');
  }
  if (!cached) throw new Error('活动数据源暂时不可用');
  return shape(cached, nowMs, false);
}

function shape(value: { checkedAtMs: number; events: EventCalendarItem[] }, nowMs: number, stale: boolean): EventCalendarResponse {
  // 不无限扩张响应：显示最近两周已结束与未来一年内的活动。
  const relevant = value.events.filter((e) =>
    e.startsAt < nowMs + 366 * 86_400_000 &&
    (e.endsAt ?? e.startsAt) >= nowMs - 14 * 86_400_000).slice(0, 250);
  return {
    events: relevant, serverTimeMs: nowMs,
    source: { name: SOURCE_NAME, subscribeUrl: CN_CALENDAR_ICS_URL, checkedAtMs: value.checkedAtMs, stale },
  };
}

/** 仅测试注入，不暴露给 HTTP 路由。 */
export function resetCnCalendarCacheForTests(): void { cached = null; inFlight = null; }
