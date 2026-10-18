import {expect,test,type BrowserContext,type Page,type APIRequestContext} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {pairingCreateResponseSchema,pairingClaimResponseSchema,fishSyncSnapshotSchema} from '../../packages/shared/src/index';
import type {FishDocument} from '../../packages/fish-sync/src/index';
import type {SyncPlan,PreviewResult} from '../../packages/fish-sync/src/coordinator';
import type {createFixtureClient} from './sync-runtime.fixture';
import type * as RuntimeFixture from './sync-runtime.fixture';

const credentials=JSON.parse(readFileSync(new URL('./.credentials.phase06c.json',import.meta.url),'utf8')) as {token:string;baseUrl:string;workspaceId:string};
const script=readFileSync(new URL('../../.wrangler/phase06c-fixture/sync-runtime.js',import.meta.url),'utf8');
const MODULE='/__sync-runtime-fixture.js';const DAV='https://dav.sync-fixture.test/';
const empty=():FishDocument=>({completed:[],pinned:[],alarmFish:[]});
declare global{interface Window{
  syncClient:ReturnType<typeof createFixtureClient>;
  syncPlan:SyncPlan;
  releaseSyncLock:()=>Promise<void>;
}}

/** Intercepted DAV wire fixture, shared by two devices. No external service is contacted. */
function davFixture(){
  const files=new Map<string,{body:string;etag:string}>();let serial=0;
  return {install:async(context:BrowserContext)=>{
    await context.route(`${DAV}**`,async(route)=>{
      const request=route.request();const key=new URL(request.url()).pathname;const row=files.get(key);
      const headers={'Access-Control-Allow-Origin':credentials.baseUrl,'Access-Control-Expose-Headers':'ETag',
        'Access-Control-Allow-Methods':'GET,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,If-Match,If-None-Match'};
      const method=request.method();const reqHeaders=request.headers();
      if(method==='OPTIONS'){await route.fulfill({status:204,headers});return;}
      if(method==='GET'){await route.fulfill({status:row===undefined?404:200,headers:{...headers,...(row===undefined?{}:{ETag:row.etag})},body:row?.body??''});return;}
      if((reqHeaders['if-none-match']==='*'&&row!==undefined)||(reqHeaders['if-match']!==undefined&&reqHeaders['if-match']!==row?.etag)){
        await route.fulfill({status:412,headers});return;
      }
      if(method==='DELETE'){files.delete(key);await route.fulfill({status:204,headers});return;}
      const etag=`"${++serial}"`;files.set(key,{body:request.postData()??'',etag});
      await route.fulfill({status:201,headers:{...headers,ETag:etag}});
    });
  }};
}

async function mount(page:Page,token=credentials.token,document=empty(),region:'cn'|'global'='cn'):Promise<void>{
  // Test-only origin document. Production CSP and production build remain untouched.
  await page.route('**/__sync-harness',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Sync runtime acceptance fixture</title>'}));
  await page.route(`**${MODULE}`,r=>r.fulfill({contentType:'text/javascript',body:script}));
  await page.goto(`${credentials.baseUrl}/__sync-harness`);
  await page.evaluate(async(args)=>{
    const runtime=await import(args.module) as typeof RuntimeFixture;
    window.syncClient=runtime.createFixtureClient({id:crypto.randomUUID(),workspaceId:args.workspaceId,hubOrigin:location.origin,
      davBaseUrl:args.dav,region:args.region,name:'E2E runtime profile'},args.token,JSON.parse(args.document) as FishDocument);
  },{module:MODULE,token,document:JSON.stringify(document),region,workspaceId:credentials.workspaceId,dav:`${DAV}${region}/`});
}
async function preview(page:Page,resolutions:Record<string,'local'|'webdav'|'hub'|'baseline'>={}):Promise<PreviewResult>{
  const text=await page.evaluate(async(choices)=>{
    const {coordinator,profile}=window.syncClient;const result=await coordinator.preview({profile,resolutions:choices});
    if(result.state==='ready')window.syncPlan=result.plan;return JSON.stringify(result);
  },resolutions);
  return JSON.parse(text) as PreviewResult;
}
const apply=(page:Page)=>page.evaluate(async()=>{await window.syncClient.coordinator.apply({profile:window.syncClient.profile,plan:window.syncPlan});});
const localDocument=async(page:Page):Promise<FishDocument>=>JSON.parse(await page.evaluate(async()=>JSON.stringify((await window.syncClient.readLocal()).document))) as FishDocument;
async function newDevice(request:APIRequestContext){
  const pairing=await request.post(`${credentials.baseUrl}/api/v1/identity/pairing`,{headers:{Authorization:`Bearer ${credentials.token}`},data:{}});
  expect(pairing.status()).toBe(201);const code=pairingCreateResponseSchema.parse(await pairing.json()).pairingCode;
  const claim=await request.post(`${credentials.baseUrl}/api/v1/identity/pairing/claim`,{data:{pairingCode:code,deviceName:'06C second device'}});
  expect(claim.status()).toBe(201);return pairingClaimResponseSchema.parse(await claim.json());
}

test('Web Locks：两个标签互斥、释放幂等、关闭持锁标签后可恢复',async({page,context},info)=>{
  test.skip(info.project.name!=='desktop-chromium','跨标签验收在桌面执行');
  const other=await context.newPage();await mount(page);await mount(other);
  const id=crypto.randomUUID();
  const acquire=async(tab:Page)=>tab.evaluate(async({module,id})=>{
    const runtime=await import(module) as typeof RuntimeFixture;
    try{window.releaseSyncLock=await runtime.createBrowserProfileLock().acquire(id);return 'acquired';}
    catch(error){return (error as {code:string}).code;}
  },{module:MODULE,id});
  expect(await acquire(page)).toBe('acquired');expect(await acquire(other)).toBe('lock-busy');
  await page.evaluate(async()=>{await window.releaseSyncLock();await window.releaseSyncLock();});
  expect(await acquire(other)).toBe('acquired');await other.close();
  await expect.poll(()=>page.evaluate(async(profileId)=>(await navigator.locks.query()).held?.some((lock)=>lock.name===`ff14-hub:fish-sync:${profileId}`)??false,id)).toBe(false);
  expect(await acquire(page)).toBe('acquired');await page.evaluate(()=>window.releaseSyncLock());
});

test('两个真实设备：三集合与取消状态跨端一致，陈旧计划不覆盖新提交',async({page,browser,request},info)=>{
  test.skip(info.project.name!=='desktop-chromium','多设备验收在桌面执行');
  const fixture=davFixture();await fixture.install(page.context());
  const device=await newDevice(request);const otherContext=await browser.newContext();await fixture.install(otherContext);
  try{
    const other=await otherContext.newPage();
    const source={completed:[9000001],pinned:[9000001],alarmFish:[9999999],future:{marker:'client-extension-only'}};
    await mount(page,credentials.token,source);await mount(other,device.deviceToken);
    expect((await preview(page)).state).toBe('ready');await apply(page);
    expect((await preview(other)).state).toBe('conflict');
    expect((await preview(other,{'completed:9000001':'webdav','pinned:9000001':'webdav','alarmFish:9999999':'webdav'})).state).toBe('ready');
    await apply(other);expect(await localDocument(other)).toEqual(source);
    await other.evaluate(()=>window.syncClient.mutate({completed:[],pinned:[9000001],alarmFish:[9999999],future:{marker:'client-extension-only'}}));
    expect((await preview(other)).state).toBe('ready');await apply(other);
    expect((await preview(page)).state).toBe('ready');await apply(page);
    expect((await localDocument(page)).completed).toEqual([]);
    // Both clients read the same remote state. A changes true while B retains explicit false intent.
    await page.evaluate(()=>window.syncClient.mutate({...window.syncPlan.document,completed:[9000001]}));
    await other.evaluate(()=>window.syncClient.mutate({...window.syncPlan.document,completed:[]},['completed:9000001']));
    expect((await preview(page)).state).toBe('ready');expect((await preview(other)).state).toBe('ready');
    await apply(page);await expect(apply(other)).rejects.toThrow('已发生变化');
    const response=await request.get(`${credentials.baseUrl}/api/v1/me/fish-sync?region=cn`,{headers:{Authorization:`Bearer ${device.deviceToken}`}});
    const text=await response.text();expect(text).not.toContain('client-extension-only');expect(text).not.toContain('fixture-dav-password');
    const state=fishSyncSnapshotSchema.parse(JSON.parse(text) as unknown);
    expect(state.fields.find((f)=>f.field==='caught')?.value).toBe(true);
    expect(state.fields.find((f)=>f.field==='alarm')?.fishId).toBe(9999999);
    expect((await localDocument(other)).completed).toEqual([]);
  }finally{await otherContext.close();}
});

test('真实D1：提交响应丢失后按原操作恢复，设备撤销与区服隔离仍生效',async({page,request},info)=>{
  test.skip(info.project.name!=='desktop-chromium','恢复验收在桌面执行');
  const fixture=davFixture();await fixture.install(page.context());const device=await newDevice(request);
  await mount(page,device.deviceToken,{completed:[424242],pinned:[],alarmFish:[]},'global');
  expect((await preview(page)).state).toBe('ready');
  await page.route('**/api/v1/me/fish-sync/apply',async(route)=>{
    const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');
  });
  await expect(apply(page)).rejects.toThrow('network');
  const pending=await page.evaluate(()=>window.syncClient.coordinator.status(window.syncClient.profile));
  expect(pending?.stage).toBe('dav-committed');
  await page.unroute('**/api/v1/me/fish-sync/apply');
  const outcome=JSON.parse(await page.evaluate(async()=>JSON.stringify(await window.syncClient.coordinator.recover({profile:window.syncClient.profile})))) as {status:string;outcome:{replayedHubApply:boolean}};
  expect(outcome.status).toBe('completed');
  if(outcome.status==='completed')expect(outcome.outcome.replayedHubApply).toBe(true);
  const global=await request.get(`${credentials.baseUrl}/api/v1/me/fish-sync?region=global`,{headers:{Authorization:`Bearer ${credentials.token}`}});
  expect(fishSyncSnapshotSchema.parse(await global.json()).fields).toEqual([{fishId:424242,field:'caught',value:true,revision:1}]);
  const cn=await request.get(`${credentials.baseUrl}/api/v1/me/fish-sync?region=cn`,{headers:{Authorization:`Bearer ${credentials.token}`}});
  expect(fishSyncSnapshotSchema.parse(await cn.json()).fields.some((f)=>f.fishId===424242)).toBe(false);
  const revoked=await request.delete(`${credentials.baseUrl}/api/v1/me/devices/${device.device.id}`,{headers:{Authorization:`Bearer ${credentials.token}`}});
  expect(revoked.status()).toBe(204);
  await expect(preview(page)).rejects.toThrow('unauthorized');
});
