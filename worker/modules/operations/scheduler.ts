import {logLine} from '../../lib/redact';
export const STALE_SCHEDULER_MS=30*60_000;
type Stage='start'|'plan'|'deliver'|'finish';

/** Journal before effects; failures are rethrown with a fixed message for platform logs. */
export async function observeScheduled(db:D1Database,scheduledAt:number,work:{plan:()=>Promise<number>;deliver:()=>Promise<number>},clock:()=>number=Date.now):Promise<void>{
  const runId=crypto.randomUUID();let stage:Stage='start';let recorded=false;let planned:number|null=null;let processed:number|null=null;
  try{
    const startedAt=clock();
    await db.batch([
      db.prepare(`UPDATE scheduler_observations SET status='abandoned',finished_at=?,failure_stage='abandoned'
        WHERE seq IN(SELECT seq FROM scheduler_observations WHERE status='running' AND started_at<? LIMIT 100)`).bind(startedAt,startedAt-STALE_SCHEDULER_MS),
      db.prepare(`DELETE FROM scheduler_observations WHERE seq IN(SELECT seq FROM scheduler_observations WHERE status!='running' ORDER BY seq DESC LIMIT 100 OFFSET 100)`),
      db.prepare("INSERT INTO scheduler_observations(run_id,status,scheduled_at,started_at) VALUES(?,'running',?,?)").bind(runId,scheduledAt,startedAt),
    ]);
    recorded=true;stage='plan';planned=await work.plan();stage='deliver';processed=await work.deliver();stage='finish';
    const finished=await db.prepare("UPDATE scheduler_observations SET status='succeeded',finished_at=?,planned=?,processed=? WHERE run_id=? AND status='running'")
      .bind(clock(),planned,processed,runId).run();
    if(finished.meta.changes!==1)throw new Error('Scheduled observation no longer owned');
    console.info(logLine('info','scheduled_notifications',{runId,planned:String(planned),processed:String(processed),scheduledTime:String(scheduledAt)}));
  }catch{
    if(recorded){
      try{await db.prepare("UPDATE scheduler_observations SET status='failed',finished_at=?,planned=?,processed=?,failure_stage=? WHERE run_id=? AND status='running'")
        .bind(clock(),planned,processed,stage,runId).run();}catch{/* Observation storage failure is surfaced by the platform failure below. */}
    }
    console.error(logLine('error','scheduled_notifications_failed',{runId,stage,scheduledTime:String(scheduledAt)}));
    throw new Error('Scheduled notification processing failed; inspect operational run metadata');
  }
}
