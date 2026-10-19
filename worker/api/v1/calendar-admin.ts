/** 站点级国服活动编辑 API：设备凭证 + 显式管理员白名单，杜绝普通工作空间提权。 */
import { eventCalendarItemSchema, type EventCalendarItem } from '@ff14-hub/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { deviceAuth } from '../../middleware/auth';
import { listCuratedCalendarEntries } from '../../modules/events/calendar-curation';
import type { AppBindings } from '../../types';

export const calendarAdminRoutes = new Hono<AppBindings>();
calendarAdminRoutes.use('*', deviceAuth());
calendarAdminRoutes.use('*', async (c, next) => {
  const deviceId = c.get('deviceId');
  const row = await c.env.DB.prepare(
    'SELECT device_id FROM site_admin_devices WHERE device_id = ?',
  ).bind(deviceId).first<{ device_id: string }>();
  if (row === null) return c.json({ code: 'forbidden', message: '仅站点管理员可以编辑公开活动' }, 403);
  return await next();
});

const eventInput = eventCalendarItemSchema.omit({ id: true }).superRefine((item, ctx) => {
  // 有日期必须提供完整起止区间；零时长的节点暂不可用，避免日历和订阅错误。
  if ((item.startsAt === null) !== (item.endsAt === null)) {
    ctx.addIssue({ code: 'custom', message: '开始和结束时间必须同时填写或同时留空' });
  }
  if (item.startsAt !== null && item.endsAt !== null && item.endsAt <= item.startsAt) {
    ctx.addIssue({ code: 'custom', message: '结束时间必须晚于开始时间' });
  }
});
const changeSchema = z.object({
  event: eventInput,
  expectedRevision: z.number().int().min(0),
}).strict();
const hideSchema = z.object({ expectedRevision: z.number().int().min(0) }).strict();

async function currentRevision(db: D1Database, id: string): Promise<number> {
  const row = await db.prepare('SELECT revision FROM curated_calendar_events WHERE id = ?')
    .bind(id).first<{ revision: number }>();
  return row?.revision ?? 0;
}

function validId(id: string): boolean {
  return /^(official:[0-9]{1,15}|manual:[0-9a-f-]{36})$/.test(id);
}

calendarAdminRoutes.get('/me', (c) => c.json({ admin: true }));
calendarAdminRoutes.get('/entries', async (c) => c.json({ entries: await listCuratedCalendarEntries(c.env.DB) }));

calendarAdminRoutes.post('/entries', async (c) => {
  const parsed = eventInput.safeParse(c.get('jsonBody'));
  if (!parsed.success) return c.json({ code: 'validation_error', message: '请检查活动标题、类型、时间和来源链接' }, 422);
  const event: EventCalendarItem = { ...parsed.data, id: 'manual:' + crypto.randomUUID() };
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO curated_calendar_events (id,payload,hidden,revision,updated_at,updated_by) VALUES (?,?,0,1,?,?)',
  ).bind(event.id, JSON.stringify(event), now, c.get('deviceId')).run();
  return c.json({ event, revision: 1 }, 201);
});

calendarAdminRoutes.put('/entries/:id', async (c) => {
  const id = c.req.param('id');
  if (!validId(id)) return c.json({ code: 'validation_error', message: '活动标识不合法' }, 422);
  const parsed = changeSchema.safeParse(c.get('jsonBody'));
  if (!parsed.success) return c.json({ code: 'validation_error', message: '请检查活动字段及修订版本' }, 422);
  const event: EventCalendarItem = { ...parsed.data.event, id };
  const current = await currentRevision(c.env.DB, id);
  if (current !== parsed.data.expectedRevision) {
    return c.json({ code: 'conflict', message: '活动已由其他管理员修改，请刷新后重试' }, 409);
  }
  const now = Date.now();
  if (current === 0) {
    try {
      await c.env.DB.prepare(
        'INSERT INTO curated_calendar_events (id,payload,hidden,revision,updated_at,updated_by) VALUES (?,?,0,1,?,?)',
      ).bind(id, JSON.stringify(event), now, c.get('deviceId')).run();
    } catch { return c.json({ code: 'conflict', message: '有其他管理员同时修改，请刷新' }, 409); }
  } else {
    const result = await c.env.DB.prepare(
      'UPDATE curated_calendar_events SET payload=?,hidden=0,revision=revision+1,updated_at=?,updated_by=? WHERE id=? AND revision=?',
    ).bind(JSON.stringify(event), now, c.get('deviceId'), id, current).run();
    if (result.meta.changes !== 1) return c.json({ code: 'conflict', message: '有其他管理员同时修改，请刷新' }, 409);
  }
  return c.json({ event, revision: current + 1 });
});

calendarAdminRoutes.post('/entries/:id/hide', async (c) => {
  const id = c.req.param('id');
  if (!validId(id)) return c.json({ code: 'validation_error', message: '活动标识不合法' }, 422);
  const parsed = hideSchema.safeParse(c.get('jsonBody'));
  if (!parsed.success) return c.json({ code: 'validation_error', message: '修订版本不合法' }, 422);
  const current = await currentRevision(c.env.DB, id);
  if (current !== parsed.data.expectedRevision) {
    return c.json({ code: 'conflict', message: '活动已由其他管理员修改，请刷新' }, 409);
  }
  const now = Date.now();
  if (current === 0) {
    try {
      await c.env.DB.prepare(
        'INSERT INTO curated_calendar_events (id,payload,hidden,revision,updated_at,updated_by) VALUES (?, ?, 1, 1, ?, ?)',
      ).bind(id, '{}', now, c.get('deviceId')).run();
    } catch { return c.json({ code: 'conflict', message: '活动已变更，请刷新' }, 409); }
  } else {
    const result = await c.env.DB.prepare(
      'UPDATE curated_calendar_events SET hidden=1,revision=revision+1,updated_at=?,updated_by=? WHERE id=? AND revision=?',
    ).bind(now, c.get('deviceId'), id, current).run();
    if (result.meta.changes !== 1) return c.json({ code: 'conflict', message: '活动已变更，请刷新' }, 409);
  }
  return c.json({ id, hidden: true, revision: current + 1 });
});
