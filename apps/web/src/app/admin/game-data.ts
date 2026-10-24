import {DEFAULT_GAME_DATA,siteGameDataSchema,type SiteGameData} from '@ff14-hub/shared';
import {useEffect,useState} from 'react';
export const GAME_DATA_CHANGED='ff14hub:game-data-changed';
let cached:Promise<SiteGameData>|undefined;
export function loadGameData(){return cached??=fetch('/api/v1/site/data',{credentials:'omit',cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error('在线修订暂不可用');const value=await response.json() as {data:unknown};return siteGameDataSchema.parse(value.data);}).catch(error=>{cached=undefined;throw error;});}
export function invalidateGameData(){cached=undefined;window.dispatchEvent(new Event(GAME_DATA_CHANGED));}
export function useGameData(){const [data,setData]=useState(DEFAULT_GAME_DATA);useEffect(()=>{let alive=true;const refresh=()=>{cached=undefined;void loadGameData().then(value=>{if(alive)setData(value);}).catch(()=>undefined);};refresh();window.addEventListener(GAME_DATA_CHANGED,refresh);window.addEventListener('focus',refresh);return()=>{alive=false;window.removeEventListener(GAME_DATA_CHANGED,refresh);window.removeEventListener('focus',refresh);};},[]);return data;}
