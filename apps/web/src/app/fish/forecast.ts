import {fishWindows,type FishRegion,type FishWindow} from '@ff14-hub/shared';
import type {CatalogFish} from './catalog';
export interface FishForecast {id:number;windows:FishWindow[];failed:boolean}
/** Whole-catalog calculation precedes filtering/pagination. Runs off the UI thread. */
export function forecastCatalog(fish:readonly CatalogFish[],region:FishRegion,from:number,hours:number):FishForecast[]{
  if(!Number.isInteger(hours)||hours<1||hours>168)throw new RangeError('Invalid forecast range');
  return fish.filter(f=>f.rule!==null).map(f=>{
    try{
      const windows=fishWindows({region,rules:f.rule?[f.rule]:[],from,to:from+hours*3600000});
      return {id:f.id,windows:windows.slice(0,12),failed:false};
    }catch{return {id:f.id,windows:[],failed:true};}
  });
}
export function windowState(fish:CatalogFish,forecast:FishForecast|undefined,now:number){
  const open=forecast?.windows.find(w=>!w.unrestricted&&w.startsAtUtcMs<=now&&w.endsAtUtcMs>now)??null;
  const next=forecast?.windows.find(w=>w.startsAtUtcMs>now)??null;
  const always=fish.method==='rod'&&(fish.always||forecast?.windows.some(w=>w.unrestricted)===true);
  let sort=next?.startsAtUtcMs??Number.MAX_SAFE_INTEGER;
  if(open){sort=open.endsAtUtcMs-1e15;}
  else if(always){sort=Number.MAX_SAFE_INTEGER-1;}
  return {open,next,always,unknown:(!fish.rule&&!always)||forecast?.failed===true,sort};
}
