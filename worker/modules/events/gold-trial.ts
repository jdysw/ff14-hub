import {z} from 'zod';
import {type EventCalendarResponse,type EventCalendarItem} from '@ff14-hub/shared';
import {boundedBody} from './calendar-feed';

const ENDPOINT='https://actff1.web.sdo.com/20241130_GoldTrial/Handler/Config/Active/GetCurrentActive.ashx';
const SOURCE='https://actff1.web.sdo.com/20241130_GoldTrial/#/index';
const TTL=15*60_000,RETRY_MS=60_000;
const dateText=z.string().regex(/^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/);
const activitySchema=z.object({ActiveID:z.string().regex(/^\d{8}$/),ActiveName:z.string().regex(/^\d{1,5}$/),StartTime_Terri:dateText,EndTime_Terri:dateText,StartTime_Reward:dateText,EndTime_Reward:dateText,StartTime_Result:dateText});
function chinaTime(value:string):number|null{
  const match=/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  if(!match)return null;
  const [year,month,day,hour,minute,second]=match.slice(1).map(Number) as [number,number,number,number,number,number];
  const utc=Date.UTC(year,month-1,day,hour,minute,second),date=new Date(utc);
  if(year<2025||year>2100||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59||second>59)return null;
  return utc-8*3600000;
}
export function parseGoldTrial(payload:unknown):EventCalendarItem[]{
  const result=z.object({result:z.literal('1'),currentActive:z.unknown(),nextActive:z.unknown().optional(),vTerri:z.array(z.object({territory_name:z.string().max(100)})).optional()}).safeParse(payload);
  if(!result.success)throw new Error('invalid_gold_trial_response');
  const current=activitySchema.safeParse(result.data.currentActive);
  if(!current.success)throw new Error('invalid_gold_trial_activity');
  const activities=[current.data];
  const next=activitySchema.safeParse(result.data.nextActive);if(next.success)activities.push(next.data);
  return activities.flatMap(activity=>{
    const description='时间来自官方专题配置。幸运奖励抽取：'+activity.StartTime_Result+'（北京时间）。';
    const phases=[{id:'challenge',name:'副本挑战期',start:activity.StartTime_Terri,end:activity.EndTime_Terri},{id:'registration',name:'试炼登记期',start:activity.StartTime_Reward,end:activity.EndTime_Reward}];
    return phases.map(phase=>{
      const startsAt=chinaTime(phase.start),endsAt=chinaTime(phase.end);
      if(startsAt===null||endsAt===null||endsAt<=startsAt)throw new Error('invalid_gold_trial_dates');
      return {id:'official:gold-trial:'+activity.ActiveID+':'+phase.id,region:'cn' as const,title:'黄金的试炼 第'+activity.ActiveName+'期 · '+phase.name,description,category:'黄金的试炼',location:'',startsAt,endsAt,allDay:false,sourceUrl:SOURCE};
    });
  });
}
let cached:{events:EventCalendarItem[];at:number}|undefined;
let failedAt=0;
async function readGoldTrial(){
  const now=Date.now();
  if(cached&&now-cached.at<TTL)return {events:cached.events,stale:false};
  if(failedAt!==0&&now-failedAt<RETRY_MS)return {events:cached?.events??[],stale:true};
    try{
      const response=await fetch(ENDPOINT,{redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('gold_trial_unavailable');
      const events=parseGoldTrial(JSON.parse(await boundedBody(response)) as unknown);
      cached={events,at:Date.now()};return {events,stale:false};
    }catch{failedAt=Date.now();return {events:cached?.events??[],stale:true};}
}
export async function withGoldTrial(calendar:EventCalendarResponse):Promise<EventCalendarResponse>{
  const supplement=await readGoldTrial();
  const combined=new Map(calendar.events.map(item=>[item.id,item]));
  for(const event of supplement.events)combined.set(event.id,event);
  return {...calendar,events:[...combined.values()],source:{...calendar.source,stale:calendar.source.stale||supplement.stale}};
}
