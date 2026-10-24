import {DEFAULT_GAME_DATA,siteGameDataSchema,type SiteGameData} from '@ff14-hub/shared';
import {useEffect,useState} from 'react';

export const GAME_DATA_CHANGED='ff14hub:game-data-changed';
const GAME_DATA_CACHE_KEY='ff14-hub:public-game-data:v1';
const GAME_DATA_MAX_AGE=30*24*60*60_000;
type GameDataSource='live'|'cached'|'bundled';
let source:GameDataSource='bundled';
let cached:Promise<SiteGameData>|undefined;

/** 仅缓存匿名公开的站点修订和轮换规则，不包含管理员会话或私有设置。 */
function readCachedGameData():SiteGameData|null {
  try{
    if(typeof localStorage==='undefined')return null;
    const raw=localStorage.getItem(GAME_DATA_CACHE_KEY);
    if(!raw)return null;
    const record=JSON.parse(raw) as {at?:unknown;value?:unknown};
    if(typeof record.at!=='number'||!Number.isFinite(record.at)||record.at>Date.now()+60_000||Date.now()-record.at>GAME_DATA_MAX_AGE)return null;
    return siteGameDataSchema.safeParse(record.value).data??null;
  }catch{return null;}
}
function writeCachedGameData(value:SiteGameData):void{
  try{if(typeof localStorage!=='undefined')localStorage.setItem(GAME_DATA_CACHE_KEY,JSON.stringify({at:Date.now(),value}));}catch{/* 禁用本地存储时仍可联网使用 */}
}
export function gameDataSource():GameDataSource{return source;}
export function loadGameData():Promise<SiteGameData>{
  return cached??=fetch('/api/v1/site/data',{credentials:'omit',cache:'no-store',redirect:'error'})
    .then(async response=>{
      if(!response.ok)throw new Error('在线修订暂不可用');
      const payload=await response.json() as {data:unknown};
      const value=siteGameDataSchema.parse(payload.data);
      source='live';writeCachedGameData(value);return value;
    })
    .catch(()=>{
      const saved=readCachedGameData();
      source=saved?'cached':'bundled';
      // 鱼类的全部基础数据随前端静态资源打包；管理端修订不可访问时不能因此阻断鱼窗。
      // 使用默认修订规则时调用方应显示来源警告，不得假称已经获取最新人工修订。
      return saved??DEFAULT_GAME_DATA;
    });
}
export function invalidateGameData(){cached=undefined;window.dispatchEvent(new Event(GAME_DATA_CHANGED));}
export function useGameData(){
  const [data,setData]=useState(DEFAULT_GAME_DATA);
  useEffect(()=>{
    let alive=true;
    const refresh=()=>{
      cached=undefined;
      void loadGameData().then(value=>{if(alive)setData(value);});
    };
    refresh();
    window.addEventListener(GAME_DATA_CHANGED,refresh);
    window.addEventListener('focus',refresh);
    return()=>{alive=false;window.removeEventListener(GAME_DATA_CHANGED,refresh);window.removeEventListener('focus',refresh);};
  },[]);
  return data;
}
