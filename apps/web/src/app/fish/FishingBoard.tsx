import {useEffect,useMemo,useRef,useState} from 'react';
import {eorzeaTime,fishProgressResponseSchema,type FishProgress,type FishProgressField,type FishRegion} from '@ff14-hub/shared';
import type {ModuleDataPort} from '../widgets/types';
import {fishingCatalogSchema,type CatalogFish,type FishingCatalog} from './catalog';
import {windowState,type FishForecast} from './forecast';
import './fishing-board.css';
import {registerPrivateDraftSource} from '../pwa/draft-registry';
import {fishCountdown as duration} from './countdown';
const localTime=(ms:number)=>new Date(ms).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const kindLabel={normal:'普通鱼',big:'鱼王',legendary:'鱼皇'};
const tugLabel:Record<string,string>={light:'轻竿 !',medium:'中竿 !!',heavy:'重竿 !!!'};
const hookLabel:Record<string,string>={Precision:'精准提钩',Powerful:'强力提钩'};
type View='windows'|'all'|'pinned';
export interface FishDetailSelection {
  readonly region:FishRegion;
  readonly view:View;
  readonly kind:string;
  readonly text:string;
  readonly hideCaught:boolean;
  readonly windowHours:6|24|72|168;
}

interface FishingBoardProps {
  data:ModuleDataPort;initialRegion?:FishRegion;hours?:number;compact?:boolean;embedded?:boolean;expanded?:boolean;initialFilters?:FishDetailSelection|undefined;onOpenDetail?:(selection:FishDetailSelection)=>void;onReady?:()=>void;onError?:((error:unknown)=>void)|undefined;onConnect?:()=>void;onImport?:()=>void;
}
export function FishingBoard(props:FishingBoardProps){
  const [region,setRegion]=useState(props.initialFilters?.region??props.initialRegion??'cn');
  const [reload,setReload]=useState(0);
  return <FishingBoardSession key={`${region}:${reload}:${props.data.operations.join(',')}`} {...props} region={region}
    onRegion={setRegion} onReload={()=>setReload(n=>n+1)}/>;
}
function FishingBoardSession({data,region,hours=168,compact=false,embedded=false,expanded=false,initialFilters,onOpenDetail,onReady,onError,onConnect,onImport,onRegion,onReload}:FishingBoardProps&{
  region:FishRegion;onRegion:(region:FishRegion)=>void;onReload:()=>void;
}){
  const [catalog,setCatalog]=useState<FishingCatalog|null>(null);
  const [forecasts,setForecasts]=useState<FishForecast[]|null>(null);
  const [fields,setFields]=useState<FishProgress[]>([]);
  const [view,setView]=useState<View>(initialFilters?.view??'windows');
  const [kind,setKind]=useState(initialFilters?.kind??'rare');
  const [text,setText]=useState(initialFilters?.text??'');
  // 首页默认排除已钓获，便于优先查看仍需完成的鱼窗；用户可自行取消筛选。
  const [hideCaught,setHideCaught]=useState(initialFilters?.hideCaught??embedded);
  // 时间范围控制首页的数据密度，绝不使用固定条数截断选定范围。
  const [windowHours,setWindowHours]=useState<6|24|72|168>(initialFilters?.windowHours??24);
  const [limit,setLimit]=useState(compact?6:30);
  const [now,setNow]=useState(()=>Date.now());
  const [error,setError]=useState<string|null>(null);
  const [progressError,setProgressError]=useState<string|null>(null);
  const [pending,setPending]=useState<{fishId:number;field:FishProgressField;value:boolean;expectedRevision:number;operationId:string}|null>(null);
  const pendingIntent=useRef<typeof pending>(null);
  useEffect(()=>registerPrivateDraftSource(()=>pendingIntent.current!==null),[]);
  const [busy,setBusy]=useState(false);
  const generation=useRef(0);
  const progressWatermark=useRef(-1);
  const [progressReady,setProgressReady]=useState(false);
  const callbacks=useRef({onReady,onError});
  useEffect(()=>{callbacks.current={onReady,onError};});
  const canEdit=data.operations.includes('fish.progress');

  useEffect(()=>{
    let alive=true;
    void data.call('fish.catalog',{region}).then(value=>{
      const parsed=fishingCatalogSchema.parse(value);
      if(alive){setCatalog(parsed);callbacks.current.onReady?.();}
    }).catch((cause:unknown)=>{
      if(alive){setError('鱼类目录加载失败，请重试。');callbacks.current.onError?.(cause);}
    });
    return()=>{alive=false;};
  },[data,region]);

  useEffect(()=>{
    if(!catalog)return;
    const worker=new Worker(new URL('./forecast.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=(event:MessageEvent<{forecasts?:FishForecast[];error?:string}>)=>{
      if(event.data.forecasts)setForecasts(event.data.forecasts);
      if(event.data.error)setError(event.data.error);
    };
    worker.onerror=()=>setError('鱼窗计算中断，请重试。');
    const calculate=()=>worker.postMessage({fish:catalog.fish,region,from:Date.now(),hours});
    calculate();const timer=window.setInterval(calculate,60000);
    return()=>{window.clearInterval(timer);worker.terminate();};
  },[catalog,region,hours]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);

  useEffect(()=>{
    const current=++generation.current;let alive=true;progressWatermark.current=-1;
    if(!data.operations.includes('fish.progress.read'))return()=>{alive=false;};
    const load=async()=>{
      try{
        const result=fishProgressResponseSchema.parse(await data.call('fish.progress.read',{region}));
        if(alive&&current===generation.current&&result.watermark>=progressWatermark.current){progressWatermark.current=result.watermark;setFields(result.fields);setProgressReady(true);if(pendingIntent.current===null)setProgressError(null);}
      }catch{if(alive)setProgressError('个人进度未能读取；暂时禁止修改，请刷新重试。');}
    };
    void load();const timer=window.setInterval(()=>{void load();},30000);
    return()=>{alive=false;window.clearInterval(timer);};
  },[data,region]);
  const flags=useMemo(()=>new Map(fields.map(field=>[`${field.fishId}:${field.field}`,field])),[fields]);
  const forecastsById=useMemo(()=>new Map((forecasts??[]).map(item=>[item.id,item])),[forecasts]);
  const query=text.trim().toLocaleLowerCase();
  const visible=useMemo(()=>{
    return (catalog?.fish??[]).filter(fish=>{
      const state=windowState(fish,forecastsById.get(fish.id),now);
      return (kind==='all'||(kind==='rare'?fish.kind!=='normal':fish.kind===kind))&&
        (!query||[fish.name,fish.englishName,fish.zone,fish.location,...fish.bait].join(' ').toLocaleLowerCase().includes(query))&&
        (view!=='pinned'||flags.get(`${fish.id}:pinned`)?.value===true)&&(!hideCaught||flags.get(`${fish.id}:caught`)?.value!==true)&&
        (view!=='windows'||fish.method==='rod'&&(
          state.open!==null||
          (state.next!==null&&(!(embedded||expanded)||state.next.startsAtUtcMs<=now+windowHours*3600000))||
          (!(embedded||expanded)&&state.always)
        ));
    }).sort((a,b)=>windowState(a,forecastsById.get(a.id),now).sort-windowState(b,forecastsById.get(b.id),now).sort||a.id-b.id);
  },[catalog,forecastsById,now,kind,query,view,flags,hideCaught,embedded,expanded,windowHours]);
  const changeFilter=(action:()=>void)=>{action();setLimit(compact?6:30);};
  const write=async(fish:CatalogFish,field:FishProgressField)=>{
    if(!canEdit||!progressReady||busy||(progressError&&!pending))return;
    const intent=pending??{fishId:fish.id,field,value:!(flags.get(`${fish.id}:${field}`)?.value??false),
      expectedRevision:flags.get(`${fish.id}:${field}`)?.revision??0,operationId:crypto.randomUUID()};
    const current=generation.current;setBusy(true);setPending(intent);pendingIntent.current=intent;
    try{
      await data.call('fish.progress',{...intent,region});
      const fresh=fishProgressResponseSchema.parse(await data.call('fish.progress.read',{region}));
      if(current===generation.current&&fresh.watermark>=progressWatermark.current){progressWatermark.current=fresh.watermark;setFields(fresh.fields);setPending(null);pendingIntent.current=null;setProgressError(null);}
    }catch{if(current===generation.current)setProgressError('标记未保存。你的选择已保留，可重试或重新读取最新进度。');}
    finally{if(current===generation.current)setBusy(false);}
  };
  const openDetail=(overrides:Partial<FishDetailSelection>={})=>{
    onOpenDetail?.({region,view,kind,text,hideCaught,windowHours,...overrides});
  };
  const displayed=expanded?visible:visible.slice(0,limit);
  const et=eorzeaTime(now);
  if(embedded){
    const active=visible.filter(fish=>windowState(fish,forecastsById.get(fish.id),now).open!==null).length;
    const ready=catalog!==null&&forecasts!==null;
    return <section className="fish-glance" aria-label="钓鱼鱼窗概览" data-testid="fishing-board">
      <header className="fish-glance__heading">
        <h2>钓鱼</h2>
        <button type="button" className="fish-glance__link" onClick={()=>openDetail()}>全部鱼窗 ↗</button>
      </header>
      <div className="fish-glance__meta">
        <span>{region==='cn'?'国服':'国际服'} · 艾欧泽亚时间 <strong>{String(et.hour).padStart(2,'0')}:{String(et.minute).padStart(2,'0')}</strong></span>
        <span>未来 {windowHours} 小时</span>
      </div>
      {error?<p className="fish-glance__message" role="alert">{error} <button type="button" onClick={onReload}>重试</button></p>:
      !ready?<p className="fish-glance__message" role="status">正在计算鱼窗…</p>:<>
        <div className="fish-glance__stats" aria-label="鱼窗状态统计">
          <span><strong>{active}</strong> 正在开放</span>
          <span><strong>{visible.length-active}</strong> 即将开放</span>
        </div>
        {visible.length===0?<p className="fish-glance__message">当前没有符合条件的鱼窗。</p>:<>
          <div className="fish-glance__columns" aria-hidden="true"><span>鱼类</span><span>地点</span><span>剩余时间</span></div>
          <ul className="fish-glance__list" tabIndex={0} aria-label="鱼窗列表">{visible.map(fish=>{
            const state=windowState(fish,forecastsById.get(fish.id),now);
            return <li key={fish.id} className="fish-glance__item">
              <button type="button" onClick={()=>openDetail({text:fish.name})} aria-label={`查看${fish.name}的完整鱼窗`}>
                <span className="fish-glance__fish"><strong>{fish.name}</strong><small>{fish.location}</small></span>
                <span className="fish-glance__time">
                  <small>{state.open?`${duration(state.open.endsAtUtcMs-now)} 后结束`:state.next?`${duration(state.next.startsAtUtcMs-now)} 后开始`:'查看完整信息'}</small>
                </span>
              </button>
            </li>;
          })}</ul></>}
      </>}
      {progressError?<p className="fish-glance__message" role="alert">{progressError}</p>:null}
    </section>;
  }
  return <section className={`fish-board${compact?' fish-board--home':''}${embedded?' fish-board--embedded':''}`} aria-label="钓鱼时钟" data-testid="fishing-board">
    <header className="fish-board__heading"><div><h2>钓鱼</h2></div>
      <div className="fish-board__header-actions">
        <span className="fish-board__clock">艾欧泽亚时间 <strong>{String(et.hour).padStart(2,'0')}:{String(et.minute).padStart(2,'0')}</strong></span>
        {embedded&&onOpenDetail?<button type="button" className="fish-board__open-detail" onClick={()=>openDetail()}>查看完整鱼窗 ↗</button>:null}
      </div>
    </header>
    <div className="fish-board__toolbar">
      <div className="fish-board__tabs" role="group" aria-label="钓鱼视图">{([['windows','近期鱼窗'],['all','全部鱼类'],['pinned','我的收藏']] as const).map(([value,label])=>
        <button type="button" key={value} aria-pressed={view===value} onClick={()=>{if(embedded&&value==='all'&&onOpenDetail){onOpenDetail({region,view:'all',kind:'all',text,hideCaught,windowHours});return;}changeFilter(()=>{setView(value);if(value==='all')setKind('all');});}}>{label}{embedded&&value==='all'?' ↗':''}</button>)}</div>
      <label className="fish-board__region"><span className="visually-hidden">钓鱼区服</span><select aria-label="钓鱼区服" value={region} onChange={event=>onRegion(event.target.value as FishRegion)}><option value="cn">国服</option><option value="global">国际服</option></select></label>
    </div>
    {(embedded||expanded)&&view==='windows'?<div className="fish-board__range" role="group" aria-label="首页鱼窗时间范围">
      <span className="fish-board__range-label">查看范围</span>
      {([[6,'未来 6 小时'],[24,'24 小时'],[72,'3 天'],[168,'7 天']] as const).map(([value,label])=>
        <button type="button" key={value} aria-pressed={windowHours===value}
          onClick={()=>setWindowHours(value)}>{label}</button>)}
    </div>:null}
    <div className="fish-board__filters"><label><span className="visually-hidden">搜索鱼类</span><input type="search" value={text} placeholder="搜索鱼名、钓场或鱼饵" onChange={event=>changeFilter(()=>setText(event.target.value))}/></label>
      <label><span className="visually-hidden">鱼类类型</span><select aria-label="鱼类类型" value={kind} onChange={event=>changeFilter(()=>setKind(event.target.value))}><option value="all">所有鱼类</option><option value="rare">鱼王与鱼皇</option><option value="big">鱼王</option><option value="legendary">鱼皇</option><option value="normal">普通鱼</option></select></label></div>
    {error?<p role="alert">{error} <button type="button" onClick={onReload}>重试</button></p>:null}
    {progressError?<p role="alert">{progressError}{pending?<button type="button" disabled={busy} onClick={()=>{
      const fish=catalog?.fish.find(f=>f.id===pending.fishId);if(fish){setProgressError(null);void write(fish,pending.field);}
    }}>重试保存</button>:null}<button type="button" onClick={onReload}>重新读取</button></p>:null}
    {!catalog?<p className="fish-board__empty" role="status">正在读取鱼类目录…</p>:<>
      <p className="fish-board__summary">{forecasts===null?'正在计算完整目录的鱼窗…':(embedded||expanded)&&view==='windows'?`正在开放及未来 ${windowHours} 小时内：${visible.length} 种鱼`:`找到 ${visible.length} 种鱼`}</p>
      {canEdit?<label className="fish-board__account"><input type="checkbox" checked={hideCaught} disabled={!progressReady} onChange={event=>changeFilter(()=>setHideCaught(event.target.checked))}/>隐藏已钓获 · 已记录 {fields.filter(field=>field.field==='caught'&&field.value).length} 种</label>:null}
      {!canEdit?<p className="fish-board__account">无需登录即可查鱼窗。{onConnect?<button type="button" onClick={onConnect}>连接工作空间保存钓获与收藏</button>:'连接工作空间并启用钓鱼模块后可保存标记。'}</p>:null}
      <div className="fish-board__columns" aria-hidden="true"><span>鱼类 / 钓场</span><span>推荐鱼饵</span><span>鱼窗</span><span>标记</span></div>
      <div className="fish-board__list">{displayed.map(fish=>{
        const forecast=forecastsById.get(fish.id),state=windowState(fish,forecast,now);
        return <article className="fish-board__row" key={fish.id}>
          <details><summary className="fish-board__row-main"><span className="fish-board__identity"><strong>{fish.name}</strong><small>{fish.method==='spear'?'刺鱼':fish.method==='ocean'?'海钓':kindLabel[fish.kind]} · {fish.location}</small></span>
            <span className="fish-board__bait">{fish.bait.join(' → ')||'鱼饵资料待补'}</span>
            <span className={`fish-board__window${state.open?' is-open':''}`}>
              <strong>{fish.rule&&forecasts===null?'正在计算':state.open?'正在开放':state.always?'全天':state.next?'即将开放':state.unknown?'窗口资料待补':`${hours} 小时内暂无窗口`}</strong>
              <small>{state.open?`${duration(state.open.endsAtUtcMs-now)}后关闭`:state.next?`${duration(state.next.startsAtUtcMs-now)}后开放`:state.always?'无已知时间 / 天气限制':'可展开查看已有资料'}</small>
            </span></summary>
            <div className="fish-board__detail">
              <p>{fish.zone} · {fish.location}{fish.patch?` · ${fish.patch} 版本`:''}</p>
              <p>鱼饵路径：{fish.bait.join(' → ')||'尚未收录'}{fish.tug?` · ${tugLabel[fish.tug]??fish.tug}`:''}{fish.hookset?` · ${hookLabel[fish.hookset]??fish.hookset}`:''}</p>
              {fish.conditions.length?<ul>{fish.conditions.map(condition=><li key={condition}>{condition}</li>)}</ul>:null}
              {fish.rule?<p>ET {fish.rule.startHour}:00 – {fish.rule.endHour}:00 · 天气：{fish.rule.previousWeather.join(' / ')||'不限'} → {fish.rule.currentWeather.join(' / ')||'不限'}。社区规则，未逐条完成国服验证。</p>:<p>{state.always?'资料未标注时间和天气限制，仍需满足鱼饵、任务等要求。':'尚无可靠预测规则；不会把资料缺失显示为全天可钓。'}</p>}
              {forecast?.windows.length?<ol>{forecast.windows.slice(0,5).map(window=><li key={window.occurrenceKey}>{localTime(window.startsAtUtcMs)} — {localTime(window.endsAtUtcMs)} <span>{window.weatherChain.previous} → {window.weatherChain.current}</span></li>)}</ol>:null}
              {fish.spotId>0?<a href={`https://fish.ffmomola.com/ng/#/wiki/fishing/spot/${fish.spotId}/fish/${fish.id}`} target="_blank" rel="noreferrer noopener">在鱼糕查看钓法参考</a>:null}
            </div>
          </details>
          <div className="fish-board__actions">{(['pinned','caught'] as const).map(field=><button type="button" key={field} aria-label={`${field==='pinned'?'收藏':'钓获'} ${fish.name}`} aria-pressed={flags.get(`${fish.id}:${field}`)?.value??false}
            disabled={!canEdit||!progressReady||busy||progressError!==null||pending!==null} title={!canEdit?'连接工作空间并启用钓鱼模块后保存标记':undefined} onClick={()=>{void write(fish,field);}}>{field==='pinned'?'收藏':'钓获'}</button>)}</div>
        </article>;
      })}</div>
      {visible.length===0&&forecasts!==null?<p className="fish-board__empty">{view==='pinned'?'还没有收藏的鱼。可以在鱼类旁标记收藏。':(embedded||expanded)&&view==='windows'?'这个时间范围内暂无鱼窗，可选择更长时间范围。':'没有匹配的鱼。试试其他分类或搜索词；“全部鱼类”也会显示资料待补的记录。'}</p>:null}
      {!embedded&&!expanded&&visible.length>limit?<button className="fish-board__more" type="button" onClick={()=>setLimit(n=>n+(compact?10:30))}>显示更多（还有 {visible.length-limit} 种）</button>:null}
      {onImport?<button className="fish-board__more" type="button" onClick={onImport}>导入鱼糕钓获记录</button>:null}
      <details className="fish-board__sources"><summary>数据覆盖与来源</summary><p>{region==='cn'?'国服':'国际服'}目录 {catalog.coverage.total} 条 · 有窗口规则 {catalog.coverage.forecast} 条 · 无时间天气限制 {catalog.coverage.always} 条 · 规则待补 {catalog.coverage.unknown} 条。完整目录参与筛选，页面显示数量不会限制鱼窗计算。</p>
        <p>目录更新于 {new Date(catalog.generatedAt).toLocaleDateString('zh-CN')}。国服名称与身份来自游戏表，时间天气规则来自社区；海钓和未知规则不套用普通鱼窗。</p>
        <a href={`https://github.com/icykoneko/ff14-fish-tracker-app/tree/${catalog.versions.tracker}`} target="_blank" rel="noreferrer noopener">Fish Tracker 规则来源</a>{' / '}
        <a href={`https://github.com/thewakingsands/ffxiv-datamining-cn/tree/${catalog.versions.cn}`} target="_blank" rel="noreferrer noopener">国服游戏表</a></details>
    </>}
  </section>;
}
