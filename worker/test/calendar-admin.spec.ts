import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetIdentityState, seedAuth } from './helpers';
import type { EventCalendarResponse } from '@ff14-hub/shared';

const API = 'https://example.com/api/v1/events';
const baseUrl = API + '/admin/items';
const adminStatus = API + '/admin/status';
const now = () => Date.now();

function official(): EventCalendarResponse {
  const current = now();
  return {
    serverTimeMs: current,
    source: {
      name: '盛趣游戏 · FF14 国服官方公告',
      homeUrl: 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',
      checkedAtMs: current, stale: false,
    },
    events: [{
      id: 'official:123', region: 'cn', title: '守护天节', category: '季节活动',
      description: '', location: '', startsAt: current - 60_000, endsAt: current + 86_400_000,
      allDay: false, sourceUrl: 'https://ff.web.sdo.com/web8/index.html',
    }],
  };
}
function post(auth: string | null, body: unknown, url = baseUrl, method = 'POST') {
  return SELF.fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}
function item() {
  const current = now();
  return {
    title: '管理员新增联动', description: '仅测试', category: '限时联动',
    location: '', startsAt: current, endsAt: current + 86_400_000,
    sourceUrl: 'https://ff.web.sdo.com/web8/index.html', allDay: false,
  };
}
async function setupSource() {
  const source = official();
  await env.DB.prepare(
    "INSERT INTO official_calendar_snapshots (source, payload, checked_at_ms) VALUES ('cn', ?, ?) ON CONFLICT(source) DO UPDATE SET payload=excluded.payload,checked_at_ms=excluded.checked_at_ms",
  ).bind(JSON.stringify(source), source.source.checkedAtMs).run();
}
async function asAdmin() {
  const device = await seedAuth();
  await env.DB.prepare('INSERT INTO calendar_admin_devices (device_id, workspace_id, granted_at) VALUES (?,?,?)')
    .bind(device.deviceId, device.workspaceId, now()).run();
  return device;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM calendar_admin_audit').run();
  await env.DB.prepare('DELETE FROM calendar_editor_entries').run();
  await resetIdentityState();
  await setupSource();
});

describe('公开日历管理员权限及持久化', () => {
  it('匿名和普通设备均无法读写管理接口，但公共日历仍可匿名查看', async () => {
    expect((await SELF.fetch(adminStatus)).status).toBe(401);
    const ordinary = await seedAuth();
    expect((await SELF.fetch(adminStatus, { headers: { Authorization: ordinary.authorization } })).status).toBe(403);
    expect((await post(ordinary.authorization, { expectedRevision: 0, item: item() })).status).toBe(403);
    expect((await post(null, { expectedRevision: 0, item: item() })).status).toBe(401);
    expect((await SELF.fetch(API + '/calendar')).status).toBe(200);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM calendar_editor_entries').first<{count: number}>();
    expect(count?.count).toBe(0);
  });

  it('管理员创建、修改、隐藏和恢复会立即反映在公共 API 与 ICS，并留下审计', async () => {
    const admin = await asAdmin();
    expect((await SELF.fetch(adminStatus, { headers: { Authorization: admin.authorization } })).status).toBe(200);
    const created = await post(admin.authorization, { expectedRevision: 0, item: item() });
    expect(created.status).toBe(201);
    const row = await created.json<{ id: string; revision: number }>();
    expect(row.id).toMatch(/^manual:/);
    expect(row.revision).toBe(1);

    const edited = await post(admin.authorization, {
      expectedRevision: 1, item: { ...item(), title: '管理员调整后的活动' },
    }, baseUrl + '/' + row.id, 'PUT');
    expect(edited.status).toBe(200);
    expect((await edited.json<{ revision: number }>()).revision).toBe(2);

    const effective = await (await SELF.fetch(API + '/calendar')).json<EventCalendarResponse>();
    expect(effective.events.some(e => e.title === '管理员调整后的活动')).toBe(true);
    const ics = await (await SELF.fetch(API + '/calendar.ics')).text();
    expect(ics).toContain('管理员调整后的活动');

    const hidden = await post(admin.authorization, { expectedRevision: 2 }, baseUrl + '/' + row.id + '/hide');
    expect(hidden.status).toBe(200);
    expect((await (await SELF.fetch(API + '/calendar')).json<EventCalendarResponse>()).events.some(e => e.id === row.id)).toBe(false);

    const restored = await post(admin.authorization, { expectedRevision: 3 }, baseUrl + '/' + row.id + '/restore');
    expect(restored.status).toBe(200);
    expect((await (await SELF.fetch(API + '/calendar')).json<EventCalendarResponse>()).events.some(e => e.id === row.id)).toBe(true);

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM calendar_admin_audit WHERE event_id=?')
      .bind(row.id).first<{count: number}>();
    expect(count?.count).toBe(4);
  });

  it('编辑官方活动不改变来源快照，三小时刷新后仍按管理员版本显示', async () => {
    const admin = await asAdmin();
    const update = await post(admin.authorization, {
      expectedRevision: 0,
      item: { ...item(), title: '守护天节（人工校正）' },
    }, baseUrl + '/official:123', 'PUT');
    expect(update.status).toBe(200);
    const raw = await env.DB.prepare("SELECT payload FROM official_calendar_snapshots WHERE source='cn'")
      .first<{ payload: string }>();
    expect(raw?.payload).toContain('守护天节');
    expect(raw?.payload).not.toContain('人工校正');
    const effective = await (await SELF.fetch(API + '/calendar')).json<EventCalendarResponse>();
    expect(effective.events.find(x => x.id === 'official:123')?.title).toBe('守护天节（人工校正）');

    const conflict = await post(admin.authorization, {
      expectedRevision: 0, item: { ...item(), title: '过期版本覆盖' },
    }, baseUrl + '/official:123', 'PUT');
    expect(conflict.status).toBe(409);
    const audits = await env.DB.prepare('SELECT COUNT(*) AS count FROM calendar_admin_audit WHERE event_id=?')
      .bind('official:123').first<{count: number}>();
    expect(audits?.count).toBe(1);
    const restore = await post(admin.authorization, { expectedRevision: 1 }, baseUrl + '/official:123/restore');
    expect(restore.status).toBe(200);
    const after = await (await SELF.fetch(API + '/calendar')).json<EventCalendarResponse>();
    expect(after.events.find(x => x.id === 'official:123')?.title).toBe('守护天节');
  });

  it('校验危险内容、倒置时间和已撤销设备，拒绝写入', async () => {
    const admin = await asAdmin();
    const invalid = await post(admin.authorization, {
      expectedRevision: 0, item: { ...item(), endsAt: now() - 60_000 },
    });
    expect(invalid.status).toBe(422);
    const badUrl = await post(admin.authorization, {
      expectedRevision: 0, item: { ...item(), sourceUrl: 'javascript:alert(1)' },
    });
    expect(badUrl.status).toBe(422);
    await env.DB.prepare('UPDATE devices SET revoked_at=? WHERE id=?')
      .bind(now(), admin.deviceId).run();
    expect((await post(admin.authorization, { expectedRevision: 0, item: item() })).status).toBe(401);
  });
});
