import { fishRecordSchema,fishWindows,REMINDER_MODULE_ID,type ReminderRule } from '@ff14-hub/shared';
import { fingerprintOf } from '../idempotency/ledger';
import { MODULE_GATE_SQL,parseRule,RULE_COLUMNS } from './rules';
export interface Occurrence{key:string;startsAt:number;expiresAt:number;sourceHash:string}
export async function occurrences(db:D1Database,workspace:string,rule:ReminderRule,now:number):Promise<Occurrence[]>{
  const gate=await db.prepare(`SELECT 1 AS ok WHERE ${MODULE_GATE_SQL} AND ${MODULE_GATE_SQL}`).bind(workspace,REMINDER_MODULE_ID,
    workspace,rule.kind==='fish'?'ff14.fishing':'ff14.events').first();
  if(gate===null || !rule.enabled || rule.deleted)return [];
  if(rule.kind==='event'){
    const event=await db.prepare(`SELECT revision,starts_at,ends_at FROM workspace_events WHERE workspace_id=? AND region=? AND id=? AND deleted_at IS NULL`)
      .bind(workspace,rule.region,rule.targetId).first<{revision:number;starts_at:number;ends_at:number}>();
    if(event===null || event.ends_at<=now)return [];
    return [{key:`event:${rule.targetId}:${String(event.starts_at)}`,startsAt:event.starts_at,expiresAt:Math.min(event.ends_at,event.starts_at+15*60_000),
      sourceHash:await fingerprintOf('event.source',event)}];
  }
  const rows=await db.batch<Record<string,unknown>>([
    db.prepare('SELECT record_json FROM fish_catalog WHERE region=? AND CAST(fish_id AS TEXT)=?').bind(rule.region,rule.targetId),
    db.prepare("SELECT field,value FROM fish_state_fields WHERE workspace_id=? AND region=? AND CAST(fish_id AS TEXT)=? AND field IN('caught','alarm')").bind(workspace,rule.region,rule.targetId),
  ]);
  const json=rows[0]?.results[0]?.['record_json'];if(typeof json!=='string')return [];
  const record=fishRecordSchema.parse(JSON.parse(json) as unknown);
  const progress=rows[1]?.results ?? [];
  if(record.demo || record.source.verificationStatus!=='verified' || record.rule.validationStatus!=='verified' || record.rule.conditions.length>0 ||
    progress.some((f)=>f['field']==='caught'&&f['value']===1) || !progress.some((f)=>f['field']==='alarm'&&f['value']===1))return [];
  const sourceHash=await fingerprintOf('fish.source',record.rule);
  return fishWindows({region:rule.region,rules:[record.rule],from:Math.max(0,now-15*60_000),to:now+72*3600_000})
    .filter((w)=>!w.candidateOnly&&!w.unrestricted).map((w)=>({key:w.occurrenceKey,startsAt:w.startsAtUtcMs,
      expiresAt:Math.min(w.endsAtUtcMs,w.startsAtUtcMs+15*60_000),sourceHash}));
}
export async function planNotifications(db:D1Database,now:number,workspace?:string):Promise<number>{
  const rows=await db.prepare(`SELECT workspace_id,${RULE_COLUMNS} FROM reminder_rules WHERE enabled=1 AND deleted=0
    ${workspace===undefined?'':'AND workspace_id=?'} ORDER BY last_planned_at,id LIMIT 20`).bind(...(workspace===undefined?[]:[workspace])).all<Record<string,unknown>>();
  let count=0;
  for(const row of rows.results){
    const scope=String(row['workspace_id']);const rule=parseRule(row);
    const candidates=(await occurrences(db,scope,rule,now)).map((o)=>({...o,dueAt:o.startsAt-rule.leadMinutes*60_000,
      expiresAt:Math.min(o.expiresAt,o.startsAt-rule.leadMinutes*60_000+15*60_000)}))
      .filter((o)=>o.expiresAt>now&&o.dueAt<=now+6*3600_000).slice(0,50);
    const statements=candidates.map((o)=>db.prepare(`INSERT INTO notification_jobs
      (id,workspace_id,rule_id,rule_revision,source_hash,occurrence_key,starts_at,due_at,expires_at,status,next_attempt_at,created_at,updated_at,dedup_key)
      SELECT ?,?,?,?,?,?,?,?,?,'queued',?,?,?,? WHERE EXISTS(SELECT 1 FROM reminder_rules WHERE workspace_id=? AND id=? AND revision=? AND enabled=1 AND deleted=0)
      ON CONFLICT(workspace_id,dedup_key) DO NOTHING`).bind(crypto.randomUUID(),scope,rule.id,rule.revision,o.sourceHash,o.key,o.startsAt,
        o.dueAt,o.expiresAt,o.dueAt,now,now,
        `${rule.id}:${String(rule.revision)}:${o.sourceHash}:${o.key}`,scope,rule.id,rule.revision));
    statements.push(db.prepare('UPDATE reminder_rules SET last_planned_at=? WHERE workspace_id=? AND id=? AND revision=?').bind(now,scope,rule.id,rule.revision));
    const result=await db.batch(statements);count+=result.slice(0,-1).reduce((sum,r)=>sum+r.meta.changes,0);
  }
  return count;
}
