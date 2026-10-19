import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_CALENDAR_SNAPSHOT_STALE_MS,
  parseOfficialCalendarSnapshot,
  readOfficialCalendarSnapshot,
} from '../modules/events/calendar-snapshot';

function officialPayload(checkedAtMs: number) {
  return {
    serverTimeMs: checkedAtMs,
    source: {
      name: '盛趣游戏 · FF14 国服官方公告',
      homeUrl: 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',
      checkedAtMs,
      stale: false,
    },
    events: [{
      id: 'official:394275', region: 'cn', title: '守护天节',
      description: '', category: '季节活动', location: '',
      startsAt: checkedAtMs - 60_000, endsAt: checkedAtMs + 60_000,
      sourceUrl: 'https://actff1.web.sdo.com/project/event/index.html', allDay: false,
    }],
  };
}
function row(at: number) {
  return { checked_at_ms: at, payload: JSON.stringify(officialPayload(at)) };
}

describe('官方活动持久快照', () => {
  const at = Date.UTC(2026, 9, 19, 8, 0);
  it('从 D1 快照重新计算当前服务端时间，不依赖会话凭证', () => {
    const result = parseOfficialCalendarSnapshot(row(at), at + 90_000);
    expect(result?.events).toHaveLength(1);
    expect(result?.serverTimeMs).toBe(at + 90_000);
    expect(result?.source.stale).toBe(false);
  });
  it('6 小时过期后仍保留官方来源内容，但明确标记旧数据', () => {
    const result = parseOfficialCalendarSnapshot(row(at), at + OFFICIAL_CALENDAR_SNAPSHOT_STALE_MS + 1);
    expect(result?.events[0]?.title).toBe('守护天节');
    expect(result?.source.stale).toBe(true);
  });
  it('拒绝损坏、伪造来源、不一致或未来时间的数据', () => {
    expect(parseOfficialCalendarSnapshot({ checked_at_ms: at, payload: '{' }, at)).toBeNull();
    expect(parseOfficialCalendarSnapshot(row(at + 60 * 60_000), at)).toBeNull();
    expect(parseOfficialCalendarSnapshot({ checked_at_ms: at + 1, payload: row(at).payload }, at + 2)).toBeNull();
    const tampered = officialPayload(at);
    tampered.source.homeUrl = 'https://attacker.invalid/feed';
    expect(parseOfficialCalendarSnapshot({ checked_at_ms: at, payload: JSON.stringify(tampered) }, at)).toBeNull();
  });
  it('D1 查询失败时回退到既有直连路径，避免将数据库故障掩盖为成功', async () => {
    const db = {
      prepare: () => ({
        first: (): Promise<unknown> => Promise.reject(new Error('db unavailable')),
      }),
    } as unknown as D1Database;
    expect(await readOfficialCalendarSnapshot(db, at)).toBeNull();
  });
});
