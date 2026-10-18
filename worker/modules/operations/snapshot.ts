import {operationsSnapshotSchema,type OperationsSnapshot,type FishRegion} from '@ff14-hub/shared';
import type {Env} from '../../env';
import {pushConfigured} from '../reminders/push';
import {STALE_SCHEDULER_MS} from './scheduler';
export const SOURCE_STALE_MS=7*86400_000;

/** Workspace aggregates only; global scheduler liveness exposes no run ids or workload counts. */
export async function operationsSnapshot(env:Env,workspace:string,region:FishRegion,now=Date.now()):Promise<OperationsSnapshot>{
  const day=now-86400_000;
  const rows=await env.DB.batch<Record<string,unknown>>([
    env.DB.prepare(`SELECT status,scheduled_at AS scheduledAt,started_at AS startedAt,finished_at AS finishedAt,failure_stage AS failureStage FROM scheduler_observations ORDER BY seq DESC LIMIT 1`),
    env.DB.prepare("SELECT MAX(finished_at) AS lastSuccessAt FROM scheduler_observations WHERE status='succeeded'"),
    env.DB.prepare(`SELECT m.module_id AS id,m.status,EXISTS(SELECT 1 FROM workspace_module_operations o WHERE o.workspace_id=m.workspace_id AND o.module_id=m.module_id) AS pending
      FROM workspace_modules m WHERE m.workspace_id=? AND m.module_id IN('ff14.navigation','ff14.events','ff14.fishing','ff14.sync','ff14.reminders') ORDER BY m.module_id`).bind(workspace),
    env.DB.prepare(`SELECT COUNT(*) AS activeRules,COALESCE(SUM(last_planned_at=0),0) AS unplannedRules FROM reminder_rules WHERE workspace_id=? AND region=? AND enabled=1 AND deleted=0`).bind(workspace,region),
    env.DB.prepare(`SELECT
      COALESCE(SUM(j.due_at<=? AND j.expires_at>? AND j.status IN('queued','retry','blocked','leased')),0) AS due,
      COALESCE(SUM(j.status='blocked' AND j.expires_at>?),0) AS blocked,
      COALESCE(SUM(j.status='leased' AND j.lease_until<=? AND j.expires_at>?),0) AS staleLeases,
      COALESCE(SUM(j.status='failed' AND j.updated_at>=?),0) AS failed24h,
      MIN(CASE WHEN j.due_at<=? AND j.expires_at>? AND j.status IN('queued','retry','blocked','leased') THEN j.due_at END) AS oldestDueAt
      FROM notification_jobs j JOIN reminder_rules r ON r.workspace_id=j.workspace_id AND r.id=j.rule_id WHERE j.workspace_id=? AND r.region=?`)
      .bind(now,now,now,now,now,day,now,now,workspace,region),
    env.DB.prepare(`SELECT COALESCE(SUM(d.status='accepted'),0) AS accepted24h,COALESCE(SUM(d.status='temporary'),0) AS temporary24h,
      COALESCE(SUM(d.status='permanent'),0) AS permanent24h FROM notification_deliveries d JOIN notification_jobs j ON j.id=d.job_id
      JOIN reminder_rules r ON r.workspace_id=j.workspace_id AND r.id=j.rule_id WHERE j.workspace_id=? AND r.region=? AND d.attempted_at>=?`).bind(workspace,region,day),
    env.DB.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(json_extract(record_json,'$.demo')=1),0) AS demo,
      COALESCE(SUM(json_extract(record_json,'$.demo')=0 AND json_extract(record_json,'$.source.verificationStatus')='verified'),0) AS verified,
      COALESCE(SUM(json_extract(record_json,'$.demo')=0 AND json_extract(record_json,'$.source.verificationStatus')='verified' AND json_extract(record_json,'$.source.fetchedAt')<?),0) AS staleVerified,
      MIN(json_extract(record_json,'$.source.fetchedAt')) AS oldestFetchedAt FROM fish_catalog WHERE region=?`).bind(now-SOURCE_STALE_MS,region),
    env.DB.prepare('SELECT MAX(created_at) AS lastImportedAt,COALESCE(SUM(created_at>=?),0) AS imports24h FROM fish_sync_audit WHERE workspace_id=? AND region=?').bind(day,workspace,region),
    env.DB.prepare('SELECT COALESCE(MAX(seq),0) AS watermark FROM fish_progress_changes WHERE workspace_id=? AND region=?').bind(workspace,region),
  ]);
  const first=(index:number):Record<string,unknown>=>rows[index]?.results[0]??{};
  const snapshot=operationsSnapshotSchema.parse({
    region,observedAt:now,scheduler:{last:rows[0]?.results[0]??null,lastSuccessAt:first(1)['lastSuccessAt']??null,cadenceVerified:false},
    modules:(rows[2]?.results??[]).map((m)=>({...m,pending:m['pending']===1})),
    reminders:{...first(3),...first(4),...first(5),pushConfigurationPresent:pushConfigured(env)},
    catalog:{...first(6),fetchMonitoringAvailable:false},sync:{...first(7),...first(8),webdavFreshnessAvailable:false},alerts:[],
  });
  const add=(code:OperationsSnapshot['alerts'][number]['code'],severity:'info'|'warning'='warning')=>snapshot.alerts.push({code,severity});
  const last=snapshot.scheduler.last;
  if(last===null)add('scheduler_not_observed','info');
  else if(last.status==='failed')add('scheduler_failed');
  else if(last.status==='abandoned'||(last.status==='running'&&last.startedAt<now-STALE_SCHEDULER_MS))add('scheduler_stale');
  if(snapshot.reminders.due>0)add('due_backlog');
  if(snapshot.reminders.staleLeases>0)add('stale_leases');
  if(snapshot.reminders.failed24h+snapshot.reminders.temporary24h+snapshot.reminders.permanent24h>0)add('delivery_failures');
  if(snapshot.reminders.activeRules>0&&!snapshot.reminders.pushConfigurationPresent)add('push_unconfigured');
  if(snapshot.catalog.verified===0)add('catalog_unverified','info');
  if(snapshot.catalog.staleVerified>0)add('source_stale');
  if(snapshot.modules.some((m)=>m.pending))add('modules_pending');
  return snapshot;
}
