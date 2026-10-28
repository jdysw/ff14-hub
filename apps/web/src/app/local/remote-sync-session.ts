import {localDataSchema,type LocalData,type LocalStore} from './store';
import {readDeviceRecord,updateDeviceRecord} from './secure-storage';
import {applyPersonalSync,createRemoteClient,mergePersonalData,personalDataFingerprint,remoteConfigSchema,RemoteSyncError,type RemoteConfig} from './remote-sync';

export const REMOTE_SYNC_CHANGED='ff14hub:remote-sync-changed';
export interface RemoteSyncSession {config:RemoteConfig;baseline:LocalData|null;lastSync?:string;backup?:LocalData;automatic?:boolean;needsReview?:boolean;}
export interface RemoteSyncPreview {local:LocalData;remote:LocalData|null;etag:string|null;configKey:string;}
const configKey=(config:RemoteConfig)=>JSON.stringify(remoteConfigSchema.parse(config));
export async function readRemoteSession():Promise<RemoteSyncSession|null>{
  const saved=await readDeviceRecord<RemoteSyncSession>('remote-sync');
  return saved?{...saved,config:remoteConfigSchema.parse(saved.config),baseline:saved.baseline?localDataSchema.parse(saved.baseline):null}:null;
}
function announce(){
  window.dispatchEvent(new Event(REMOTE_SYNC_CHANGED));
  if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(REMOTE_SYNC_CHANGED);channel.postMessage('changed');channel.close();}
}
export async function updateRemoteSession(update:(previous:RemoteSyncSession|null)=>RemoteSyncSession|undefined){
  const value=await updateDeviceRecord<RemoteSyncSession>('remote-sync',update);announce();return value;
}
export async function withRemoteSyncLock<T>(action:()=>Promise<T>):Promise<T>{
  if(typeof navigator!=='undefined'&&navigator.locks)return await navigator.locks.request('ff14hub:personal-remote-sync',action);
  return action();
}
function requireSession(saved:RemoteSyncSession|null,key:string):RemoteSyncSession{
  if(!saved||configKey(saved.config)!==key)throw new Error('本机同步配置已变化，请重新预览');
  return saved;
}
export async function saveRemoteConfig(config:RemoteConfig){
  const parsed=remoteConfigSchema.parse(config);createRemoteClient(parsed);
  return withRemoteSyncLock(()=>updateRemoteSession(previous=>{
    if(previous&&configKey(previous.config)===configKey(parsed))return {...previous,config:parsed};
    return {config:parsed,baseline:null,automatic:false,needsReview:false,...(previous?.backup?{backup:previous.backup}:{})};
  }));
}
export async function setRemoteAutomatic(enabled:boolean){
  if(enabled&&!navigator.locks)throw new RemoteSyncError('config','当前浏览器不支持安全的跨标签同步锁，请使用手动同步');
  return withRemoteSyncLock(()=>updateRemoteSession(previous=>{
    if(!previous)throw new Error('本机尚未配置同步');
    if(enabled&&(!previous.baseline||!previous.lastSync||previous.needsReview))throw new RemoteSyncError('config','请先读取远端并确认一次双向同步');
    return {...previous,automatic:enabled};
  }));
}
export async function previewRemoteSync(store:LocalStore,config:RemoteConfig):Promise<RemoteSyncPreview>{
  return withRemoteSyncLock(async()=>{
    const key=configKey(config);requireSession(await readRemoteSession(),key);
    await updateRemoteSession(previous=>({...requireSession(previous,key),needsReview:true}));
    const local=await store.read(),remote=await createRemoteClient(config).read();
    return {local,remote:remote.data,etag:remote.etag,configKey:key};
  });
}

/** Same comparison is used by the scheduler and the manual review. Revisions are local bookkeeping. */
export async function commitRemoteMerge(store:LocalStore,saved:RemoteSyncSession,preview:RemoteSyncPreview,choices:Record<string,'local'|'remote'>={},client=createRemoteClient(saved.config),current:()=>boolean=()=>true){
  const merged=mergePersonalData(saved.baseline,preview.local,preview.remote,choices);
  if(merged.conflicts.length)throw new RemoteSyncError('conflict','有不同设备同时修改的内容，请读取远端并逐项确认');
  const localChanged=personalDataFingerprint(merged.data)!==personalDataFingerprint(preview.local);
  const remoteChanged=!preview.remote||personalDataFingerprint(merged.data)!==personalDataFingerprint(preview.remote);
  const baselineChanged=!saved.baseline||personalDataFingerprint(saved.baseline)!==personalDataFingerprint(merged.data);
  if(!localChanged&&!remoteChanged&&!baselineChanged)return saved;
  if(!current()||(await store.read()).revision!==preview.local.revision)throw new Error('本机数据已变化，请重新预览');
  await updateRemoteSession(previous=>({...requireSession(previous,preview.configKey),backup:preview.local}));
  if(!current())throw new Error('本机同步已停止');
  if(remoteChanged)await client.write(merged.data,preview.etag);
  if(!current())throw new Error('本机同步暂缓，未替换本机数据');
  if(localChanged)await applyPersonalSync(store,preview.local.revision,merged.data);
  // A local edit during PUT remains pending; a later merge must not mark it synchronized.
  const latest=await store.read();
  if(!localChanged&&latest.revision!==preview.local.revision)throw new Error('本机数据在上传时已变化，请重新预览');
  const next=await updateRemoteSession(previous=>({...requireSession(previous,preview.configKey),baseline:merged.data,lastSync:new Date().toISOString(),needsReview:false}));
  return next!;
}
export async function applyRemotePreview(store:LocalStore,preview:RemoteSyncPreview,choices:Record<string,'local'|'remote'>){
  return withRemoteSyncLock(async()=>{
    const saved=requireSession(await readRemoteSession(),preview.configKey);
    const result=await commitRemoteMerge(store,saved,preview,choices);
    if(result.needsReview)return (await updateRemoteSession(previous=>({...requireSession(previous,preview.configKey),needsReview:false,lastSync:new Date().toISOString()})))!;
    return result;
  });
}
export async function automaticRemoteSync(store:LocalStore,current:()=>boolean=()=>true){
  if(!navigator.locks)return 'unsupported' as const;
  return withRemoteSyncLock(async()=>{
    const saved=await readRemoteSession();
    if(!saved?.automatic)return 'disabled' as const;
    if(saved.needsReview||!saved.baseline||!saved.lastSync)return 'review' as const;
    const key=configKey(saved.config),client=createRemoteClient(saved.config);
    try{
      const remote=await client.read(),local=await store.read();
      if(!remote.data)throw new RemoteSyncError('format','远端文件已不存在，请重新读取预览，自动同步未重新创建它');
      await commitRemoteMerge(store,saved,{local,remote:remote.data,etag:remote.etag,configKey:key},{},client,current);
      return 'synced' as const;
    }catch(cause){
      if(!current())return 'deferred' as const;
      const review=cause instanceof RemoteSyncError?['auth','etag','format','config'].includes(cause.code)||(cause.code==='conflict'&&!cause.message.startsWith('远端已被其他设备修改')):true;
      if(review)await updateRemoteSession(previous=>({...requireSession(previous,key),needsReview:true}));
      throw cause;
    }
  });
}
export async function restoreRemoteBackup(store:LocalStore){
  return withRemoteSyncLock(async()=>{
    const saved=await readRemoteSession();if(!saved?.backup)return;
    await updateRemoteSession(previous=>previous?{...previous,automatic:false,needsReview:true}:undefined);
    await store.restoreBackup({format:'ff14-hub-local',version:1,exportedAt:new Date().toISOString(),data:localDataSchema.parse(saved.backup)});
  });
}
