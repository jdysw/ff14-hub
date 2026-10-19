import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedAuth, TEST_BASE_URL } from './helpers';
import { eventCalendarItemSchema } from '@ff14-hub/shared';

const route = TEST_BASE_URL + '/api/v1/admin/calendar';
const official = {
  region: 'cn', title: '管理员活动', description: '公开资料',
  category: '季节活动', location: '', startsAt: 1790000000000,
  endsAt: 1790100000000, allDay: false,
  sourceUrl: 'https://ff.web.sdo.com/web8/index.html',
};

async function adminDevice() {
  const identity = await seedAuth();
  await env.DB.prepare('INSERT INTO site_admin_devices (device_id, granted_at) VALUES (?,?)')
    .bind(identity.deviceId, Date.now()).run();
  return identity;
}
function post(url: string, authorization: string, data: unknown) {
  return SELF.fetch(url, {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
function put(url: string, authorization: string, data: unknown) {
  return SELF.fetch(url, {
    method: 'PUT', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

describe('国服活动管理员权限与持久化', () => {
  it('匿名无法写入，普通设备也不能获取管理员角色', async () => {
    const guest = await seedAuth();
    expect((await SELF.fetch(route + '/me')).status).toBe(401);
    expect((await SELF.fetch(route + '/me', { headers: { Authorization: guest.authorization } })).status).toBe(403);
    expect((await post(route + '/entries', guest.authorization, official)).status).toBe(403);
    const total = await env.DB.prepare('SELECT count(*) AS count FROM curated_calendar_events').first<{count:number}>();
    expect(total?.count).toBe(0);
  });

  it('管理员结构化创建、版本保护、编辑、隐藏，并同步匿名日历和 ICS', async () => {
    const admin = await adminDevice();
    expect((await SELF.fetch(route + '/me', { headers: { Authorization: admin.authorization } })).status).toBe(200);
    const createdResponse = await post(route + '/entries', admin.authorization, official);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ event: {id:string},revision:number }>();
    expect(created.event.id).toMatch(/^manual:/);
    expect(created.revision).toBe(1);
    const id = created.event.id;
    const bad = await put(route + '/entries/' + encodeURIComponent(id), admin.authorization, {
      event: { ...official, title: '过期写入' }, expectedRevision: 0,
    });
    expect(bad.status).toBe(409);
    const saved = await put(route + '/entries/' + encodeURIComponent(id), admin.authorization, {
      event: { ...official, title: '管理员已修订' }, expectedRevision: 1,
    });
    expect(saved.status).toBe(200);
    const entries = await SELF.fetch(route + '/entries', { headers: { Authorization: admin.authorization } });
    const data = await entries.json<{ entries: { event: unknown, revision: number }[] }>();
    expect(eventCalendarItemSchema.parse(data.entries.find(x => x.revision === 2)?.event).title).toBe('管理员已修订');
    const hidden = await post(route + '/entries/' + encodeURIComponent(id) + '/hide', admin.authorization, { expectedRevision: 2 });
    expect(hidden.status).toBe(200);
    const row = await env.DB.prepare('SELECT hidden,revision FROM curated_calendar_events WHERE id = ?')
      .bind(id).first<{hidden:number,revision:number}>();
    expect(row).toEqual({ hidden: 1, revision: 3 });
  });

  it('提交恶意 URL / 不完整或倒置时间必须拒绝', async () => {
    const admin = await adminDevice();
    for (const value of [
      { ...official, sourceUrl: 'javascript:alert(1)' },
      { ...official, startsAt: null },
      { ...official, startsAt: official.endsAt, endsAt: official.startsAt },
    ]) {
      expect((await post(route + '/entries', admin.authorization, value)).status).toBe(422);
    }
  });
});
