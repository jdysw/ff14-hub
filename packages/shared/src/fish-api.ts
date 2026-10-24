import { z } from 'zod';
import { fishRuleSchema, regionSchema, utcSchema, verificationSchema, fishRecordSchema } from '@ff14-hub/fish-engine';
import { operationIdSchema } from './operation-id';
import type { ModuleManifest } from './module-manifest';
import type { WidgetConfigContract } from './builtin-modules';
export { fishWindows, eorzeaTime, forecastTarget, WEATHER_PERIOD_MS, ET_DAY_MS, ET_HOUR_MS } from '@ff14-hub/fish-engine';
export { fishRuleSchema, regionSchema as fishRegionSchema };
export type { FishRule, FishWindow, FishRegion, FishRecord } from '@ff14-hub/fish-engine';
export { fishSourceSchema,fishRecordSchema,fishDataBundleSchema } from '@ff14-hub/fish-engine';
export const FISH_MODULE_ID = 'ff14.fishing';
export const FISH_WIDGET_ID = 'fishing-windows';
export const fishCategorySchema = z.enum(['all','rare','normal','big','legendary']);
export const fishListQuerySchema = z.object({ region: regionSchema, category:fishCategorySchema.default('all'), offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(30), text: z.string().max(100).default('') });
export const fishWindowQuerySchema = z.object({ region: regionSchema, from: z.coerce.number().pipe(utcSchema).optional(),
  hours: z.coerce.number().int().min(1).max(168).default(72),
  fishIds:z.string().regex(/^\d+(,\d+){0,49}$/).max(600).transform((s)=>s.split(',').map(Number)).pipe(z.array(z.number().int().positive()).max(50)).optional(),
  fishId: z.coerce.number().int().positive().optional() });
export const fishListResponseSchema = z.object({ fish: z.array(fishRecordSchema), total: z.number().int(), offset: z.number().int() });
export const fishWindowSchema = z.object({ occurrenceKey:z.string(),region:regionSchema,fishId:z.number().int(),ruleVersion:z.string(),
  startsAtUtcMs:utcSchema,endsAtUtcMs:utcSchema,weatherChain:z.object({previous:z.string(),current:z.string()}),
  validationStatus:verificationSchema,candidateOnly:z.boolean(),conditions:fishRuleSchema.shape.conditions,
  unrestricted:z.boolean().optional(),
  weatherSegments:z.array(z.object({startsAtUtcMs:utcSchema,endsAtUtcMs:utcSchema,previous:z.string(),current:z.string()})).max(1000).optional() });
export const fishWindowsResponseSchema = z.object({ windows:z.array(fishWindowSchema),from:utcSchema,to:utcSchema,
  truncatedFishIds:z.array(z.number().int().positive()).optional() });
export const fishProgressFieldSchema = z.enum(['caught','pinned','alarm']);
export type FishProgressField = z.infer<typeof fishProgressFieldSchema>;
export const fishProgressSchema = z.object({ region: regionSchema, fishId: z.number().int().positive(), field: fishProgressFieldSchema,
  value: z.boolean(), revision: z.number().int().min(1), updatedAt: utcSchema });
export type FishProgress = z.infer<typeof fishProgressSchema>;
export const fishProgressResponseSchema = z.object({ fields: z.array(fishProgressSchema), watermark: z.number().int().nonnegative() });
export const fishProgressWriteSchema = z.object({ region: regionSchema, fishId: z.number().int().positive(), field: fishProgressFieldSchema,
  value: z.boolean(), expectedRevision: z.number().int().min(0), operationId: operationIdSchema }).strict();
export type FishProgressWrite = z.infer<typeof fishProgressWriteSchema>;
export const fishWidgetConfigSchema = z.object({ region: regionSchema.default('cn'), hours: z.number().int().min(1).max(168).default(72) }).strict();
export const fishSnapshotQuerySchema = fishWidgetConfigSchema.extend({category:fishCategorySchema.default('all'),offset:z.number().int().min(0).max(100000).default(0),text:z.string().max(100).default('')});
export const FISH_WIDGET_CONFIG_CONTRACTS: readonly WidgetConfigContract[] = [{widgetId: FISH_WIDGET_ID,configSchemaVersion:1,
  schema:fishWidgetConfigSchema, defaultConfig:{region:'cn',hours:72}, migrations:{}}];
export const FISH_MODULE_MANIFEST: ModuleManifest = { id:FISH_MODULE_ID,version:'1.0.0',displayName:'钓鱼手账',
  capabilities:['storage:own'], settingsSchemaVersion:1,lifecycle:{},widgets:[{id:FISH_WIDGET_ID,moduleId:FISH_MODULE_ID,
    displayName:'鱼类窗口与进度',allowMultiple:true,defaultSize:{w:6,h:5},minSize:{w:3,h:3},configSchemaVersion:1}] };
