import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFishcakeAdapter,fishcakeDocument,findFishcakeStore} from '../lib/fishcake-adapter.mjs';
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
