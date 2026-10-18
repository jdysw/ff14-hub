import { SELF,env } from 'cloudflare:test';
import { describe,it,expect,beforeEach } from 'vitest';
import { FISH_MODULE_ID,fishListResponseSchema,fishProgressResponseSchema,fishWindowsResponseSchema } from '@ff14-hub/shared';
import { importFishBundle,demoFish } from '../modules/fish/adapter';
import { seedAuth,resetIdentityState,enableDemoModule,jsonPut,opId,patchModule } from './helpers';

const BASE='https://hub.test/api/v1';
beforeEach(async()=>{
  await resetIdentityState();
  for(const region of ['cn','global'] as const)await importFishBundle(env.DB,{schemaVersion:1,region,records:demoFish(region)});
});
async function auth(){const a=await seedAuth();await enableDemoModule(a.authorization,FISH_MODULE_ID);return a;}
describe('fishing API',()=>{
  it('requires region and bounds window computation; examples remain explicitly unverified',async()=>{
    expect((await SELF.fetch(`${BASE}/fish`)).status).toBe(422);
    const response=await SELF.fetch(`${BASE}/fish?region=cn`);
    const body=fishListResponseSchema.parse(await response.json());
    expect(body.fish[0]?.demo).toBe(true);expect(body.fish[0]?.rule.validationStatus).toBe('unverified');
    const windows=await SELF.fetch(`${BASE}/fish/windows?region=cn&from=4200000&hours=1`);
    expect(windows.status).toBe(200);fishWindowsResponseSchema.parse(await windows.json());
    expect((await SELF.fetch(`${BASE}/fish/windows?region=cn&hours=169`)).status).toBe(422);
  });
  it('keeps workspace, region and three fields independent, supports false and idempotent replay',async()=>{
    const a=await auth();const b=await auth();
    const input={region:'cn',fishId:9000001,field:'caught',value:true,expectedRevision:0,operationId:opId('caught')};
    const put=(body:unknown)=>SELF.fetch(`${BASE}/me/fish-progress`,jsonPut(body,{Authorization:a.authorization}));
    const response=await put(input);expect(response.status,await response.clone().text()).toBe(200);
    expect((await put(input)).status).toBe(200);
    expect((await put({...input,value:false})).status).toBe(409);
    expect((await put({...input,operationId:opId('stale')})).status).toBe(409);
    expect((await put({...input,field:'pinned',operationId:opId('pinned')})).status).toBe(200);
    expect((await put({...input,region:'global',operationId:opId('global')})).status).toBe(200);
    const read=async(token:string,region='cn')=>fishProgressResponseSchema.parse(await (await SELF.fetch(`${BASE}/me/fish-progress?region=${region}`,{headers:{Authorization:token}})).json());
    const before=await read(a.authorization);expect(before.fields).toHaveLength(2);
    expect((await read(b.authorization)).fields).toHaveLength(0);
    expect((await read(a.authorization,'global')).fields).toHaveLength(1);
    expect((await put({...input,value:false,expectedRevision:1,operationId:opId('uncaught')})).status).toBe(200);
    const after=await read(a.authorization);expect(after.watermark).toBeGreaterThan(before.watermark);
    expect(after.fields.find((f)=>f.field==='caught')?.value).toBe(false);
    expect(after.fields.find((f)=>f.field==='pinned')?.value).toBe(true);
  });
  it('only admits one concurrent field CAS and rejects missing identities',async()=>{
    const a=await auth();
    const put=(operationId:string,fishId=9000001)=>SELF.fetch(`${BASE}/me/fish-progress`,jsonPut({region:'cn',fishId,field:'alarm',value:true,expectedRevision:0,operationId},{Authorization:a.authorization}));
    const responses=await Promise.all([put(opId('race-a')),put(opId('race-b'))]);
    expect(responses.map((r)=>r.status).sort()).toEqual([200,409]);
    expect((await put(opId('missing'),999)).status).toBe(404);
  });
  it('blocks anonymous, disabled modules and revoked devices',async()=>{
    expect((await SELF.fetch(`${BASE}/me/fish-progress?region=cn`)).status).toBe(401);
    const a=await auth();
    await patchModule(a.authorization,FISH_MODULE_ID,{action:'disable',expectedRevision:1});
    expect((await SELF.fetch(`${BASE}/me/fish-progress?region=cn`,{headers:{Authorization:a.authorization}})).status).toBe(403);
    await env.DB.prepare('UPDATE devices SET revoked_at=1 WHERE id=?').bind(a.deviceId).run();
    expect((await SELF.fetch(`${BASE}/me/fish-progress?region=cn`,{headers:{Authorization:a.authorization}})).status).toBe(401);
  });
  it('validates all identities before import and preserves progress on rule updates',async()=>{
    await expect(importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:demoFish('global')})).rejects.toThrow();
    const a=await auth();
    await SELF.fetch(`${BASE}/me/fish-progress`,jsonPut({region:'cn',fishId:9000001,field:'pinned',value:true,expectedRevision:0,operationId:opId('update-dataset')},{Authorization:a.authorization}));
    await importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:demoFish('cn').map((f)=>({...f,rule:{...f.rule,version:'synthetic-v2'}}))});
    const response=await SELF.fetch(`${BASE}/me/fish-progress?region=cn`,{headers:{Authorization:a.authorization}});
    expect(fishProgressResponseSchema.parse(await response.json()).fields[0]?.value).toBe(true);
  });
});
