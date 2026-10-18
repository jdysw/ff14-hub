import { SELF,env } from 'cloudflare:test';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { REMINDER_MODULE_ID,reminderSnapshotSchema,pushSubscriptionInputSchema } from '@ff14-hub/shared';
import { seedAuth,seedDevice,resetIdentityState,enableDemoModule,jsonPut,opId,patchModule } from './helpers';
import { importFishBundle,demoFish } from '../modules/fish/adapter';
import { planNotifications } from '../modules/reminders/planner';
import { claimJob,finishJob,runNotifications,JOB_LEASE_MS } from '../modules/reminders/runner';
import { createPushTransport } from '../modules/reminders/push';
const BASE='https://hub.test/api/v1/me/reminders';
const NOW=Date.UTC(2026,9,18,0);
const sub={endpoint:'https://fcm.googleapis.com/fcm/send/test',expirationTime:null,keys:{p256dh:'B'+'A'.repeat(86),auth:'A'.repeat(22)}};
beforeEach(resetIdentityState);
afterEach(()=>vi.restoreAllMocks());
async function setup(){
  const a=await seedAuth();await enableDemoModule(a.authorization,REMINDER_MODULE_ID);await enableDemoModule(a.authorization,'ff14.events');
  const id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO workspace_events(id,workspace_id,region,title,description,starts_at,ends_at,verification_status,revision,created_at,updated_at)
    VALUES(?,?,'cn','提醒测试','',?,?,'unverified',1,?,?)`).bind(id,a.workspaceId,NOW+60_000,NOW+600_000,NOW,NOW).run();
  const input={id:crypto.randomUUID(),kind:'event',region:'cn',targetId:id,leadMinutes:1,enabled:true,expectedRevision:0,operationId:opId('rule')};
  const response=await SELF.fetch(`${BASE}/rules`,jsonPut(input,{Authorization:a.authorization}));
  expect(response.status,await response.clone().text()).toBe(200);
  return {...a,eventId:id,input};
}
async function register(a:Awaited<ReturnType<typeof setup>>,endpoint=sub.endpoint){
  const response=await SELF.fetch(`${BASE}/push`,jsonPut({...sub,endpoint},{Authorization:a.authorization}));
  expect(response.status,await response.clone().text()).toBe(200);
}
async function state(a:{authorization:string}){
  const response=await SELF.fetch(BASE,{headers:{Authorization:a.authorization}});
  return reminderSnapshotSchema.parse(await response.json());
}
describe('rules and scope',()=>{
  it('requires authentication, enforces scope, handles exact replay and stale revisions',async()=>{
    expect((await SELF.fetch(BASE)).status).toBe(401);
    const a=await setup();const b=await setup();
    expect((await state(a)).rules).toHaveLength(1);expect((await state(b)).rules).toHaveLength(1);
    expect((await SELF.fetch(`${BASE}/rules`,jsonPut(a.input,{Authorization:a.authorization}))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/rules`,jsonPut({...a.input,leadMinutes:2},{Authorization:a.authorization}))).status).toBe(409);
    expect((await SELF.fetch(`${BASE}/rules`,jsonPut({...a.input,operationId:opId('stale')},{Authorization:a.authorization}))).status).toBe(409);
    expect((await SELF.fetch(`${BASE}/rules`,jsonPut({...a.input,id:crypto.randomUUID(),targetId:b.eventId,operationId:opId('foreign')},{Authorization:a.authorization}))).status).toBe(409);
    await planNotifications(env.DB,NOW,a.workspaceId);
    expect((await state(b)).jobs).toHaveLength(0);
    expect((await SELF.fetch(`${BASE}/rules`,jsonPut({...a.input,id:crypto.randomUUID(),kind:'fish',targetId:'1',leadMinutes:4321,operationId:opId('too-early')},{Authorization:a.authorization}))).status).toBe(422);
  });
  it('deduplicates jobs and cancels old generations on rule edit',async()=>{
    const a=await setup();expect(await planNotifications(env.DB,NOW,a.workspaceId)).toBe(1);
    expect(await planNotifications(env.DB,NOW,a.workspaceId)).toBe(0);
    const edited=await SELF.fetch(`${BASE}/rules`,jsonPut({...a.input,leadMinutes:2,expectedRevision:1,operationId:opId('edit')},{Authorization:a.authorization}));
    expect(edited.status).toBe(200);
    expect((await state(a)).jobs[0]?.status).toBe('cancelled');
    expect(await planNotifications(env.DB,NOW,a.workspaceId)).toBe(1);
  });
  it('never accepts arbitrary/internal push endpoints and never lists subscription secrets',async()=>{
    for(const endpoint of ['not a url','','https://127.0.0.1/test','http://fcm.googleapis.com/test','https://fcm.googleapis.com.evil.test/','https://user@fcm.googleapis.com/'])
      expect(pushSubscriptionInputSchema.safeParse({...sub,endpoint}).success).toBe(false);
    const a=await setup();await register(a);
    const response=JSON.stringify(await state(a));expect(response).not.toContain(sub.endpoint);expect(response).not.toContain(sub.keys.p256dh);
    const b=await setup();expect((await SELF.fetch(`${BASE}/push`,jsonPut(sub,{Authorization:b.authorization}))).status).toBe(409);
  });
});
describe('scheduler leases and suppression',()=>{
  it('allows only one concurrent claim and fences late completions after reclamation',async()=>{
    const a=await setup();await planNotifications(env.DB,NOW,a.workspaceId);const id=(await state(a)).jobs[0]?.id??'';
    const claims=await Promise.all([claimJob(env.DB,id,NOW),claimJob(env.DB,id,NOW)]);
    expect(claims.filter(Boolean)).toHaveLength(1);const old=claims.find((c)=>c!==null);if(old==null)throw new Error('claim missing');
    const newer=await claimJob(env.DB,id,NOW+JOB_LEASE_MS);expect(newer).not.toBeNull();
    await finishJob(env.DB,old,'sent',null,NOW+JOB_LEASE_MS);
    expect((await state(a)).jobs[0]?.status).toBe('leased');
  });
  it('records unconfigured transport as blocked without consuming retries or inventing a delivery',async()=>{
    const a=await setup();await planNotifications(env.DB,NOW,a.workspaceId);
    const send=vi.fn(()=>Promise.resolve({status:201}));
    await runNotifications(env.DB,{configured:false,send},()=>NOW,a.workspaceId);
    const snapshot=await state(a);expect(snapshot.jobs[0]?.status).toBe('blocked');expect(snapshot.jobs[0]?.attempts).toBe(0);
    expect(snapshot.deliveries).toHaveLength(0);expect(send).not.toHaveBeenCalled();
  });
  it.each(['module','event','device'] as const)('rechecks %s immediately before delivery',async(change)=>{
    const a=await setup();await register(a);await planNotifications(env.DB,NOW,a.workspaceId);
    if(change==='module')await patchModule(a.authorization,'ff14.events',{action:'disable',expectedRevision:1});
    if(change==='event')await env.DB.prepare('UPDATE workspace_events SET deleted_at=? WHERE id=?').bind(NOW,a.eventId).run();
    if(change==='device')await env.DB.prepare('UPDATE devices SET revoked_at=? WHERE id=?').bind(NOW,a.deviceId).run();
    const send=vi.fn(()=>Promise.resolve({status:201}));
    await runNotifications(env.DB,{configured:true,send},()=>NOW,a.workspaceId);expect(send).not.toHaveBeenCalled();
  });
  it('retries temporary failures, does not resend accepted devices, disables gone endpoints',async()=>{
    const a=await setup();await register(a);await planNotifications(env.DB,NOW,a.workspaceId);
    const send=vi.fn().mockResolvedValueOnce({status:503}).mockResolvedValueOnce({status:201});
    await runNotifications(env.DB,{configured:true,send},()=>NOW,a.workspaceId);
    expect((await state(a)).jobs[0]?.status).toBe('retry');
    await runNotifications(env.DB,{configured:true,send},()=>NOW+30_000,a.workspaceId);
    expect((await state(a)).jobs[0]?.status).toBe('sent');
    await runNotifications(env.DB,{configured:true,send},()=>NOW+40_000,a.workspaceId);expect(send).toHaveBeenCalledTimes(2);
    const b=await setup();await register(b,'https://fcm.googleapis.com/fcm/send/gone');await planNotifications(env.DB,NOW,b.workspaceId);
    await runNotifications(env.DB,{configured:true,send:()=>Promise.resolve({status:410})},()=>NOW,b.workspaceId);
    expect((await state(b)).devices[0]?.active).toBe(false);expect((await state(b)).jobs[0]?.status).toBe('failed');
  });
  it('does not resend a successful device when a different device needs a retry',async()=>{
    const a=await setup();await register(a);const second=await seedDevice(a.workspaceId);
    await SELF.fetch(`${BASE}/push`,jsonPut({...sub,endpoint:'https://fcm.googleapis.com/fcm/send/second'},{Authorization:second.authorization}));
    await planNotifications(env.DB,NOW,a.workspaceId);
    const calls:string[]=[];let first=true;
    const send=(raw:unknown)=>{const s=pushSubscriptionInputSchema.parse(raw);calls.push(s.endpoint);
      if(s.endpoint.endsWith('/second')&&first){first=false;return Promise.resolve({status:503});}return Promise.resolve({status:201});};
    await runNotifications(env.DB,{configured:true,send},()=>NOW,a.workspaceId);
    await runNotifications(env.DB,{configured:true,send},()=>NOW+30_000,a.workspaceId);
    expect(calls.filter((url)=>url===sub.endpoint)).toHaveLength(1);expect(calls.filter((url)=>url.endsWith('/second'))).toHaveLength(2);
    expect((await state(a)).jobs[0]?.status).toBe('sent');
  });
  it('suppresses completed fish and never schedules demo/unverified rules',async()=>{
    const a=await setup();await enableDemoModule(a.authorization,'ff14.fishing');await register(a);
    await importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:demoFish('cn')});
    const input={...a.input,id:crypto.randomUUID(),kind:'fish',targetId:'9000001',leadMinutes:0,operationId:opId('fish-reminder')};
    expect((await SELF.fetch(`${BASE}/rules`,jsonPut(input,{Authorization:a.authorization}))).status).toBe(200);
    const fishNow=Math.floor(NOW/1400000)*1400000;
    await planNotifications(env.DB,fishNow,a.workspaceId);expect((await state(a)).jobs).toHaveLength(1); // only the manual event
    const verified=demoFish('cn').map((f)=>({...f,demo:false,source:{...f.source,verificationStatus:'verified'},
      rule:{...f.rule,startHour:0,endHour:24,validationStatus:'verified',weatherRates:[{weather:'clear',chance:100}]}}));
    await importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:verified});
    await SELF.fetch('https://hub.test/api/v1/me/fish-progress',jsonPut({region:'cn',fishId:9000001,field:'alarm',value:true,expectedRevision:0,operationId:opId('alarm-yes')},{Authorization:a.authorization}));
    await planNotifications(env.DB,fishNow,a.workspaceId);expect((await state(a)).jobs.length).toBeGreaterThan(1);
    expect((await SELF.fetch(`${BASE}/rules`,jsonPut({...input,leadMinutes:4320,expectedRevision:1,operationId:opId('long-lead')},{Authorization:a.authorization}))).status).toBe(200);
    await planNotifications(env.DB,fishNow,a.workspaceId);
    const longLead=await env.DB.prepare("SELECT due_at,starts_at FROM notification_jobs WHERE workspace_id=? AND rule_id=? AND status='queued'")
      .bind(a.workspaceId,input.id).all<{due_at:number;starts_at:number}>();
    expect(longLead.results.length).toBeGreaterThan(0);
    expect(longLead.results.every((j)=>j.starts_at-j.due_at===4320*60_000&&j.due_at>fishNow-15*60_000)).toBe(true);
    await SELF.fetch('https://hub.test/api/v1/me/fish-progress',jsonPut({region:'cn',fishId:9000001,field:'caught',value:true,expectedRevision:0,operationId:opId('caught-yes')},{Authorization:a.authorization}));
    const send=vi.fn(()=>Promise.resolve({status:201}));await runNotifications(env.DB,{configured:true,send},()=>fishNow,a.workspaceId);
    expect(send).not.toHaveBeenCalled();
  });
});
it('builds a real RFC8291 encrypted request using the reused library in workerd',async()=>{
  const b64=(bytes:unknown):string=>{
    if(!(bytes instanceof ArrayBuffer))throw new Error('expected raw key');
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  };
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const receiver=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  if(!('privateKey' in keys)||!('publicKey' in receiver))throw new Error('expected key pairs');
  const privateKey=await crypto.subtle.exportKey('jwk',keys.privateKey);
  if(privateKey instanceof ArrayBuffer)throw new Error('expected JWK');
  const validSub={...sub,keys:{p256dh:b64(await crypto.subtle.exportKey('raw',receiver.publicKey)),auth:b64(new Uint8Array(16).fill(1).buffer)}};
  const send=vi.spyOn(globalThis,'fetch').mockImplementation(async(_input,init)=>{
    expect(new Headers(init?.headers).get('Content-Encoding')).toBe('aes128gcm');
    expect((await new Response(init?.body).arrayBuffer()).byteLength).toBe(4096);
    expect(init?.redirect).toBe('manual');return new Response(null,{status:201});
  });
  const transport=createPushTransport({...env,VAPID_PUBLIC_KEY:b64(await crypto.subtle.exportKey('raw',keys.publicKey)),VAPID_PRIVATE_KEY:privateKey.d??'',VAPID_SUBJECT:'mailto:dev@example.test'});
  expect((await transport.send(validSub,'test-job')).status).toBe(201);expect(send).toHaveBeenCalledOnce();
});
