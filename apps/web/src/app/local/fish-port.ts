import {fishProgressWriteSchema,fishRegionSchema} from '@ff14-hub/shared';
import type {FishingData} from '../fish/data';
import {loadFishingCatalog} from '../fish/catalog';
import type {LocalStore} from './store';

export function localFishingData(store:LocalStore):FishingData{
  return {
    loadCatalog:loadFishingCatalog,
    async readProgress(input){
      const region=fishRegionSchema.parse(input),data=await store.read();
      return {fields:data.fish[region],watermark:data.revision};
    },
    async saveProgress(input){await store.saveProgress(fishProgressWriteSchema.parse(input));},
  };
}
