import { ApiError,REMINDER_MODULE_ID,reminderRuleSchema,type ReminderRule,type ReminderRuleInput } from '@ff14-hub/shared';
import { createLedger,fingerprintOf } from '../idempotency/ledger';
import { readModuleGateStatus } from '../lifecycle/workspace-modules';
export const reminderLedger=createLedger({
  guardSql:'EXISTS(SELECT 1 FROM reminder_operations WHERE workspace_id=? AND operation_id=? AND attempt_token=?)',
  readRowSql:`SELECT o.kind,o.result_json,o.attempt_token,COALESCE(i.request_fingerprint,'') AS request_fingerprint FROM reminder_operations o
    LEFT JOIN reminder_operation_intents i ON i.workspace_id=o.workspace_id AND i.operation_id=o.operation_id WHERE o.workspace_id=? AND o.operation_id=?`,
  claimPrefix:"INSERT INTO reminder_operations(workspace_id,operation_id,kind,result_json,created_at,attempt_token) SELECT ?,?,?,'',?,? WHERE (",
  claimSuffix:') ON CONFLICT(workspace_id,operation_id) DO NOTHING',
  claimIntentPrefix:'INSERT INTO reminder_operation_intents(workspace_id,operation_id,kind,request_fingerprint,created_at) SELECT ?,?,?,?,? WHERE ',
  finalizeSql:'UPDATE reminder_operations SET result_json=?,attempt_token=NULL WHERE workspace_id=? AND operation_id=? AND attempt_token=?',
});
export const RULE_COLUMNS='id,region,kind,target_id AS targetId,lead_minutes AS leadMinutes,enabled,deleted,revision,updated_at AS updatedAt';
export const MODULE_GATE_SQL=`EXISTS(SELECT 1 FROM workspace_modules m WHERE m.workspace_id=? AND m.module_id=? AND m.status='enabled'
  AND NOT EXISTS(SELECT 1 FROM workspace_module_operations o WHERE o.workspace_id=m.workspace_id AND o.module_id=m.module_id))`;
export function parseRule(row:Record<string,unknown>):ReminderRule {
  return reminderRuleSchema.parse({id:row['id'],region:row['region'],kind:row['kind'],targetId:row['targetId'],leadMinutes:row['leadMinutes'],
    revision:row['revision'],updatedAt:row['updatedAt'],enabled:row['enabled']===1,deleted:row['deleted']===1});
}
export async function requireReminders(db:D1Database,workspace:string):Promise<void>{
  if((await readModuleGateStatus(db,workspace,REMINDER_MODULE_ID)).status!=='enabled')throw new ApiError('forbidden','请先启用提醒管理模块');
}
export async function ruleById(db:D1Database,workspace:string,id:string):Promise<ReminderRule|null>{
  const row=await db.prepare(`SELECT ${RULE_COLUMNS} FROM reminder_rules WHERE workspace_id=? AND id=?`).bind(workspace,id).first<Record<string,unknown>>();
  return row===null?null:parseRule(row);
}
export async function saveRule(db:D1Database,workspace:string,input:ReminderRuleInput|{id:string;expectedRevision:number;operationId:string},deleted=false){
  await requireReminders(db,workspace);
  const kind=deleted?'reminder.delete':'reminder.put';
  const requestFingerprint=await fingerprintOf(kind,input);
  const meta={db,workspaceId:workspace,operationId:input.operationId,kind,requestFingerprint};
  const replay=await reminderLedger.readReplay<ReminderRule>(meta);
  if(replay!==null)return replay;
  const existing=await ruleById(db,workspace,input.id);
  if(deleted && (existing===null || existing.deleted))throw new ApiError('not_found','提醒规则不存在');
  const fields='region' in input?input:existing;
  if(fields===null)throw new ApiError('not_found','提醒规则不存在');
  const now=Date.now();
  const result:ReminderRule={id:input.id,region:fields.region,kind:fields.kind,targetId:fields.targetId,leadMinutes:fields.leadMinutes,
    enabled:deleted?false:fields.enabled,deleted,revision:input.expectedRevision+1,updatedAt:now};
  const targetSql=fields.kind==='event'?
    'EXISTS(SELECT 1 FROM workspace_events WHERE workspace_id=? AND region=? AND id=? AND deleted_at IS NULL)':
    'EXISTS(SELECT 1 FROM fish_catalog WHERE region=? AND CAST(fish_id AS TEXT)=?)';
  const targetBinds=fields.kind==='event'?[workspace,fields.region,fields.targetId]:[fields.region,fields.targetId];
  return reminderLedger.runIdempotentWrite({...meta,now,
    preconditionSql:`${MODULE_GATE_SQL} AND COALESCE((SELECT revision FROM reminder_rules WHERE workspace_id=? AND id=?),0)=?
      AND ((SELECT COUNT(*) FROM reminder_rules WHERE workspace_id=? AND deleted=0)<100 OR EXISTS(SELECT 1 FROM reminder_rules WHERE workspace_id=? AND id=? AND deleted=0)) ${deleted?'':`AND ${targetSql}`}`,
    preconditionBinds:[workspace,REMINDER_MODULE_ID,workspace,input.id,input.expectedRevision,workspace,workspace,input.id,...(deleted?[]:targetBinds)],
    buildStatements:(guard)=>[
      db.prepare(`INSERT INTO reminder_rules(workspace_id,id,region,kind,target_id,lead_minutes,enabled,deleted,revision,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} ON CONFLICT(workspace_id,id) DO UPDATE SET region=excluded.region,kind=excluded.kind,
        target_id=excluded.target_id,lead_minutes=excluded.lead_minutes,enabled=excluded.enabled,deleted=excluded.deleted,
        revision=excluded.revision,updated_at=excluded.updated_at,last_planned_at=0`)
        .bind(workspace,result.id,result.region,result.kind,result.targetId,result.leadMinutes,result.enabled?1:0,deleted?1:0,result.revision,now,...guard.binds),
      db.prepare(`UPDATE notification_jobs SET status='cancelled',reason='rule_changed',claim_token=NULL,lease_until=NULL,updated_at=?
        WHERE workspace_id=? AND rule_id=? AND status NOT IN('sent','cancelled') AND ${guard.sql}`).bind(now,workspace,result.id,...guard.binds),
    ],result,explain:()=>Promise.resolve({ok:false,reason:'rule_conflict',detail:'规则或目标已变化、达到上限，或模块已停用；请刷新后重试'}),
  });
}
