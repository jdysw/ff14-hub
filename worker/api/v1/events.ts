/**
 * `/api/v1/events` —— 公开活动列表（阶段 04：HUB-011）。
 *
 * 安全前提：
 * - **只读**、匿名可读，且只返回公共来源表 `events` 的行。
 *   个人活动在 `workspace_events`，永远不进入本响应（有测试覆盖）。
 * - 响应形状由共享的 `publicEventListResponseSchema` 约束（**严格**：只有
 *   `events` / `serverTimeMs` 两个键），因此不可能顺手把个人活动字段或内部元数据
 *   塞进公共响应。
 * - 本阶段公共表为空表（不捆绑未经核实的活动数据），因此正常返回空列表；
 *   界面据此诚实显示 `EVENTS_MESSAGES.publicEmpty`，而不是编造数据。
 * - 阶段 04 不做抓取器 / 提醒调度，也不注册 Cron（ADR-0004 D9 / D12）。
 */
import {
  ApiError,
  EVENT_SORT_ORDERS,
  eventCalendarResponseSchema,
  eventPhaseSchema,
  eventRegionSchema,
  type EventPhase,
  type EventRegion,
  type EventSortOrder,
} from '@ff14-hub/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { noStoreJson } from '../../lib/response';
import { nowUtcMs } from '../../lib/util';
import { parsedJsonBody, validateJsonBody } from '../../middleware/validation';
import { methodNotAllowed } from '../../middleware/error-handler';
import { validateQuery } from '../../middleware/validation';
import { createEventService } from '../../modules/events/service';
import { readCnCalendar } from '../../modules/events/calendar-feed';
import { createOfficialCalendarIcs } from '../../modules/events/calendar-ics';
import { readOfficialCalendarSnapshot } from '../../modules/events/calendar-snapshot';
import { applyCalendarEdits, calendarMutationSchema, calendarToggleSchema, listEditorEntries, saveCalendarEdit } from '../../modules/events/calendar-editor';
import type { AppBindings, AppMiddleware } from '../../types';
import { accountRow, issueAdminSession, revokeAdminSession, startAdminSetup, throttleAdmin, validateAdminCredentials, validateAdminSession, verifySetupSecret } from '../../modules/events/calendar-admin-auth';

export const publicEventRoutes = new Hono<AppBindings>();

/**
 * 公开列表的查询参数。
 *
 * 刻意**不**用 `.strict()`：查询串里出现无关参数（例如缓存击穿用的 `_=123`）不应让
 * 一个只读列表返回 422；真正需要拒绝的是「已知参数取了非法值」——
 * `region=both` / `phase=bogus` / `sort=bogus` 都会在这里被拒（422）。
 * 区服沿用共享枚举（**没有** `both`：活动是分区服的事实，INV-08）。
 */
const publicEventQuerySchema = z.object({
  region: eventRegionSchema.optional(),
  phase: eventPhaseSchema.optional(),
  text: z.string().optional(),
  sort: z.enum(EVENT_SORT_ORDERS).optional(),
});

/**
 * 取出原始查询参数。
 *
 * 与 `validateQuery` 的取值方式**逐字一致**（同一份 `URLSearchParams`），
 * 因此「中间件校验过的值」与「处理器使用的值」必然是同一批；重复参数也遵循同一规则
 * （`Object.fromEntries` 取最后一次出现的值，`URLSearchParams.get` 取第一次——正因如此
 * 这里不直接调 `c.req.query()`，避免两条路径对重复参数给出不同结果）。
 */
function rawQuery(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/** GET /api/v1/events —— 公共来源活动（匿名可读）。 */
publicEventRoutes.get('/', validateQuery(publicEventQuerySchema), async (c) => {
  // 中间件已经用**同一份输入**校验过，这里的 parse 不会失败；
  // 万一失败（说明中间件链被改动），让它以 500 响亮失败，而不是返回形状不完整的数据。
  const query = publicEventQuerySchema.parse(rawQuery(c.req.url));
  const service = createEventService({ db: c.env.DB });
  const region: EventRegion | null = query.region ?? null;
  const phase: EventPhase | null = query.phase ?? null;
  const sort: EventSortOrder = query.sort ?? 'startsAt';
  return noStoreJson(
    c,
    await service.listPublic({
      region,
      phase,
      text: query.text ?? null,
      // 阶段判定与响应里的 serverTimeMs 用同一个「现在」：客户端据 serverTimeMs 复算阶段时，
      // 必须与服务端筛选时的基准一致，否则设备时钟偏差会改变筛选结果。
      nowMs: nowUtcMs(),
      sort,
    }),
  );
});

async function calendarForPublic(db: D1Database) {
  const snapshot = await readOfficialCalendarSnapshot(db);
  return await applyCalendarEdits(db, eventCalendarResponseSchema.parse(snapshot ?? await readCnCalendar()));
}

async function assertEditableId(db: D1Database, id: string): Promise<void> {
  if (!/^(official:[A-Za-z0-9_-]+|manual:[0-9a-f-]{36})$/.test(id)) {
    throw new ApiError('validation_failed', '活动标识不合法');
  }
  const saved = await db.prepare('SELECT id FROM calendar_editor_entries WHERE id=?').bind(id).first<{id: string}>();
  if (saved !== null) return;
  const base = await readOfficialCalendarSnapshot(db);
  if (base?.events.some(event => event.id === id)) return;
  throw new ApiError('not_found', '活动不存在');
}

/** 国服活动公共 JSON，由 D1 已验证快照提供，不需要工作空间授权。 */
publicEventRoutes.get('/calendar', async (c) => {
  // 优先读取有持久保证的公共官方快照，避免 Cloudflare 不同边缘实例各自冷缓存，
  // 或从边缘节点无法直接连接盛趣官网时整个首页活动列表 503。
  const snapshot = await readOfficialCalendarSnapshot(c.env.DB);
  if (snapshot !== null) return noStoreJson(c, await applyCalendarEdits(c.env.DB, snapshot));
  try {
    const calendar = await calendarForPublic(c.env.DB);
    return noStoreJson(c, calendar);
  } catch {
    return c.json({ code: 'service_unavailable', message: '官方活动数据暂时无法同步；尚无可用的历史快照' }, 503);
  }
});

/** 标准 ICS 订阅：只包含官方明确起止时间的公共活动，不包含用户私有活动。 */
publicEventRoutes.get('/calendar.ics', async (c) => {
  try {
    const data = await calendarForPublic(c.env.DB);
    const ics = createOfficialCalendarIcs(data);
    return new Response(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="ff14-cn-events.ics"',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return c.json({ code: 'service_unavailable', message: '官方活动日历订阅暂时不可用' }, 503);
  }
});

/** 管理端与玩家设备登录互不关联。首次开户需 Cloudflare 部署初始化密钥；日常操作必须账号密码+TOTP。 */
const adminSetupSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9._-]{3,40}$/),
  password: z.string().min(14).max(128),
}).strict();
const adminVerifySchema = adminSetupSchema.extend({ code: z.string().regex(/^\d{6}$/) }).strict();

function adminAuth(): AppMiddleware {
  return async (c,next) => {
    if (!await validateAdminSession(c.env.DB,c.req.header('Authorization'))) {
      throw new ApiError('unauthorized','请先以管理员账号、密码及身份验证器登录');
    }
    await next();
  };
}

publicEventRoutes.get('/admin/provisioning', async (c) => {
  const user=await accountRow(c.env.DB);
  return noStoreJson(c,{configured:user?.activated_at!==null && user!==null,
    pending:user!==null && user.activated_at===null});
});
publicEventRoutes.post('/admin/setup',validateJsonBody(adminSetupSchema),async (c)=>{
  await throttleAdmin(c.env.DB,'admin:setup',6);
  await verifySetupSecret(c.req.header('X-Calendar-Setup-Key')??null,c.env.BOOTSTRAP_SECRET);
  const input=parsedJsonBody(c,adminSetupSchema);
  const binding=await startAdminSetup(c.env.DB,c.env.BOOTSTRAP_SECRET!,input.username,input.password);
  return noStoreJson(c,{totpKey:binding.secret,otpauthUri:binding.uri},201);
});
publicEventRoutes.post('/admin/setup/confirm',validateJsonBody(adminVerifySchema),async(c)=>{
  await throttleAdmin(c.env.DB,'admin:confirm',10);
  await verifySetupSecret(c.req.header('X-Calendar-Setup-Key')??null,c.env.BOOTSTRAP_SECRET);
  const input=parsedJsonBody(c,adminVerifySchema);
  const ok=await validateAdminCredentials(c.env.DB,c.env.BOOTSTRAP_SECRET,input.username,input.password,input.code,true);
  if(!ok)throw new ApiError('unauthorized','管理员账号或验证信息有误');
  return noStoreJson(c,{token:await issueAdminSession(c.env.DB)});
});
publicEventRoutes.post('/admin/login',validateJsonBody(adminVerifySchema),async(c)=>{
  await throttleAdmin(c.env.DB,'admin:login',30);
  const input=parsedJsonBody(c,adminVerifySchema);
  const ok=await validateAdminCredentials(c.env.DB,c.env.BOOTSTRAP_SECRET,input.username,input.password,input.code,false);
  if(!ok)throw new ApiError('unauthorized','管理员账号或验证信息有误');
  return noStoreJson(c,{token:await issueAdminSession(c.env.DB)});
});
publicEventRoutes.post('/admin/logout',adminAuth(),async(c)=>{
  await revokeAdminSession(c.env.DB,c.req.header('Authorization'));
  return noStoreJson(c,{ok:true});
});
publicEventRoutes.get('/admin/status',adminAuth(),(c)=>noStoreJson(c,{administrator:true}));

/** 管理台显示官方原始数据和人工修改的版本号，避免普通访问取得编辑审计信息。 */
publicEventRoutes.get('/admin/items', adminAuth(), async (c) => {
  const official = await readOfficialCalendarSnapshot(c.env.DB);
  return noStoreJson(c, {
    official: official?.events ?? [],
    edits: await listEditorEntries(c.env.DB),
  });
});

publicEventRoutes.post('/admin/items', adminAuth(), validateJsonBody(calendarMutationSchema), async (c) => {
  const input = parsedJsonBody(c, calendarMutationSchema);
  if (input.expectedRevision !== 0) throw new ApiError('validation_failed', '新建活动的版本号必须为 0');
  const id = 'manual:' + crypto.randomUUID();
  const revision = await saveCalendarEdit(c.env.DB, 'owner', id, 'upsert',
    { ...input.item, id, region: 'cn' }, 0);
  return noStoreJson(c, { id, revision }, 201);
});

publicEventRoutes.put('/admin/items/:id', adminAuth(), validateJsonBody(calendarMutationSchema), async (c) => {
  const id = c.req.param('id');
  await assertEditableId(c.env.DB, id);
  const input = parsedJsonBody(c, calendarMutationSchema);
  const revision = await saveCalendarEdit(c.env.DB, 'owner', id, 'upsert',
    { ...input.item, id, region: 'cn' }, input.expectedRevision);
  return noStoreJson(c, { id, revision });
});

publicEventRoutes.post('/admin/items/:id/hide', adminAuth(), validateJsonBody(calendarToggleSchema), async (c) => {
  const id = c.req.param('id');
  await assertEditableId(c.env.DB, id);
  const body = parsedJsonBody(c, calendarToggleSchema);
  const overrides = await listEditorEntries(c.env.DB);
  const existing = overrides.find(entry => entry.id === id);
  const original = (await readOfficialCalendarSnapshot(c.env.DB))?.events.find(item => item.id === id);
  const hiddenItem = existing?.item ?? original ?? null;
  const revision = await saveCalendarEdit(c.env.DB, 'owner', id, 'hide', hiddenItem, body.expectedRevision);
  return noStoreJson(c, { id, revision });
});

publicEventRoutes.post('/admin/items/:id/restore', adminAuth(), validateJsonBody(calendarToggleSchema), async (c) => {
  const id = c.req.param('id');
  await assertEditableId(c.env.DB, id);
  const body = parsedJsonBody(c, calendarToggleSchema);
  if (body.expectedRevision === 0) throw new ApiError('conflict', '此活动暂无人工修改记录');
  const existing = (await listEditorEntries(c.env.DB)).find(entry => entry.id === id);
  const manual = id.startsWith('manual:');
  if (manual && (!existing?.item || existing.mode !== 'hide')) {
    throw new ApiError('conflict', '手动活动无可恢复的内容');
  }
  const revision = await saveCalendarEdit(c.env.DB, 'owner', id,
    manual ? 'upsert' : 'restore', manual ? existing?.item ?? null : null, body.expectedRevision);
  return noStoreJson(c, { id, revision });
});

// 只支持 GET：其他方法给结构化 405（不落入 404，便于区分「路径写错」与「方法写错」）。
publicEventRoutes.all('*', methodNotAllowed(['GET']));
