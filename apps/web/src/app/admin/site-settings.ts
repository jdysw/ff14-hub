/** 匿名公开站点展示设置：失败时退回内置安全默认值，不读取任何私有身份信息。 */
import { useCallback, useEffect, useState } from 'react';
export interface SiteSettings {
  readonly siteName: string;
  readonly announcement: string;
  readonly announcementEnabled: boolean;
  readonly homeCalendarEnabled: boolean;
}
export interface SiteSettingsDocument {
  readonly revision:number;
  readonly settings:SiteSettings;
}
export const DEFAULT_SITE_SETTINGS:SiteSettings=Object.freeze({
  siteName:'FF14 Hub',announcement:'',announcementEnabled:false,homeCalendarEnabled:true,
});
export const SITE_SETTINGS_CHANGED='ff14hub:site-settings-changed';
export function useSiteSettings():SiteSettings {
  const [settings,setSettings]=useState<SiteSettings>(DEFAULT_SITE_SETTINGS);
  const reload=useCallback(()=>{
    const controller=new AbortController();
    void fetch('/api/v1/site',{credentials:'omit',cache:'no-store',signal:controller.signal})
      .then(async r=>{
        if(!r.ok)throw new Error('site settings unavailable');
        const data=await r.json() as SiteSettingsDocument;
        if(!data.settings || typeof data.settings.siteName!=='string' ||
          typeof data.settings.announcement!=='string' ||
          typeof data.settings.announcementEnabled!=='boolean' ||
          typeof data.settings.homeCalendarEnabled!=='boolean')return;
        setSettings(data.settings);
      }).catch(()=>undefined);
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    let cancel=reload();
    const refresh=()=>{cancel();cancel=reload();};
    window.addEventListener(SITE_SETTINGS_CHANGED,refresh);
    return ()=>{cancel();window.removeEventListener(SITE_SETTINGS_CHANGED,refresh);};
  },[reload]);
  return settings;
}
