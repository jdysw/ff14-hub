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
  catalog:FishingCatalog;
  worker:Worker;
  listeners:Set<Listener>;
  timer:number;
  last:ForecastMessage|null;
}
const jobs=new Map<string,ForecastJob>();

/**
 * generatedAt 是来源标记，不是内容哈希；相同元数据的两个目录仍可能有不同的规则。
 * 只比较参与预测的鱼 ID 与规则，避免将另一份目录的窗口错误广播给订阅者。
 */
function sameForecastRules(a:FishingCatalog,b:FishingCatalog):boolean{
  if(a===b)return true;
  if(a.fish.length!==b.fish.length)return false;
  return a.fish.every((fish,index)=>{
    const other=b.fish[index];
    return other!==undefined&&fish.id===other.id&&JSON.stringify(fish.rule)===JSON.stringify(other.rule);
  });
}

export function subscribeFishingForecast(
  catalog:FishingCatalog,region:FishRegion,hours:number,listener:Listener,
):()=>void{
  const baseKey=JSON.stringify([region,hours,catalog.generatedAt,catalog.versions,catalog.fish.length]);
  // 优先扫描所有同元数据的存活任务：较早的任务退出后，不能因为基础 key 空了
  // 就绕过仍在使用的 :1/:2 任务，重新启动一份相同规则的 Worker。
  let key=baseKey;
  let job:ForecastJob|undefined;
  for(const [candidateKey,candidate] of jobs){
    if((candidateKey===baseKey||candidateKey.startsWith(baseKey+':'))&&sameForecastRules(candidate.catalog,catalog)){
      key=candidateKey;
      job=candidate;
      break;
    }
  }
  if(!job){
    let collision=0;
    while(jobs.has(key))key=baseKey+':'+String(++collision);
  }
  if(!job){
    const worker=new Worker(new URL('./forecast.worker.ts',import.meta.url),{type:'module'});
    const current:ForecastJob={catalog,worker,listeners:new Set([listener]),timer:0,last:null};
    worker.onmessage=(event:MessageEvent<ForecastMessage>)=>{
      current.last=event.data;
      for(const subscriber of current.listeners)subscriber(event.data);
    };
    worker.onerror=()=>{
      const message={error:'鱼窗计算中断，请重试。'};
      current.last=message;
      for(const subscriber of current.listeners)subscriber(message);
    };
    const calculate=()=>worker.postMessage({fish:catalog.fish,region,from:Date.now(),hours});
    // 先注册订阅者、再发计算消息，避免首个回调丢失。
    jobs.set(key,current);
    try{
      calculate();
      current.timer=window.setInterval(calculate,60_000);
    }catch(error){
      jobs.delete(key);
      worker.terminate();
      throw error;
    }
    job=current;
  }else{
    job.listeners.add(listener);
    if(job.last)listener(job.last);
  }
  const subscription=job;
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
