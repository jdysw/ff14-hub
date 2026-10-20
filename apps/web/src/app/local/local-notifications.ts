import {eventCalendarResponseSchema,fishDigestSchema,type LocalNotificationJob,type LocalNotificationChannel} from '@ff14-hub/shared';
import {forecastCatalog} from '../fish/forecast';
import {loadFishingCatalog} from '../fish/catalog';
import type {LocalData,LocalStore} from './store';
import {readDeviceRecord,writeDeviceRecord,updateDeviceRecord} from './secure-storage';
export interface NotificationSettings{token:string|null;channel:'serverchan'|'resend';events:boolean;eventEndDays:(1|3)[];fish:boolean;digestTime:string;leadMinutes:number;dailyLimit:number;browser:boolean;jobs:LocalNotificationJob[];lastPlan:number;error:string}
export const defaultNotificationSettings:NotificationSettings={token:null,channel:'serverchan',events:true,eventEndDays:[3,1],fish:true,digestTime:'08:00',leadMinutes:10,dailyLimit:5,browser:false,jobs:[],lastPlan:0,error:''};
export function digestSettings(data:LocalData,settings:NotificationSettings){
  const targets=(['cn','global'] as const).flatMap(region=>{const caught=new Set(data.fish[region].filter(f=>f.field==='caught'&&f.value).map(f=>f.fishId));return data.fish[region].filter(f=>f.field==='alarm'&&f.value&&!caught.has(f.fishId)).map(f=>({region,fishId:f.fishId}));});
  if(settings.fish&&targets.length>50)throw new Error('后台每日汇总最多关注 50 条鱼，请减少闹钟标记后再启用');
  return fishDigestSchema.parse({enabled:settings.fish||(settings.events&&settings.eventEndDays.length>0),time:settings.digestTime,eventEndDays:settings.events?settings.eventEndDays:[],targets:settings.fish?targets:[]});
}
export const NOTIFICATION_SETTINGS_CHANGED='ff14:local-notifications-changed';
let eventCache:{at:number;data:ReturnType<typeof eventCalendarResponseSchema.parse>}|null=null;
export async function buildNotificationJobs(data:LocalData,settings:NotificationSettings,now=Date.now()):Promise<LocalNotificationJob[]>{
  const jobs:LocalNotificationJob[]=[],lead=settings.leadMinutes*60_000;
  const add=(key:string,title:string,body:string,time:number)=>{const dueAt=time-lead;if(dueAt>=now&&dueAt<=now+72*3600_000)jobs.push({key:key+':'+dueAt,title:title.slice(0,80),body:body.slice(0,200),dueAt,expiresAt:Math.min(time+15*60_000,dueAt+15*60_000)});};
  if(settings.events){
    if(!eventCache||now-eventCache.at>=6*3600_000){const response=await fetch('/api/v1/events/calendar',{credentials:'omit',cache:'no-store',redirect:'error'});if(!response.ok)throw new Error('官方活动读取失败');eventCache={at:now,data:eventCalendarResponseSchema.parse(await response.json())};}
    for(const item of eventCache.data.events){if(item.startsAt!==null&&item.endsAt!==null){add('event-start:'+item.id,item.title,'活动即将开始',item.startsAt);add('event-end:'+item.id,item.title,'活动即将结束',item.endsAt);}}
  }
  if(settings.fish)for(const region of ['cn','global'] as const){
    const fields=data.fish[region],caught=new Set(fields.filter(f=>f.field==='caught'&&f.value).map(f=>f.fishId));
    const wanted=new Set(fields.filter(f=>f.field==='alarm'&&f.value&&!caught.has(f.fishId)).map(f=>f.fishId));
    if(wanted.size===0)continue;
    const catalog=await loadFishingCatalog(region);
    const fish=catalog.fish.filter(f=>wanted.has(f.id)&&f.rule?.validationStatus==='verified'&&f.rule.conditions.length===0);
    const names=new Map(fish.map(f=>[f.id,f]));
    for(const item of forecastCatalog(fish,region,now,72))for(const window of item.windows){if(!window.candidateOnly){const record=names.get(item.id)!;add(`fish:${region}:${item.id}:${window.startsAtUtcMs}`,record.name,`${region==='cn'?'国服':'国际服'} · ${record.location} · 鱼窗即将开放`,window.startsAtUtcMs);}}
  }
  return jobs.sort((a,b)=>a.dueAt-b.dueAt||a.key.localeCompare(b.key)).slice(0,30);
}
export async function notificationRequest(path:string,token:string,method='GET',body?:unknown){
  const response=await fetch('/api/v1/local-notifications'+path,{method,credentials:'omit',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(method==='DELETE'&&response.status===401)return {removed:true};
  if(!response.ok)throw new Error(response.status===401?'通知订阅已失效，请重新启用':response.status===429?'通知操作过于频繁，请稍后再试':'通知服务暂不可用，请稍后重试');
  return response.json() as Promise<unknown>;
}
export async function registerNotifications(channel:LocalNotificationChannel,settings:NotificationSettings,store:LocalStore){
  const data=await store.read(),digest=digestSettings(data,settings),jobs=await buildNotificationJobs(data,settings);
  const response=await fetch('/api/v1/local-notifications/register',{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel,jobs:[],digest,dailyLimit:settings.dailyLimit})});
  if(!response.ok)throw new Error(response.status===429?'启用过于频繁，请稍后再试':'通知配置未保存，请检查输入与服务状态');
  const value=await response.json() as {token:string};
  if(!/^ffh_push_[a-f0-9]{64}$/.test(value.token))throw new Error('通知配置响应异常');
  const next={...settings,token:value.token,jobs,lastPlan:Date.now(),error:''};await writeDeviceRecord('notifications',next);window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_CHANGED));return next;
}
/** Only active devices renew plans. A closed page leaves already registered jobs deliverable. */
export function startLocalNotifications(store:LocalStore){
  let stopped=false,timer:number|undefined,running=false;
  const renew=async(localOnly=false)=>{
    if(stopped||running)return;running=true;
    try{const settings=await readDeviceRecord<NotificationSettings>('notifications');if(!settings||(!settings.token&&!settings.browser)||(localOnly&&!settings.browser))return;
      const data=await store.read(),digest=settings.token&&!localOnly?digestSettings(data,settings):null,jobs=await buildNotificationJobs(data,settings);
      const latest=await readDeviceRecord<NotificationSettings>('notifications');
      if(stopped||!latest||latest.token!==settings.token||latest.browser!==settings.browser||latest.digestTime!==settings.digestTime||(await store.read()).revision!==data.revision)return;
      if(settings.token&&!localOnly)await notificationRequest('/plan',settings.token,'PUT',{jobs:[],digest,targetsOnly:true});
      await updateDeviceRecord<NotificationSettings>('notifications',current=>{
        if(stopped||!current||current.token!==settings.token||current.browser!==settings.browser)return undefined;
        return {...current,jobs,lastPlan:localOnly?current.lastPlan:Date.now(),error:''};
      });
    }catch{/* A failed refresh preserves the durable server plan; status is available in settings. */}finally{running=false;}
  };
  const changed=()=>{window.clearTimeout(timer);timer=window.setTimeout(()=>void renew(),2000);};
  const unsubscribe=store.subscribe(changed);
  window.addEventListener(NOTIFICATION_SETTINGS_CHANGED,changed);
  const periodic=window.setInterval(()=>{if(document.visibilityState!=='hidden')void renew();},6*3600_000);
  const localPeriodic=window.setInterval(()=>void renew(true),15*60_000);
  const seen=new Set<string>();
  const browserTimer=window.setInterval(()=>{void (async()=>{
    const settings=await readDeviceRecord<NotificationSettings>('notifications');
    if(stopped||!settings?.browser||!('Notification' in window)||Notification.permission!=='granted')return;
    for(const job of settings.jobs){if(job.dueAt<=Date.now()&&job.expiresAt>Date.now()&&!seen.has(job.key)){
      seen.add(job.key);const registration=await navigator.serviceWorker.ready;
      await registration.showNotification(job.title,{body:job.body,tag:job.key,data:{url:'/?view=notifications'}});
    }}
  })().catch(()=>{});},30_000);
  void renew();
  return()=>{stopped=true;unsubscribe();window.clearTimeout(timer);window.clearInterval(periodic);window.clearInterval(localPeriodic);window.clearInterval(browserTimer);window.removeEventListener(NOTIFICATION_SETTINGS_CHANGED,changed);};
}
