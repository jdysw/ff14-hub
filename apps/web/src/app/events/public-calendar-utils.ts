/**
 * 公开国服日程的纯逻辑。区分「有可靠起止时间的日程」与「只有发布日期的公告」；
 * 不根据公告发布时间伪造活动区间，所有日期统一按北京时间解读。
 */
import type { EventCalendarItem } from '@ff14-hub/shared';

export const CN_OFFSET = 8 * 60 * 60_000;
export const DAY_MS = 86_400_000;
export const SOON_MS = 7 * DAY_MS;
export const ENDING_MS = DAY_MS;

export function chinaDayKey(timeMs: number): string {
  return new Date(timeMs + CN_OFFSET).toISOString().slice(0, 10);
}

export function chinaToday(nowMs: number): string {
  return chinaDayKey(nowMs);
}

export function isScheduled(item: EventCalendarItem): boolean {
  return item.startsAt !== null && item.endsAt !== null &&
    Number.isFinite(item.startsAt) && Number.isFinite(item.endsAt) &&
    item.endsAt > item.startsAt;
}

export function eventsForChinaDay(events: readonly EventCalendarItem[], day: string): EventCalendarItem[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const start = Date.parse(day + 'T00:00:00.000Z') - CN_OFFSET;
  if (!Number.isFinite(start) || chinaDayKey(start) !== day) return [];
  const end = start + DAY_MS;
  return events.filter(item => isScheduled(item) && item.startsAt! < end && item.endsAt! >= start)
    .sort((a, b) => a.startsAt! - b.startsAt!);
}

export type CalendarPhase = 'active' | 'upcoming' | 'ending' | 'ended' | 'unscheduled';

export function eventStatus(item: EventCalendarItem, nowMs: number): CalendarPhase {
  if (!isScheduled(item)) return 'unscheduled';
  if (item.endsAt! < nowMs) return 'ended';
  if (item.startsAt! > nowMs) return 'upcoming';
  return item.endsAt! - nowMs <= ENDING_MS ? 'ending' : 'active';
}

export function calendarOverview(events: readonly EventCalendarItem[], nowMs: number) {
  const scheduled = events.filter(isScheduled);
  return {
    today: eventsForChinaDay(scheduled, chinaToday(nowMs)),
    active: scheduled.filter(x => x.startsAt! <= nowMs && x.endsAt! >= nowMs),
    upcoming: scheduled.filter(x => x.startsAt! > nowMs && x.startsAt! <= nowMs + SOON_MS)
      .sort((a, b) => a.startsAt! - b.startsAt!),
    ending: scheduled.filter(x => x.startsAt! <= nowMs && x.endsAt! >= nowMs && x.endsAt! <= nowMs + ENDING_MS)
      .sort((a, b) => a.endsAt! - b.endsAt!),
    unscheduled: events.filter(x => !isScheduled(x)),
  };
}

export function chinaDateTime(timeMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timeMs));
}

export function chinaMonthDays(year: number, month: number): string[] {
  if (!Number.isInteger(year) || year < 2020 || year > 2100 ||
      !Number.isInteger(month) || month < 1 || month > 12) return [];
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const start = Date.UTC(year, month - 1, 1) - firstWeekday * DAY_MS;
  return Array.from({ length: 42 }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

export function displayCalendarTitle(value: string): string {
  return value.replace(/^[【〖](?:季节活动|官方活动)[】〗]\s*/, '').trim();
}
