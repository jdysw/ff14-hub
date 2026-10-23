/**
 * 页面内共享同一地区/时段的鱼窗预测 Worker。
 * 首页和展开层可以同时订阅；最后一个订阅者退出时关闭计时器及 Worker。
 * 不跨版本共享结果，避免目录更新后复用旧规则。
 */
import type {FishRegion} from '@ff14-hub/shared';
import type {FishingCatalog} from './catalog';
import type {FishForecast} from './forecast';

interface ForecastMessage {forecasts?:FishForecast[];error?:string}
type Listener=(message:ForecastMessage)=>void;
interface ForecastJob {
  worker:Worker;
  listeners:Set<Listener>;
  timer:number;
  last:ForecastMessage|null;
}
const jobs=new Map<string,ForecastJob>();

export function subscribeFishingForecast(
  catalog:FishingCatalog,region:FishRegion,hours:number,listener:Listener,
):()=>void{
  const key=JSON.stringify([region,hours,catalog.generatedAt,catalog.versions,catalog.fish.length]);
  let job=jobs.get(key);
  if(!job){
    const worker=new Worker(new URL('./forecast.worker.ts',import.meta.url),{type:'module'});
    const current:ForecastJob={worker,listeners:new Set(),timer:0,last:null};
    worker.onmessage=(event:MessageEvent<ForecastMessage>)=>{
      current.last=event.data;
      for(const subscriber of current.listeners)subscriber(event.data);
    };
    worker.onerror=()=>{
      const message={error:'鱼窗计算中断，请重试。'};
      for(const subscriber of current.listeners)subscriber(message);
    };
    const calculate=()=>worker.postMessage({fish:catalog.fish,region,from:Date.now(),hours});
    // Register before the first calculation. Responses can arrive in microtasks.
    jobs.set(key,current);
    job=current;
    calculate();
    current.timer=window.setInterval(calculate,60_000);
  }
  const subscription=job;
  subscription.listeners.add(listener);
  if(subscription.last)listener(subscription.last);
  return ()=>{
    subscription.listeners.delete(listener);
    if(subscription.listeners.size!==0)return;
    window.clearInterval(subscription.timer);
    subscription.worker.terminate();
    if(jobs.get(key)===subscription)jobs.delete(key);
  };
}

/** Minute ticks plus exact start/end boundaries keep list membership correct. */
export function nextFishingWindowRefresh(now:number,forecasts:readonly FishForecast[]):number{
  let next=(Math.floor(now/60_000)+1)*60_000;
  for(const entry of forecasts)for(const window of entry.windows){
    if(window.startsAtUtcMs>now&&window.startsAtUtcMs<next)next=window.startsAtUtcMs;
    if(window.endsAtUtcMs>now&&window.endsAtUtcMs<next)next=window.endsAtUtcMs;
  }
  return next;
}
