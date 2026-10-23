import {useEffect,useMemo,useRef,useState} from 'react';
import {eorzeaTime,fishProgressResponseSchema,type FishProgress,type FishProgressField,type FishRegion} from '@ff14-hub/shared';
import type {DataPort} from '../../lib/data-port';
import {fishingCatalogSchema,type CatalogFish,type FishingCatalog} from './catalog';
import {windowState,type FishForecast} from './forecast';
import {nextFishingWindowRefresh,subscribeFishingForecast} from './forecast-session';
import './fishing-board.css';
import {registerPrivateDraftSource} from '../pwa/draft-registry';
import {fishCountdown as duration} from './countdown';
import {FishReminderPanel} from './FishReminderPanel';
const localTime=(ms:number)=>new Date(ms).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const windowDate=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const windowClock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const windowDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
function WindowPeriod({window}:{window:{startsAtUtcMs:number;endsAtUtcMs:number;unrestricted?:boolean}|null}){
  if(!window||window.unrestricted)return null;
  const start=windowDate.format(window.startsAtUtcMs),end=(windowDay.format(window.startsAtUtcMs)===windowDay.format(window.endsAtUtcMs)?windowClock:windowDate).format(window.endsAtUtcMs);
  return <span className="fish-window-period" title="北京时间" aria-label={`北京时间 ${start} 至 ${end}`}>
    <time dateTime={new Date(window.startsAtUtcMs).toISOString()}>{start}</time><span aria-hidden="true">–</span><time dateTime={new Date(window.endsAtUtcMs).toISOString()}>{end}</time>
  </span>;
}
const etTime=(hour:number)=>{const minutes=Math.round(hour*60);return `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;};
const kindLabel={normal:'普通鱼',big:'鱼王',legendary:'鱼皇'};
const tugLabel:Record<string,string>={light:'轻竿 !',medium:'中竿 !!',heavy:'重竿 !!!'};
const hookLabel:Record<string,string>={Precision:'精准提钩',Powerful:'强力提钩'};
const auditStatus={checked:'可比资料已核对',partial:'部分条件资料待补','single-source':'社区条件资料待补',conflict:'存在待处理的来源差异'};
type View='windows'|'all'|'pinned'|'followed';
type WindowPhase='open'|'upcoming'|'always';
type Method='all'|'rod'|'spear'|'ocean';
type SearchField='name'|'location'|'bait'|'all';
type HomeView='open'|'upcoming'|'followed';
export interface FishDetailSelection {
  readonly region:FishRegion;
  readonly view:View;
  readonly kind:string;
  readonly text:string;
  readonly hideCaught:boolean;
  readonly windowHours:6|24|72|168;
  readonly fishId?:number;
  readonly windowStartsAt?:number;
  readonly windowPhase?:WindowPhase;
  readonly method?:Method;
  readonly searchField?:SearchField;
}

interface FishingBoardProps {
  subscribeProgress?:(listener:()=>void)=>()=>void;onNotificationSettings?:()=>void;
  data:DataPort;initialRegion?:FishRegion;hours?:number;compact?:boolean;embedded?:boolean;expanded?:boolean;initialFilters?:FishDetailSelection|undefined;onOpenDetail?:(selection:FishDetailSelection)=>void;onReady?:()=>void;onError?:((error:unknown)=>void)|undefined;onConnect?:()=>void;onImport?:()=>void;
}
export function FishingBoard(props:FishingBoardProps){
  const [region,setRegion]=useState(props.initialFilters?.region??props.initialRegion??'cn');
  const [reload,setReload]=useState(0);
  return <FishingBoardSession key={`${region}:${reload}:${props.data.operations.join(',')}`} {...props} region={region}
    onRegion={setRegion} onReload={()=>setReload(n=>n+1)}/>;
}
function FishingBoardSession({data,region,hours=168,compact=false,embedded=false,expanded=false,initialFilters,onOpenDetail,onReady,onError,onConnect,onImport,onRegion,onReload,subscribeProgress,onNotificationSettings}:FishingBoardProps&{
  region:FishRegion;onRegion:(region:FishRegion)=>void;onReload:()=>void;
}){
  const [catalog,setCatalog]=useState<FishingCatalog|null>(null);
  const [forecasts,setForecasts]=useState<FishForecast[]|null>(null);
  const [fields,setFields]=useState<FishProgress[]>([]);
  const [view,setView]=useState<View>(initialFilters?.view==='pinned'?'followed':initialFilters?.view??'windows');
  const [homeView,setHomeView]=useState<HomeView>('open');
  const [windowPhase,setWindowPhase]=useState<WindowPhase>(initialFilters?.windowPhase??'open');
  const [kind,setKind]=useState(initialFilters?.kind??(embedded?'rare':'all'));
  const [method,setMethod]=useState<Method>(initialFilters?.method??'all');
  const [text,setText]=useState(initialFilters?.text??'');
  const [searchField,setSearchField]=useState<SearchField>(initialFilters?.searchField??'name');
  const [targetId,setTargetId]=useState<number|null>(initialFilters?.fishId??null);
  const [reminderFish,setReminderFish]=useState<CatalogFish|null>(null);
  const [undo,setUndo]=useState<{fish:CatalogFish;value:boolean;revision:number;operationId:string;expiresAt:number}|null>(null);
  const [feedback,setFeedback]=useState('');
  const offerUndo=useRef(true);
  const mutationInFlight=useRef(false),undoChecking=useRef(false);
  // 首页默认排除已钓获，便于优先查看仍需完成的鱼窗；用户可自行取消筛选。
  const [hideCaught,setHideCaught]=useState(initialFilters?.hideCaught??(embedded&&data.operations.includes('fish.progress.read')));
  // 时间范围控制首页的数据密度，绝不使用固定条数截断选定范围。
  const [windowHours,setWindowHours]=useState<6|24|72|168>(initialFilters?.windowHours??24);
  const [limit,setLimit]=useState(compact?6:30);
  const [now,setNow]=useState(()=>Date.now());
  // 倒计时每秒更新，完整目录筛选/排序仅在分钟或鱼窗边界时重新计算。
  const [windowAsOf,setWindowAsOf]=useState(()=>Date.now());
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
    let active=true;
    const stop=subscribeFishingForecast(catalog,region,hours,message=>{
      if(!active)return;
      if(message.forecasts){setForecasts(message.forecasts);setWindowAsOf(Date.now());setError(null);}
      if(message.error)setError(message.error);
    });
    return()=>{active=false;stop();};
  },[catalog,region,hours]);
  useEffect(()=>{
    if(!forecasts)return;
    let timer:number;
    const schedule=()=>{
      const current=Date.now();
      timer=window.setTimeout(()=>{
        setWindowAsOf(Date.now());
        schedule();
      },Math.max(1,nextFishingWindowRefresh(current,forecasts)-current+1));
    };
    const resume=()=>{
      if(document.visibilityState==='hidden')return;
      window.clearTimeout(timer);
      setWindowAsOf(Date.now());
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange',resume);
    return()=>{window.clearTimeout(timer);document.removeEventListener('visibilitychange',resume);};
  },[forecasts]);
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
    void load();const timer=window.setInterval(()=>{void load();},30000),unsubscribe=subscribeProgress?.(()=>{void load();});
    return()=>{alive=false;window.clearInterval(timer);unsubscribe?.();};
  },[data,region,subscribeProgress]);
  const flags=useMemo(()=>new Map(fields.map(field=>[`${field.fishId}:${field.field}`,field])),[fields]);
  const forecastsById=useMemo(()=>new Map((forecasts??[]).map(item=>[item.id,item])),[forecasts]);
  const query=text.trim().toLocaleLowerCase();
  const following=(embedded&&homeView==='followed')||view==='followed';
  const selectedPhase=embedded?(homeView==='followed'?null:homeView):view==='windows'?windowPhase:null;
  const visible=useMemo(()=>{
    return (catalog?.fish??[]).filter(fish=>{
      const state=windowState(fish,forecastsById.get(fish.id),windowAsOf);
      const names=[fish.name,fish.englishName,...(fish.aliases??[])],locations=[fish.zone,fish.location,...(fish.acquisitionContext?.locations.map(s=>s.name)??[])];
      const searchValues=searchField==='name'?names:searchField==='location'?locations:searchField==='bait'?fish.bait:[...names,...locations,...fish.bait,fish.acquisitionContext?.label??''];
      return (embedded&&following||kind==='all'||(kind==='special'?Boolean(fish.acquisitionContext):!fish.acquisitionContext&&(kind==='rare'?fish.kind!=='normal':fish.kind===kind)))&&
        (targetId===null||fish.id===targetId)&&(view==='windows'||method==='all'||fish.method===method)&&
        (!query||searchValues.join(' ').toLocaleLowerCase().includes(query))&&
        (view!=='pinned'||flags.get(`${fish.id}:pinned`)?.value===true)&&
        (!following||flags.get(`${fish.id}:pinned`)?.value===true||flags.get(`${fish.id}:alarm`)?.value===true)&&
        (embedded&&following||!hideCaught||flags.get(`${fish.id}:caught`)?.value!==true)&&
        (following||view!=='windows'||fish.method==='rod'&&(selectedPhase==='open'?state.open!==null:selectedPhase==='upcoming'?
          state.next!==null&&state.next.startsAtUtcMs<=windowAsOf+windowHours*3600000:state.always));
    }).sort((a,b)=>{
      const first=windowState(a,forecastsById.get(a.id),windowAsOf),second=windowState(b,forecastsById.get(b.id),windowAsOf);
      return (selectedPhase==='upcoming'?(first.next?.startsAtUtcMs??Infinity)-(second.next?.startsAtUtcMs??Infinity):first.sort-second.sort)||a.id-b.id;
    });
  },[catalog,forecastsById,windowAsOf,kind,method,query,searchField,view,flags,hideCaught,embedded,windowHours,targetId,following,selectedPhase]);
  const changeFilter=(action:()=>void)=>{action();setLimit(compact?6:30);};
  const write=async(fish:CatalogFish,field:FishProgressField,forced?:{value:boolean;expectedRevision:number;operationId?:string;undo?:boolean}):Promise<boolean>=>{
    if(!canEdit||!progressReady||busy||mutationInFlight.current||(undoChecking.current&&!forced?.undo)||(progressError&&!pending))return false;
    mutationInFlight.current=true;
    const intent=pending??{fishId:fish.id,field,value:forced?.value??!(flags.get(`${fish.id}:${field}`)?.value??false),
      expectedRevision:forced?.expectedRevision??flags.get(`${fish.id}:${field}`)?.revision??0,operationId:forced?.operationId??crypto.randomUUID()};
    if(!pending)offerUndo.current=field==='caught'&&!forced?.undo;
    const current=generation.current;setBusy(true);setPending(intent);pendingIntent.current=intent;
    try{
      await data.call('fish.progress',{...intent,region});
      const fresh=fishProgressResponseSchema.parse(await data.call('fish.progress.read',{region}));
      if(current===generation.current&&fresh.watermark>=progressWatermark.current){progressWatermark.current=fresh.watermark;setFields(fresh.fields);setPending(null);pendingIntent.current=null;setProgressError(null);
        const saved=fresh.fields.find(f=>f.fishId===intent.fishId&&f.field===intent.field);
        if(offerUndo.current&&saved?.value===intent.value&&saved.revision===intent.expectedRevision+1)setUndo({fish,value:!intent.value,revision:saved.revision,operationId:crypto.randomUUID(),expiresAt:Date.now()+15000});
        else if(field==='caught')setUndo(null);
        setFeedback(field==='alarm'?(intent.value?'已保存这条鱼的提醒标记':'已取消这条鱼的提醒'):field==='caught'&&!offerUndo.current?'已撤销本次钓获修改':`已${intent.value?'标记':'取消'}${field==='caught'?'钓获':'收藏'}：${fish.name}`);return true;
      }
      return false;
    }catch{if(current===generation.current)setProgressError('标记未保存。你的选择已保留，可重试或重新读取最新进度。');return false;}
    finally{mutationInFlight.current=false;if(current===generation.current)setBusy(false);}
  };
  const openDetail=(overrides:Partial<FishDetailSelection>={})=>{
    onOpenDetail?.({region,view:embedded&&following?'followed':view,kind:embedded&&following?'all':kind,method,searchField,text,hideCaught:embedded&&following?false:hideCaught,windowHours,
      ...(selectedPhase&&overrides.view!=='all'&&overrides.view!=='followed'?{windowPhase:selectedPhase}:{}),...overrides});
  };
  const displayed=expanded?visible:visible.slice(0,limit);
  const et=eorzeaTime(now);
  const undoNotice=<div className="fish-board__feedback" role="status">{feedback}{undo&&undo.expiresAt>now?<button type="button" disabled={busy||pending!==null} onClick={()=>{
    if(undoChecking.current||mutationInFlight.current)return;undoChecking.current=true;
    void (async()=>{try{
      const fresh=fishProgressResponseSchema.parse(await data.call('fish.progress.read',{region})),saved=fresh.fields.find(f=>f.fishId===undo.fish.id&&f.field==='caught');
      if(saved?.revision!==undo.revision||saved.value===undo.value){setUndo(null);setFeedback('这条鱼已被其他页面或同步更新，未覆盖新记录。');return;}
      await write(undo.fish,'caught',{value:undo.value,expectedRevision:undo.revision,operationId:undo.operationId,undo:true});
    }catch{setFeedback('最新进度暂时无法读取，请重试撤销。');}finally{undoChecking.current=false;}})();
  }}>撤销</button>:null}</div>;
  const clearFishFilters=()=>{setTargetId(null);setText('');setKind('all');setMethod('all');setHideCaught(false);setLimit(compact?6:30);};
  const showCatalog=()=>{clearFishFilters();setText(text);setView('all');};
  const hasFilters=Boolean(query||kind!=='all'||(view!=='windows'&&method!=='all')||hideCaught||targetId!==null);
  const kindName=kind==='rare'?'鱼王 / 鱼皇':kind==='special'?'任务 / 特殊条目':kindLabel[kind as keyof typeof kindLabel];
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
        <span>{homeView==='open'?'当前开放':homeView==='upcoming'?`未来 ${windowHours} 小时`:'已收藏或设置提醒'}</span>
      </div>
      <div className="home-status-tabs" role="group" aria-label="首页鱼窗切换">
        {([['open','开放中鱼窗'],['upcoming','未来鱼窗'],['followed','关注鱼窗']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={homeView===value} onClick={()=>setHomeView(value)}>{label}</button>)}
      </div>
      <div className="fish-board__filter-tags" aria-label="当前鱼窗筛选">
        {following?<span>收藏或提醒 · 含已钓获</span>:<>{data.operations.includes('fish.progress.read')?<label><input type="checkbox" checked={hideCaught} disabled={!progressReady} onChange={event=>setHideCaught(event.target.checked)}/>只看未钓获</label>:null}
        <label>鱼种 <select aria-label="首页鱼种" value={kind} onChange={event=>setKind(event.target.value)}><option value="rare">鱼王 / 鱼皇</option><option value="all">全部鱼种</option></select></label></>}
        <button type="button" onClick={()=>openDetail({view:'all',kind:'all',hideCaught:false,text:''})}>查看全部鱼类</button>
      </div>
      {error?<p className="fish-glance__message" role="alert">{error} <button type="button" onClick={onReload}>重试</button></p>:
      !ready?<p className="fish-glance__message" role="status">正在计算鱼窗…</p>:<>
        <div className="fish-glance__stats" aria-label="鱼窗状态统计">
          {homeView==='followed'?<><span><strong>{visible.length}</strong> 已关注</span><span><strong>{active}</strong> 当前开放</span></>:<span><strong>{visible.length}</strong> {homeView==='open'?'开放中':'未来鱼窗'}</span>}
        </div>
        {visible.length===0?<p className="fish-glance__message">{homeView==='open'?'当前没有符合筛选条件的开放中鱼窗，可切换“未来鱼窗”查看。':homeView==='upcoming'?`未来 ${windowHours} 小时内没有符合筛选条件的鱼窗。`:'还没有关注的鱼，在完整鱼窗中收藏或设置提醒即可。'}</p>:<>
          <div className="fish-glance__columns" aria-hidden="true"><span>鱼类</span><span>地点</span><span>剩余时间</span></div>
          <ul key={homeView} className="fish-glance__list" tabIndex={0} aria-label="鱼窗列表">{visible.map(fish=>{
            const state=windowState(fish,forecastsById.get(fish.id),now);
            const displayedWindow=homeView==='upcoming'?state.next:state.open??state.next;
            return <li key={fish.id} className="fish-glance__item">
              <button type="button" onClick={()=>openDetail({view:'all',kind:'all',method:'all',hideCaught:false,text:'',fishId:fish.id})} aria-label={`查看${fish.name}的完整鱼窗`}>
                <span className="fish-glance__fish"><strong>{fish.name}</strong><small>{fish.location}</small></span>
                <span className="fish-glance__time">
                  <small>{displayedWindow?`${duration((homeView==='upcoming'||!state.open?displayedWindow.startsAtUtcMs:displayedWindow.endsAtUtcMs)-now)} ${homeView==='upcoming'||!state.open?'后开始':'后结束'}`:state.always?'时间天气不限':'查看完整信息'}</small>
                  <WindowPeriod window={displayedWindow}/>
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
    {feedback?undoNotice:null}
    {targetId!==null&&initialFilters?.windowStartsAt!==undefined&&forecasts!==null&&initialFilters.windowStartsAt<now&&!forecasts.some(f=>f.id===initialFilters.fishId&&f.windows.some(w=>w.startsAtUtcMs===initialFilters.windowStartsAt))?<p role="status">原提醒的窗口已结束或已更新，下面显示最新鱼窗。</p>:null}
    {targetId!==null?<p className="fish-board__account">已定位所选鱼类。<button type="button" onClick={()=>{clearFishFilters();setView('all');}}>查看全部鱼类</button></p>:null}
    {targetId!==null&&catalog&&!catalog.fish.some(f=>f.id===targetId)?<p role="alert">当前区服目录尚未收录这条鱼，可查看全部鱼类或切换区服。</p>:null}
    {reminderFish?<FishReminderPanel key={region+':'+reminderFish.id} fish={reminderFish} region={region} enabled={flags.get(`${reminderFish.id}:alarm`)?.value??false} caught={flags.get(`${reminderFish.id}:caught`)?.value??false}
      onSave={value=>write(reminderFish,'alarm',{value,expectedRevision:flags.get(`${reminderFish.id}:alarm`)?.revision??0})} onClose={()=>setReminderFish(null)} {...(onNotificationSettings?{onSettings:onNotificationSettings}:{})}/>:null}
    <div className="fish-board__toolbar">
      <div className="fish-board__tabs" role="group" aria-label="钓鱼视图">{([['windows','鱼窗查询'],['all','全部资料'],['followed','我的关注']] as const).map(([value,label])=>
        <button type="button" key={value} aria-pressed={view===value} onClick={()=>{changeFilter(()=>{setTargetId(null);setView(value);setKind('all');setMethod('all');setHideCaught(false);});}}>{label}</button>)}</div>
      <label className="fish-board__region"><span className="visually-hidden">钓鱼区服</span><select aria-label="钓鱼区服" value={region} onChange={event=>onRegion(event.target.value as FishRegion)}><option value="cn">国服</option><option value="global">国际服</option></select></label>
    </div>
    {view==='windows'?<div className="fish-board__phases" role="group" aria-label="鱼窗状态">
      {([['open','开放中'],['upcoming','即将开放'],['always','时间天气不限']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={windowPhase===value} onClick={()=>changeFilter(()=>setWindowPhase(value))}>{label}</button>)}
    </div>:null}
    {view==='windows'&&windowPhase==='upcoming'?<div className="fish-board__range" role="group" aria-label="鱼窗时间范围">
      <span className="fish-board__range-label">从现在起</span>
      {([[6,'6 小时'],[24,'24 小时'],[72,'3 天'],[168,'7 天']] as const).map(([value,label])=>
        <button type="button" key={value} aria-pressed={windowHours===value}
          onClick={()=>setWindowHours(value)}>{label}</button>)}
    </div>:null}
    <p className="fish-board__scope">{view==='windows'?windowPhase==='open'?'只显示此刻有时限的竿钓窗口，按剩余时间排序。':windowPhase==='upcoming'?`显示未来 ${windowHours} 小时内开始的竿钓窗口，按开始时间排序；已开放的鱼可查看下一次窗口。`:'这些鱼没有已知时间或天气限制，仍需满足鱼饵、鱼识及任务条件。':view==='all'?'查看完整目录与获取资料，包含海钓、刺鱼、任务条目和暂无预测规则的鱼。':view==='pinned'?'仅显示已收藏的鱼；下方筛选仍然生效。':'已收藏或设置提醒的鱼都会显示，包含已钓获；下方筛选仍然生效。'}{view==='windows'?<button type="button" onClick={showCatalog}>海钓、刺鱼或找不到鱼？查看全部资料</button>:null}</p>
    <div className="fish-board__filters"><label><span>搜索</span><span className="fish-board__search-control"><select aria-label="搜索范围" value={searchField} onChange={event=>changeFilter(()=>setSearchField(event.target.value as SearchField))}><option value="name">鱼名</option><option value="location">钓场 / 地区</option><option value="bait">鱼饵</option><option value="all">全部字段</option></select><input aria-label="搜索鱼类" type="search" value={text} placeholder={searchField==='name'?'输入鱼名或别名':searchField==='location'?'输入钓场或地区':searchField==='bait'?'输入鱼饵名称':'输入鱼名、地点或鱼饵'} onChange={event=>changeFilter(()=>{setText(event.target.value);setTargetId(null);})}/></span></label>
      <label><span>鱼种</span><select aria-label="鱼类类型" value={kind} onChange={event=>changeFilter(()=>setKind(event.target.value))}><option value="all">全部鱼种</option><option value="rare">鱼王与鱼皇</option><option value="big">鱼王</option><option value="legendary">鱼皇</option><option value="normal">普通鱼</option>{view!=='windows'?<option value="special">任务 / 特殊条目</option>:null}</select></label>
      {view!=='windows'?<label><span>获取方式</span><select aria-label="获取方式" value={method} onChange={event=>changeFilter(()=>setMethod(event.target.value as Method))}><option value="all">全部方式</option><option value="rod">竿钓</option><option value="spear">刺鱼</option><option value="ocean">海钓</option></select></label>:null}</div>
    {hasFilters?<div className="fish-board__filter-tags" aria-label="已应用筛选"><span>当前筛选</span>{query?<button type="button" aria-label="清除搜索词" onClick={()=>changeFilter(()=>setText(''))}>搜索：{text} ×</button>:null}{kind!=='all'?<button type="button" aria-label="清除鱼种筛选" onClick={()=>changeFilter(()=>setKind('all'))}>{kindName} ×</button>:null}{method!=='all'&&view!=='windows'?<button type="button" aria-label="清除获取方式筛选" onClick={()=>changeFilter(()=>setMethod('all'))}>{{rod:'竿钓',spear:'刺鱼',ocean:'海钓'}[method]} ×</button>:null}{hideCaught?<button type="button" onClick={()=>changeFilter(()=>setHideCaught(false))}>只看未钓获 ×</button>:null}<button type="button" className="fish-board__reset" onClick={clearFishFilters}>清除筛选</button></div>:null}
    {query&&view!=='all'?<button type="button" className="fish-board__search-all" onClick={showCatalog}>在全部资料中搜索“{text}”</button>:null}
    {error?<p role="alert">{error} <button type="button" onClick={onReload}>重试</button></p>:null}
    {progressError?<p role="alert">{progressError}{pending?<button type="button" disabled={busy} onClick={()=>{
      const fish=catalog?.fish.find(f=>f.id===pending.fishId);if(fish){setProgressError(null);void write(fish,pending.field);}
    }}>重试保存</button>:null}<button type="button" onClick={onReload}>重新读取</button></p>:null}
    {!catalog?<p className="fish-board__empty" role="status">正在读取鱼类目录…</p>:<>
      <p className="fish-board__summary" role="status">{forecasts===null?'正在计算完整目录的鱼窗…':view==='windows'?`${windowPhase==='open'?'开放中':windowPhase==='upcoming'?`未来 ${windowHours} 小时内开放`:'时间天气不限'} · ${visible.length} 种鱼`:`找到 ${visible.length} 条记录`}</p>
      {canEdit?<label className="fish-board__account"><input type="checkbox" checked={hideCaught} disabled={!progressReady} onChange={event=>changeFilter(()=>setHideCaught(event.target.checked))}/>隐藏已钓获 · 已记录 {fields.filter(field=>field.field==='caught'&&field.value).length} 种</label>:null}
      {!canEdit?<p className="fish-board__account">无需登录即可查鱼窗。{onConnect?<button type="button" onClick={onConnect}>连接工作空间保存钓获与收藏</button>:'连接工作空间并启用钓鱼模块后可保存标记。'}</p>:null}
      <div className="fish-board__columns" aria-hidden="true"><span>鱼类 / 钓场</span><span>推荐鱼饵</span><span>鱼窗</span><span>标记</span></div>
      <div className="fish-board__list">{displayed.map(fish=>{
        const forecast=forecastsById.get(fish.id),rawState=windowState(fish,forecast,now),state=selectedPhase==='upcoming'?{...rawState,open:null}:rawState;
        return <article className="fish-board__row" key={fish.id}>
          <details {...(targetId===fish.id?{open:true}:{})}><summary className="fish-board__row-main"><span className="fish-board__identity"><strong>{fish.name}</strong><small>{fish.acquisitionContext?.label??(fish.method==='spear'?'刺鱼':fish.method==='ocean'?'海钓':kindLabel[fish.kind])} · {fish.location}</small></span>
            <span className="fish-board__bait">{fish.bait.join(' → ')||'鱼饵资料待补'}</span>
            <span className={`fish-board__window${state.open?' is-open':''}`}>
              <strong>{fish.acquisitionContext&&!fish.rule?'专项获取 · 查看资料':fish.method==='ocean'?'海钓 · 查看航次条件':fish.method==='spear'?'刺鱼 · 查看鱼影条件':fish.rule&&forecasts===null?'正在计算':state.open?(state.open.candidateOnly?'候选窗口中':'时间天气匹配'):state.always?'时间天气不限':state.next?(state.next.candidateOnly?'后续候选':'即将匹配'):state.unknown?'窗口资料待补':`${hours} 小时内暂无窗口`}</strong>
              <small>{state.open?`${duration(state.open.endsAtUtcMs-now)}后关闭`:state.next?`${duration(state.next.startsAtUtcMs-now)}后开放`:state.always?'无已知时间 / 天气限制':'可展开查看已有资料'}</small>
              <WindowPeriod window={state.open??state.next}/>
            </span></summary>
            <div className="fish-board__detail">
              <p>{fish.zone} · {fish.location}{fish.patch?` · ${fish.patch} 版本`:''}</p>
              {fish.acquisitionContext?.locations.length?<p>来源记录地点：{fish.acquisitionContext.locations.map(s=>s.name).join('、')}。{fish.acquisitionContext.locations.some(s=>s.evidence==='community-record')?'部分地点来自 Teamcraft 获取记录。':fish.acquisitionContext.locations.every(s=>s.evidence==='corroborated')?'地点已对照游戏表与 Teamcraft。':'地点见游戏表；部分地点尚缺社区记录佐证。'}</p>:null}
              <p>鱼饵路径：{fish.bait.join(' → ')||'尚未收录'}{fish.tug?` · ${tugLabel[fish.tug]??fish.tug}`:''}{fish.hookset?` · ${hookLabel[fish.hookset]??fish.hookset}`:''}</p>
              {fish.conditions.length?<ul>{fish.conditions.map(condition=><li key={condition}>{condition}</li>)}</ul>:null}
              {fish.intuitionCrosscheck?<p>鱼识来源核对：{fish.intuitionCrosscheck.description||(fish.intuitionCrosscheck.status==='matched'?'鱼糕与 Tracker 的前置鱼、数量、时长及时间天气条件一致。':'来源资料尚不完整。')}<small> 核对于 {new Date(fish.intuitionCrosscheck.checkedAt).toLocaleDateString('zh-CN')}。</small></p>:null}
              {fish.crossSourceAudit?<div className="fish-board__audit"><p>资料交叉核对：{fish.crossSourceAudit.specialContent?'图鉴外专项获取记录':auditStatus[fish.crossSourceAudit.status]} · {fish.crossSourceAudit.compared} 项可比资料。</p>{fish.crossSourceAudit.notes.map(note=><p key={note}>{note}</p>)}</div>:null}
              {fish.rule?<p>ET {etTime(fish.rule.startHour)} – {etTime(fish.rule.endHour)} · 天气：{fish.rule.previousWeather.join(' / ')||'不限'} → {fish.rule.currentWeather.join(' / ')||'不限'}。时间规则来自社区数据；鱼饵、鱼识及技能条件仍需另行满足。</p>:<p>{fish.acquisitionContext?'请按对应任务或专项内容的获取条件查看。':fish.method==='ocean'?'海钓请结合本页条件与航次查看。':fish.method==='spear'?'刺鱼请结合本页鱼影触发和鱼识条件查看。':state.always?'资料未标注时间和天气限制，仍需满足鱼饵、任务等要求。':'尚无可靠预测规则；不会把资料缺失显示为全天可钓。'}</p>}
              {forecast?.windows.some(window=>!window.unrestricted)?<ol>{forecast.windows.filter(window=>!window.unrestricted).slice(0,5).map(window=><li key={window.occurrenceKey}>{localTime(window.startsAtUtcMs)} — {localTime(window.endsAtUtcMs)} <span>{window.weatherSegments&&window.weatherSegments.length>1?'连续窗口，包含多段天气':`${window.weatherChain.previous} → ${window.weatherChain.current}`}</span></li>)}</ol>:null}
              {fish.spotId>0&&(!fish.crossSourceAudit||fish.crossSourceAudit.sources.includes('fishcake'))?<a href={`https://fish.ffmomola.com/ng/#/wiki/${fish.method==='spear'?'spearfishing':'fishing'}/spot/${fish.spotId}/fish/${fish.id}`} target="_blank" rel="noreferrer noopener">在鱼糕查看钓法参考</a>:fish.crossSourceAudit?.sources.includes('teamcraft')?<a href={`https://ffxivteamcraft.com/db/en/item/${fish.id}`} target="_blank" rel="noreferrer noopener">在 Teamcraft 查看获取资料</a>:null}
            </div>
          </details>
          <div className="fish-board__actions">{(['pinned','caught'] as const).map(field=><button type="button" key={field} aria-label={`${field==='pinned'?'收藏':'钓获'} ${fish.name}`} aria-pressed={flags.get(`${fish.id}:${field}`)?.value??false}
            disabled={!canEdit||!progressReady||busy||progressError!==null||pending!==null} title={!canEdit?'连接工作空间并启用钓鱼模块后保存标记':undefined} onClick={()=>{void write(fish,field);}}>{field==='pinned'?'收藏':'钓获'}</button>)}
            <button type="button" aria-label={`提醒 ${fish.name}`} aria-pressed={flags.get(`${fish.id}:alarm`)?.value??false} disabled={!canEdit||!progressReady||busy||pending!==null||progressError!==null} onClick={()=>setReminderFish(fish)}>提醒</button></div>
        </article>;
      })}</div>
      {visible.length===0&&forecasts!==null?<div className="fish-board__empty"><p>{hasFilters?'当前筛选下没有结果，并不代表目录未收录。':view==='pinned'?'还没有收藏的鱼。可以在鱼类旁标记收藏。':view==='followed'?'还没有关注的鱼。收藏或设置提醒后即可在这里查看。':view==='windows'?(windowPhase==='open'?'此刻没有符合条件的限时窗口，可查看即将开放的鱼。':windowPhase==='upcoming'?`未来 ${windowHours} 小时内没有符合条件的窗口，可扩大时间范围。`:'当前目录暂无符合条件的不限时间天气记录。'):'当前目录没有匹配记录。'}</p>{hasFilters?<button type="button" onClick={clearFishFilters}>清除筛选</button>:null}{view==='windows'&&windowPhase==='open'?<button type="button" onClick={()=>setWindowPhase('upcoming')}>查看即将开放</button>:null}{view!=='all'?<button type="button" onClick={showCatalog}>{query?'保留搜索词，查全部资料':'查看全部资料'}</button>:null}</div>:null}
      {!embedded&&!expanded&&visible.length>limit?<button className="fish-board__more" type="button" onClick={()=>setLimit(n=>n+(compact?10:30))}>显示更多（还有 {visible.length-limit} 种）</button>:null}
      {onImport?<button className="fish-board__more" type="button" onClick={onImport}>导入鱼糕钓获记录</button>:null}
      <details className="fish-board__sources"><summary>数据覆盖与来源</summary><p>{region==='cn'?'国服':'国际服'}目录 {catalog.coverage.total} 条 · 有窗口规则 {catalog.coverage.forecast} 条 · 无时间天气限制 {catalog.coverage.always} 条 · 普通鱼窗未收录或其他玩法 {catalog.coverage.unknown} 条。完整目录参与筛选，页面显示数量不会限制鱼窗计算。</p>
        {catalog.accuracy?<p>已对照国服游戏表核对 {catalog.accuracy.weatherMatched} 条规则的天气概率；{catalog.accuracy.fishWithPredators} 条含前置鱼条件。鱼识条件以鱼糕及其他来源交叉核对为准；资料有冲突或缺失时会保留提示。</p>:null}
        {catalog.intuitionCrosscheck&&!catalog.crossSourceAudit?<p>鱼识跨源比对 {catalog.intuitionCrosscheck.total} 条：{catalog.intuitionCrosscheck.matched} 条一致、{catalog.intuitionCrosscheck.supplemented??0} 条已按鱼糕补全时长、{catalog.intuitionCrosscheck.partial} 条资料待补、{catalog.intuitionCrosscheck.conflicts} 条条件差异，详情保留来源与具体说明。</p>:null}
        {catalog.crossSourceAudit?<div><p>全目录交叉核对 {catalog.crossSourceAudit.total} 条：{catalog.crossSourceAudit.checked} 条图鉴鱼可比资料已核对、{catalog.crossSourceAudit.special??0} 条任务或特殊记录、{catalog.crossSourceAudit.partial} 条图鉴鱼条件来源不足、{catalog.crossSourceAudit.conflicts} 条差异待处理。鱼识时长已收录 {catalog.crossSourceAudit.intuitionRecords??0} 条。</p>{catalog.crossSourceAudit.special?<p>特殊记录中，已定位 {catalog.crossSourceAudit.specialWithLocations??0} 条的获取地点，{catalog.crossSourceAudit.specialWithBaits??0} 条收录来源鱼饵；{catalog.crossSourceAudit.specialSourceOnly??0} 条仍缺少可核验的社区获取记录。任务触发条件与普通鱼窗分开展示。</p>:null}<p>核对日期 {new Date(catalog.crossSourceAudit.checkedAt).toLocaleDateString('zh-CN')}。<a href="https://github.com/jdysw/ff14-hub/blob/main/data/fishing-full-crosscheck.json" target="_blank" rel="noreferrer noopener">查看逐条核对报告 ↗</a></p></div>:null}
        <p>目录更新于 {new Date(catalog.generatedAt).toLocaleDateString('zh-CN')}。国服名称与身份来自游戏表，时间天气规则来自社区；海钓和未知规则不套用普通鱼窗。</p>
        <a href={`https://github.com/icykoneko/ff14-fish-tracker-app/tree/${catalog.versions.tracker}`} target="_blank" rel="noreferrer noopener">Fish Tracker 规则来源</a>{' / '}
        <a href={`https://github.com/thewakingsands/ffxiv-datamining-cn/tree/${catalog.versions.cn}`} target="_blank" rel="noreferrer noopener">国服游戏表</a></details>
    </>}
  </section>;
}
