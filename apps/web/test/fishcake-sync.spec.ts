// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fieldsToDocument} from '@ff14-hub/shared';
import {applyFishcake,applyFishcakeLocal,fishcakeRequest,mergeFishcakePreview,previewFishcake,startFishcakeSync,type FishcakePreview} from '../src/app/local/fishcake-sync';
import type {LocalData,LocalStore} from '../src/app/local/store';
const memory=vi.hoisted(()=>new Map<string,unknown>());
vi.mock('../src/app/local/secure-storage',()=>({readDeviceRecord:(id:string)=>Promise.resolve(memory.get(id)??null),writeDeviceRecord:(id:string,value:unknown)=>{memory.set(id,structuredClone(value));return Promise.resolve();}}));
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]});
function makeStore(){
  const record={data:empty()};
  return {record,store:{read:()=>Promise.resolve(structuredClone(record.data)),change:(edit:(r:typeof record)=>void)=>{edit(record);record.data.revision++;return Promise.resolve();},subscribe:()=>()=>{}} as unknown as LocalStore};
}
function bridge(remote={completed:[10],pinned:[] as number[],alarmFish:[] as number[]}){
  const state={remote,rejectApply:false,applies:0};
  vi.spyOn(window,'postMessage').mockImplementation((message:unknown)=>{
    const m=message as Record<string,unknown>;
    queueMicrotask(()=>{
      let value:unknown={connected:true};let error:string|undefined;
      if(m['action']==='read')value={session:'test',region:m['region'],at:Date.now(),document:state.remote};
      if(m['action']==='apply'){state.applies++;if(state.rejectApply)error='鱼糕进度已变化';else{state.remote=m['document'] as typeof remote;value=state.remote;}}
      window.dispatchEvent(new MessageEvent('message',{source:window,origin:location.origin,data:{channel:'ff14hub-fishcake',direction:'response',id:m['id'],value,error}}));
    });
  });return state;
}
beforeEach(()=>{memory.clear();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(_name:string,action:()=>Promise<unknown>)=>action()}});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('requires explicit choices for first connection and propagates later cancellations',()=>{
  const preview:FishcakePreview={local:empty(),remote:{completed:[10],pinned:[],alarmFish:[]},baseline:null,region:'cn'};
  expect(mergeFishcakePreview(preview).conflicts).toHaveLength(1);
  expect(mergeFishcakePreview(preview,new Map([['completed:10','local']])).document.completed).toEqual([10]);
  preview.baseline=preview.remote;preview.remote={completed:[],pinned:[],alarmFish:[]};
  preview.local.fish.cn=[{region:'cn',fishId:10,field:'caught',value:true,revision:1,updatedAt:1}];
  expect(mergeFishcakePreview(preview).document.completed).toEqual([]);
});
it('persists a checkpoint and waits for fish acknowledgement before touching local state',async()=>{
  const {store,record}=makeStore(),remote=bridge();const preview=await previewFishcake(store,'cn');
  remote.rejectApply=true;await expect(applyFishcake(store,preview,new Map([['completed:10','local']]))).rejects.toThrow('已变化');
  expect(record.data.fish.cn).toEqual([]);
  expect(memory.get('fishcake-sync-v1')).toMatchObject({enabled:false,backup:{completed:[]}});
});
it('applies the real store port and enables automatic updates only after both sides agree',async()=>{
  const {store,record}=makeStore(),remote=bridge();const preview=await previewFishcake(store,'cn');
  await applyFishcake(store,preview,new Map([['completed:10','local']]));
  expect(fieldsToDocument(record.data.fish.cn).completed).toEqual([10]);expect(record.data.fish.global).toEqual([]);
  expect(remote.applies).toBe(1);expect(memory.get('fishcake-sync-v1')).toMatchObject({enabled:true,baseline:{completed:[10]}});
});
it('stops stale local writes after remote success rather than discarding a concurrent user edit',async()=>{
  const {store,record}=makeStore();record.data.revision=5;
  await expect(applyFishcakeLocal(store,4,'cn',{completed:[1],pinned:[],alarmFish:[]})).rejects.toThrow('已变化');
  expect(record.data.fish.cn).toEqual([]);
});
it('automatic synchronization retries an offline peer without changing local data',async()=>{
  vi.useFakeTimers();const {store,record}=makeStore();
  memory.set('fishcake-sync-v1',{region:'cn',enabled:true,baseline:{completed:[],pinned:[],alarmFish:[]}});
  vi.spyOn(window,'postMessage').mockImplementation(()=>{});
  const stop=startFishcakeSync(store);await vi.advanceTimersByTimeAsync(18001);
  expect(record.data.fish.cn).toEqual([]);expect(memory.get('fishcake-sync-v1')).toMatchObject({enabled:true});expect((memory.get('fishcake-sync-v1') as {error:string}).error).toContain('脚本');stop();
});
it('ignores replies from another origin even when the correlation ID is copied',async()=>{
  vi.useFakeTimers();vi.spyOn(window,'postMessage').mockImplementation((message:unknown)=>{
    const m=message as Record<string,unknown>;
    window.dispatchEvent(new MessageEvent('message',{source:window,origin:'https://foreign.example',data:{channel:'ff14hub-fishcake',direction:'response',id:m['id'],value:'bad'}}));
  });
  const pending=expect(fishcakeRequest('hello',undefined,{},30)).rejects.toThrow('脚本');await vi.advanceTimersByTimeAsync(31);await pending;
});
