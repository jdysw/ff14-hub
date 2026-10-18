import {env,SELF,createExecutionContext,createScheduledController} from 'cloudflare:test';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {operationsSnapshotSchema} from '@ff14-hub/shared';
import {seedAuth,resetIdentityState,enableDemoModule,seedDevice} from './helpers';
import {observeScheduled,STALE_SCHEDULER_MS} from '../modules/operations/scheduler';
import {operationsSnapshot,SOURCE_STALE_MS} from '../modules/operations/snapshot';
import {handleScheduled} from '../scheduled';
import {demoFish,importFishBundle} from '../modules/fish/adapter';
const NOW=Date.UTC(2026,9,19);
beforeEach(resetIdentityState);
afterEach(()=>vi.restoreAllMocks());

describe('scheduler observations',()=>{
  it('awaits the actual scheduled pipeline and persists a completed run without sending externally',async()=>{
    const info=vi.spyOn(console,'info').mockImplementation(()=>undefined);
    const network=vi.spyOn(globalThis,'fetch');
    await handleScheduled(createScheduledController({scheduledTime:NOW,cron:'* * * * *'}),env,createExecutionContext());
    const row=await env.DB.prepare('SELECT status,planned,processed,failure_stage FROM scheduler_observations').first();
    expect(row).toEqual({status:'succeeded',planned:0,processed:0,failure_stage:null});
    expect(info).toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
  });
  it.each(['plan','deliver'] as const)('persists %s failure without exception text or false success',async(stage)=>{
    const secret='provider error with private subscription phrase';
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const plan=vi.fn(()=>stage==='plan'?Promise.reject(new Error(secret)):Promise.resolve(3));
    const deliver=vi.fn(()=>Promise.reject(new Error(secret)));
    await expect(observeScheduled(env.DB,NOW,{plan,deliver},()=>NOW)).rejects.toThrow('Scheduled notification processing failed');
    const row=await env.DB.prepare('SELECT status,planned,processed,failure_stage FROM scheduler_observations').first();
    expect(row).toEqual({status:'failed',planned:stage==='plan'?null:3,processed:null,failure_stage:stage});
    if(stage==='plan')expect(deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
  });
  it('does not execute effects if the initial observation cannot be persisted',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const plan=vi.fn(()=>Promise.resolve(1));const deliver=vi.fn(()=>Promise.resolve(1));
    await env.DB.prepare("CREATE TRIGGER observation_test_abort BEFORE INSERT ON scheduler_observations BEGIN SELECT RAISE(ABORT,'private test error'); END").run();
    try{
      await expect(observeScheduled(env.DB,NOW,{plan,deliver})).rejects.toThrow('Scheduled notification processing failed');
      expect(plan).not.toHaveBeenCalled();expect(deliver).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('private test error');
    }finally{await env.DB.prepare('DROP TRIGGER observation_test_abort').run();}
  });
  it('marks old unfinished observations and prunes completed history without modifying jobs',async()=>{
    vi.spyOn(console,'info').mockImplementation(()=>undefined);
    const statements=Array.from({length:105},()=>env.DB.prepare("INSERT INTO scheduler_observations(run_id,status,scheduled_at,started_at,finished_at,planned,processed) VALUES(?,'succeeded',?,?,?,0,0)").bind(crypto.randomUUID(),1,1,2));
    statements.push(env.DB.prepare("INSERT INTO scheduler_observations(run_id,status,scheduled_at,started_at) VALUES('stale','running',1,1)"));
    await env.DB.batch(statements);
    await observeScheduled(env.DB,NOW,{plan:()=>Promise.resolve(0),deliver:()=>Promise.resolve(0)},()=>NOW);
    const row=await env.DB.prepare("SELECT status,failure_stage FROM scheduler_observations WHERE run_id='stale'").first();
    expect(row).toEqual({status:'abandoned',failure_stage:'abandoned'});
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM scheduler_observations').first<{count:number}>())?.count).toBeLessThanOrEqual(101);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM notification_jobs').first<{count:number}>())?.count).toBe(0);
  });
});

async function seedRule(scope:string,region:'cn'|'global'='cn'){
  const id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO reminder_rules(workspace_id,id,region,kind,target_id,lead_minutes,enabled,deleted,revision,updated_at,last_planned_at)
    VALUES(?,?,?,'event','fixture-event',0,1,0,1,?,0)`).bind(scope,id,region,NOW).run();return id;
}
async function seedJob(scope:string,rule:string,status='queued',reason:string|null=null){
  const id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO notification_jobs(id,workspace_id,rule_id,rule_revision,source_hash,occurrence_key,starts_at,due_at,expires_at,status,reason,next_attempt_at,created_at,updated_at,dedup_key,lease_until)
    VALUES(?,?,?,1,'source','fixture',?,?,?, ?,?,?,?, ?,?,?)`)
    .bind(id,scope,rule,NOW,NOW-1000,NOW+60000,status,reason,NOW,NOW,NOW,id,status==='leased'?NOW-1:null).run();return id;
}
describe('private operational diagnostics',()=>{
  it('requires authentication, rejects scope/query injection and is no-store',async()=>{
    const url='https://hub.test/api/v1/me/operations?region=cn';
    expect((await SELF.fetch(url)).status).toBe(401);const a=await seedAuth();
    const response=await SELF.fetch(url,{headers:{Authorization:a.authorization}});
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data=operationsSnapshotSchema.parse(await response.json());
    expect(data.scheduler.last).toBeNull();expect(data.scheduler.cadenceVerified).toBe(false);
    expect(data.alerts.find((a)=>a.code==='scheduler_not_observed')?.severity).toBe('info');
    expect(data.sync.webdavFreshnessAvailable).toBe(false);expect(data.catalog.fetchMonitoringAvailable).toBe(false);
    expect((await SELF.fetch(`${url}&workspaceId=other`,{headers:{Authorization:a.authorization}})).status).toBe(422);
    expect((await SELF.fetch(url,{method:'POST',headers:{Authorization:a.authorization}})).status).toBe(405);
  });
  it('keeps workspace and region aggregates separate, omitting subscription and failure payloads',async()=>{
    const a=await seedAuth();const b=await seedAuth();
    const own=await seedRule(a.workspaceId);const foreign=await seedRule(b.workspaceId);const global=await seedRule(a.workspaceId,'global');
    const job=await seedJob(a.workspaceId,own,'blocked','arbitrary private provider body');
    await seedJob(a.workspaceId,own,'leased');await seedJob(a.workspaceId,global,'failed');await seedJob(b.workspaceId,foreign,'failed');
    const device=await seedDevice(a.workspaceId);const subscription=crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO push_subscriptions(id,workspace_id,device_id,endpoint,subscription_json,active,updated_at) VALUES(?,?,?,'https://push.private.test/opaque-path','{"keys":{"auth":"private phrase"}}',1,?)`)
      .bind(subscription,a.workspaceId,device.deviceId,NOW).run();
    await env.DB.prepare("INSERT INTO notification_deliveries(job_id,subscription_id,device_id,status,http_status,attempted_at) VALUES(?,?,?,'temporary',503,?)").bind(job,subscription,device.deviceId,NOW).run();
    await enableDemoModule(a.authorization,'ff14.reminders');
    const result=await operationsSnapshot(env,a.workspaceId,'cn',NOW);const text=JSON.stringify(result);
    expect(result.reminders).toMatchObject({activeRules:1,due:2,blocked:1,staleLeases:1,failed24h:0,temporary24h:1,pushConfigurationPresent:false});
    expect((await operationsSnapshot(env,b.workspaceId,'cn',NOW)).reminders).toMatchObject({activeRules:1,due:0,failed24h:1,temporary24h:0});
    expect((await operationsSnapshot(env,a.workspaceId,'global',NOW)).reminders.failed24h).toBe(1);
    for(const secret of ['opaque-path','private phrase','arbitrary private provider body',a.deviceToken,b.workspaceId,subscription])expect(text).not.toContain(secret);
    expect(result.modules.some((m)=>m.id==='ff14.reminders')).toBe(true);
    expect(result.alerts.map((a)=>a.code)).toEqual(expect.arrayContaining(['due_backlog','stale_leases','push_unconfigured','delivery_failures']));
  });
  it('reports stale sources and observed failures without claiming Cron or external freshness',async()=>{
    const a=await seedAuth();const record=demoFish('cn')[0]!;
    await importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:[{...record,demo:false,source:{...record.source,verificationStatus:'verified',fetchedAt:NOW-SOURCE_STALE_MS-1}}]});
    await env.DB.prepare("INSERT INTO scheduler_observations(run_id,status,scheduled_at,started_at) VALUES('unfinished','running',?,?)").bind(NOW-STALE_SCHEDULER_MS-1,NOW-STALE_SCHEDULER_MS-1).run();
    const stale=await operationsSnapshot(env,a.workspaceId,'cn',NOW);
    expect(stale.catalog).toMatchObject({total:1,verified:1,staleVerified:1});
    expect(stale.alerts.map((a)=>a.code)).toEqual(expect.arrayContaining(['source_stale','scheduler_stale']));
    vi.spyOn(console,'error').mockImplementation(()=>undefined);
    await expect(observeScheduled(env.DB,NOW,{plan:()=>Promise.reject(new Error('private')),deliver:()=>Promise.resolve(0)},()=>NOW)).rejects.toThrow();
    const failed=await operationsSnapshot(env,a.workspaceId,'cn',NOW);
    expect(failed.scheduler.last?.failureStage).toBe('plan');expect(failed.alerts.some((a)=>a.code==='scheduler_failed')).toBe(true);
  });
});
