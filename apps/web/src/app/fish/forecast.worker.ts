import {forecastCatalog} from './forecast';
import type {CatalogFish} from './catalog';
import type {FishRegion} from '@ff14-hub/shared';
const workerScope=self as unknown as {onmessage:((event:MessageEvent<{fish:CatalogFish[];region:FishRegion;from:number;hours:number}>)=>void)|null;postMessage:(message:unknown)=>void};
workerScope.onmessage=({data})=>{
  try{workerScope.postMessage({forecasts:forecastCatalog(data.fish,data.region,data.from,data.hours)});}
  catch{workerScope.postMessage({error:'鱼窗计算失败，请重新加载'});}
};
