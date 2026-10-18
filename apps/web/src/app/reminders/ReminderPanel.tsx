import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { REMINDER_MODULE_ID,REMINDER_WIDGET_ID,reminderSnapshotSchema,type ReminderRule,type ReminderSnapshot,type ModuleGateStatus } from '@ff14-hub/shared';
import type { ModuleDataPort,WidgetRuntimeProps } from '../widgets/types';
import { registerPrivateDraftSource } from '../pwa/draft-registry';
interface Draft{id:string;kind:'event'|'fish';region:'cn'|'global';targetId:string;leadMinutes:number;enabled:boolean;expectedRevision:number;operationId:string}
const STATUS:Record<string,string>={queued:'等待到期',leased:'处理中',retry:'等待重试',sent:'推送服务已接受',suppressed:'已抑制',blocked:'渠道未就绪',failed:'投递失败',cancelled:'已取消'};
const REASONS:Record<string,string>={rule_changed:'规则已修改',expired:'提醒时间已过',attempts_exhausted:'达到重试上限',source_or_rule_inactive:'目标、规则或模块已失效',
  no_active_device:'没有可接收的设备',push_unconfigured:'推送渠道未配置',source_changed_during_delivery:'目标在投递期间发生变化',temporary_delivery:'推送服务暂时不可用',no_accepted_delivery:'没有设备的请求被接受'};
export function ReminderPanel({data,ready,failed,refreshKey=0}:{data:ModuleDataPort|undefined;ready?:()=>void;failed?:(e:unknown)=>void;refreshKey?:number}){
  const [snapshot,setSnapshot]=useState<ReminderSnapshot|null>(null);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [version,setVersion]=useState(0);
  const mounted=useRef(false);const draftRef=useRef(draft);const requestSeq=useRef(0);
  const loaded=useRef(false);
  const callbacks=useRef({ready,failed});
  useEffect(()=>{callbacks.current={ready,failed};draftRef.current=draft;});
  useEffect(()=>registerPrivateDraftSource(()=>draftRef.current!==null),[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let alive=true;let inFlight=false;
    const load=async():Promise<void>=>{
      if(data===undefined||inFlight)return;inFlight=true;
      const seq=++requestSeq.current;
      try{const result=reminderSnapshotSchema.parse(await data.call('reminders.snapshot'));
        if(!alive||seq!==requestSeq.current)return;setSnapshot(result);loaded.current=true;callbacks.current.ready?.();
      }catch(cause){if(!alive)return;setError(cause instanceof Error?cause.message:'读取失败');if(!loaded.current)callbacks.current.failed?.(cause);}
      finally{inFlight=false;}
    };
    void load();const timer=setInterval(()=>{void load();},30_000);
    return()=>{alive=false;clearInterval(timer);};
  },[data,version,refreshKey]);
  const action=useCallback(async(op:string,input?:unknown):Promise<boolean>=>{
    if(data===undefined||busy)return false;setBusy(true);setError(null);
    try{await data.call(op,input);if(!mounted.current)return false;setVersion((n)=>n+1);return true;}
    catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'操作失败');return false;}
    finally{if(mounted.current)setBusy(false);}
  },[data,busy]);
  const edit=(rule?:ReminderRule):void=>{setError(null);setDraft({id:rule?.id??crypto.randomUUID(),kind:rule?.kind??'event',region:rule?.region??'cn',
    targetId:rule?.targetId??'',leadMinutes:rule?.leadMinutes??10,enabled:rule?.enabled??true,expectedRevision:rule?.revision??0,operationId:crypto.randomUUID()});};
  const update=(change:Partial<Draft>):void=>setDraft((old)=>old===null?null:{...old,...change,operationId:crypto.randomUUID()});
  const subscribe=async():Promise<void>=>{
    if(!snapshot?.pushConfigured||snapshot.publicKey===null)return;
    try{
      if(!('serviceWorker' in navigator)||!('PushManager' in window))throw new Error('此浏览器不支持推送');
      const registration=await navigator.serviceWorker.ready;
      const key=snapshot.publicKey.replaceAll('-','+').replaceAll('_','/');
      const raw=atob(key+'='.repeat((4-key.length%4)%4));const bytes=Uint8Array.from(raw,(char)=>char.charCodeAt(0));
      const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
      await action('reminders.subscribe',subscription.toJSON());
    }catch(cause){setError(cause instanceof Error?cause.message:'设备订阅失败');}
  };
  if(data===undefined)return <p>请先启用提醒管理模块。</p>;
  return <section className="fishing-panel" aria-label="提醒管理"><header className="fishing-header"><h2>提醒管理</h2>
    <button disabled={busy} onClick={()=>setVersion((n)=>n+1)}>刷新提醒</button></header>
    <p>此处先提供规则和投递框架，通知采用通用占位文案。推送服务接受不代表设备已收件。</p>
    <p role="status">{snapshot?.pushConfigured?'推送服务已配置；设备仍需主动订阅。':'推送渠道未配置，任务会显示“渠道未就绪”。'}</p>
    {error!==null?<p role="alert">{error}</p>:null}
    <div className="fishing-actions"><button disabled={busy} onClick={()=>edit()}>新增提醒规则</button>
      <button disabled={busy||!snapshot?.pushConfigured} onClick={()=>{void subscribe();}}>订阅当前设备</button>
      <button disabled={busy} onClick={()=>{void action('reminders.unsubscribe');}}>停用当前设备接收</button>
      <button disabled={busy} onClick={()=>{void action('reminders.reconcile');}}>检查到期任务</button></div>
    {draft!==null?<form onSubmit={(e)=>{e.preventDefault();void action('reminders.save',draft).then((ok)=>{if(ok)setDraft(null);});}}>
      <h3>{draft.expectedRevision===0?'新增规则':'编辑规则'}</h3>
      <div className="fishing-toolbar"><label>类型 <select value={draft.kind} onChange={(e)=>update({kind:e.target.value as 'event'|'fish',targetId:''})}><option value="event">个人活动</option><option value="fish">鱼类窗口</option></select></label>
        <label>区服 <select value={draft.region} onChange={(e)=>update({region:e.target.value as 'cn'|'global',targetId:''})}><option value="cn">国服</option><option value="global">国际服</option></select></label>
        <label>目标 <select aria-label="提醒目标" required value={draft.targetId} onChange={(e)=>update({targetId:e.target.value})}><option value="">请选择已建立的目标</option>
          {(snapshot?.targets??[]).filter((t)=>t.kind===draft.kind&&t.region===draft.region).map((t)=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
        <label>提前分钟 <input type="number" min={0} max={draft.kind==='fish'?4320:10080} required value={draft.leadMinutes} onChange={(e)=>update({leadMinutes:Number(e.target.value)})}/></label>
        <label><input type="checkbox" checked={draft.enabled} onChange={(e)=>update({enabled:e.target.checked})}/>启用规则</label></div>
      <div className="fishing-actions"><button disabled={busy||draft.targetId===''} type="submit">保存提醒规则</button><button type="button" onClick={()=>setDraft(null)}>放弃编辑</button></div>
    </form>:null}
    <h3>规则</h3>{snapshot?.rules.length===0?<p>尚未建立规则。鱼类示例与未验证规则不会生成真实通知任务。</p>:null}
    <ul>{snapshot?.rules.map((r)=><li key={r.id}>{snapshot.targets.find((t)=>t.id===r.targetId&&t.region===r.region&&t.kind===r.kind)?.label??r.targetId} · 提前{r.leadMinutes}分钟 · {r.enabled?'启用':'停用'}
      <button disabled={busy} onClick={()=>edit(r)}>编辑规则</button><button disabled={busy} onClick={()=>{void action('reminders.delete',{id:r.id,expectedRevision:r.revision,operationId:crypto.randomUUID()});}}>删除规则</button></li>)}</ul>
    <h3>任务与投递记录</h3><ul>{snapshot?.jobs.map((j)=><li key={j.id}>{STATUS[j.status]} · {new Date(j.dueAt).toLocaleString()} · 尝试{j.attempts}次{j.reason===null?'':`（${REASONS[j.reason]??'状态已变化'}）`}</li>)}</ul>
    <ul>{snapshot?.deliveries.map((d)=><li key={`${d.jobId}:${d.deviceId}`}>设备 {d.deviceId.slice(0,8)}：{d.status==='accepted'?'推送服务已接受':d.status==='temporary'?'临时失败':'永久失败'} · {new Date(d.attemptedAt).toLocaleString()}</li>)}</ul>
    <p>当前记录设备订阅{snapshot?.devices.length??0}项，投递结果{snapshot?.deliveries.length??0}项。</p>
  </section>;
}
export function ReminderWidget(props:WidgetRuntimeProps){return <ReminderPanel data={props.data} ready={props.reportReady} failed={props.reportAsyncError} refreshKey={props.retryToken}/>;}
export const reminderWidgetComponents={[REMINDER_WIDGET_ID]:ReminderWidget};
export function ReminderPage({dataPortFor,status}:{dataPortFor:(id:string)=>ModuleDataPort|undefined;status:ModuleGateStatus}){
  const data=useMemo(()=>dataPortFor(REMINDER_MODULE_ID),[dataPortFor]);
  return status==='enabled'?<ReminderPanel data={data}/>:<p>请在模块管理中启用提醒管理。</p>;
}
