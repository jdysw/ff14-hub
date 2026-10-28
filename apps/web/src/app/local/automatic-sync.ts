import type {LocalStore} from './store';
import {automaticRemoteSync,REMOTE_SYNC_CHANGED} from './remote-sync-session';
import {remoteFailureMessage} from './remote-sync';
import {hasAnyPrivateDraft,registerPrivateDraftSource} from '../pwa/draft-registry';

export const AUTO_SYNC_STATUS='ff14hub:auto-sync-status';
export interface AutoSyncStatus {kind:'idle'|'syncing'|'synced'|'offline'|'review'|'retry'|'disabled'|'unsupported'|'deferred';message:string;checkedAt?:number;}
let status:AutoSyncStatus={kind:'idle',message:'等待检查同步配置'};
export const automaticSyncStatus=()=>status;
function publish(next:AutoSyncStatus){status=next;window.dispatchEvent(new Event(AUTO_SYNC_STATUS));}

/** Runs only while a page is alive. IDB is the durable offline queue; no unload upload is attempted. */
export function startAutomaticSync(store:LocalStore){
  let stopped=false,running=false,timer:ReturnType<typeof setTimeout>|undefined,failures=0;
  const ownDraft=()=>running;
  const schedule=(delay=2000)=>{
    if(stopped||running)return;
    clearTimeout(timer);timer=setTimeout(()=>{void run();},delay);
  };
  const run=async()=>{
    if(stopped||running)return;
    if(document.visibilityState==='hidden'){schedule(30_000);return;}
    if(navigator.onLine===false){publish({kind:'offline',message:'当前离线，修改保存在本机；联网后继续同步'});schedule(30_000);return;}
    if(hasAnyPrivateDraft(ownDraft)){publish({kind:'deferred',message:'有未保存的编辑，保存或取消后继续自动同步'});schedule(2000);return;}
    running=true;publish({kind:'syncing',message:'正在检查其他设备的修改…'});
    try{
      const result=await automaticRemoteSync(store,()=>!stopped&&!hasAnyPrivateDraft(ownDraft));
      failures=0;
      const messages={synced:'已检查，当前资料已同步',disabled:'自动同步未开启',review:'自动同步已暂停，请读取远端预览并确认差异',unsupported:'当前浏览器不支持自动同步，请使用手动同步',deferred:'有未保存的编辑，稍后继续自动同步'};
      if(!stopped)publish({kind:result,message:messages[result],...(result==='synced'?{checkedAt:Date.now()}:{})});
    }catch(cause){failures++;if(!stopped)publish({kind:'retry',message:remoteFailureMessage(cause)});}
    finally{running=false;schedule(failures?Math.min(300_000,5000*3**Math.min(failures-1,4)):30_000);}
  };
  const wake=()=>{failures=0;schedule(0);};
  const changed=()=>schedule();
  const unsubscribe=store.subscribe(changed),unregister=registerPrivateDraftSource(ownDraft);
  window.addEventListener(REMOTE_SYNC_CHANGED,wake);window.addEventListener('online',wake);window.addEventListener('offline',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel(REMOTE_SYNC_CHANGED);
  if(channel)channel.onmessage=()=>{window.dispatchEvent(new Event(REMOTE_SYNC_CHANGED));};
  schedule(0);
  return()=>{stopped=true;clearTimeout(timer);unsubscribe();unregister();channel?.close();window.removeEventListener(REMOTE_SYNC_CHANGED,wake);window.removeEventListener('online',wake);window.removeEventListener('offline',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
}
