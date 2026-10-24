import {useEffect,useMemo,useState} from 'react';
import type {EventCalendarItem,FishRegion} from '@ff14-hub/shared';
import {loadFishingCatalog} from '../fish/catalog';
import {frontlineAt,crystallineAt} from '../pvp/rotation';
import {loadPublicCalendar} from './public-resources';
import {planEvents,type planFish} from './today-plan';
import type {LocalData,LocalStore} from './store';
import type {FeatureTarget,FishSearchTarget} from './site-search';
import {BackupStatusLine} from './BackupStatusLine';
const clock=(time:number)=>new Date(time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
type TodayFishResult=ReturnType<typeof planFish>;
function TodayFishResults({error,result,region,now,limit,onFish,onMore}:Readonly<{
  error:string;result:TodayFishResult|null;region:FishRegion;now:number;limit:number;
  onFish:(target:FishSearchTarget)=>void;onMore:()=>void;
}>){
  if(error)return <p role="alert">{error}</p>;
  if(!result)return <output style={{display:'block'}}>正在计算今天的关注鱼窗…</output>;
  return <>
    <p>未钓获关注鱼 {result.watched} 条 · 今日有限窗口 {result.rows.length} 个。候选时间仍需满足鱼饵及鱼识等条件。</p>
    {result.limited?<p>当前计算前 50 条关注鱼，其余请在完整鱼窗中查看。</p>:null}
    {result.rows.length?<ul>{result.rows.slice(0,limit).map(row=><li key={`${row.fishId}:${row.startsAt}`}><button onClick={()=>onFish({fishId:row.fishId,region})}>{row.name}<small>{row.startsAt<=now?'正在开放':clock(row.startsAt)+' 开始'} · {clock(row.endsAt)} 结束 · {row.location}{row.candidate?' · 候选':''}</small></button></li>)}</ul>:<p>{result.watched?'今天没有预测到有限窗口。':'收藏鱼或设置提醒后，会自动列入这里。'}</p>}
    {result.rows.length>limit?<button onClick={onMore}>显示更多今日窗口</button>:null}
    {result.unrestricted>0||result.unavailable>0?<p>另有 {result.unrestricted} 条时间天气不限、{result.unavailable} 条规则待补或不适用普通鱼窗。</p>:null}
  </>;
}
function TodayActivityRows({error,events,activities,now,onEvent}:Readonly<{
  error:string;events:EventCalendarItem[]|null;activities:ReturnType<typeof planEvents>;now:number;onEvent:(id:string)=>void;
}>){
  if(error)return <output style={{display:'block'}}>{error}</output>;
  if(events===null)return <output style={{display:'block'}}>正在加载活动节点…</output>;
  if(!activities.length)return <p>今天没有已确认时间的开始或截止节点。</p>;
  return <ul>{activities.map(e=><li key={e.id}><button onClick={()=>onEvent(e.id)}>{e.title}<small>{e.startsAt!>=now?clock(e.startsAt!)+' 开始':clock(e.endsAt!)+' 截止'}</small></button></li>)}</ul>;
}
export function TodayPlan({data,store,onFish,onEvent,onFeature}:Readonly<{data:LocalData;store:LocalStore;onFish:(target:FishSearchTarget)=>void;onEvent:(id:string)=>void;onFeature:(target:FeatureTarget)=>void}>){
  const [now,setNow]=useState(Date.now),[region,setRegion]=useState<FishRegion>(data.configuration.region),[events,setEvents]=useState<EventCalendarItem[]|null>(null),[eventError,setEventError]=useState('');
  const [report,setReport]=useState<{value:ReturnType<typeof planFish>;region:FishRegion;now:number;fields:LocalData['fish']['cn']}|null>(null),[fishError,setFishError]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[limit,setLimit]=useState(20);
  const result=report?.region===region&&report.now===now&&report.fields===data.fish[region]?report.value:null;
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{let alive=true;void loadPublicCalendar().then(v=>{if(alive)setEvents(v.events);}).catch(()=>{if(alive)setEventError('活动暂未加载，鱼窗和备忘仍可查看');});return()=>{alive=false;};},[]);
  useEffect(()=>{
    let alive=true;const worker=new Worker(new URL('./today-plan.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=(event:MessageEvent<{result?:ReturnType<typeof planFish>;error?:string}>)=>{if(alive){if(event.data.result){setReport({value:event.data.result,region,now,fields:data.fish[region]});setFishError('');}if(event.data.error)setFishError(event.data.error);}};
    worker.onerror=()=>{if(alive)setFishError('今日鱼窗计算失败，请重新打开计划');};
    void loadFishingCatalog(region).then(c=>{if(alive)worker.postMessage({fish:c.fish,fields:data.fish[region],region,now});}).catch(()=>{if(alive)setFishError('鱼类目录暂不可用');});
    return()=>{alive=false;worker.terminate();};
  },[region,data.fish,now]);
  const activities=useMemo(()=>planEvents(events??[],now),[events,now]),frontline=frontlineAt(now),crystal=crystallineAt(now);
  const complete=async(id:string,value:boolean)=>{if(busy){return;}setBusy(true);setError('');try{await store.change(doc=>{const note=doc.data.notes.find(n=>n.id===id);if(!note){throw new Error('备忘已被删除');}note.completed=value;});}catch{setError('待办状态未保存，请重试');}finally{setBusy(false);}};
  return <section className="site-discovery today-plan" aria-label="今日计划">
    <p>{new Date(now).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'})} · 北京时间 · 关注鱼窗、活动与个人待办</p>
    <section aria-label="今日关注鱼窗"><header><h3>今日关注鱼窗</h3><label>区服<select aria-label="计划区服" value={region} onChange={e=>{setRegion(e.target.value as FishRegion);setLimit(20);}}><option value="cn">国服</option><option value="global">国际服</option></select></label></header>
      <TodayFishResults error={fishError} result={result} region={region} now={now} limit={limit} onFish={onFish} onMore={()=>setLimit(n=>n+20)}/>
    </section>
    <section aria-label="今日活动节点"><h3>今日活动节点</h3><TodayActivityRows error={eventError} events={events} activities={activities} now={now} onEvent={onEvent}/><button onClick={()=>onFeature('events')}>查看完整活动日历</button></section>
    <section aria-label="今日PVP轮换"><h3>PVP 当前轮换</h3><p>纷争前线：{frontline.current} · {clock(frontline.changesAt)} 换图</p><p>水晶冲突：{crystal.current} · {clock(crystal.changesAt)} 换图</p><button onClick={()=>onFeature('pvp')}>查看后续轮换</button></section>
    <section aria-label="个人待办"><header><h3>个人待办</h3><button onClick={()=>onFeature('notes')}>管理备忘</button></header>{data.notes.length?<ul>{data.notes.map(note=><li key={note.id}><label className="today-plan__note"><input type="checkbox" checked={note.completed??false} disabled={busy} onChange={e=>{void complete(note.id,e.target.checked);}}/><span className={note.completed?'is-complete':''}>{note.title}<small>{note.text.slice(0,160)}</small></span></label></li>)}</ul>:<p>还没有个人备忘，可以添加需要完成的事项。</p>}{error?<p role="alert">{error}</p>:null}</section>
    <section aria-label="计划数据状态"><h3>数据与备份</h3><BackupStatusLine/><button onClick={()=>onFeature('backup')}>备份与恢复</button> <button onClick={()=>onFeature('sync')}>检查数据同步</button></section>
  </section>;
}
