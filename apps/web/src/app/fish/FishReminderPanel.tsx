import {useEffect,useState} from 'react';
import type {FishRegion} from '@ff14-hub/shared';
import type {CatalogFish} from './catalog';
import {readDeviceRecord,updateDeviceRecord} from '../local/secure-storage';
import {defaultNotificationSettings,NOTIFICATION_SETTINGS_CHANGED,type NotificationSettings} from '../local/local-notifications';
import {usePrivateDraft} from '../pwa/draft-registry';

export function FishReminderPanel({fish,region,enabled,caught,onSave,onClose,onSettings}:{fish:CatalogFish;region:FishRegion;enabled:boolean;caught:boolean;onSave:(value:boolean)=>Promise<boolean>;onClose:()=>void;onSettings?:()=>void}){
  const [settings,setSettings]=useState<NotificationSettings|null>(null),[lead,setLead]=useState(10),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const key=`${region}:${fish.id}`;
  usePrivateDraft(busy||Boolean(settings&&lead!==(settings.fishLeadMinutes?.[key]??settings.leadMinutes)));
  useEffect(()=>{let alive=true;void readDeviceRecord<NotificationSettings>('notifications').then(saved=>{if(alive){const s=saved??defaultNotificationSettings;setSettings(s);setLead(s.fishLeadMinutes?.[key]??s.leadMinutes);}}).catch(()=>{if(alive)setError('提醒配置读取失败，请关闭后重试');});return()=>{alive=false;};},[key]);
  const save=async()=>{
    if(busy||!settings)return;setBusy(true);setError('');
    try{
      await updateDeviceRecord<NotificationSettings>('notifications',current=>{const s=current??defaultNotificationSettings;return {...s,fish:true,fishLeadMinutes:{...s.fishLeadMinutes,[key]:lead}};});
      if(await onSave(true)){window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_CHANGED));onClose();}
    }catch{setError('提醒未保存，请重试');}finally{setBusy(false);}
  };
  const authorize=()=>{
    if(!('Notification' in window)){setError('当前浏览器不支持网页通知，可在通知设置中配置后台每日汇总');return;}
    // Permission must be requested directly from the user's click.
    const permission=Notification.requestPermission();setBusy(true);setError('');
    void permission.then(async value=>{
      if(value!=='granted')throw new Error('请在浏览器的站点设置中允许通知，标记提醒仍可保存');
      const next=await updateDeviceRecord<NotificationSettings>('notifications',current=>({... (current??defaultNotificationSettings),browser:true,fish:true}));
      setSettings(next);window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_CHANGED));
    }).catch((cause:unknown)=>setError(cause instanceof Error?cause.message:'通知授权失败')).finally(()=>setBusy(false));
  };
  const rule=fish.rule;
  const unrestricted=rule&&rule.startHour===0&&rule.endHour===24&&
    (!rule.currentWeather.length||rule.weatherRates.every(r=>rule.currentWeather.includes(r.weather)))&&
    (!rule.previousWeather.length||rule.weatherRates.every(r=>rule.previousWeather.includes(r.weather)));
  const finite=rule&&fish.method==='rod'&&!unrestricted&&!rule.conditions.some(c=>c.kind==='unknown');
  return <section className="fish-reminder-panel" aria-label={`${fish.name}的提醒`}>
    <header><h3>{fish.name} · 提醒</h3><button type="button" onClick={onClose} disabled={busy} aria-label="关闭单鱼提醒">关闭</button></header>
    <p>网页通知只在网页打开时检查；后台渠道每天发送日程汇总，不提供关窗后的准点弹窗。</p>
    {!finite?<p>此鱼没有有限开窗规则，可保留提醒标记，但暂不生成开窗通知。</p>:<p>按社区时间天气候选窗口提醒；鱼饵、鱼识及技能条件仍需另行满足。</p>}
    {caught?<p>此鱼已标记钓获，提醒将跳过；取消钓获后才会恢复。</p>:null}
    <label>这条鱼提前多久提醒<select aria-label="单鱼提醒提前时间" value={lead} disabled={busy||!settings} onChange={e=>setLead(Number(e.target.value))}>{[5,10,15,30,60].map(value=><option key={value} value={value}>{value} 分钟</option>)}</select></label>
    <output style={{display:'block'}}>{settings?.browser&&'Notification' in window&&Notification.permission==='granted'?'网页内通知已启用':'网页内通知尚未启用'} · {settings?.token?'后台渠道已连接':'后台渠道未连接'}</output>
    <div className="fish-reminder-panel__actions"><button type="button" disabled={busy||!settings} onClick={()=>{void save();}}>{enabled?'保存这条鱼的提醒':'保存提醒标记'}</button>
      <button type="button" disabled={busy||!settings} onClick={authorize}>授权并启用网页通知</button>
      {enabled?<button type="button" disabled={busy||!settings} onClick={()=>{setBusy(true);void onSave(false).then(ok=>{if(ok)onClose();}).catch(()=>setError('取消提醒失败')).finally(()=>setBusy(false));}}>取消这条鱼的提醒</button>:null}
      {onSettings?<button type="button" onClick={onSettings} disabled={busy}>通知设置</button>:null}</div>
    {error?<p role="alert">{error}</p>:null}
  </section>;
}
