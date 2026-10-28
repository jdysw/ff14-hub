// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {automaticRemoteSync,applyRemotePreview,previewRemoteSync,setRemoteAutomatic,saveRemoteConfig,type RemoteSyncSession} from '../src/app/local/remote-sync-session';
import {emptyRemoteConfig} from '../src/app/local/remote-sync';
import {startAutomaticSync,automaticSyncStatus} from '../src/app/local/automatic-sync';
import {localBackupSchema,localDataSchema,type LocalData,type LocalStore} from '../src/app/local/store';
import {registerPrivateDraftSource,resetPrivateDraftSources} from '../src/app/pwa/draft-registry';

const memory:{saved:unknown}=vi.hoisted(()=>({saved:null}));
vi.mock('../src/app/local/secure-storage',()=>({
  readDeviceRecord:()=>Promise.resolve(structuredClone(memory.saved)),
  updateDeviceRecord:(_id:string,update:(previous:unknown)=>unknown)=>{const next=update(structuredClone(memory.saved));if(next!==undefined)memory.saved=structuredClone(next);return Promise.resolve(structuredClone(memory.saved));},
}));
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]});
const config={...emptyRemoteConfig,url:'https://dav.example/personal.json',username:'test',password:'test-only'};
const session=(baseline=empty()):RemoteSyncSession=>({config,baseline,lastSync:'2026-10-27T00:00:00Z',automatic:true});
const note=(title:string)=>({id:crypto.randomUUID(),title,text:title});
function localStore(initial=empty()){
  let data=structuredClone(initial);const listeners=new Set<()=>void>();
  const store={read:()=>Promise.resolve(structuredClone(data)),change:(update:(doc:{data:LocalData;operations:unknown[]})=>unknown)=>Promise.resolve().then(()=>{
    const doc={data:structuredClone(data),operations:[]};const result=update(doc);doc.data.revision=data.revision+1;data=localDataSchema.parse(doc.data);listeners.forEach(listener=>listener());return result;
  }),subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}} as unknown as LocalStore;
  return {store,read:()=>data,edit:(change:(value:LocalData)=>void)=>{change(data);data.revision++;listeners.forEach(listener=>listener());}};
}
function remoteObject(initial=empty()){
  let data=structuredClone(initial),version=1;
  const fetcher=vi.fn<typeof fetch>(async(_url,init)=>{
    await Promise.resolve();
    if(init?.method==='PUT'){
      if(new Headers(init.headers).get('if-match')!==`"v${version}"`)return new Response(null,{status:412});
      if(typeof init.body!=='string')throw new Error('Expected a JSON backup body');
      data=localBackupSchema.parse(JSON.parse(init.body) as unknown).data;version++;return new Response(null,{status:204});
    }
    return new Response(JSON.stringify({format:'ff14-hub-local',version:1,exportedAt:'test',data}),{headers:{ETag:`"v${version}"`}});
  });
  vi.stubGlobal('fetch',fetcher);return {fetcher,read:()=>data,edit:(change:(value:LocalData)=>void)=>{change(data);version++;}};
}
beforeEach(()=>{
  memory.saved=session();let tail=Promise.resolve();
  vi.stubGlobal('navigator',{onLine:true,locks:{request:(_name:string,action:()=>Promise<unknown>)=>{const next=tail.then(action);tail=next.then(()=>{},()=>{});return next;}}});
  vi.stubGlobal('BroadcastChannel',undefined);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();resetPrivateDraftSources();});

it('propagates independent edits between two devices and skips repeated writes',async()=>{
  const base=empty(),a=localStore(base),b=localStore(base),remote=remoteObject(base),aNote=note('设备 A'),bNote=note('设备 B');
  a.edit(data=>data.notes.push(aNote));b.edit(data=>data.notes.push(bNote));
  await automaticRemoteSync(a.store);const savedA=structuredClone(memory.saved);
  memory.saved=session(base);await automaticRemoteSync(b.store);
  expect(b.read().notes.map(item=>item.id).sort()).toEqual([aNote.id,bNote.id].sort());
  memory.saved=savedA;await automaticRemoteSync(a.store);
  const byId=(data:LocalData)=>[...data.notes].sort((left,right)=>left.id.localeCompare(right.id));
  expect(byId(a.read())).toEqual(byId(b.read()));expect(byId(remote.read())).toEqual(byId(b.read()));
  const writes=remote.fetcher.mock.calls.filter(([,init])=>init?.method==='PUT').length,revision=a.read().revision;
  await automaticRemoteSync(a.store);expect(remote.fetcher.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(writes);expect(a.read().revision).toBe(revision);
});
it('pauses competing edits without writing and resumes after explicit review',async()=>{
  const base={...empty(),notes:[note('原文')]},device=localStore(base),remote=remoteObject(base);memory.saved=session(base);
  device.edit(data=>{data.notes[0]!.text='本机';});remote.edit(data=>{data.notes[0]!.text='远端';});
  await expect(automaticRemoteSync(device.store)).rejects.toThrow('逐项确认');
  expect((memory.saved as RemoteSyncSession).needsReview).toBe(true);expect(remote.read().notes[0]?.text).toBe('远端');
  const preview=await previewRemoteSync(device.store,config);
  await applyRemotePreview(device.store,preview,{['note:'+base.notes[0]!.id]:'remote'});
  expect(device.read().notes[0]?.text).toBe('远端');expect((memory.saved as RemoteSyncSession).needsReview).toBe(false);
  expect(await automaticRemoteSync(device.store)).toBe('synced');
});
it('keeps offline changes durable and uploads after connectivity returns',async()=>{
  const device=localStore(),remote=remoteObject();device.edit(data=>data.notes.push(note('断网记录')));
  remote.fetcher.mockRejectedValueOnce(new TypeError('offline'));
  await expect(automaticRemoteSync(device.store)).rejects.toThrow('网络');
  expect((memory.saved as RemoteSyncSession).needsReview).not.toBe(true);expect(device.read().notes).toHaveLength(1);
  await automaticRemoteSync(device.store);expect(remote.read().notes).toEqual(device.read().notes);
});
it('includes local edits committed while downloading the remote snapshot',async()=>{
  const device=localStore(),remote=remoteObject(),fetcher=remote.fetcher.getMockImplementation()!;
  let edited=false;
  remote.fetcher.mockImplementation(async(url,init)=>{const response=await fetcher(url,init);if(init?.method==='GET'&&!edited){edited=true;device.edit(data=>data.notes.push(note('下载期间提交')));}return response;});
  expect(await automaticRemoteSync(device.store)).toBe('synced');
  expect(remote.read().notes[0]?.title).toBe('下载期间提交');expect((memory.saved as RemoteSyncSession).needsReview).toBe(false);
});
it('does not overwrite a newer remote ETag and re-reads before retry',async()=>{
  const device=localStore(),remote=remoteObject();device.edit(data=>data.notes.push(note('本机')));
  const fetcher=remote.fetcher.getMockImplementation()!;let raced=false;
  remote.fetcher.mockImplementation(async(url,init)=>{if(init?.method==='PUT'&&!raced){raced=true;remote.edit(data=>data.notes.push(note('并发远端')));}return fetcher(url,init);});
  await expect(automaticRemoteSync(device.store)).rejects.toThrow('其他设备修改');
  await automaticRemoteSync(device.store);expect(device.read().notes).toHaveLength(2);expect(remote.read().notes).toHaveLength(2);
});
it('preserves a local edit made during upload and requires fresh review',async()=>{
  const device=localStore(),remote=remoteObject();device.edit(data=>data.notes.push(note('上传前')));
  const fetcher=remote.fetcher.getMockImplementation()!;
  remote.fetcher.mockImplementation(async(url,init)=>{if(init?.method==='PUT')device.edit(data=>data.notes.push(note('上传中')));return fetcher(url,init);});
  await expect(automaticRemoteSync(device.store)).rejects.toThrow('本机数据在上传时已变化');
  expect(device.read().notes).toHaveLength(2);expect(remote.read().notes).toHaveLength(1);expect((memory.saved as RemoteSyncSession).needsReview).toBe(true);
});
it('never recreates a deleted remote file automatically',async()=>{
  const device=localStore();const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:404}));vi.stubGlobal('fetch',fetcher);
  await expect(automaticRemoteSync(device.store)).rejects.toThrow('不存在');expect(fetcher).toHaveBeenCalledTimes(1);expect((memory.saved as RemoteSyncSession).needsReview).toBe(true);
});
it('requires first confirmation and disables automatic mode after changing target',async()=>{
  memory.saved={config,baseline:null};await expect(setRemoteAutomatic(true)).rejects.toThrow('先读取');
  memory.saved=session();await saveRemoteConfig({...config,url:'https://dav.example/another.json'});
  expect(memory.saved).toMatchObject({automatic:false,baseline:null});
  const remote=remoteObject();expect(await automaticRemoteSync(localStore().store)).toBe('disabled');expect(remote.fetcher).not.toHaveBeenCalled();
});
it('serializes concurrent tabs so the second check does not upload an echo',async()=>{
  const device=localStore(),remote=remoteObject();device.edit(data=>data.notes.push(note('一次写入')));
  await Promise.all([automaticRemoteSync(device.store),automaticRemoteSync(device.store)]);
  expect(remote.fetcher.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1);
});
it('scheduler waits offline, wakes online, and stops after disposal',async()=>{
  vi.useFakeTimers();vi.stubGlobal('navigator',{onLine:false,locks:{request:(_name:string,action:()=>Promise<unknown>)=>action()}});
  const device=localStore(),remote=remoteObject();const stop=startAutomaticSync(device.store);
  await vi.advanceTimersByTimeAsync(1);expect(automaticSyncStatus().kind).toBe('offline');expect(remote.fetcher).not.toHaveBeenCalled();
  vi.stubGlobal('navigator',{onLine:true,locks:navigator.locks});window.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(1);
  expect(remote.fetcher).toHaveBeenCalledTimes(1);stop();await vi.advanceTimersByTimeAsync(60_000);expect(remote.fetcher).toHaveBeenCalledTimes(1);
});
it('defers network access while a form has an unsaved draft',async()=>{
  vi.useFakeTimers();const device=localStore(),remote=remoteObject();
  const unregister=registerPrivateDraftSource(()=>true),stop=startAutomaticSync(device.store);
  await vi.advanceTimersByTimeAsync(1);expect(automaticSyncStatus().kind).toBe('deferred');expect(remote.fetcher).not.toHaveBeenCalled();
  unregister();await vi.advanceTimersByTimeAsync(2000);expect(remote.fetcher).toHaveBeenCalledTimes(1);stop();
});
