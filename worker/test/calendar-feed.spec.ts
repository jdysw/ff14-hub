import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractOfficialActivityRange, readCnCalendar, resetCnCalendarCacheForTests } from '../modules/events/calendar-feed';

afterEach(() => { resetCnCalendarCacheForTests(); vi.unstubAllGlobals(); });

describe('盛趣官方公告活动时间提取', () => {
  it('从明确的北京时间完整区间提取', () => {
    const result = extractOfficialActivityRange(
      '<p>活动时间：2026年10月19日 10:00 ～ 2026年11月2日 23:59</p>',
    );
    expect(result).toEqual({
      startsAt: Date.UTC(2026, 9, 19, 2, 0),
      endsAt: Date.UTC(2026, 10, 2, 15, 59),
    });
  });

  it('不将发布时间、签到统计周期或不完整的活动日期推成时间', () => {
    expect(extractOfficialActivityRange('发布于 2026年10月19日 10:00')).toBeNull();
    expect(extractOfficialActivityRange('活动时间：2026年10月19日～11月2日')).toBeNull();
    expect(extractOfficialActivityRange('每日统计时间：2026年10月19日10:00-2026年10月20日10:00')).toBeNull();
    expect(extractOfficialActivityRange('活动时间：2026年2月30日10:00-2026年3月1日10:00')).toBeNull();
  });

  it('拒绝结束早于开始的活动区间', () => {
    expect(extractOfficialActivityRange('活动时间：2026年10月20日10:00-2026年10月19日10:00')).toBeNull();
  });

  it('忽略脚本和样式的伪造活动时间', () => {
    expect(extractOfficialActivityRange(
      '<script>活动时间：2026年10月19日10:00-2026年10月30日10:00</script><p>欢迎</p>',
    )).toBeNull();
  });
});

describe('盛趣官方活动 API 适配器', () => {
  it('仅访问盛趣官方固定路径并保留无法确认起止时间的活动', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('newsDetail')) {
        return new Response(JSON.stringify({ Code: 0, Data: { Content: '<p>活动时间：2026年10月20日10:00-2026年11月2日23:59</p>' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ Code: 0, Data: [
        { Id: 41, Title: '季节活动', Summary: '官方公告', OutLink: 'https://ff.web.sdo.com/act' },
        { Id: 42, Title: '未知起止活动', Summary: '等待详细日程', OutLink: 'https://example.com/phishing' },
      ] }), { status: 200 });
    }));
    const response = await readCnCalendar();
    expect(response.events).toHaveLength(2);
    expect(response.events[0]?.startsAt).toBe(Date.UTC(2026, 9, 20, 2, 0));
    expect(response.events[1]?.startsAt).toBeNull();
    expect(response.events[1]?.sourceUrl).toContain('ff.web.sdo.com');
    expect(response.source.name).toContain('盛趣游戏');
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((url) => url.startsWith('https://cqnews.web.sdo.com/api/news/'))).toBe(true);
  });
});
