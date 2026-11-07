import './setup-d1';
import { describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { EventCalendarResponse } from '@ff14-hub/shared';

const now = Date.UTC(2026, 9, 19, 8, 0);
function data(): EventCalendarResponse {
  return {
    serverTimeMs: now,
    source: {
      name: '盛趣游戏 · FF14 国服官方公告',
      homeUrl: 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',
      checkedAtMs: now, stale: false,
    },
    events: [
      { id: 'official:1', title: '守护天节,活动;更新', region: 'cn', category: '季节活动',
        description: '官方公告\n请参与', location: '', allDay: false,
        startsAt: now, endsAt: now + 3_600_000,
        sourceUrl: 'https://actff1.web.sdo.com/project/seasonal/index.html' },
      { id: 'official:2', title: '不确定时间', region: 'cn', category: '官方公告',
        description: '', location: '', allDay: false, startsAt: null, endsAt: null,
        sourceUrl: 'https://ff.web.sdo.com/web8/index.html' },
      { id: 'official:3', title: '时间点', region: 'cn', category: '版本更新',
        description: '', location: '', allDay: false, startsAt: now, endsAt: now,
        sourceUrl: null },
    ],
  };
}

describe('公开活动 ICS 格式和安全边界', () => {




  it('接口匿名提供持久快照中有效日程，个人活动不进入输出', async () => {
    const feed = data();
    feed.source.checkedAtMs = Date.now();
    feed.serverTimeMs = Date.now();
    await env.DB.prepare("INSERT INTO official_calendar_snapshots (source,payload,checked_at_ms) VALUES ('cn',?,?) ON CONFLICT(source) DO UPDATE SET payload=excluded.payload,checked_at_ms=excluded.checked_at_ms")
      .bind(JSON.stringify(feed), feed.source.checkedAtMs).run();
    const response = await SELF.fetch('https://example.com/api/v1/events/calendar.ics');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/calendar');
    const body = await response.text();
    expect(body).toContain('BEGIN:VEVENT');
    expect(body).not.toContain('不确定时间');
    expect(body).not.toContain('workspace');
  });
});
