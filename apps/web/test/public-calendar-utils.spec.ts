import { describe, expect, it } from 'vitest';
import type { EventCalendarItem } from '@ff14-hub/shared';
import {
  calendarOverview, chinaDayKey, chinaMonthDays, chinaToday,
  eventStatus, eventsForChinaDay, isScheduled,
} from '../src/app/events/public-calendar-utils';

const start = Date.UTC(2026, 9, 19, 15, 30); // 北京时间 2026-10-19 23:30
function event(id: string, startsAt: number | null, endsAt: number | null): EventCalendarItem {
  return {
    id, region: 'cn', title: id, description: '', category: '季节活动',
    location: '', startsAt, endsAt, allDay: false, sourceUrl: null,
  };
}

describe('国服公开月历纯逻辑', () => {
  it('按北京时间而非浏览器时区生成日期键', () => {
    expect(chinaDayKey(start)).toBe('2026-10-19');
    expect(chinaDayKey(start + 60 * 60_000)).toBe('2026-10-20');
    expect(chinaToday(start)).toBe('2026-10-19');
  });

  it('跨北京午夜的活动出现在两天，而公告和零时长条目不进入日历', () => {
    const cross = event('cross', start, start + 90 * 60_000);
    const announcement = event('notice', null, null);
    const point = event('point', start, start);
    expect(isScheduled(cross)).toBe(true);
    expect(isScheduled(point)).toBe(false);
    expect(eventsForChinaDay([cross, announcement, point], '2026-10-19').map(x => x.id)).toEqual(['cross']);
    expect(eventsForChinaDay([cross, announcement, point], '2026-10-20').map(x => x.id)).toEqual(['cross']);
    expect(eventsForChinaDay([cross], '2026-10-00')).toEqual([]);
  });

  it('即将结束优先、未来七天和未知日期互不混淆', () => {
    const now = start;
    const active = event('active', now - 60_000, now + 4 * 86_400_000);
    const ending = event('ending', now - 60_000, now + 30_000);
    const upcoming = event('upcoming', now + 4 * 86_400_000, now + 5 * 86_400_000);
    const unknown = event('unknown', null, null);
    const result = calendarOverview([active, ending, upcoming, unknown], now);
    expect(result.today.map(x => x.id)).toEqual(['active', 'ending']);
    expect(result.upcoming.map(x => x.id)).toEqual(['upcoming']);
    expect(result.ending.map(x => x.id)).toEqual(['ending']);
    expect(result.unscheduled.map(x => x.id)).toEqual(['unknown']);
    expect(eventStatus(ending, now)).toBe('ending');
    expect(eventStatus(unknown, now)).toBe('unscheduled');
  });

  it('每个月生成固定 42 格且正确跨年', () => {
    expect(chinaMonthDays(2026, 10)).toHaveLength(42);
    expect(chinaMonthDays(2026, 10)[0]).toBe('2026-09-27');
    expect(chinaMonthDays(2026, 12).at(-1)).toBe('2027-01-09');
    expect(chinaMonthDays(2026, 13)).toEqual([]);
  });
});
