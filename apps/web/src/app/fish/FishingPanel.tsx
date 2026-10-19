import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { FISH_MODULE_ID,FISH_WIDGET_ID,eorzeaTime,fishWidgetConfigSchema,type FishRecord,type FishWindow,
  type FishProgressField,type FishRegion,type ModuleGateStatus } from '@ff14-hub/shared';
import type { WidgetRuntimeProps,ModuleDataPort } from '../widgets/types';
import { fishingSnapshotSchema,publicFishPort,type FishingSnapshot } from './fish-data-port';
import './fishing.css';

const LABELS:Record<FishProgressField,string>={caught:'已钓获',pinned:'收藏',alarm:'提醒偏好'};
type Category='all'|'rare'|'normal'|'big'|'legendary';
type Availability='all'|'active'|'soon';
type ProgressFilter='all'|'uncaught'|'pinned'|'alarm';
const DAY_MS=86_400_000;
function remaining(ms:number):string {
  if(ms<=0)return '即将结束';
  const minutes=Math.ceil(ms/60_000);
  if(minutes<60)return String(minutes)+' 分钟';
  const hours=Math.floor(minutes/60);
  if(hours<24)return String(hours)+' 小时 '+String(minutes%60)+' 分钟';
  return String(Math.floor(hours/24))+' 天 '+String(hours%24)+' 小时';
}
function localTime(ms:number):string {
  return new Date(ms).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}
function etLabel(ms:number):string{
  const et=eorzeaTime(ms);
  return String(et.hour).padStart(2,'0')+':'+String(et.minute).padStart(2,'0');
}
function getAvailableWindows(windows:readonly FishWindow[],now:number){
  const open=windows.find(w=>w.startsAtUtcMs<=now && w.endsAtUtcMs>now)??null;
  const next=windows.find(w=>w.startsAtUtcMs>now)??null;
  return {open,next};
}
export function FishingPanel({data,initialRegion='cn',hours=72,onReady,onError,compact=false}:{
  data:ModuleDataPort|undefined;initialRegion?:FishRegion;hours?:number;
  onReady?:()=>void;onError?:(e:unknown)=>void;compact?:boolean;
}){
  const [region,setRegion]=useState<FishRegion>(initialRegion);
  const [range,setRange]=useState(hours);
  const [category,setCategory]=useState<Category>('all');
  const [availability,setAvailability]=useState<Availability>('all');
  const [filter,setFilter]=useState<ProgressFilter>('all');
  const [text,setText]=useState('');
  const [offset,setOffset]=useState(0);
  const [snapshot,setSnapshot]=useState<FishingSnapshot|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [clock,setClock]=useState(()=>Date.now());
  const [expanded,setExpanded]=useState<Record<number,boolean>>({});
  const [pending,setPending]=useState<{fishId:number;field:FishProgressField;value:boolean;operationId:string;expectedRevision:number}|null>(null);
  const [reload,setReload]=useState(0);
  const generation=useRef(0);
  const watermark=useRef(-1);
  const callbacks=useRef({onReady,onError});
  useEffect(()=>{callbacks.current={onReady,onError};});
  useEffect(()=>{
    const timer=window.setInterval(()=>setClock(Date.now()),15_000);
    return ()=>window.clearInterval(timer);
  },[]);
  useEffect(()=>{
    let alive=true;
    const current=++generation.current;
    watermark.current=-1;
    const load=async():Promise<void>=>{
      if(data===undefined)return;
      try{
        const result=fishingSnapshotSchema.parse(await data.call('fish.snapshot',{region,hours:range,category,offset,text}));
        if(!alive||current!==generation.current||result.progress.watermark<watermark.current)return;
        watermark.current=result.progress.watermark;
        setSnapshot(result);setError(null);setClock(Date.now());callbacks.current.onReady?.();
      }catch(cause){
        if(!alive||current!==generation.current)return;
        setError(cause instanceof Error?cause.message:'鱼类数据加载失败');callbacks.current.onError?.(cause);
      }
    };
    void load();
    const timer=window.setInterval(()=>{void load();},30_000);
    const focus=():void=>{void load();};
    window.addEventListener('focus',focus);
    return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('focus',focus);};
  },[data,region,range,category,offset,text,reload]);
  const canEdit=data?.operations.includes('fish.progress')??false;
  const fields=snapshot?.progress.fields??[];
  const flag=(id:number,field:FishProgressField):boolean=>fields.find(f=>f.fishId===id&&f.field===field)?.value??false;
  const windowsByFish=useMemo(()=>{
    const result=new Map<number,FishWindow[]>();
    for(const w of snapshot?.windows.windows??[]){
      const list=result.get(w.fishId)??[];
      list.push(w);result.set(w.fishId,list);
    }
    return result;
  },[snapshot]);
  const pageFish=snapshot?.fish.fish??[];
  const fish=useMemo(()=>{
    const eligible=pageFish.filter(f=>{
      const windows=windowsByFish.get(f.id)??[];
      const state=getAvailableWindows(windows,clock);
      return (filter==='all'||(filter==='uncaught'?!flag(f.id,'caught'):flag(f.id,filter==='pinned'?'pinned':'alarm'))) &&
        (availability==='all'||(availability==='active'?state.open!==null:state.open===null&&state.next!==null&&state.next.startsAtUtcMs-clock<=DAY_MS));
    });
    return eligible.sort((a,b)=>{
      const score=(f:FishRecord):number=>{
        const state=getAvailableWindows(windowsByFish.get(f.id)??[],clock);
        if(state.open!==null)return state.open.endsAtUtcMs-DAY_MS*200;
        return state.next?.startsAtUtcMs??Number.MAX_SAFE_INTEGER;
      };
      return score(a)-score(b)||a.id-b.id;
    });
  // 进度水位在 snapshot 内，筛选只针对当前页；切换分类时由后端重新分页。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pageFish,windowsByFish,clock,filter,availability,snapshot]);
  const activeCount=pageFish.filter(f=>getAvailableWindows(windowsByFish.get(f.id)??[],clock).open!==null).length;
  const soonCount=pageFish.filter(f=>{
    const state=getAvailableWindows(windowsByFish.get(f.id)??[],clock);
    return state.open===null&&state.next!==null&&state.next.startsAtUtcMs-clock<=DAY_MS;
  }).length;
  const caughtCount=pageFish.filter(f=>flag(f.id,'caught')).length;
  const changeField=useCallback(async(fishId:number,field:FishProgressField):Promise<void>=>{
    if(data===undefined||!canEdit||busy||snapshot===null)return;
    const old=snapshot.progress.fields.find(f=>f.fishId===fishId&&f.field===field);
    const intent=pending?.fishId===fishId&&pending.field===field?pending:{
      fishId,field,value:!(old?.value??false),expectedRevision:old?.revision??0,operationId:crypto.randomUUID()
    };
    setPending(intent);setBusy(true);
    const current=generation.current;
    try{
      await data.call('fish.progress',{...intent,region});
      if(current===generation.current){setPending(null);setReload(n=>n+1);}
    }catch(cause){
      if(current===generation.current)setError(cause instanceof Error?cause.message:'保存失败');
    }finally{if(current===generation.current)setBusy(false);}
  },[data,canEdit,busy,snapshot,pending,region]);
  if(data===undefined)return <p role="status">请在模块管理中启用钓鱼手账。</p>;
  const et=eorzeaTime(clock);
  const hasDemo=pageFish.some(f=>f.demo);
  const clearFilters=():void=>{setFilter('all');setAvailability('all');setText('');setCategory('all');setOffset(0);setSnapshot(null);};
  return <section className={'fishing-panel'+(compact?' fishing-panel--widget':'')} aria-label="钓鱼手账">
    <header className="fishing-header">
      <div><span className="fishing-kicker">FISHING · WINDOW TRACKER</span><h2>钓鱼手账</h2>
        <p>国服优先的鱼窗查询、收集进度与提醒入口</p></div>
      <div className="fishing-clock" aria-label="当前艾欧泽亚时间"><span>艾欧泽亚时间 ET</span>
        <strong>{String(et.hour).padStart(2,'0')}:{String(et.minute).padStart(2,'0')}</strong>
        <span>地球时间 {new Date(clock).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}</span></div>
    </header>
    <div className="fishing-summary" aria-label="当前分页鱼窗概览">
      <div><span>当前窗口</span><strong>{snapshot===null?'—':activeCount}</strong><small>本页进行中</small></div>
      <div><span>即将开放</span><strong>{snapshot===null?'—':soonCount}</strong><small>本页未来 24 小时</small></div>
      <div><span>已钓获</span><strong>{snapshot===null?'—':canEdit?caughtCount:'—'}</strong><small>{canEdit?'本页记录':'连接个人空间后可记录'}</small></div>
      <div><span>鱼类目录</span><strong>{snapshot===null?'—':snapshot.fish.total}</strong><small>当前区服和类型</small></div>
    </div>
    <div className="fishing-toolbar" aria-label="鱼类筛选">
      <label>区服<select aria-label="钓鱼区服" value={region} disabled={busy} onChange={e=>{
        setRegion(e.target.value as FishRegion);setOffset(0);setSnapshot(null);setPending(null);setError(null);
      }}><option value="cn">国服</option><option value="global">国际服</option></select></label>
      <label>鱼类<select aria-label="鱼类类型" value={category} onChange={e=>{setCategory(e.target.value as Category);setOffset(0);setSnapshot(null);}}>
        <option value="all">全部类型</option><option value="rare">鱼王 / 鱼皇</option><option value="big">鱼王</option>
        <option value="legendary">鱼皇</option><option value="normal">普通鱼</option></select></label>
      <label>查询范围<select aria-label="鱼窗查询范围" value={range} onChange={e=>{setRange(Number(e.target.value));setSnapshot(null);}}>
        <option value={24}>未来 24 小时</option><option value={72}>未来 72 小时</option><option value={168}>未来 7 天</option></select></label>
      <label className="fishing-search">搜索鱼名<input type="search" value={text} onChange={e=>{setText(e.target.value);setOffset(0);setSnapshot(null);}}
        placeholder="输入鱼名查找"/></label>
      <button type="button" className="fishing-refresh" aria-label="刷新数据" disabled={busy} onClick={()=>{setPending(null);setReload(n=>n+1);}}>刷新数据 ↻</button>
    </div>
    <div className="fishing-filterbar">
      <div className="fishing-tabs" role="group" aria-label="鱼窗状态筛选">
        <button aria-pressed={availability==='all'} onClick={()=>setAvailability('all')}>全部鱼窗</button>
        <button aria-pressed={availability==='active'} onClick={()=>setAvailability('active')}>进行中</button>
        <button aria-pressed={availability==='soon'} onClick={()=>setAvailability('soon')}>24 小时内开放</button>
      </div>
      {canEdit?<label>收集状态<select aria-label="收集状态" value={filter} onChange={e=>setFilter(e.target.value as ProgressFilter)}>
        <option value="all">全部进度</option><option value="uncaught">未钓获</option><option value="pinned">已收藏</option><option value="alarm">提醒偏好</option></select></label>:<span className="fishing-readonly">公开浏览 · 连接个人空间后可保存钓获与收藏</span>}
    </div>
    <p className="fishing-disclaimer">鱼窗按 ET 和天气预测，鱼识、前置鱼、鱼饵等需自行满足；未验证规则仅展示候选窗口。状态筛选及统计作用于当前分页。</p>
    {error!==null?<p className="fishing-notice" role="alert">{error}{pending!==null?'；未保存的选择已保留，可重试或刷新后重新选择。':''}</p>:null}
    {snapshot===null&&error===null?<p className="fishing-empty" role="status">正在读取鱼窗数据…</p>:null}
    {snapshot!==null&&snapshot.fish.total===0?<div className="fishing-empty">
      <h3>此区服暂无可用的鱼类目录</h3><p>当前后端尚未导入对应区服的正式鱼类数据。本页面不会用虚构鱼类或旧数据假装可用。</p>
      <p>可以先使用 <a href="https://fish.ffmomola.com/#/fishing" target="_blank" rel="noopener noreferrer">鱼糕</a> 或
        {' '}<a href="https://ff14fish.carbuncleplushy.com/" target="_blank" rel="noopener noreferrer">FFX|V Fish Tracker</a> 查询。</p>
    </div>:null}
    {snapshot!==null&&snapshot.fish.total>0&&fish.length===0?<div className="fishing-empty"><p>当前页没有符合筛选条件的鱼。</p><button onClick={clearFilters}>清除筛选</button></div>:null}
    {hasDemo?<p className="fishing-notice" role="status">包含合成测试鱼类：这些数据不是游戏真实钓鱼条件，不应用于安排鱼窗。</p>:null}
    <div className="fishing-list">
      {(compact?fish.slice(0,3):fish).map(f=>{
        const all=(windowsByFish.get(f.id)??[]).filter(w=>w.endsAtUtcMs>clock);
        const {open,next}=getAvailableWindows(all,clock);
        const current=open??next;
        const status=open!==null?'active':next!==null?'next':'none';
        const candidate=current?.candidateOnly??false;
        const subtitle=status==='active'?'距离关闭 '+remaining(open!.endsAtUtcMs-clock):
          status==='next'?'距离开放 '+remaining(next!.startsAtUtcMs-clock):'当前查询范围暂无窗口';
        return <article key={f.region+':'+String(f.id)} className={'fishing-entry fishing-entry--'+status}>
          <div className="fishing-entry__main">
            <div className="fishing-entry__heading"><div><div className="fishing-entry__tags">
              <span>{f.fishType==='legendary'?'鱼皇':f.fishType==='big'?'鱼王':'普通鱼'}</span>
              {f.demo?<span>示例数据</span>:null}
              <span>{f.rule.validationStatus==='verified'?'规则已核对':f.rule.validationStatus==='incomplete'?'条件不完整':'规则未验证'}</span>
            </div><h3>{f.name}</h3><p>{f.rule.zoneId}</p></div>
              <div className={'fishing-entry__status fishing-entry__status--'+status}>
                <strong>{status==='active'?'窗口进行中':status==='next'?'即将开放':'暂无窗口'}</strong>
                <span>{subtitle}</span>{candidate?<small>候选窗口 · 条件未全验证</small>:null}
              </div>
            </div>
            {canEdit?<div className="fishing-actions" role="group" aria-label={f.name+'进度操作'}>
              {(['caught','pinned','alarm'] as const).map(field=><button key={field} type="button"
                aria-pressed={flag(f.id,field)} disabled={busy} onClick={()=>{void changeField(f.id,field);}}>
                {LABELS[field]}</button>)}</div>:null}
          </div>
          {all.length===0?<p className="fishing-no-window">未来 {String(range)} 小时内没有匹配的窗口，不代表该鱼无法钓获。</p>:
            <ol className="fishing-windows" aria-label={f.name+'未来窗口'}>{all.slice(0,expanded[f.id]?undefined:3).map(w=>
              <li key={w.occurrenceKey}>
                <span className="fishing-window__date">{localTime(w.startsAtUtcMs)} — {localTime(w.endsAtUtcMs)}</span>
                <span className="fishing-window__et">ET {etLabel(w.startsAtUtcMs)}–{etLabel(w.endsAtUtcMs)}</span>
                <span className="fishing-window__weather">{w.weatherChain.previous} → {w.weatherChain.current}</span>
                {w.candidateOnly?<span className="fishing-window__candidate">候选</span>:null}
              </li>)}{all.length>3?<li className="fishing-windows__more"><button type="button" aria-expanded={expanded[f.id]??false}
                onClick={()=>setExpanded(previous=>({...previous,[f.id]:!previous[f.id]}))}>
                {expanded[f.id]?'收起后续窗口':'查看全部 '+String(all.length)+' 个未来窗口'}</button></li>:null}</ol>}
          <details className="fishing-detail"><summary>钓鱼条件与数据来源</summary>
            {f.rule.conditions.length>0?<ul>{f.rule.conditions.map((c,i)=><li key={c.kind+String(i)}>{c.description}</li>)}</ul>:
              <p>没有额外条件记录；不代表实际无其他要求。</p>}
            <p>规则版本：{f.rule.version} · 来源版本：{f.source.version} · 数据授权：
              {f.source.authorizationStatus==='permitted'?'已记录':'待核实'}</p>
            <a href={f.source.url} target="_blank" rel="noopener noreferrer">查看原始来源 ↗</a>
          </details>
        </article>;
      })}
    </div>
    {snapshot!==null&&snapshot.fish.total>0?<nav className="fishing-pagination" aria-label="鱼类分页">
      <button type="button" disabled={offset===0||busy} onClick={()=>{setOffset(Math.max(0,offset-30));setSnapshot(null);}}>上一页</button>
      <span>第 {String(Math.floor(offset/30)+1)} 页 / {String(Math.ceil(snapshot.fish.total/30))} 页
        <small>共 {String(snapshot.fish.total)} 条 · 按本页最近鱼窗排序</small></span>
      <button type="button" disabled={offset+30>=snapshot.fish.total||busy} onClick={()=>{setOffset(offset+30);setSnapshot(null);}}>下一页</button>
    </nav>:null}
  </section>;
}
export function FishingWidget(props:WidgetRuntimeProps){
  const config=fishWidgetConfigSchema.parse(props.config);
  return <FishingPanel data={props.data} initialRegion={config.region} hours={config.hours}
    onReady={props.reportReady} onError={props.reportAsyncError} compact/>;
}
export const fishWidgetComponents={[FISH_WIDGET_ID]:FishingWidget};
export function FishingPage({dataPortFor,status}:{dataPortFor:(moduleId:string)=>ModuleDataPort|undefined;status:ModuleGateStatus}){
  const privatePort=useMemo(()=>dataPortFor(FISH_MODULE_ID),[dataPortFor]);
  const data=status==='enabled'&&privatePort!==undefined?privatePort:publicFishPort;
  return <FishingPanel data={data}/>;
}
