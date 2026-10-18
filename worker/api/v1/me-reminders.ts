import { z } from 'zod';
import type { Hono } from 'hono';
import { ApiError,reminderRuleInputSchema,reminderDeleteSchema,pushSubscriptionInputSchema,reminderSnapshotSchema,fishRecordSchema } from '@ff14-hub/shared';
import type { AppBindings } from '../../types';
import { noStoreJson,rateLimited } from '../../lib/response';
import { enforceRateLimits,RATE_LIMITS } from '../../lib/rate-limit';
import { parsedJsonBody,validateJsonBody } from '../../middleware/validation';
import { parseRule,requireReminders,RULE_COLUMNS,saveRule } from '../../modules/reminders/rules';
import { planNotifications } from '../../modules/reminders/planner';
import { runNotifications } from '../../modules/reminders/runner';
import { createPushTransport,pushConfigured } from '../../modules/reminders/push';
const empty=z.object({}).strict();
export function registerReminderRoutes(me:Hono<AppBindings>):void{
  me.get('/reminders',async(c)=>{
    const workspace=c.get('workspaceId');await requireReminders(c.env.DB,workspace);
    const result=await c.env.DB.batch<Record<string,unknown>>([
      c.env.DB.prepare(`SELECT ${RULE_COLUMNS} FROM reminder_rules WHERE workspace_id=? AND deleted=0 ORDER BY updated_at DESC LIMIT 100`).bind(workspace),
      c.env.DB.prepare(`SELECT id,rule_id AS ruleId,due_at AS dueAt,expires_at AS expiresAt,status,attempts,reason FROM notification_jobs WHERE workspace_id=? ORDER BY created_at DESC,id LIMIT 100`).bind(workspace),
      c.env.DB.prepare(`SELECT d.job_id AS jobId,d.device_id AS deviceId,d.status,d.http_status AS httpStatus,d.attempted_at AS attemptedAt FROM notification_deliveries d
        JOIN notification_jobs j ON j.id=d.job_id WHERE j.workspace_id=? ORDER BY d.attempted_at DESC LIMIT 100`).bind(workspace),
      c.env.DB.prepare('SELECT id,device_id AS deviceId,active FROM push_subscriptions WHERE workspace_id=? ORDER BY id LIMIT 10').bind(workspace),
      c.env.DB.prepare("SELECT id,region,'event' AS kind,title AS label FROM workspace_events WHERE workspace_id=? AND deleted_at IS NULL ORDER BY starts_at LIMIT 100").bind(workspace),
      c.env.DB.prepare('SELECT record_json FROM fish_catalog ORDER BY region,fish_id LIMIT 100'),
    ]);
    const targets=[...(result[4]?.results ?? []),...(result[5]?.results ?? []).map((f)=>{
      const record=fishRecordSchema.parse(JSON.parse(String(f['record_json'])) as unknown);
      return {id:String(record.id),region:record.region,kind:'fish',label:record.name};
    })];
    return noStoreJson(c,reminderSnapshotSchema.parse({rules:(result[0]?.results ?? []).map(parseRule),jobs:result[1]?.results ?? [],targets,
      deliveries:result[2]?.results ?? [],devices:(result[3]?.results ?? []).map((d)=>({...d,active:d['active']===1})),
      pushConfigured:pushConfigured(c.env),publicKey:pushConfigured(c.env)?c.env.VAPID_PUBLIC_KEY:null}));
  });
  me.put('/reminders/rules',validateJsonBody(reminderRuleInputSchema),async(c)=>{
    const result=await saveRule(c.env.DB,c.get('workspaceId'),parsedJsonBody(c,reminderRuleInputSchema));
    if(!result.ok)throw new ApiError(result.reason==='persist_failed'?'internal_error':'conflict',result.detail,result.reason);
    return noStoreJson(c,{rule:result.value,replayed:result.replayed});
  });
  me.delete('/reminders/rules/:id',validateJsonBody(reminderDeleteSchema),async(c)=>{
    const id=z.uuid().safeParse(c.req.param('id'));if(!id.success)throw new ApiError('validation_failed','提醒规则ID不合法');
    const result=await saveRule(c.env.DB,c.get('workspaceId'),{...parsedJsonBody(c,reminderDeleteSchema),id:id.data},true);
    if(!result.ok)throw new ApiError(result.reason==='persist_failed'?'internal_error':'conflict',result.detail,result.reason);
    return noStoreJson(c,{rule:result.value,replayed:result.replayed});
  });
  me.post('/reminders/reconcile',validateJsonBody(empty),async(c)=>{
    const workspace=c.get('workspaceId');await requireReminders(c.env.DB,workspace);
    const decision=await enforceRateLimits(c.env.DB,[[`reminder-reconcile:${workspace}`,RATE_LIMITS.reminderReconcilePerWorkspace]]);
    if(!decision.allowed)return rateLimited(c,decision);
    const planned=await planNotifications(c.env.DB,Date.now(),workspace);
    const processed=await runNotifications(c.env.DB,createPushTransport(c.env),Date.now,workspace);
    return noStoreJson(c,{planned,processed});
  });
  me.put('/reminders/push',validateJsonBody(pushSubscriptionInputSchema),async(c)=>{
    const workspace=c.get('workspaceId');await requireReminders(c.env.DB,workspace);
    const decision=await enforceRateLimits(c.env.DB,[
      [`push-register-workspace:${workspace}`,RATE_LIMITS.pushRegistrationPerWorkspace],
      [`push-register-device:${c.get('deviceId')}`,RATE_LIMITS.pushRegistrationPerDevice],
    ]);
    if(!decision.allowed)return rateLimited(c,decision);
    const subscription=parsedJsonBody(c,pushSubscriptionInputSchema);
    try{
      const result=await c.env.DB.prepare(`INSERT INTO push_subscriptions(id,workspace_id,device_id,endpoint,subscription_json,active,updated_at)
        SELECT ?,?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM devices WHERE workspace_id=? AND id=? AND revoked_at IS NULL)
          AND ((SELECT COUNT(*) FROM push_subscriptions WHERE workspace_id=?)<10 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE workspace_id=? AND device_id=?))
        ON CONFLICT(workspace_id,device_id) DO UPDATE SET endpoint=excluded.endpoint,subscription_json=excluded.subscription_json,active=1,updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(),workspace,c.get('deviceId'),subscription.endpoint,JSON.stringify(subscription),Date.now(),workspace,c.get('deviceId'),workspace,workspace,c.get('deviceId')).run();
      if(result.meta.changes<1)throw new ApiError('conflict','设备状态已变化或订阅达到上限');
    }catch(error){if(error instanceof ApiError)throw error;throw new ApiError('conflict','该推送订阅无法绑定，请重新订阅');}
    return noStoreJson(c,{registered:true});
  });
  me.delete('/reminders/push',validateJsonBody(empty),async(c)=>{
    await requireReminders(c.env.DB,c.get('workspaceId'));
    await c.env.DB.prepare('UPDATE push_subscriptions SET active=0,updated_at=? WHERE workspace_id=? AND device_id=?').bind(Date.now(),c.get('workspaceId'),c.get('deviceId')).run();
    return noStoreJson(c,{registered:false});
  });
}
