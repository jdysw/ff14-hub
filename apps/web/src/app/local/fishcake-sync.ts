import {z} from 'zod';
import {canonicalJson,fieldsToDocument,fishDocumentSchema,mergeFishDocuments,documentChanges,type FishDocument,type FishRegion,type MergeConflict} from '@ff14-hub/shared';
import {readDeviceRecord,writeDeviceRecord} from './secure-storage';
import type {LocalStore,LocalData} from './store';

const STATE_KEY='fishcake-sync-v1';
export const FISHCAKE_SYNC_CHANGED='ff14hub:fishcake-sync';
interface Saved{region:FishRegion;enabled:boolean;baseline:FishDocument|null;lastSync?:number;error?:string;backup?:FishDocument}
export interface FishcakePreview{local:LocalData;remote:FishDocument;baseline:FishDocument|null;region:FishRegion;restore?:FishDocument}
const snapshotSchema=z.object({session:z.string(),region:z.enum(['cn','global']),at:z.number(),document:fishDocumentSchema.nullable(),error:z.string().nullable().optional()});
export function fishcakeRequest(action:string,region?:FishRegion,extra:Record<string,unknown>={},timeout=18000):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const finish=()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
    const receive=(event:MessageEvent<unknown>)=>{
      if(event.source!==window||event.origin!==location.origin)return;
      const message=event.data as Record<string,unknown>|null;
      if(!message||message['channel']!=='ff14hub-fishcake'||message['direction']!=='response'||message['id']!==id)return;
      finish();if(typeof message['error']==='string'&&message['error'])reject(new Error(message['error']));else resolve(message['value']);
    };
    const timer=setTimeout(()=>{finish();reject(new Error('未收到互通脚本响应，请安装或更新脚本，并刷新本站和鱼糕页面。'));},timeout);
    window.addEventListener('message',receive);
    window.postMessage({channel:'ff14hub-fishcake',direction:'request',id,action,region,...extra},location.origin);
  });
}
const changed=()=>window.dispatchEvent(new Event(FISHCAKE_SYNC_CHANGED));
export const readFishcakeSettings=()=>readDeviceRecord<Saved>(STATE_KEY);
async function save(value:Saved){await writeDeviceRecord(STATE_KEY,value);changed();}
async function exclusive<T>(action:()=>Promise<T>):Promise<T>{
  if(!navigator.locks)throw new Error('当前浏览器不支持安全的跨标签同步，请更新浏览器');
  return navigator.locks.request('ff14hub-fishcake-sync',action);
}
export function mergeFishcakePreview(preview:FishcakePreview,choices:ReadonlyMap<string,'local'|'hub'>=new Map()){
  if(preview.restore)return {document:fishDocumentSchema.parse({...preview.remote,...preview.restore}),conflicts:[] as MergeConflict[]};
  return mergeFishDocuments({baseline:preview.baseline,local:preview.remote,webdav:preview.remote,
    hub:fieldsToDocument(preview.local.fish[preview.region]),resolutions:choices});
}
export async function previewFishcakeRestore(store:LocalStore):Promise<FishcakePreview>{
  const saved=await readFishcakeSettings();if(!saved?.backup)throw new Error('没有可恢复的同步前快照');
  return {...await previewFishcake(store,saved.region),restore:saved.backup};
}
export function fishcakeConflictLabel(conflict:MergeConflict):string{
  const [field,id]=conflict.key.split(':');
  return `${field==='completed'?'钓获':field==='pinned'?'收藏':field==='alarmFish'?'提醒':'扩展字段'} · ${id??''}`;
}
async function readRemote(region:FishRegion,waitForPeer=false):Promise<FishDocument>{
  let raw:unknown=await fishcakeRequest('read',region);
  for(let attempt=0;!raw&&waitForPeer&&attempt<12;attempt++){
    await new Promise(resolve=>setTimeout(resolve,500));raw=await fishcakeRequest('read',region);
  }
  if(!raw)throw new Error('请在同一浏览器打开鱼糕页面，并确认互通脚本已启用；稍后重新读取。');
  const snapshot=snapshotSchema.parse(raw);
  if(snapshot.region!==region||Date.now()-snapshot.at>20000)throw new Error('鱼糕页面已离线，请打开或刷新鱼糕');
  if(snapshot.error)throw new Error(snapshot.error);
  return fishDocumentSchema.parse(snapshot.document);
}
export async function previewFishcake(store:LocalStore,region:FishRegion):Promise<FishcakePreview>{
  return exclusive(async()=>{
    const saved=await readFishcakeSettings();
    // Opening a preview pauses automation; a subsequent explicit apply resumes it.
    if(saved?.enabled)await save({...saved,enabled:false});
    await fishcakeRequest('connect',region);
    return {local:await store.read(),remote:await readRemote(region,true),baseline:saved?.region===region?saved.baseline:null,region};
  });
}
export async function applyFishcakeLocal(store:LocalStore,expectedRevision:number,region:FishRegion,document:FishDocument):Promise<void>{
  const checked=fishDocumentSchema.parse(document);
  const before=await store.read();
  // No transaction or notification when the data already agrees.
  if(before.revision!==expectedRevision)throw new Error('本站进度已变化，请重新读取；鱼糕已确认的写入会保留。');
  const changes=documentChanges(checked,before.fish[region]);
  if(!changes.length)return;
  await store.change(record=>{
    if(record.data.revision!==expectedRevision)throw new Error('本站进度已变化，请重新读取；鱼糕已确认的写入会保留。');
    const fields=record.data.fish[region];
    for(const edit of changes){
      const current=fields.find(f=>f.fishId===edit.fishId&&f.field===edit.field);
      if(current){current.value=edit.value;current.revision++;current.updatedAt=Date.now();}
      else fields.push({region,fishId:edit.fishId,field:edit.field,value:edit.value,revision:1,updatedAt:Date.now()});
    }
  });
}
async function apply(store:LocalStore,preview:FishcakePreview,choices:ReadonlyMap<string,'local'|'hub'>){
  const merged=mergeFishcakePreview(preview,choices);
  if(merged.conflicts.length)throw new Error(`有 ${merged.conflicts.length} 项差异需要选择，请在鱼糕互通中预览。`);
  if((await store.read()).revision!==preview.local.revision)throw new Error('本站数据已变化，请重新预览');
  const old=await readFishcakeSettings();
  const checkpoint:Saved={region:preview.region,enabled:false,baseline:preview.baseline,backup:fieldsToDocument(preview.local.fish[preview.region]),...(old?.lastSync?{lastSync:old.lastSync}:{})};
  // Persist a before-image before crossing the two independent stores.
  await save(checkpoint);
  try{
    // The fish adapter compares the live source even when the desired document is equal.
    const acknowledged=fishDocumentSchema.parse(await fishcakeRequest('apply',preview.region,{expected:preview.remote,document:merged.document}));
    if(canonicalJson(acknowledged)!==canonicalJson(merged.document))throw new Error('鱼糕确认的数据不一致，请重新读取');
    await applyFishcakeLocal(store,preview.local.revision,preview.region,merged.document);
    await save({...checkpoint,enabled:true,baseline:merged.document,lastSync:Date.now()});
  }catch(cause){await save({...checkpoint,error:cause instanceof Error?cause.message:'互通失败，请重新读取'});throw cause;}
}
export const applyFishcake=(store:LocalStore,preview:FishcakePreview,choices:ReadonlyMap<string,'local'|'hub'>=new Map())=>exclusive(()=>apply(store,preview,choices));
export async function disconnectFishcake(){
  await exclusive(async()=>{
    const saved=await readFishcakeSettings();
    // Stop locally even if the extension or the fish page is no longer available.
    if(saved)await save({...saved,enabled:false,error:'已暂停；重新预览并应用后可恢复'});
    if(saved)await fishcakeRequest('disconnect',saved.region);
  });
}
export function startFishcakeSync(store:LocalStore){
  let stopped=false,busy=false;
  const tick=()=>{
    if(stopped||busy)return;busy=true;
    void exclusive(async()=>{
      const saved=await readFishcakeSettings();if(stopped||!saved?.enabled)return;
      try{
        const remote=await readRemote(saved.region),local=await store.read();
        if(canonicalJson(fieldsToDocument(local.fish[saved.region]))===canonicalJson(saved.baseline)&&canonicalJson(remote)===canonicalJson(saved.baseline)){
          if(saved.error){const next={...saved};delete next.error;await save(next);}return;
        }
        if(mergeFishcakePreview({local,remote,region:saved.region,baseline:saved.baseline}).conflicts.length){
          await save({...saved,enabled:false,error:'检测到差异，自动互通已暂停，请重新预览并选择。'});return;
        }
        await apply(store,{local,remote,region:saved.region,baseline:saved.baseline},new Map());
      }catch(cause){
        const error=cause instanceof Error?cause.message:'互通暂不可用';
        // Network/offline errors retry. A divergent edit or failed commit requires preview.
        const current=await readFishcakeSettings();
        if(current&&current.error!==error)await save({...current,error});
      }
    }).catch(()=>{}).finally(()=>{busy=false;});
  };
  const unsubscribe=store.subscribe(tick),timer=setInterval(tick,5000);tick();
  window.addEventListener(FISHCAKE_SYNC_CHANGED,tick);
  return()=>{stopped=true;clearInterval(timer);unsubscribe();window.removeEventListener(FISHCAKE_SYNC_CHANGED,tick);};
}
