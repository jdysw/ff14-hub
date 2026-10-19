import {fishProgressWriteSchema,fishRegionSchema} from '@ff14-hub/shared';
import type {ModuleDataPort} from '../widgets/types';
import {publicFishPort} from '../fish/fish-data-port';
import type {LocalStore} from './store';
export function localFishPort(store:LocalStore):ModuleDataPort{
  return {moduleId:'ff14.fishing',operations:['fish.catalog','fish.progress','fish.progress.read'],async call<T>(operation:string,input?:unknown):Promise<T>{
    if(operation==='fish.catalog')return publicFishPort.call<T>(operation,input);
    if(operation==='fish.progress.read'){
      const region=fishRegionSchema.parse((input as {region?:unknown}|undefined)?.region);
      const data=await store.read();return {fields:data.fish[region],watermark:data.revision} as T;
    }
    if(operation==='fish.progress')return {field:await store.saveProgress(fishProgressWriteSchema.parse(input)),replayed:false} as T;
    throw new Error('不支持的本地钓鱼操作');
  }};
}
