import {z} from 'zod';
import {fishRuleSchema,fishRegionSchema,type FishRegion} from '@ff14-hub/shared';
export const catalogFishSchema=z.object({id:z.number().int().positive(),name:z.string(),englishName:z.string(),
  kind:z.enum(['normal','big','legendary']),method:z.enum(['rod','spear','ocean']),level:z.number(),patch:z.string(),
  zone:z.string(),location:z.string(),spotId:z.number(),bait:z.array(z.string()),tug:z.string(),hookset:z.string(),
  conditions:z.array(z.string()),always:z.boolean(),rule:fishRuleSchema.nullable()});
export const fishingCatalogSchema=z.object({schemaVersion:z.literal(1),region:z.enum(['cn','global']),generatedAt:z.string(),
  accuracy:z.object({weatherMatched:z.number().int().nonnegative(),weatherMismatch:z.number().int().nonnegative(),weatherMissing:z.number().int().nonnegative(),
    fishWithPredators:z.number().int().nonnegative(),gameplayVerified:z.number().int().nonnegative()}).optional(),
  versions:z.object({tracker:z.string(),cn:z.string(),teamcraft:z.string()}),
  coverage:z.object({total:z.number(),forecast:z.number(),always:z.number(),unknown:z.number()}),fish:z.array(catalogFishSchema).max(5000)})
  .refine(c=>c.coverage.total===c.fish.length&&new Set(c.fish.map(f=>f.id)).size===c.fish.length,'Invalid catalog coverage');
export type CatalogFish=z.infer<typeof catalogFishSchema>;
export type FishingCatalog=z.infer<typeof fishingCatalogSchema>;

const catalogs=new Map<FishRegion,Promise<FishingCatalog>>();
export async function loadFishingCatalog(input:FishRegion):Promise<FishingCatalog>{
  const region=fishRegionSchema.parse(input);
  let pending=catalogs.get(region);
  if(!pending){
    pending=fetch('/fishing/catalog-'+region+'.json',{credentials:'omit',redirect:'error'})
      .then(async response=>{if(!response.ok)throw new Error('鱼类目录暂时无法加载');return fishingCatalogSchema.parse(await response.json());})
      .then(catalog=>{if(catalog.region!==region)throw new Error('目录区服不一致');return catalog;});
    catalogs.set(region,pending);void pending.catch(()=>catalogs.delete(region));
  }
  return pending;
}
