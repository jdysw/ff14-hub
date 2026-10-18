import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { z } from 'zod';
import { SYNC_MODULE_ID,SYNC_WIDGET_ID,syncWidgetConfigSchema,fishSyncSnapshotSchema,fishSyncPreviewSchema,fishSyncResultSchema,
  parseFishDocument,serializeFishDocument,fieldsToDocument,documentChanges,type FishSyncSnapshot,type FishSyncPreview,type FishDocument,type FishRegion,type ModuleGateStatus } from '@ff14-hub/shared';
import type { ModuleDataPort,WidgetRuntimeProps } from '../widgets/types';
import { registerPrivateDraftSource } from '../pwa/draft-registry';
const FIELD_LABELS={caught:'已钓获',pinned:'收藏',alarm:'提醒偏好'};
function download(document:FishDocument,name:string):void{
  const url=URL.createObjectURL(new Blob([serializeFishDocument(document)],{type:'application/json'}));
  const link=window.document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function SyncPanel({data,initialRegion='cn',ready,failed,refreshKey=0}:{data:ModuleDataPort|undefined;initialRegion?:FishRegion;
  ready?:()=>void;failed?:(error:unknown)=>void;refreshKey?:number}){
  const [region,setRegion]=useState<FishRegion>(initialRegion);const [snapshot,setSnapshot]=useState<FishSyncSnapshot|null>(null);
  const [text,setText]=useState('');const [document,setDocument]=useState<FishDocument|null>(null);
  const [preview,setPreview]=useState<FishSyncPreview|null>(null);const [backup,setBackup]=useState<FishDocument|null>(null);
  const [backedUp,setBackedUp]=useState(false);const [confirmed,setConfirmed]=useState(false);
  const [operationId,setOperationId]=useState('');const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);const [version,setVersion]=useState(0);
  const alive=useRef(false);const loaded=useRef(false);const pending=useRef(false);const callbacks=useRef({ready,failed});
  const published=useRef<FishSyncSnapshot|null>(null);
  const publish=useCallback((next:FishSyncSnapshot):boolean=>{
    const current=published.current;if(current!==null&&current.region===next.region&&current.watermark>next.watermark)return false;
    published.current=next;setSnapshot(next);return true;
  },[]);
  useEffect(()=>{callbacks.current={ready,failed};pending.current=text!==''||preview!==null;});
  useEffect(()=>registerPrivateDraftSource(()=>pending.current),[]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    let active=true;let reading=false;
    const read=async():Promise<void>=>{if(data===undefined||reading)return;reading=true;
      try{const result=fishSyncSnapshotSchema.parse(await data.call('sync.snapshot',{region}));
        if(!active)return;publish(result);loaded.current=true;callbacks.current.ready?.();
      }catch(cause){if(active){setError(cause instanceof Error?cause.message:'读取失败');if(!loaded.current)callbacks.current.failed?.(cause);}}
      finally{reading=false;}
    };
    void read();const timer=setInterval(()=>{void read();},30_000);return()=>{active=false;clearInterval(timer);};
  },[data,region,version,refreshKey,publish]);
  const run=useCallback(async(action:()=>Promise<void>):Promise<void>=>{
    if(busy||data===undefined)return;setBusy(true);setError(null);setNotice(null);
    try{await action();}catch(cause){if(alive.current)setError(cause instanceof z.ZodError?'文件格式不合法：请提供completed、pinned、alarmFish三个数字ID数组，并检查扩展字段':
      cause instanceof SyntaxError?'JSON无法解析，请检查括号、引号和逗号':cause instanceof Error?cause.message:'同步操作失败');}
    finally{if(alive.current)setBusy(false);}
  },[busy,data]);
  const stage=(next:FishSyncPreview,current:FishSyncSnapshot,extensions:FishDocument|null):void=>{
    if(current.watermark!==next.watermark||!publish(current))throw new Error('预览期间数据已变化，请重新预览');
    setPreview(next);setBackup(fieldsToDocument(current.fields,extensions??undefined));setBackedUp(false);setConfirmed(false);setOperationId(crypto.randomUUID());
  };
  const previewImport=():void=>{void run(async()=>{
    if(data===undefined)return;const parsed=parseFishDocument(text);
    const current=fishSyncSnapshotSchema.parse(await data.call('sync.snapshot',{region}));const changes=documentChanges(parsed,current.fields);
    if(changes.length===0){setDocument(parsed);setNotice('三个集合与服务器一致，没有需要写入的变化。');return;}
    if(changes.length>200)throw new Error('本轮每次最多200项字段变化，请拆分文件；不会部分写入');
    const next=fishSyncPreviewSchema.parse(await data.call('sync.preview',{region,changes}));
    const stable=fishSyncSnapshotSchema.parse(await data.call('sync.snapshot',{region}));
    if(!alive.current)return;setDocument(parsed);stage(next,stable,parsed);
  });};
  const rollback=(auditId:string):void=>{void run(async()=>{
    if(data===undefined)return;const next=fishSyncPreviewSchema.parse(await data.call('sync.rollback',{auditId}));
    const current=fishSyncSnapshotSchema.parse(await data.call('sync.snapshot',{region}));if(alive.current)stage(next,current,document);
  });};
  const apply=():void=>{void run(async()=>{
    if(data===undefined||preview===null||!backedUp||!confirmed)return;
    const result=fishSyncResultSchema.parse(await data.call('sync.apply',{token:preview.token,operationId}));
    let current:FishSyncSnapshot;
    try{current=fishSyncSnapshotSchema.parse(await data.call('sync.snapshot',{region}));}
    catch{throw new Error('提交已确认，但状态刷新失败；请刷新状态，按原操作重试不会重复写入');}
    if(!alive.current)return;publish(current);setPreview(null);setText('');setNotice(`已写入${String(result.applied)}项字段变化，审计记录已保存。`);
  });};
  if(data===undefined)return <p>请先启用数据同步模块和钓鱼手账。</p>;
  return <section className="fishing-panel" aria-label="数据同步"><header className="fishing-header"><h2>数据同步</h2><button disabled={busy} onClick={()=>setVersion((n)=>n+1)}>刷新同步状态</button></header>
    <p>本轮提供鱼糕文件导入／导出与同步协议框架。WebDAV客户端适配已具备条件写与恢复机制，真实鱼糕脚本连接待后续接入。</p>
    <p>WebDAV用户名和密码不会传给Hub；未知扩展字段只保留在当前客户端和导出文件中。</p>
    <label>同步区服 <select value={region} disabled={busy||preview!==null} onChange={(e)=>{setRegion(e.target.value as FishRegion);setSnapshot(null);setError(null);}}><option value="cn">国服</option><option value="global">国际服</option></select></label>
    <p>最后服务端导入：{snapshot?.lastSyncedAt==null?'暂无记录':new Date(snapshot.lastSyncedAt).toLocaleString()}。本状态不代表WebDAV当前内容。</p>
    {error!==null?<p role="alert">{error}</p>:null}{notice!==null?<p role="status">{notice}</p>:null}
    <label>鱼糕JSON文件 <input type="file" accept="application/json,.json" disabled={busy||preview!==null} onChange={(e)=>{const file=e.target.files?.[0];if(file===undefined)return;
      if(file.size>1048576){setError('文件超过1MiB上限');return;}void run(async()=>{const value=await file.text();if(alive.current){setText(value);setDocument(null);}});}}/></label>
    <label>鱼糕JSON内容 <textarea aria-label="鱼糕JSON内容" rows={7} maxLength={1048576} style={{width:'100%',maxWidth:'100%'}} value={text} disabled={busy||preview!==null}
      onChange={(e)=>{setText(e.target.value);setDocument(null);}} placeholder={'{"completed":[],"pinned":[],"alarmFish":[]}'}/></label>
    <div className="fishing-actions"><button disabled={busy||text===''||preview!==null} onClick={previewImport}>预览导入</button>
      <button disabled={busy||snapshot===null} onClick={()=>{if(snapshot!==null)download(fieldsToDocument(snapshot.fields,document??undefined),`fish-${region}.json`);}}>导出当前进度</button></div>
    {preview!==null?<section aria-label="同步变更预览"><h3>变更预览：{preview.changes.length}项</h3>
      <ul>{preview.changes.slice(0,20).map((c)=><li key={`${String(c.fishId)}:${c.field}`}>鱼类{c.fishId} · {FIELD_LABELS[c.field]} → {c.value?'是':'否'}</li>)}</ul>
      {preview.changes.length>20?<p>以上显示前20项，共{preview.changes.length}项。</p>:null}
      <button disabled={busy||backup===null} onClick={()=>{if(backup!==null){download(backup,`fish-before-${region}.json`);setBackedUp(true);}}}>下载变更前备份</button>
      <label><input type="checkbox" checked={confirmed} onChange={(e)=>setConfirmed(e.target.checked)}/>我已核对区服与变更，确认应用</label>
      <div className="fishing-actions"><button disabled={busy||!backedUp||!confirmed} onClick={apply}>应用同步变更</button><button disabled={busy} onClick={()=>setPreview(null)}>取消预览</button></div>
    </section>:null}
    <h3>导入与撤销记录</h3><ul>{snapshot?.audits.map((audit)=><li key={audit.id}>{new Date(audit.createdAt).toLocaleString()} · {audit.applied}项
      <button disabled={busy||preview!==null} onClick={()=>rollback(audit.id)}>预览撤销</button></li>)}</ul>
  </section>;
}
export function SyncWidget(props:WidgetRuntimeProps){const config=syncWidgetConfigSchema.parse(props.config);return <SyncPanel data={props.data} initialRegion={config.region} ready={props.reportReady} failed={props.reportAsyncError} refreshKey={props.retryToken}/>;}
export const syncWidgetComponents={[SYNC_WIDGET_ID]:SyncWidget};
export function SyncPage({dataPortFor,status}:{dataPortFor:(id:string)=>ModuleDataPort|undefined;status:ModuleGateStatus}){
  const data=useMemo(()=>dataPortFor(SYNC_MODULE_ID),[dataPortFor]);return status==='enabled'?<SyncPanel data={data}/>:<p>请在模块管理中启用数据同步和钓鱼手账。</p>;
}
