import { z } from 'zod';
import { fishRegionSchema } from './fish-api';
import { operationIdSchema } from './operation-id';
import type { ModuleManifest } from './module-manifest';
import type { WidgetConfigContract } from './builtin-modules';
export const REMINDER_MODULE_ID='ff14.reminders';
export const REMINDER_WIDGET_ID='reminder-manager';
const ruleValues=z.object({id:z.uuid(),region:fishRegionSchema,kind:z.enum(['event','fish']),
  targetId:z.string().min(1).max(80),leadMinutes:z.number().int().min(0).max(10080),enabled:z.boolean()}).strict();
export const reminderRuleInputSchema=ruleValues.extend({expectedRevision:z.number().int().nonnegative(),operationId:operationIdSchema})
  .refine((r)=>r.kind!=='fish'||r.leadMinutes<=4320,{message:'鱼类提醒提前量不能超过72小时预测范围',path:['leadMinutes']});
export const reminderRuleSchema=ruleValues.extend({
  revision:z.number().int().positive(),deleted:z.boolean(),updatedAt:z.number().int().nonnegative()});
export type ReminderRule=z.infer<typeof reminderRuleSchema>;
export type ReminderRuleInput=z.infer<typeof reminderRuleInputSchema>;
export const reminderDeleteSchema=z.object({expectedRevision:z.number().int().positive(),operationId:operationIdSchema}).strict();
export const notificationJobStatusSchema=z.enum(['queued','leased','retry','sent','suppressed','blocked','failed','cancelled']);
export const notificationJobSchema=z.object({id:z.string(),ruleId:z.string(),dueAt:z.number(),expiresAt:z.number(),
  status:notificationJobStatusSchema,attempts:z.number().int(),reason:z.string().nullable()});
export const notificationDeliverySchema=z.object({jobId:z.string(),deviceId:z.string(),status:z.enum(['accepted','temporary','permanent']),
  httpStatus:z.number().nullable(),attemptedAt:z.number()});
export const pushEndpointSchema=z.url().max(2048).refine((raw)=>{
  try{const u=new URL(raw);
    return u.protocol==='https:' && u.username==='' && u.password==='' && u.port==='' &&
      ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(u.hostname);
  }catch{return false;}
},'仅支持受信任的浏览器推送服务');
const urlKey=z.string().regex(/^[A-Za-z0-9_-]+$/);
export const pushSubscriptionInputSchema=z.object({endpoint:pushEndpointSchema,expirationTime:z.number().int().positive().nullable(),
  keys:z.object({p256dh:urlKey.length(87),auth:urlKey.length(22)}).strict()}).strict();
export const reminderSnapshotSchema=z.object({rules:z.array(reminderRuleSchema),jobs:z.array(notificationJobSchema),
  targets:z.array(z.object({id:z.string(),region:fishRegionSchema,kind:z.enum(['event','fish']),label:z.string()})),
  deliveries:z.array(notificationDeliverySchema),devices:z.array(z.object({id:z.string(),deviceId:z.string(),active:z.boolean()})),
  pushConfigured:z.boolean(),publicKey:z.string().nullable()});
export type ReminderSnapshot=z.infer<typeof reminderSnapshotSchema>;
export const reminderWidgetConfigSchema=z.object({}).strict();
export const REMINDER_WIDGET_CONFIG_CONTRACTS:readonly WidgetConfigContract[]=[{widgetId:REMINDER_WIDGET_ID,
  configSchemaVersion:1,schema:reminderWidgetConfigSchema,defaultConfig:{},migrations:{}}];
export const REMINDER_MODULE_MANIFEST:ModuleManifest={id:REMINDER_MODULE_ID,version:'1.0.0',displayName:'提醒管理',
  capabilities:['storage:own','scheduled:own'],settingsSchemaVersion:1,lifecycle:{},widgets:[{id:REMINDER_WIDGET_ID,moduleId:REMINDER_MODULE_ID,
    displayName:'提醒规则与投递记录',allowMultiple:true,defaultSize:{w:6,h:5},minSize:{w:3,h:3},configSchemaVersion:1}]};
