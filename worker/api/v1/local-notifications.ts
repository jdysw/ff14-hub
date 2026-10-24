import {Hono} from 'hono';
import {z} from 'zod';
import {ApiError,localNotificationJobsSchema,localNotificationChannelSchema,fishDigestSchema,type FishDigestSettings} from '@ff14-hub/shared';
import type {AppBindings,AppMiddleware} from '../../types';
import {noStoreJson,rateLimited} from '../../lib/response';
import {parsedJsonBody,validateJsonBody} from '../../middleware/validation';
import {hashCredential} from '../../modules/identity/credentials';
import {enforceRateLimits} from '../../lib/rate-limit';
import {pushConfigured} from '../../modules/reminders/push';
import {encryptChannel,decryptChannel,sendChannel} from '../../modules/reminders/notification-channel';
import {checkedJobs,replaceLocalJobs} from '../../modules/reminders/local-push';
import {nextDigestAt} from '../../modules/reminders/fish-digest';

export const localNotificationRoutes=new Hono<AppBindings>();
const plan=z.object({jobs:localNotificationJobsSchema,digest:fishDigestSchema,dailyLimit:z.number().int().min(1).max(50).optional(),targetsOnly:z.boolean().optional()}).strict();
async function updateDigest(db:D1Database,id:string,digest:FishDigestSettings,targetsOnly=false){
  const previous=await db.prepare('SELECT digest_json FROM local_push_devices WHERE id=?').bind(id).first<{digest_json:string|null}>();
  if(targetsOnly&&previous?.digest_json)digest={...fishDigestSchema.parse(JSON.parse(previous.digest_json) as unknown),targets:digest.targets};
  const encoded=JSON.stringify(digest);
  if(previous?.digest_json!==encoded)await db.prepare('UPDATE local_push_devices SET digest_json=?,digest_next_at=? WHERE id=?')
    .bind(encoded,digest.enabled?nextDigestAt(Date.now(),digest.time):null,id).run();
}
const registration=plan.extend({channel:localNotificationChannelSchema,dailyLimit:z.number().int().min(1).max(50)}).strict();
localNotificationRoutes.get('/config',c=>noStoreJson(c,{configured:(c.env.BOOTSTRAP_SECRET?.length??0)>=32,webPushConfigured:pushConfigured(c.env),publicKey:pushConfigured(c.env)?c.env.VAPID_PUBLIC_KEY:null}));
localNotificationRoutes.post('/register',validateJsonBody(registration),async c=>{
  if((c.env.BOOTSTRAP_SECRET?.length??0)<32)throw new ApiError('service_unavailable','通知加密服务尚未配置');
  const ipHash=(await hashCredential(c.req.header('CF-Connecting-IP')??'unknown')).slice(0,32);
  const quota=await enforceRateLimits(c.env.DB,[[`local-push:register:${ipHash}`,{limit:5,windowMs:300_000}],['local-push:register:global',{limit:30,windowMs:300_000}]]);
  if(!quota.allowed){return rateLimited(c,quota);}
  const body=parsedJsonBody(c,registration),now=Date.now();
  if(body.channel.kind==='webpush'&&!pushConfigured(c.env))throw new ApiError('service_unavailable','浏览器推送渠道尚未配置');
  const token='ffh_push_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const id=crypto.randomUUID();
  try{
    const result=await c.env.DB.prepare(`INSERT INTO local_push_devices(id,token_hash,endpoint_hash,channel_ciphertext,expires_at,updated_at,daily_limit)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM local_push_devices)<1000`)
      .bind(id,await hashCredential(token),await hashCredential(body.channel.kind==='webpush'?body.channel.subscription.endpoint:id),await encryptChannel(body.channel,c.env.BOOTSTRAP_SECRET!,id),now+90*86400_000,now,body.dailyLimit).run();
    if(result.meta.changes!==1)throw new Error('capacity');
  }catch{throw new ApiError('conflict','此设备已订阅或订阅额度已满，请停用后重新订阅');}
  await replaceLocalJobs(c.env.DB,id,checkedJobs(body.jobs,now),now);
  await updateDigest(c.env.DB,id,body.digest);
  return noStoreJson(c,{token},201);
});
const notificationAuth:AppMiddleware=async(c,next)=>{
  const auth=c.req.header('Authorization')??'';
  if(!/^Bearer ffh_push_[a-f0-9]{64}$/.test(auth))throw new ApiError('unauthorized','需要当前浏览器的通知凭证');
  const hash=await hashCredential(auth.slice(7));
  const device=await c.env.DB.prepare('SELECT id FROM local_push_devices WHERE token_hash=? AND expires_at>?').bind(hash,Date.now()).first<{id:string}>();
  if(!device)throw new ApiError('unauthorized','通知订阅已失效，请重新启用');
  c.set('deviceId',device.id);
  const quota=await enforceRateLimits(c.env.DB,[[`local-push:device:${device.id}`,{limit:20,windowMs:300_000}]]);
  if(!quota.allowed){return rateLimited(c,quota);}
  return await next();
};
localNotificationRoutes.use('*',notificationAuth);
localNotificationRoutes.put('/plan',validateJsonBody(plan),async c=>{const body=parsedJsonBody(c,plan),jobs=checkedJobs(body.jobs);await replaceLocalJobs(c.env.DB,c.get('deviceId'),jobs);await updateDigest(c.env.DB,c.get('deviceId'),body.digest,body.targetsOnly);if(body.dailyLimit!==undefined){await c.env.DB.prepare('UPDATE local_push_devices SET daily_limit=? WHERE id=?').bind(body.dailyLimit,c.get('deviceId')).run();}return noStoreJson(c,{planned:jobs.length});});
localNotificationRoutes.get('/status',async c=>{
  const device=await c.env.DB.prepare('SELECT expires_at AS expiresAt,sent_count AS sentCount,sent_day AS sentDay,daily_limit AS dailyLimit FROM local_push_devices WHERE id=?').bind(c.get('deviceId')).first();
  const jobs=await c.env.DB.prepare('SELECT job_key AS key,due_at AS dueAt,status,attempts FROM local_push_jobs WHERE device_id=? ORDER BY due_at DESC LIMIT 30').bind(c.get('deviceId')).all();
  return noStoreJson(c,{device,jobs:jobs.results});
});
localNotificationRoutes.post('/test',async c=>{
  const quota=await enforceRateLimits(c.env.DB,[[`local-push:test:${c.get('deviceId')}`,{limit:2,windowMs:300_000}]]);
  if(!quota.allowed){return rateLimited(c,quota);}
  const row=await c.env.DB.prepare('SELECT channel_ciphertext FROM local_push_devices WHERE id=?').bind(c.get('deviceId')).first<{channel_ciphertext:string}>();
  if(!row){throw new ApiError('unauthorized','通知订阅已失效');}
  const status=await sendChannel(c.env,await decryptChannel(row.channel_ciphertext,c.env.BOOTSTRAP_SECRET!,c.get('deviceId')),'ff14-test-'+crypto.randomUUID(),{title:'FF14 Hub 通知测试',body:'后台通知已连接。活动和鱼窗提醒将在设定时间发送。'});
  return noStoreJson(c,{accepted:status>=200&&status<300});
});
localNotificationRoutes.delete('/subscription',async c=>{await c.env.DB.prepare('DELETE FROM local_push_devices WHERE id=?').bind(c.get('deviceId')).run();return noStoreJson(c,{removed:true});});
