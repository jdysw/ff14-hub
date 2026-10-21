import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFishcakeAdapter,fishcakeDocument,findFishcakeStore} from '../lib/fishcake-adapter.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
function fixture(legacy=null){
  let fishing={completedFish:[10],pinnedFish:[],alarmFish:['2:20'],otherFilter:['keep']};
  let legacyRaw=legacy;let calls=0;
  const model={getSpotFish:spot=>{const id=Number(String(spot).split(':')[1]);return {itemId:id,isEmpty:!id};},getSpotFishesByFishId:id=>id===999?[]:[{id:`2:${id}`,itemId:id},{id:`3:${id}`,itemId:id}]};
  const store={getState:()=>({fishing}),subscribe:()=>()=>{},dispatch:action=>{calls++;assert.equal(action.type,'fishing/importSettings');fishing={...fishing,...action.payload};if(legacyRaw)legacyRaw={...legacyRaw,completed:action.payload.completedFish,pinned:action.payload.pinnedFish,toBeNotified:action.payload.alarmFish.map(s=>model.getSpotFish(s).itemId),syncedKey:['completed','pinned','toBeNotified']};}};
  const adapter=createFishcakeAdapter(store,model,{getItem:()=>legacyRaw?JSON.stringify(legacyRaw):null});
  return {adapter,store,calls:()=>calls,legacy:()=>legacyRaw};
}
test('translates spot alarms to item IDs and preserves existing spot choices',()=>{
  const f=fixture(),before=f.adapter.read();assert.deepEqual(before,{completed:[10],pinned:[],alarmFish:[20]});
  const result=f.adapter.apply(before,{completed:[],pinned:[30],alarmFish:[20,40]});
  assert.deepEqual(result,{completed:[],pinned:[30],alarmFish:[20,40]});
  assert.deepEqual(f.store.getState().fishing.alarmFish,['2:20','2:40','3:40']);
  assert.deepEqual(f.store.getState().fishing.otherFilter,['keep']);
});
test('removes flags rather than unioning and rejects stale snapshots without dispatch',()=>{
  const f=fixture(),before=f.adapter.read();
  f.adapter.apply(before,{completed:[],pinned:[],alarmFish:[]});
  assert.deepEqual(f.adapter.read(),{completed:[],pinned:[],alarmFish:[]});
  assert.throws(()=>f.adapter.apply(before,before),/已变化/);assert.equal(f.calls(),1);
});
test('refuses unsupported alarms before any partial write',()=>{
  const f=fixture(),before=f.adapter.read();assert.throws(()=>f.adapter.apply(before,{...before,alarmFish:[999]}),/不支持/);
  assert.equal(f.calls(),0);assert.deepEqual(f.adapter.read(),before);
});
test('uses un-migrated legacy selections and preserves unrelated legacy data',()=>{
  const f=fixture({completed:[90],pinned:[80],toBeNotified:[70],privateExtra:{keep:true}});
  assert.deepEqual(f.adapter.read(),{completed:[90],pinned:[80],alarmFish:[70]});
  f.adapter.apply(f.adapter.read(),{completed:[91],pinned:[],alarmFish:[]});
  assert.deepEqual(f.adapter.read(),{completed:[91],pinned:[],alarmFish:[]});assert.deepEqual(f.legacy().privateExtra,{keep:true});
});
test('validates bounded positive item IDs and locates the live Provider without a window global',()=>{
  assert.throws(()=>fishcakeDocument({completed:[-1],pinned:[],alarmFish:[]}));
  assert.throws(()=>fishcakeDocument({completed:[],pinned:[],alarmFish:['2:1']}));
  const f=fixture();const root={'__reactContainer$test':{child:{memoizedProps:{store:f.store}}}};
  assert.equal(findFishcakeStore(root),f.store);assert.throws(()=>findFishcakeStore({}),/接口/);
});
test('ignores native countdown changes while preserving progress updates and online heartbeats',async()=>{
  const source=await readFile(new URL('../userscripts/fishcake-page.js',import.meta.url),'utf8');
  let listener,changed,current={completed:[1],pinned:[],alarmFish:[]};const posts=[];
  const window={postMessage:m=>posts.push(m),addEventListener:(_event,callback)=>{listener=callback;}};
  const context=vm.createContext({window,document:{},localStorage:{},location:{origin:'https://fish.ffmomola.com'},loadFishcakeAdapter:async()=>({read:()=>current,subscribe:callback=>{changed=callback;}})});
  vm.runInContext(source+';startPageAdapter("test-nonce");',context);
  const read=async()=>{listener({source:window,origin:'https://fish.ffmomola.com',data:{channel:'ff14hub-fishcake-page',nonce:'test-nonce',action:'read'}});await new Promise(resolve=>setImmediate(resolve));};
  await read();assert.equal(posts.length,1);
  for(let n=0;n<100;n++)changed();assert.equal(posts.length,1);
  current={...current,pinned:[2]};changed();assert.equal(posts.length,2);
  await read();assert.equal(posts.length,3);assert.deepEqual(posts[2].document.pinned,[2]);
});
