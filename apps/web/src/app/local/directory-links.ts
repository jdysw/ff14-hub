import {canonicalNavUrl,type NavCatalogEntry,type NavRegion} from '@ff14-hub/shared';
import type {LocalData} from './store';

export interface BrowserLink {
  id:string;title:string;url:string;category:string;description:string;tags:string[];aliases:string[];faviconUrl?:string|undefined;
  region:NavRegion;favorite:boolean;personal:boolean;
}

/** A favorite is a local copy; enrich it with public search metadata without mutating it. */
export function directoryLinks(catalog:readonly NavCatalogEntry[],personal:LocalData['links']):BrowserLink[]{
  const metadata=new Map(catalog.map(entry=>[canonicalNavUrl(entry.url),entry]));
  const result=new Map<string,BrowserLink>();
  for(const entry of personal){
    const key=canonicalNavUrl(entry.url);const base=metadata.get(key);
    const legacyCategories=['官方服务','新手与百科','副本与战斗','生产采集与钓鱼','市场与经济','狩猎与探索','休闲与成就','幻化与外观','住房装修','开发与辅助工具','社区与创作'];
    const category=base&&entry.categoryCustomized!==true&&(entry.categoryCustomized===false||legacyCategories.includes(entry.category))?base.category:entry.category;
    result.set(key,{...entry,category:category||'个人网站',description:entry.description?.trim()||base?.description||'',
      tags:base?.tags??[],aliases:base?.aliases??[],region:base?.region??'both',personal:true});
  }
  for(const entry of catalog){const key=canonicalNavUrl(entry.url);if(!result.has(key))result.set(key,{...entry,favorite:false,personal:false});}
  return [...result.values()];
}
