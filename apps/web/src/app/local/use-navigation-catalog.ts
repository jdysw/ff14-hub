/** 公开导航目录读取与后台编辑后的统一刷新入口；不持有任何个人资料。 */
import {useCallback,useEffect,useState} from 'react';
import {API_ROUTES,navCatalogResponseSchema,type NavCatalogEntry} from '@ff14-hub/shared';
import {readCachedNavigation,saveCachedNavigation} from './public-navigation-cache';

export const NAV_DIRECTORY_CHANGED='ff14hub:directory-changed';

export function useNavigationCatalog(){
  const [catalog,setCatalog]=useState<NavCatalogEntry[]>([]);
  const [catalogLoading,setCatalogLoading]=useState(true);
  const [catalogError,setCatalogError]=useState(false);
  const [version,setVersion]=useState(0);
  const reloadCatalog=useCallback(()=>{
    setCatalogLoading(true);
    setCatalogError(false);
    setVersion(value=>value+1);
  },[]);
  useEffect(()=>{
    let active=true;
    void fetch(API_ROUTES.navCatalog,{credentials:'omit',redirect:'error'})
      .then(async response=>{
        if(!response.ok)throw new Error('目录暂时无法读取');
        return navCatalogResponseSchema.parse(await response.json());
      })
      .then(result=>{if(active){saveCachedNavigation(result);setCatalog([...result.entries]);setCatalogError(false);}})
      .catch(()=>{if(active){const saved=readCachedNavigation();if(saved){setCatalog(saved);}setCatalogError(true);}})
      .finally(()=>{if(active)setCatalogLoading(false);});
    return()=>{active=false;};
  },[version]);
  useEffect(()=>{
    window.addEventListener(NAV_DIRECTORY_CHANGED,reloadCatalog);
    return()=>window.removeEventListener(NAV_DIRECTORY_CHANGED,reloadCatalog);
  },[reloadCatalog]);
  return {catalog,catalogLoading,catalogError,reloadCatalog};
}
