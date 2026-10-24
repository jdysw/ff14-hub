/**
 * 全站 owner API：只允许已激活的唯一管理员使用密码+TOTP 登录。
 * 所有业务修改在此统一授权，未认证设备 Token 与浏览器端口令均不得替代管理员会话。
 * 不提供任何 HTTP 注册 / 初始账号创建接口。
 */
import { ApiError,siteGameDataSchema,eventCalendarItemSchema } from '@ff14-hub/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { noStoreJson } from '../../lib/response';
import { parsedJsonBody, validateJsonBody } from '../../middleware/validation';
import { methodNotAllowed } from '../../middleware/error-handler';
import type { AppBindings, AppMiddleware } from '../../types';
import { issueAdminSession, revokeAdminSession, throttleAdmin, validateAdminCredentials, validateAdminSession } from '../../modules/events/calendar-admin-auth';
import { siteSettingsMutationSchema, readSiteSettings, updateSiteSettings } from '../../modules/admin/site-settings';
import { readOfficialCalendarSnapshot } from '../../modules/events/calendar-snapshot';
import { readCnCalendar } from '../../modules/events/calendar-feed';
import { refreshOfficialCalendarSnapshot } from '../../modules/events/calendar-refresh';
import { calendarMutationSchema, calendarToggleSchema, listEditorEntries, saveCalendarEdit } from '../../modules/events/calendar-editor';
import { registerAdminNavigation } from './admin-navigation';
import {contentStates,saveContentState} from '../../modules/admin/content-state';
import {readGameData,saveGameData} from '../../modules/admin/game-data';

export const adminRoutes = new Hono<AppBindings>();
export const publicSiteRoutes = new Hono<AppBindings>();

const loginSchema=z.object({
  username:z.string().regex(/^[A-Za-z0-9._-]{3,40}$/),
  password:z.string().min(14).max(128),
  code:z.string().regex(/^\d{6}$/),
}).strict();

export function adminAuth(): AppMiddleware {
  return async(c,next)=>{
    if(!await validateAdminSession(c.env.DB,c.req.header('Authorization')))
      throw new ApiError('unauthorized','需要站点管理员会话');
    await next();
  };
}

// 公开 API 只有展示配置，不包含账号状态、鉴权信息或部署密钥。
publicSiteRoutes.get('/',async c=>noStoreJson(c,await readSiteSettings(c.env.DB)));
publicSiteRoutes.get('/data',async c=>noStoreJson(c,await readGameData(c.env.DB)));
publicSiteRoutes.all('*',methodNotAllowed(['GET']));

adminRoutes.post('/login',validateJsonBody(loginSchema),async c=>{
  await throttleAdmin(c.env.DB,'admin:login',30);
  const {username,password,code}=parsedJsonBody(c,loginSchema);
  const valid=await validateAdminCredentials(c.env.DB,c.env.BOOTSTRAP_SECRET,username,password,code,false);
  if(!valid)throw new ApiError('unauthorized','管理员账号或验证信息有误');
  return noStoreJson(c,{token:await issueAdminSession(c.env.DB)});
});
adminRoutes.get('/session',adminAuth(),c=>noStoreJson(c,{administrator:true,role:'owner'}));
adminRoutes.get('/content-state',adminAuth(),async c=>noStoreJson(c,{records:await contentStates(c.env.DB)}));
adminRoutes.get('/content-audit',adminAuth(),async c=>noStoreJson(c,{records:(await c.env.DB.prepare('SELECT domain,content_id,state,title,revision,updated_at FROM admin_content_audit ORDER BY id DESC LIMIT 100').all()).results}));
const contentStateSchema=z.object({domain:z.enum(['navigation','calendar']),contentId:z.string().min(1).max(150),state:z.enum(['active','trash','deleted']),expectedRevision:z.number().int().nonnegative()}).strict();
adminRoutes.put('/content-state',adminAuth(),validateJsonBody(contentStateSchema),async c=>{
  const body=parsedJsonBody(c,contentStateSchema);
  let title:string;
  let snapshot:string|undefined;
  if(body.domain==='navigation'){
    const row=await c.env.DB.prepare('SELECT json_extract(payload,\'$.title\') AS title FROM nav_catalog_edits WHERE id=? UNION ALL SELECT title FROM nav_catalog_links WHERE id=? LIMIT 1').bind(body.contentId,body.contentId).first<{title:string}>();
    title=row?.title??'';
  }else{
    await assertEditableId(c.env.DB,body.contentId);
    const previous=await c.env.DB.prepare("SELECT title,record_payload,revision FROM admin_content_state WHERE domain='calendar' AND content_id=?").bind(body.contentId).first<{title:string;record_payload:string|null;revision:number}>();
    const edit=(await listEditorEntries(c.env.DB)).find(row=>row.id===body.contentId);
    const original=(await readOfficialCalendarSnapshot(c.env.DB))?.events.find(row=>row.id===body.contentId);
    const item=edit?.item??original;
    title=item?.title??previous?.title??'活动';
    if(body.state==='trash'&&item)snapshot=JSON.stringify(item);
    if(body.state==='active'&&!item&&previous?.record_payload){
      if(previous.revision!==body.expectedRevision)throw new ApiError('conflict','回收站内容已更新');
      const restored=eventCalendarItemSchema.parse(JSON.parse(previous.record_payload));
      await saveCalendarEdit(c.env.DB,'owner',body.contentId,'upsert',restored,edit?.revision??0);
    }
  }
  if(!title)throw new ApiError('not_found','内容不存在');
  return noStoreJson(c,await saveContentState(c.env.DB,{...body,title,...(snapshot?{snapshot}:{})}));
});
adminRoutes.post('/logout',adminAuth(),async c=>{
  await revokeAdminSession(c.env.DB,c.req.header('Authorization'));
  return noStoreJson(c,{ok:true});
});

adminRoutes.get('/settings',adminAuth(),async c=>noStoreJson(c,await readSiteSettings(c.env.DB)));
adminRoutes.get('/game-data',adminAuth(),async c=>noStoreJson(c,await readGameData(c.env.DB)));
const gameDataMutation=z.object({expectedRevision:z.number().int().nonnegative(),data:siteGameDataSchema}).strict();
adminRoutes.put('/game-data',adminAuth(),validateJsonBody(gameDataMutation),async c=>{const input=parsedJsonBody(c,gameDataMutation);return noStoreJson(c,await saveGameData(c.env.DB,input.data,input.expectedRevision));});
adminRoutes.get('/game-data/history',adminAuth(),async c=>noStoreJson(c,{records:(await c.env.DB.prepare('SELECT revision,updated_at FROM site_game_data_history ORDER BY revision DESC LIMIT 50').all()).results}));
adminRoutes.get('/game-data/history/:revision',adminAuth(),async c=>{const row=await c.env.DB.prepare('SELECT payload FROM site_game_data_history WHERE revision=?').bind(Number(c.req.param('revision'))).first<{payload:string}>();if(!row)throw new ApiError('not_found','版本不存在');return noStoreJson(c,{data:siteGameDataSchema.parse(JSON.parse(row.payload))});});
adminRoutes.put('/settings',adminAuth(),validateJsonBody(siteSettingsMutationSchema),async c=>{
  const input=parsedJsonBody(c,siteSettingsMutationSchema);
  return noStoreJson(c,await updateSiteSettings(c.env.DB,input));
});

async function assertEditableId(db:D1Database,id:string):Promise<void> {
  if(!/^(official:[A-Za-z0-9_-]+|manual:[0-9a-f-]{36})$/.test(id))
    throw new ApiError('validation_failed','活动标识不合法');
  const saved=await db.prepare('SELECT id FROM calendar_editor_entries WHERE id=?')
    .bind(id).first<{id:string}>();
  if(saved!==null)return;
  if(await db.prepare("SELECT 1 FROM admin_content_state WHERE domain='calendar' AND content_id=?").bind(id).first())return;
  const base=await readOfficialCalendarSnapshot(db);
  if(base?.events.some(event=>event.id===id))return;
  throw new ApiError('not_found','活动不存在');
}

/** 管理台显示官方原始数据和人工修改的版本号，避免普通访问取得编辑审计信息。 */
adminRoutes.post('/calendar/refresh', adminAuth(), async c => {
  await throttleAdmin(c.env.DB,'admin:calendar-refresh',1);
  const run=await c.env.DB.prepare("INSERT INTO admin_sync_runs(started_at,status) VALUES(?,'running') RETURNING id").bind(Date.now()).first<{id:number}>();
  const stored=await refreshOfficialCalendarSnapshot(c.env.DB,Date.now(),readCnCalendar,true);
  const checked=await readOfficialCalendarSnapshot(c.env.DB);
  if(run)await c.env.DB.prepare('UPDATE admin_sync_runs SET finished_at=?,status=?,item_count=? WHERE id=?').bind(Date.now(),stored?'success':'failed',checked?.events.length??0,run.id).run();
  if(!stored)return c.json({code:'service_unavailable',message:'官方同步失败，已保留原有活动数据，请稍后重试'},503);
  const snapshot=await readOfficialCalendarSnapshot(c.env.DB);
  return noStoreJson(c,{ok:true,checkedAtMs:snapshot?.source.checkedAtMs});
});
adminRoutes.get('/operations',adminAuth(),async c=>{
  const snapshot=await readOfficialCalendarSnapshot(c.env.DB);
  const records=(await c.env.DB.prepare('SELECT started_at,finished_at,status,item_count FROM admin_sync_runs ORDER BY id DESC LIMIT 30').all()).results;
  const counts=await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM nav_catalog_links) AS websites,(SELECT COUNT(*) FROM nav_catalog_edits) AS websiteEdits,(SELECT COUNT(*) FROM calendar_editor_entries) AS eventEdits,(SELECT COUNT(*) FROM admin_content_state WHERE state='trash') AS trash").first();
  return noStoreJson(c,{counts,calendar:snapshot?{count:snapshot.events.length,checkedAt:snapshot.source.checkedAtMs,stale:snapshot.source.stale}:null,records});
});

adminRoutes.get('/calendar/items', adminAuth(), async (c) => {
  const official = await readOfficialCalendarSnapshot(c.env.DB);
  return noStoreJson(c, {
    official: official?.events ?? [],
    edits: await listEditorEntries(c.env.DB),
  });
});

adminRoutes.post('/calendar/items', adminAuth(), validateJsonBody(calendarMutationSchema), async (c) => {
  const input = parsedJsonBody(c, calendarMutationSchema);
  if (input.expectedRevision !== 0) throw new ApiError('validation_failed', '新建活动的版本号必须为 0');
  const id = 'manual:' + crypto.randomUUID();
  const revision = await saveCalendarEdit(c.env.DB, 'owner', id, 'upsert',
    { ...input.item, id, region: 'cn' }, 0);
  return noStoreJson(c, { id, revision }, 201);
});

adminRoutes.put('/calendar/items/:id', adminAuth(), validateJsonBody(calendarMutationSchema), async (c) => {
  const id = c.req.param('id');
  await assertEditableId(c.env.DB, id);
  const input = parsedJsonBody(c, calendarMutationSchema);
  const revision = await saveCalendarEdit(c.env.DB, 'owner', id, 'upsert',
    { ...input.item, id, region: 'cn' }, input.expectedRevision);
  return noStoreJson(c, { id, revision });
});

adminRoutes.post('/calendar/items/:id/hide', adminAuth(), validateJsonBody(calendarToggleSchema), async (c) => {
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

adminRoutes.post('/calendar/items/:id/restore', adminAuth(), validateJsonBody(calendarToggleSchema), async (c) => {
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


registerAdminNavigation(adminRoutes,adminAuth());
adminRoutes.all('*',methodNotAllowed(['GET','POST','PUT']));
