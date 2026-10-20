import { SELF,env } from 'cloudflare:test';
import { beforeEach,describe,it,expect } from 'vitest';
import { SYNC_MODULE_ID,fishSyncSnapshotSchema,fishSyncPreviewSchema,fishSyncResultSchema,type FishSyncChange } from '@ff14-hub/shared';
import { seedAuth,seedDevice,resetIdentityState,enableDemoModule,jsonPost,jsonPut,opId } from './helpers';
import { importFishBundle,demoFish } from './fixtures/fish';
const URL='https://hub.test/api/v1/me/fish-sync';
beforeEach(resetIdentityState);
async function setup(){const a=await seedAuth();await enableDemoModule(a.authorization,'ff14.fishing');await enableDemoModule(a.authorization,SYNC_MODULE_ID);
  await importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:demoFish('cn')});return a;}
async function snapshot(a:{authorization:string},region='cn'){
  const response=await SELF.fetch(`${URL}?region=${region}`,{headers:{Authorization:a.authorization}});expect(response.status).toBe(200);
  return fishSyncSnapshotSchema.parse(await response.json());
}
async function preview(a:{authorization:string},changes:FishSyncChange[],region='cn'){
  const response=await SELF.fetch(`${URL}/preview`,jsonPost({region,changes},{Authorization:a.authorization}));
  expect(response.status,await response.clone().text()).toBe(200);return fishSyncPreviewSchema.parse(await response.json());
}
const apply=(a:{authorization:string},token:string,operationId=crypto.randomUUID())=>SELF.fetch(`${URL}/apply`,jsonPost({token,operationId},{Authorization:a.authorization}));
describe('minimal scope-bound progress sync',()=>{
  it('rejects anonymous access, incomplete module gates, credentials and extension payloads',async()=>{
    expect((await SELF.fetch(`${URL}?region=cn`)).status).toBe(401);
    const a=await seedAuth();expect((await SELF.fetch(`${URL}?region=cn`,{headers:{Authorization:a.authorization}})).status).toBe(403);
    const b=await setup();const body={region:'cn',changes:[{fishId:1,field:'caught',value:true,expectedRevision:0}],password:'must-not-enter-backend'};
    expect((await SELF.fetch(`${URL}/preview`,jsonPost(body,{Authorization:b.authorization}))).status).toBe(422);
    expect((await SELF.fetch(`${URL}/preview`,jsonPost({region:'cn',changes:[{...body.changes[0],username:'not-allowed'}]},{Authorization:b.authorization}))).status).toBe(422);
  });
  it('atomically imports known and unknown IDs, replays exact operations and rolls back with new revisions',async()=>{
    const a=await setup();const b=await setup();
    const p=await preview(a,[{fishId:9000001,field:'caught',value:true,expectedRevision:0},{fishId:9999999,field:'alarm',value:true,expectedRevision:0}]);
    expect((await apply(b,p.token)).status).toBe(404);
    const operationId=opId('sync-exact');const first=await apply(a,p.token,operationId);expect(first.status,await first.clone().text()).toBe(200);
    const result=fishSyncResultSchema.parse(await first.json());expect(result.applied).toBe(2);
    const again=fishSyncResultSchema.parse(await (await apply(a,p.token,operationId)).json());expect(again.auditId).toBe(result.auditId);expect(again.replayed).toBe(true);
    expect((await apply(a,p.token)).status).toBe(409);
    expect((await snapshot(a)).fields).toHaveLength(2);expect((await snapshot(a,'global')).fields).toHaveLength(0);
    const undo=await SELF.fetch(`${URL}/rollback-preview`,jsonPost({auditId:result.auditId},{Authorization:a.authorization}));
    expect(undo.status).toBe(200);const rollback=fishSyncPreviewSchema.parse(await undo.json());
    expect((await apply(a,rollback.token)).status).toBe(200);
    const after=await snapshot(a);expect(after.fields.every((f)=>!f.value&&f.revision===2)).toBe(true);expect(after.audits).toHaveLength(2);
  });
  it('rejects stale previews and rollback after another edit, preserving all other fields',async()=>{
    const a=await setup();const p=await preview(a,[{fishId:9000001,field:'caught',value:true,expectedRevision:0}]);
    await SELF.fetch('https://hub.test/api/v1/me/fish-progress',jsonPut({region:'cn',fishId:9000001,field:'pinned',value:true,expectedRevision:0,operationId:opId('other-field')},{Authorization:a.authorization}));
    expect((await apply(a,p.token)).status).toBe(409);expect((await snapshot(a)).fields).toHaveLength(1);
    const fresh=await preview(a,p.changes);const result=fishSyncResultSchema.parse(await (await apply(a,fresh.token)).json());
    await SELF.fetch('https://hub.test/api/v1/me/fish-progress',jsonPut({region:'cn',fishId:9000001,field:'caught',value:false,expectedRevision:1,operationId:opId('newer-change')},{Authorization:a.authorization}));
    expect((await SELF.fetch(`${URL}/rollback-preview`,jsonPost({auditId:result.auditId},{Authorization:a.authorization}))).status).toBe(409);
    expect((await snapshot(a)).fields.find((f)=>f.field==='pinned')?.value).toBe(true);
  });
  it('handles the 200-field budget and promotes unknown IDs when catalog data arrives',async()=>{
    const a=await setup();const changes:FishSyncChange[]=Array.from({length:200},(_,i)=>({fishId:10000+i,field:'caught',value:true,expectedRevision:0}));
    const p=await preview(a,changes);const response=await apply(a,p.token);expect(response.status,await response.clone().text()).toBe(200);
    expect((await snapshot(a)).fields).toHaveLength(200);
    const newFish=demoFish('cn').map((f)=>({...f,id:10000,rule:{...f.rule,fishId:10000}}));
    await importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:newFish});
    expect((await snapshot(a)).fields).toHaveLength(200);
    const known=await env.DB.prepare('SELECT value,revision FROM fish_state_fields WHERE workspace_id=? AND fish_id=10000').bind(a.workspaceId).first<{value:number;revision:number}>();
    expect(known).toEqual({value:1,revision:1});
    expect(await env.DB.prepare('SELECT fish_id FROM fish_external_fields WHERE workspace_id=? AND fish_id=10000').bind(a.workspaceId).first()).toBeNull();
  });
  it('rolls back the entire batch on a late database failure',async()=>{
    const a=await setup();const before=await snapshot(a);
    const p=await preview(a,[{fishId:9000001,field:'caught',value:true,expectedRevision:0},{fishId:77777,field:'caught',value:true,expectedRevision:0}]);
    await env.DB.prepare("CREATE TRIGGER sync_test_abort BEFORE INSERT ON fish_external_fields WHEN NEW.fish_id=77777 BEGIN SELECT RAISE(ABORT,'test abort'); END").run();
    try{expect((await apply(a,p.token)).status).toBe(500);const after=await snapshot(a);expect(after.fields).toEqual(before.fields);expect(after.watermark).toBe(before.watermark);expect(after.audits).toHaveLength(0);}
    finally{await env.DB.prepare('DROP TRIGGER sync_test_abort').run();}
  });
  it('does not silently overwrite a competing opposite intent from another device',async()=>{
    const a=await setup();const other=await seedDevice(a.workspaceId);
    const before={fishId:9000001,field:'caught' as const,value:true,expectedRevision:0};
    const pA=await preview(a,[before]);const pB=await preview(other,[{...before,value:false}]);
    expect((await apply(a,pA.token)).status).toBe(200);expect((await apply(other,pB.token)).status).toBe(409);
    expect((await snapshot(a)).fields[0]?.value).toBe(true);
  });
});
