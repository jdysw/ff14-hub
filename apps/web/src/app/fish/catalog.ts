import {z} from 'zod';
import {fishRuleSchema,fishRegionSchema,type FishRegion} from '@ff14-hub/shared';
import {loadGameData,GAME_DATA_CHANGED} from '../admin/game-data';
export const catalogFishSchema=z.object({id:z.number().int().positive(),name:z.string(),englishName:z.string(),
  kind:z.enum(['normal','big','legendary']),method:z.enum(['rod','spear','ocean']),level:z.number(),patch:z.string(),
  zone:z.string(),location:z.string(),spotId:z.number(),bait:z.array(z.string()),tug:z.string(),hookset:z.string(),
  conditions:z.array(z.string()),always:z.boolean(),rule:fishRuleSchema.nullable(),
  aliases:z.array(z.string()).optional(),
  acquisitionContext:z.object({category:z.enum(['cosmic','reconstruction','associated-item','quest','collectable','non-log']),label:z.string(),inFishingLog:z.literal(false),locations:z.array(z.object({spotId:z.number().int().positive(),name:z.string(),sources:z.array(z.string()),evidence:z.string(),territoryId:z.number().int()})),baitIds:z.array(z.number().int().positive()),notes:z.array(z.string()),unmatchedSpotIds:z.array(z.number().int().positive()),zone:z.string(),classificationSources:z.array(z.string()),rawSourcePresent:z.boolean()}).optional(),
  catchPathIds:z.array(z.union([z.number().int().positive(),z.array(z.number().int().positive())])).optional(),
  crossSourceAudit:z.object({status:z.enum(['checked','partial','single-source','conflict']),specialContent:z.boolean().optional(),compared:z.number().int().nonnegative(),sources:z.array(z.string()),notes:z.array(z.string()),sourceLimitedFields:z.number().int().nonnegative()}).optional(),
  intuitionDuration:z.object({seconds:z.number().int().positive().max(86400),source:z.literal('fishcake'),sourceVersion:z.string(),checkedAt:z.string()}).optional(),
  intuitionCrosscheck:z.object({status:z.enum(['matched','partial','conflict','missing']),supplemented:z.boolean().optional(),description:z.string(),checkedAt:z.string(),fishcakeVersion:z.string()}).optional()});
export const fishingCatalogSchema=z.object({schemaVersion:z.literal(1),region:z.enum(['cn','global']),generatedAt:z.string(),
  crossSourceAudit:z.object({total:z.number().int(),checked:z.number().int(),special:z.number().int().optional(),specialWithLocations:z.number().int().optional(),specialWithBaits:z.number().int().optional(),specialSourceOnly:z.number().int().optional(),partial:z.number().int(),conflicts:z.number().int(),singleSource:z.number().int(),fieldsCompared:z.number().int(),resolvedDifferences:z.number().int(),intuitionRecords:z.number().int().optional(),checkedAt:z.string(),sourceVersions:z.object({tracker:z.string(),cn:z.string(),teamcraft:z.string(),fishcake:z.string()})}).optional(),
  intuitionCrosscheck:z.object({total:z.number(),matched:z.number(),supplemented:z.number().optional(),partial:z.number(),conflicts:z.number(),missing:z.number(),checkedAt:z.string(),fishcakeVersion:z.string()}).optional(),
  accuracy:z.object({weatherMatched:z.number().int().nonnegative(),weatherMismatch:z.number().int().nonnegative(),weatherMissing:z.number().int().nonnegative(),
    fishWithPredators:z.number().int().nonnegative(),gameplayVerified:z.number().int().nonnegative()}).optional(),
  versions:z.object({tracker:z.string(),cn:z.string(),teamcraft:z.string()}),
  coverage:z.object({total:z.number(),forecast:z.number(),always:z.number(),unknown:z.number()}),fish:z.array(catalogFishSchema).max(5000)})
  .refine(c=>c.coverage.total===c.fish.length&&new Set(c.fish.map(f=>f.id)).size===c.fish.length,'Invalid catalog coverage');
export type CatalogFish=z.infer<typeof catalogFishSchema>;
export type FishingCatalog=z.infer<typeof fishingCatalogSchema>;

const catalogs=new Map<FishRegion,Promise<FishingCatalog>>();
if(typeof window!=='undefined')window.addEventListener(GAME_DATA_CHANGED,()=>catalogs.clear());
export async function loadFishingCatalog(input:FishRegion):Promise<FishingCatalog>{
  const region=fishRegionSchema.parse(input);
  let pending=catalogs.get(region);
  if(!pending){
    pending=fetch('/fishing/catalog-'+region+'.json',{credentials:'omit',redirect:'error'})
      .then(async response=>{if(!response.ok)throw new Error('鱼类目录暂时无法加载');return fishingCatalogSchema.parse(await response.json());})
      .then(async catalog=>{if(catalog.region!==region)throw new Error('目录区服不一致');
        let corrections;try{corrections=(await loadGameData()).fish.filter(item=>item.region===region);}catch{throw new Error('在线鱼类修订加载失败，请重试，避免使用未经确认的旧规则');}
        if(!corrections.length)return catalog;
        const fish=catalog.fish.map(fish=>{const patch=corrections.find(item=>item.id===fish.id);return patch?{...fish,name:patch.name,bait:patch.bait,conditions:patch.conditions,always:false,rule:patch.rule?{...patch.rule,validationStatus:'unverified'}:null,crossSourceAudit:{status:'partial',compared:fish.crossSourceAudit?.compared??0,sources:[...(fish.crossSourceAudit?.sources??[]),patch.sourceUrl],notes:[patch.reason],sourceLimitedFields:fish.crossSourceAudit?.sourceLimitedFields??0}}:fish;});
        return fishingCatalogSchema.parse({...catalog,fish,coverage:{total:fish.length,forecast:fish.filter(item=>item.rule!==null).length,always:fish.filter(item=>!item.rule&&item.always).length,unknown:fish.filter(item=>!item.rule&&!item.always).length}});});
    catalogs.set(region,pending);void pending.catch(()=>catalogs.delete(region));
  }
  return pending;
}
