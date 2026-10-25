import type {FishProgress,FishProgressWrite,FishRegion} from '@ff14-hub/shared';
import type {FishingCatalog} from './catalog';

export interface FishingData {
  loadCatalog(region:FishRegion):Promise<FishingCatalog>;
  readProgress?:(region:FishRegion)=>Promise<{fields:FishProgress[];watermark:number}>;
  saveProgress?:(input:FishProgressWrite)=>Promise<void>;
}
