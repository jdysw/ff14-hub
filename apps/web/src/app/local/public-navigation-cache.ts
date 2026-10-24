/** 公开导航目录的最后一次已验证版本：仅含公开站点，不含个人收藏或私人备注。 */
import {navCatalogResponseSchema,type NavCatalogEntry} from '@ff14-hub/shared';

const KEY='ff14-hub:public-navigation:v1';
const MAX_AGE_MS=30*24*60*60_000;

export function saveCachedNavigation(payload:unknown):void{
  try{
    if(typeof localStorage==='undefined')return;
    const value=navCatalogResponseSchema.parse(payload);
    localStorage.setItem(KEY,JSON.stringify({at:Date.now(),value}));
  }catch{/* 缓存不可用不能阻断公开目录 */}
}

export function readCachedNavigation():NavCatalogEntry[]|null{
  try{
    if(typeof localStorage==='undefined')return null;
    const raw=localStorage.getItem(KEY);
    if(!raw)return null;
    const record=JSON.parse(raw) as {at?:unknown;value?:unknown};
    if(typeof record.at!=='number'||!Number.isFinite(record.at)||record.at>Date.now()+60_000||Date.now()-record.at>MAX_AGE_MS)return null;
    const parsed=navCatalogResponseSchema.safeParse(record.value);
    return parsed.success?[...parsed.data.entries]:null;
  }catch{return null;}
}
