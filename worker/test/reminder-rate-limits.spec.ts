import {env,SELF} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {seedAuth,seedDevice,resetIdentityState,enableDemoModule,jsonPost,jsonPut} from './helpers';
import {RATE_LIMITS} from '../lib/rate-limit';
const BASE='https://hub.test/api/v1/me/reminders';
beforeEach(resetIdentityState);
async function owner(){const a=await seedAuth();await enableDemoModule(a.authorization,'ff14.reminders');return a;}
const sub={endpoint:'https://fcm.googleapis.com/fcm/send/quota',expirationTime:null,keys:{p256dh:'B'+'A'.repeat(86),auth:'A'.repeat(22)}};
describe('authenticated manual notification limits',()=>{
  it('shares an atomic reconcile quota across devices, isolates workspaces, and resets expired windows',async()=>{
    const a=await owner();const second=await seedDevice(a.workspaceId);
    const requests=await Promise.all(Array.from({length:12},(_,i)=>SELF.fetch(`${BASE}/reconcile`,jsonPost({},
      {Authorization:i%2===0?a.authorization:second.authorization}))));
    expect(requests.filter((r)=>r.status===200)).toHaveLength(5);
    expect(requests.filter((r)=>r.status===429)).toHaveLength(7);
    const denied=requests.find((r)=>r.status===429)!;
    expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);expect(denied.headers.get('Cache-Control')).toBe('no-store');
    expect((await denied.json<{code:string}>()).code).toBe('rate_limited');
    const b=await owner();expect((await SELF.fetch(`${BASE}/reconcile`,jsonPost({},{Authorization:b.authorization}))).status).toBe(200);
    await env.DB.prepare('UPDATE auth_rate_limits SET window_start=? WHERE scope_key=?')
      .bind(Date.now()-RATE_LIMITS.reminderReconcilePerWorkspace.windowMs-1000,`reminder-reconcile:${a.workspaceId}`).run();
    expect((await SELF.fetch(`${BASE}/reconcile`,jsonPost({},{Authorization:a.authorization}))).status).toBe(200);
  });
  it('rejects malformed or unauthenticated requests before consuming an owner quota',async()=>{
    expect((await SELF.fetch(`${BASE}/reconcile`,jsonPost({}))).status).toBe(401);
    const a=await owner();
    expect((await SELF.fetch(`${BASE}/reconcile`,jsonPost({unexpected:true},{Authorization:a.authorization}))).status).toBe(422);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_rate_limits WHERE scope_key=?').bind(`reminder-reconcile:${a.workspaceId}`).first<{n:number}>())?.n).toBe(0);
  });
  it('limits registration per device and across the workspace, without blocking unsubscribe',async()=>{
    const a=await owner();const second=await seedDevice(a.workspaceId);const third=await seedDevice(a.workspaceId);
    for(let i=0;i<10;i++)expect((await SELF.fetch(`${BASE}/push`,jsonPut(sub,{Authorization:a.authorization}))).status).toBe(200);
    const secondSub={...sub,endpoint:`${sub.endpoint}-second`};
    expect((await SELF.fetch(`${BASE}/push`,jsonPut(sub,{Authorization:a.authorization}))).status).toBe(429);
    // Rejected device calls still consume the conservative workspace budget.
    for(let i=0;i<9;i++)expect((await SELF.fetch(`${BASE}/push`,jsonPut(secondSub,{Authorization:second.authorization}))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/push`,jsonPut({...sub,endpoint:`${sub.endpoint}-third`},{Authorization:third.authorization}))).status).toBe(429);
    expect((await SELF.fetch(`${BASE}/push`,{...jsonPost({},{Authorization:a.authorization}),method:'DELETE'})).status).toBe(200);
    expect((await env.DB.prepare('SELECT active FROM push_subscriptions WHERE workspace_id=? AND device_id=?').bind(a.workspaceId,a.deviceId).first<{active:number}>())?.active).toBe(0);
  });
});
