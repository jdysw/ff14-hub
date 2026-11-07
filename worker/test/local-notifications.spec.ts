import './setup-d1';
import {env,SELF} from 'cloudflare:test';
import {beforeEach,expect,it,vi} from 'vitest';
import {replaceLocalJobs,runLocalNotifications} from '../modules/reminders/local-push';
import {planDailyFishDigests} from '../modules/reminders/fish-digest';
import type {FishDigestSettings,LocalNotificationJob} from '@ff14-hub/shared';
const channel={kind:'serverchan' as const,sendKey:'SCTtest_only_abcdefghijklmnopqrst'};
const digest:FishDigestSettings={enabled:true,time:'08:00',eventEndDays:[3,1],targets:[]};
const root='https://example.com/api/v1/local-notifications';
beforeEach(async()=>{await env.DB.prepare('DELETE FROM local_push_devices').run();await env.DB.prepare("DELETE FROM auth_rate_limits WHERE scope_key LIKE 'local-push:%'").run();});
async function register(){const response=await SELF.fetch(root+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel,jobs:[],digest,dailyLimit:1})});expect(response.status).toBe(201);return (await response.json<{token:string}>()).token;}

it('scopes subscriptions to opaque credentials, never returns channel keys, and deletes all jobs on stop',async()=>{
  const token=await register();
  expect((await SELF.fetch(root+'/status')).status).toBe(401);
  const status=await SELF.fetch(root+'/status',{headers:{Authorization:'Bearer '+token}});
  expect(status.status).toBe(200);expect(await status.text()).not.toContain(channel.sendKey);
  const row=await env.DB.prepare('SELECT token_hash,channel_ciphertext FROM local_push_devices').first<{token_hash:string;channel_ciphertext:string}>();
  expect(row?.token_hash).not.toContain(token);expect(row?.channel_ciphertext).not.toContain(channel.sendKey);
  expect((await SELF.fetch(root+'/subscription',{method:'DELETE',headers:{Authorization:'Bearer '+token}})).status).toBe(200);
  expect((await SELF.fetch(root+'/status',{headers:{Authorization:'Bearer '+token}})).status).toBe(401);
});
it('batches simultaneous jobs, deduplicates concurrent ticks and enforces the daily cap',async()=>{
  await register();const row=await env.DB.prepare('SELECT id FROM local_push_devices').first<{id:string}>();const id=row!.id,now=Date.now();
  const job=(key:string):LocalNotificationJob=>({key,title:'测试提醒',body:'正文',dueAt:now-1,expiresAt:now+600_000});
  await replaceLocalJobs(env.DB,id,[job('first'),job('second')],now);
  const send=vi.fn(()=>Promise.resolve(200));
  const results=await Promise.all([runLocalNotifications(env.DB,now,send),runLocalNotifications(env.DB,now,send)]);
  expect(results.reduce((sum,value)=>sum+value,0)).toBe(1);expect(send).toHaveBeenCalledOnce();
  await replaceLocalJobs(env.DB,id,[job('first'),job('third')],now);
  expect(await runLocalNotifications(env.DB,now+1,send)).toBe(0);expect(send).toHaveBeenCalledOnce();
});
it('limits retries without leaking provider content',async()=>{
  await register();const row=await env.DB.prepare('SELECT id FROM local_push_devices').first<{id:string}>();const id=row!.id,now=Date.now();
  await env.DB.prepare('UPDATE local_push_devices SET daily_limit=10 WHERE id=?').bind(id).run();
  await replaceLocalJobs(env.DB,id,[{key:'retry',title:'测试',body:'正文',dueAt:now,expiresAt:now+1200_000}],now);
  const send=vi.fn(()=>Promise.resolve(503));
  for(let tick=0;tick<4;tick++)await runLocalNotifications(env.DB,now+tick*300_000,send);
  expect(send).toHaveBeenCalledTimes(3);
});
it('refunds rejected provider attempts without exhausting the daily delivery quota',async()=>{
  await register();
  const {id}= (await env.DB.prepare('SELECT id FROM local_push_devices').first<{id:string}>())!;
  // 使用执行当天的 UTC 正午，避免跨午夜随机失败，也防止固定日期过期使测试失效。
  const now=Date.parse(new Date().toISOString().slice(0,10)+'T12:00:00Z');
  const job=(key:string):LocalNotificationJob=>({key,title:key,body:'正文',dueAt:now,expiresAt:now+600_000});
  await replaceLocalJobs(env.DB,id,[job('retry')],now);
  const failing=vi.fn(()=>Promise.resolve(503));
  expect(await runLocalNotifications(env.DB,now,failing)).toBe(0);
  expect((await env.DB.prepare('SELECT sent_count FROM local_push_devices WHERE id=?').bind(id).first<{sent_count:number}>())?.sent_count).toBe(0);
  // Retrying the same job doesn't consume successful-delivery capacity.
  expect(await runLocalNotifications(env.DB,now+300_001,failing)).toBe(0);
  expect((await env.DB.prepare('SELECT sent_count FROM local_push_devices WHERE id=?').bind(id).first<{sent_count:number}>())?.sent_count).toBe(0);
  await replaceLocalJobs(env.DB,id,[job('delivered')],now+300_002);
  const success=vi.fn(()=>Promise.resolve(200));
  expect(await runLocalNotifications(env.DB,now+300_002,success)).toBe(1);
  expect(success).toHaveBeenCalledOnce();
  expect((await env.DB.prepare('SELECT sent_count FROM local_push_devices WHERE id=?').bind(id).first<{sent_count:number}>())?.sent_count).toBe(1);
  // Once a delivery is accepted, a second one cannot exceed the daily cap.
  await replaceLocalJobs(env.DB,id,[job('extra')],now+300_003);
  expect(await runLocalNotifications(env.DB,now+300_003,success)).toBe(0);
  expect(success).toHaveBeenCalledOnce();
});


it('does not refund another lease when a delayed worker loses ownership',async()=>{
  await register();
  const {id}=(await env.DB.prepare('SELECT id FROM local_push_devices').first<{id:string}>())!;
  const now=Date.now();
  await replaceLocalJobs(env.DB,id,[{key:'claimed',title:'测试',body:'正文',dueAt:now,expiresAt:now+600_000}],now);
  const gate:{reject?:(error:Error)=>void}={};
  let started:()=>void=()=>{};
  const pending=new Promise<void>(resolve=>{started=resolve;});
  const inFlight=runLocalNotifications(env.DB,now,()=>new Promise<number>((_,reject)=>{gate.reject=reject;started();}));
  await pending;
  // Simulate lease takeover after the original worker's call stalls.
  await env.DB.prepare("UPDATE local_push_jobs SET claim_token='newer-claim' WHERE device_id=? AND job_key='claimed'").bind(id).run();
  gate.reject?.(new Error('delayed transport error'));
  expect(await inFlight).toBe(0);
  expect((await env.DB.prepare('SELECT sent_count FROM local_push_devices WHERE id=?').bind(id).first<{sent_count:number}>())?.sent_count).toBe(1);
});

it('builds and persists one complete daily digest from the static catalogue while the browser is closed',async()=>{
  await register();const now=Date.now(),settings={...digest,eventEndDays:[],targets:[{region:'cn' as const,fishId:1}]};
  await env.DB.prepare('UPDATE local_push_devices SET digest_json=?,digest_next_at=?').bind(JSON.stringify(settings),now-1).run();
  const rule={schemaVersion:1,region:'cn',fishId:1,version:'v1',zoneId:'test',startHour:1,endHour:3,weatherRates:[{weather:'clear',chance:100}],currentWeather:[],previousWeather:[],conditions:[],validationStatus:'verified'};
  const assets={fetch:()=>Promise.resolve(Response.json({fish:[{id:1,name:'每日测试鱼',location:'测试钓场',rule}]}))} as unknown as Fetcher;
  await planDailyFishDigests({...env,ASSETS:assets},now);
  await planDailyFishDigests({...env,ASSETS:assets},now+1);
  const jobs=await env.DB.prepare('SELECT payload FROM local_push_jobs').all<{payload:string}>();
  expect(jobs.results).toHaveLength(1);expect(jobs.results[0]?.payload).toContain('每日测试鱼');
  expect(jobs.results[0]?.payload).toContain('今天');expect(jobs.results[0]?.payload).toContain('明天');
});
