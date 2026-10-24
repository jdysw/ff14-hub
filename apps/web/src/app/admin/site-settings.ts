/** 匿名公开站点展示设置：失败时退回内置安全默认值，不读取任何私有身份信息。 */
import { useCallback, useEffect, useState } from 'react';
import {managedPresentationSchema,DEFAULT_CATEGORIES,DEFAULT_HOME} from '@ff14-hub/shared';
export interface SiteSettings {
  readonly siteName: string;
  readonly announcement: string;
  readonly announcementEnabled: boolean;
  readonly homeCalendarEnabled: boolean;
  readonly presentation?:ReturnType<typeof managedPresentationSchema.parse>;
}
export interface SiteSettingsDocument {
  readonly revision:number;
  readonly settings:SiteSettings;
}
export const DEFAULT_SITE_SETTINGS:SiteSettings=Object.freeze({
  siteName:'私用以太之光',announcement:'',announcementEnabled:false,homeCalendarEnabled:true,presentation:{categories:DEFAULT_CATEGORIES,home:DEFAULT_HOME,categoryAliases:{}},
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
        const presentation=managedPresentationSchema.safeParse(data.settings.presentation);
        setSettings({...data.settings,...(presentation.success?{presentation:presentation.data}:{presentation:{categories:DEFAULT_CATEGORIES,home:DEFAULT_HOME,categoryAliases:{}}})});
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
