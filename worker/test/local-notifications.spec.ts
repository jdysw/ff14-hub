import {env,SELF} from 'cloudflare:test';
import {beforeEach,expect,it,vi} from 'vitest';
import {encryptChannel,decryptChannel} from '../modules/reminders/notification-channel';
import {replaceLocalJobs,runLocalNotifications} from '../modules/reminders/local-push';
import {nextDigestAt,renderFishDigest,planDailyFishDigests} from '../modules/reminders/fish-digest';
import type {FishDigestSettings,LocalNotificationJob} from '@ff14-hub/shared';
const secret='test-only-bootstrap-secret-value-0123456789';
const channel={kind:'serverchan' as const,sendKey:'SCTtest_only_abcdefghijklmnopqrst'};
const digest:FishDigestSettings={enabled:true,time:'08:00',eventEndDays:[3,1],targets:[]};
const root='https://example.com/api/v1/local-notifications';
beforeEach(async()=>{await env.DB.prepare('DELETE FROM local_push_devices').run();await env.DB.prepare("DELETE FROM auth_rate_limits WHERE scope_key LIKE 'local-push:%'").run();});
async function register(){const response=await SELF.fetch(root+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel,jobs:[],digest,dailyLimit:1})});expect(response.status).toBe(201);return (await response.json<{token:string}>()).token;}
it('encrypts channel credentials with device-bound authenticated encryption',async()=>{
  const encoded=await encryptChannel(channel,secret,'device-a');expect(encoded).not.toContain(channel.sendKey);
  expect(await decryptChannel(encoded,secret,'device-a')).toEqual(channel);
  await expect(decryptChannel(encoded,secret,'device-b')).rejects.toThrow();
});
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
  const now=Date.now();
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
it('holds capacity for an in-flight provider call and releases it on a thrown error',async()=>{
  await register();
  const {id}= (await env.DB.prepare('SELECT id FROM local_push_devices').first<{id:string}>())!;
  const now=Date.now();
  const job=(key:string):LocalNotificationJob=>({key,title:key,body:'正文',dueAt:now,expiresAt:now+600_000});
  await replaceLocalJobs(env.DB,id,[job('first'),job('second')],now);
  let rejectSend:((cause:Error)=>void)|undefined;
  let started:()=>void=()=>{};
  const startedPromise=new Promise<void>(resolve=>{started=resolve;});
  const sender=vi.fn(()=>new Promise<number>((_,reject)=>{rejectSend=reject;started();}));
  const first=runLocalNotifications(env.DB,now,sender);
  await startedPromise;
  expect(await runLocalNotifications(env.DB,now+1,sender)).toBe(0);
  expect(sender).toHaveBeenCalledOnce();
  rejectSend?.(new Error('provider timeout'));
  expect(await first).toBe(0);
  expect((await env.DB.prepare('SELECT sent_count FROM local_push_devices WHERE id=?').bind(id).first<{sent_count:number}>())?.sent_count).toBe(0);
});
it('keeps saved delivery time and deadline options when a delayed client only updates watched fish',async()=>{
  const token=await register();
  const put=(value:unknown)=>SELF.fetch(root+'/plan',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(value)});
  expect((await put({jobs:[],digest:{...digest,time:'09:15',eventEndDays:[1]}})).status).toBe(200);
  expect((await put({jobs:[],digest:{...digest,targets:[{region:'cn',fishId:1}]},targetsOnly:true})).status).toBe(200);
  const row=await env.DB.prepare('SELECT digest_json FROM local_push_devices').first<{digest_json:string}>();
  expect(JSON.parse(row!.digest_json)).toMatchObject({time:'09:15',eventEndDays:[1],targets:[{region:'cn',fishId:1}]});
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
it('schedules user-selected China time and lists every repeated fish window in chronological day groups',()=>{
  const now=Date.parse('2026-10-21T00:00:00Z');
  expect(nextDigestAt(now,'09:15')).toBe(Date.parse('2026-10-21T01:15:00Z'));
  expect(nextDigestAt(now,'08:00')).toBe(Date.parse('2026-10-22T00:00:00Z'));
  const rule={schemaVersion:1 as const,region:'cn' as const,fishId:1,version:'v1',zoneId:'test',startHour:1,endHour:3,weatherRates:[{weather:'clear',chance:100}],currentWeather:[],previousWeather:[],conditions:[],validationStatus:'verified' as const};
  const result=renderFishDigest({...digest,targets:[{region:'cn',fishId:1}]},now,{cn:{fish:[{id:1,name:'测试鱼',location:'测试钓场',rule}]}});
  expect(result.body).toContain('今天 2026-10-21');expect(result.body).toContain('明天 2026-10-22');
  expect(result.body.split('测试鱼').length).toBeGreaterThan(3);
  for(const group of result.body.split(/今天|明天/).slice(1)){
    const times=[...group.matchAll(/^(\d{2}):(\d{2})–/gm)].map(match=>Number(match[1])*60+Number(match[2]));expect(times).toEqual([...times].sort((a,b)=>a-b));
  }
});
it('labels community and intuition windows as candidates and never sends unrestricted or unknown mechanics as openings',()=>{
  const now=Date.parse('2026-10-21T00:00:00Z');
  const rule={schemaVersion:1 as const,region:'cn' as const,fishId:1,version:'community',zoneId:'test',startHour:1,endHour:3,weatherRates:[{weather:'clear',chance:100}],currentWeather:[],previousWeather:[],conditions:[{kind:'intuition' as const,description:'需鱼识'}],validationStatus:'unverified' as const};
  const target={...digest,targets:[{region:'cn' as const,fishId:1}]};
  const render=(r:typeof rule)=>renderFishDigest(target,now,{cn:{fish:[{id:1,name:'候选测试鱼',location:'测试钓场',rule:r}]}});
  const candidate=render(rule);expect(candidate.actionable).toBe(true);expect(candidate.body).toContain('[候选]');expect(candidate.body).toContain('鱼识');
  const unrestricted=render({...rule,startHour:0,endHour:24});expect(unrestricted.actionable).toBe(false);expect(unrestricted.body).not.toContain('00:00–24:00');
  const unknown=renderFishDigest(target,now,{cn:{fish:[{id:1,name:'未知',location:'测试钓场',rule:{...rule,conditions:[{kind:'unknown',description:'未建模'}]}}]}});expect(unknown.actionable).toBe(false);expect(unknown.body).toContain('未知机制');
});
it('includes optional 3-day and 1-day deadlines without turning undated announcements into reminders',()=>{
  const now=Date.parse('2026-10-21T00:00:00Z');
  const event=(id:string,days:number|null)=>({id,title:id,region:'cn' as const,category:'活动',description:'',location:'',startsAt:now-86400_000,endsAt:days===null?null:now+days*86400_000,sourceUrl:null,allDay:false});
  const events=[event('three-days',2.5),event('one-day',0.5),event('two-days',1.5),event('undated',null)];
  const result=renderFishDigest(digest,now,{},events);expect(result.body).toContain('three-days');expect(result.body).toContain('one-day');expect(result.body).not.toContain('two-days');expect(result.body).not.toContain('undated');
  expect(renderFishDigest({...digest,eventEndDays:[1]},now,{},events).body).not.toContain('three-days');
  expect(renderFishDigest(digest,now,{},[]).actionable).toBe(false);
});
