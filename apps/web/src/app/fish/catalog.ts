import {z} from 'zod';
import {fishRuleSchema} from '@ff14-hub/shared';
export const catalogFishSchema=z.object({id:z.number().int().positive(),name:z.string(),englishName:z.string(),
  kind:z.enum(['normal','big','legendary']),method:z.enum(['rod','spear','ocean']),level:z.number(),patch:z.string(),
  zone:z.string(),location:z.string(),spotId:z.number(),bait:z.array(z.string()),tug:z.string(),hookset:z.string(),
  conditions:z.array(z.string()),always:z.boolean(),rule:fishRuleSchema.nullable()});
export const fishingCatalogSchema=z.object({schemaVersion:z.literal(1),region:z.enum(['cn','global']),generatedAt:z.string(),
  versions:z.object({tracker:z.string(),cn:z.string(),teamcraft:z.string()}),
  coverage:z.object({total:z.number(),forecast:z.number(),always:z.number(),unknown:z.number()}),fish:z.array(catalogFishSchema).max(5000)})
  .refine(c=>c.coverage.total===c.fish.length&&new Set(c.fish.map(f=>f.id)).size===c.fish.length,'Invalid catalog coverage');
export type CatalogFish=z.infer<typeof catalogFishSchema>;
export type FishingCatalog=z.infer<typeof fishingCatalogSchema>;
