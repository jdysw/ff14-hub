import { pushSubscriptionInputSchema } from '@ff14-hub/shared';
import { occurrences } from './planner';
import { ruleById } from './rules';
import type { PushTransport } from './push';
export interface JobRow{id:string;workspace_id:string;rule_id:string;rule_revision:number;source_hash:string;occurrence_key:string;
  starts_at:number;due_at:number;expires_at:number;attempts:number;claim_token:string;lease_until:number}
export const JOB_LEASE_MS=120_000;
export async function claimJob(db:D1Database,id:string,now:number):Promise<JobRow|null>{
  return db.prepare(`UPDATE notification_jobs SET status='leased',claim_token=?,lease_until=?,attempts=attempts+1,updated_at=?
    WHERE id=? AND next_attempt_at<=? AND due_at<=? AND expires_at>? AND attempts<5
      AND (status IN('queued','retry','blocked') OR (status='leased' AND lease_until<=?)) RETURNING *`)
    .bind(crypto.randomUUID(),now+JOB_LEASE_MS,now,id,now,now,now,now).first<JobRow>();
}
async function validJob(db:D1Database,job:JobRow,now:number):Promise<boolean>{
  const owned=await db.prepare("SELECT 1 AS ok FROM notification_jobs WHERE id=? AND status='leased' AND claim_token=? AND lease_until>?")
    .bind(job.id,job.claim_token,now).first();
  if(owned===null || job.expires_at<=now)return false;
  const rule=await ruleById(db,job.workspace_id,job.rule_id);
  if(rule===null || rule.revision!==job.rule_revision || !rule.enabled || rule.deleted)return false;
  return (await occurrences(db,job.workspace_id,rule,now)).some((o)=>o.key===job.occurrence_key&&o.sourceHash===job.source_hash&&o.expiresAt>now);
}
export async function finishJob(db:D1Database,job:JobRow,status:string,reason:string|null,now:number,next=now):Promise<void>{
  await db.prepare(`UPDATE notification_jobs SET status=?,reason=?,next_attempt_at=?,claim_token=NULL,lease_until=NULL,updated_at=?,
    attempts=attempts-? WHERE id=? AND status='leased' AND claim_token=? AND lease_until>?`)
    .bind(status,reason,next,now,status==='blocked'?1:0,job.id,job.claim_token,now).run();
}
/** Logical jobs are deduplicated. Network timeouts are at-least-once; push tag limits duplicate display. */
export async function runNotifications(db:D1Database,transport:PushTransport,clock:()=>number=Date.now,workspace?:string):Promise<number>{
  const now=clock();
  await db.prepare(`UPDATE notification_jobs SET status='failed',reason='attempts_exhausted',claim_token=NULL,lease_until=NULL
    WHERE id IN(SELECT id FROM notification_jobs WHERE status='leased' AND lease_until<=? AND attempts>=5
      ${workspace===undefined?'':'AND workspace_id=?'} LIMIT 100)`).bind(now,...(workspace===undefined?[]:[workspace])).run();
  await db.prepare(`UPDATE notification_jobs SET status='suppressed',reason='expired',claim_token=NULL,lease_until=NULL
    WHERE id IN(SELECT id FROM notification_jobs WHERE expires_at<=? AND status IN('queued','retry','blocked','leased')
      ${workspace===undefined?'':'AND workspace_id=?'} LIMIT 100)`).bind(now,...(workspace===undefined?[]:[workspace])).run();
  const rows=await db.prepare(`SELECT id FROM notification_jobs WHERE next_attempt_at<=? AND due_at<=? AND expires_at>?
    AND (status IN('queued','retry','blocked') OR (status='leased' AND lease_until<=?))
    ${workspace===undefined?'':'AND workspace_id=?'} ORDER BY next_attempt_at,id LIMIT 20`).bind(now,now,now,now,...(workspace===undefined?[]:[workspace])).all<{id:string}>();
  let processed=0;
  for(const row of rows.results){
    const job=await claimJob(db,row.id,clock());if(job===null)continue;processed+=1;
    if(!await validJob(db,job,clock())){await finishJob(db,job,'suppressed','source_or_rule_inactive',clock());continue;}
    const subscriptions=await db.prepare(`SELECT s.id,s.device_id,s.subscription_json FROM push_subscriptions s JOIN devices d ON d.id=s.device_id AND d.workspace_id=s.workspace_id
      WHERE s.workspace_id=? AND s.active=1 AND d.revoked_at IS NULL ORDER BY s.id LIMIT 10`).bind(job.workspace_id)
      .all<{id:string;device_id:string;subscription_json:string}>();
    if(!transport.configured || subscriptions.results.length===0){
      await finishJob(db,job,'blocked',transport.configured?'no_active_device':'push_unconfigured',clock(),clock()+300_000);continue;
    }
    let temporary=false;let accepted=0;let retryAfter=0;
    for(const sub of subscriptions.results){
      if(!await validJob(db,job,clock()))break;
      const current=await db.prepare(`SELECT 1 AS ok FROM push_subscriptions s JOIN devices d ON d.id=s.device_id AND d.workspace_id=s.workspace_id
        WHERE s.id=? AND s.workspace_id=? AND s.subscription_json=? AND s.active=1 AND d.revoked_at IS NULL`)
        .bind(sub.id,job.workspace_id,sub.subscription_json).first();
      if(current===null)continue;
      const prior=await db.prepare("SELECT status FROM notification_deliveries WHERE job_id=? AND subscription_id=? AND status IN('accepted','permanent')").bind(job.id,sub.id).first<{status:string}>();
      if(prior!==null){if(prior.status==='accepted')accepted+=1;continue;}
      let status:number;
      try{const result=await transport.send(pushSubscriptionInputSchema.parse(JSON.parse(sub.subscription_json) as unknown),job.id);
        status=result.status;retryAfter=Math.max(retryAfter,result.retryAfterMs ?? 0);
      }catch{status=0;}
      const outcome=status>=200&&status<300?'accepted':status===0||status===408||status===429||status>=500?'temporary':'permanent';
      if(outcome==='temporary')temporary=true;
      if(outcome==='accepted')accepted+=1;
      const guard="EXISTS(SELECT 1 FROM notification_jobs WHERE id=? AND status='leased' AND claim_token=? AND lease_until>?)";
      await db.batch([
        db.prepare(`INSERT INTO notification_deliveries(job_id,subscription_id,device_id,status,http_status,attempted_at)
          SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT(job_id,subscription_id) DO UPDATE SET status=excluded.status,http_status=excluded.http_status,attempted_at=excluded.attempted_at`)
          .bind(job.id,sub.id,sub.device_id,outcome,status||null,clock(),job.id,job.claim_token,clock()),
        db.prepare(`UPDATE push_subscriptions SET active=0 WHERE id=? AND subscription_json=? AND ? IN(404,410) AND ${guard}`)
          .bind(sub.id,sub.subscription_json,status,job.id,job.claim_token,clock()),
      ]);
    }
    if(!await validJob(db,job,clock())){await finishJob(db,job,'suppressed','source_changed_during_delivery',clock());continue;}
    const state=temporary?(job.attempts>=5?'failed':'retry'):accepted>0?'sent':'failed';
    await finishJob(db,job,state,temporary?'temporary_delivery':accepted>0?null:'no_accepted_delivery',clock(),
      clock()+Math.max(retryAfter,Math.min(3600_000,30_000*2**(job.attempts-1))));
  }
  return processed;
}
