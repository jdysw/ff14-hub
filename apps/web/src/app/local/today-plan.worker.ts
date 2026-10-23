import {planFish} from './today-plan';
import type {CatalogFish} from '../fish/catalog';
import type {LocalData} from './store';
import type {FishRegion} from '@ff14-hub/shared';
const scope=self as unknown as {onmessage:((event:MessageEvent<{fish:CatalogFish[];fields:LocalData['fish']['cn'];region:FishRegion;now:number}>)=>void)|null;postMessage:(message:unknown)=>void};
scope.onmessage=({data})=>{try{scope.postMessage({result:planFish(data.fish,data.fields,data.region,data.now)});}catch{scope.postMessage({error:'今日鱼窗计算失败，请重新打开计划'});}};
