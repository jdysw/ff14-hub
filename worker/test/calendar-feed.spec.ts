import { describe, expect, it } from 'vitest';
import { extractOfficialActivityRange } from '../modules/events/calendar-feed';

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
