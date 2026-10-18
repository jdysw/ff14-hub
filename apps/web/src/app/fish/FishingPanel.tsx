import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { FISH_MODULE_ID,FISH_WIDGET_ID,eorzeaTime,fishWidgetConfigSchema,type FishProgressField,type FishRegion,type ModuleGateStatus } from '@ff14-hub/shared';
import type { WidgetRuntimeProps,ModuleDataPort } from '../widgets/types';
import { fishingSnapshotSchema,type FishingSnapshot } from './fish-data-port';
import './fishing.css';

const LABELS: Record<FishProgressField,string> = {caught:'已钓获',pinned:'收藏',alarm:'提醒偏好'};
export function FishingPanel({data,initialRegion='cn',hours=72,onReady,onError}: {
  data:ModuleDataPort|undefined;initialRegion?:FishRegion;hours?:number;
  onReady?:()=>void;onError?:(e:unknown)=>void;
}) {
  const [region,setRegion] = useState(initialRegion);
  const [snapshot,setSnapshot] = useState<FishingSnapshot|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [filter,setFilter] = useState('all');
  const [text,setText] = useState('');
  const [offset,setOffset] = useState(0);
  const [pending,setPending] = useState<{fishId:number;field:FishProgressField;value:boolean;operationId:string;expectedRevision:number}|null>(null);
  const generation = useRef(0);
  const watermark = useRef(-1);
  const [reload,setReload] = useState(0);
  const callbacks = useRef({onReady,onError});
  useEffect(() => {callbacks.current={onReady,onError};});
  useEffect(() => {
    let alive=true;
    const current = ++generation.current;
    watermark.current=-1;
    const load = async ():Promise<void> => {
      if (data === undefined) return;
      try {
        const result = fishingSnapshotSchema.parse(await data.call('fish.snapshot',{region,hours,offset,text}));
        if (!alive || current !== generation.current || result.progress.watermark < watermark.current) return;
        watermark.current=result.progress.watermark;
        setSnapshot(result); setError(null); callbacks.current.onReady?.();
      } catch (cause) {
        if (!alive) return;
        setError(cause instanceof Error?cause.message:'加载失败，请重试'); callbacks.current.onError?.(cause);
      }
    };
    void load();
    const timer=setInterval(() => {void load();},30_000);
    const focus=():void => {void load();};
    window.addEventListener('focus',focus);
    return () => {alive=false;clearInterval(timer);window.removeEventListener('focus',focus);};
  },[data,region,hours,reload,offset,text]);
  const changeField = useCallback(async (fishId:number,field:FishProgressField):Promise<void> => {
    if (data === undefined || busy || snapshot === null) return;
    const old=snapshot.progress.fields.find((f) => f.fishId===fishId && f.field===field);
    const intent=pending?.fishId===fishId && pending.field===field?pending:
      {fishId,field,value:!(old?.value ?? false),expectedRevision:old?.revision ?? 0,operationId:crypto.randomUUID()};
    setPending(intent);setBusy(true);
    const current=generation.current;
    try {
      await data.call('fish.progress',{...intent,region});
      if (current===generation.current) {setPending(null);setReload((n)=>n+1);}
    } catch (cause) {if(current===generation.current)setError(cause instanceof Error?cause.message:'保存失败');}
    finally {if(current===generation.current)setBusy(false);}
  },[data,busy,snapshot,pending,region]);
  if (data === undefined) return <p role="status">请在模块管理中启用钓鱼手账。</p>;
  const fields=snapshot?.progress.fields ?? [];
  const flag=(id:number,field:FishProgressField):boolean => fields.find((f)=>f.fishId===id && f.field===field)?.value ?? false;
  const fish=(snapshot?.fish.fish ?? []).filter((f)=>f.name.toLocaleLowerCase().includes(text.toLocaleLowerCase()) &&
    (filter==='all' || (filter==='uncaught'?!flag(f.id,'caught'):flag(f.id,filter==='pinned'?'pinned':'alarm'))));
  const et=eorzeaTime(snapshot?.windows.from ?? 0);
  return <section className="fishing-panel" aria-label="钓鱼手账">
    <header className="fishing-header"><div><h2>钓鱼手账</h2><p>ET {String(et.hour).padStart(2,'0')}:{String(et.minute).padStart(2,'0')} · 时间按本机时区显示</p></div>
      <button type="button" disabled={busy} onClick={()=>{setPending(null);setReload((n)=>n+1);}}>刷新数据</button></header>
    <div className="fishing-toolbar">
      <label>区服 <select aria-label="钓鱼区服" value={region} disabled={busy} onChange={(e)=>{setRegion(e.target.value as FishRegion);setOffset(0);setSnapshot(null);setPending(null);setError(null);}}>
        <option value="cn">国服</option><option value="global">国际服</option></select></label>
      <label>鱼名 <input value={text} onChange={(e)=>{setText(e.target.value);setOffset(0);}} placeholder="筛选鱼类"/></label>
      <label>进度 <select value={filter} onChange={(e)=>setFilter(e.target.value)}><option value="all">全部</option><option value="uncaught">未钓获</option><option value="pinned">已收藏</option><option value="alarm">提醒偏好</option></select></label>
    </div>
    <p className="fishing-disclaimer">窗口为条件预测；鱼识、前置鱼等条件需另行满足。提醒偏好暂不发送通知。</p>
    {error!==null?<p role="alert">{error}{pending!==null?'；未保存的选择已保留，可重试或刷新后重新选择。':''}</p>:null}
    {snapshot===null && error===null?<p role="status">正在读取钓鱼数据…</p>:null}
    {snapshot!==null && fish.length===0?<p>没有符合筛选的鱼类。目录可通过离线数据适配器导入；尚未提供全量已验证数据。</p>:null}
    {fish.map((f)=>{
      const windows=snapshot?.windows.windows.filter((w)=>w.fishId===f.id).slice(0,4) ?? [];
      return <article key={`${f.region}:${String(f.id)}`} className="fishing-entry"><h3>{f.name}</h3>
        <p>{f.demo?'示例数据 · ':''}{f.rule.validationStatus==='verified'?'规则已核对':f.rule.validationStatus==='incomplete'?'条件不完整':'规则未验证'} · {f.rule.zoneId}</p>
        <div className="fishing-actions">{(['caught','pinned','alarm'] as const).map((field)=><button key={field} type="button" aria-pressed={flag(f.id,field)} disabled={busy}
          onClick={()=>{void changeField(f.id,field);}}>{LABELS[field]}</button>)}</div>
        {windows.length===0?<p>查询范围内没有匹配的候选窗口。</p>:<ol className="fishing-windows">{windows.map((w)=><li key={w.occurrenceKey}>
          <time dateTime={new Date(w.startsAtUtcMs).toISOString()}>{new Date(w.startsAtUtcMs).toLocaleString()}</time> 至 {new Date(w.endsAtUtcMs).toLocaleTimeString()}
          <span>{w.weatherChain.previous} → {w.weatherChain.current}{w.candidateOnly?' · 候选窗口':''}</span>
        </li>)}</ol>}
        {f.rule.conditions.length>0?<ul>{f.rule.conditions.map((c,i)=><li key={i}>{c.description}</li>)}</ul>:null}
        <details><summary>规则来源与版本</summary><p>{f.source.version} / {f.rule.version} · 数据授权{f.source.authorizationStatus==='permitted'?'已记录':'待核实'}</p>
          <a href={f.source.url} target="_blank" rel="noopener noreferrer">查看来源</a></details>
      </article>;
    })}
    {snapshot!==null?<div className="fishing-actions"><button disabled={offset===0||busy} onClick={()=>{setOffset(Math.max(0,offset-30));setSnapshot(null);}}>上一页</button>
      <span>第 {String(Math.floor(offset/30)+1)} 页 · 共 {String(snapshot.fish.total)} 条；进度筛选仅作用于本页</span>
      <button disabled={offset+30>=snapshot.fish.total||busy} onClick={()=>{setOffset(offset+30);setSnapshot(null);}}>下一页</button></div>:null}
  </section>;
}
export function FishingWidget(props:WidgetRuntimeProps) {
  const config=fishWidgetConfigSchema.parse(props.config);
  return <FishingPanel data={props.data} initialRegion={config.region} hours={config.hours} onReady={props.reportReady} onError={props.reportAsyncError}/>;
}
export const fishWidgetComponents = {[FISH_WIDGET_ID]:FishingWidget};
export function FishingPage({dataPortFor,status}:{dataPortFor:(moduleId:string)=>ModuleDataPort|undefined;status:ModuleGateStatus}) {
  const data=useMemo(()=>dataPortFor(FISH_MODULE_ID),[dataPortFor]);
  return status==='enabled'?<FishingPanel data={data}/>:<section><h2>钓鱼手账</h2><p>请先在模块管理中安装并启用钓鱼手账。</p></section>;
}
