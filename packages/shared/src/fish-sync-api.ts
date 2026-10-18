import { z } from 'zod';
import { fishRegionSchema,fishProgressFieldSchema } from './fish-api';
import { operationIdSchema } from './workbench-api';
import type { ModuleManifest } from './module-manifest';
import type { WidgetConfigContract } from './builtin-modules';
export {parseFishDocument,serializeFishDocument,mergeFishDocuments,fieldsToDocument,documentChanges} from '@ff14-hub/fish-sync';
export type {FishDocument,MergeConflict} from '@ff14-hub/fish-sync';
export const SYNC_MODULE_ID='ff14.sync';
export const SYNC_WIDGET_ID='fish-sync-manager';
export const syncFieldSchema=z.object({fishId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),field:fishProgressFieldSchema,
  value:z.boolean(),revision:z.number().int().positive()}).strict();
export const fishSyncSnapshotSchema=z.object({region:fishRegionSchema,watermark:z.number().int().nonnegative(),fields:z.array(syncFieldSchema).max(15000),
  lastSyncedAt:z.number().int().nonnegative().nullable(),audits:z.array(z.object({id:z.uuid(),createdAt:z.number(),applied:z.number().int()}))}).strict();
export type FishSyncSnapshot=z.infer<typeof fishSyncSnapshotSchema>;
export const fishSyncChangeSchema=syncFieldSchema.omit({revision:true}).extend({expectedRevision:z.number().int().nonnegative()}).strict();
export type FishSyncChange=z.infer<typeof fishSyncChangeSchema>;
export const fishSyncPreviewInputSchema=z.object({region:fishRegionSchema,changes:z.array(fishSyncChangeSchema).min(1).max(200)}).strict()
  .refine((input)=>new Set(input.changes.map((c)=>`${String(c.fishId)}:${c.field}`)).size===input.changes.length,'同一字段不能重复出现');
export const fishSyncPreviewSchema=z.object({token:z.uuid(),region:fishRegionSchema,watermark:z.number().int().nonnegative(),
  changes:z.array(fishSyncChangeSchema),backup:z.array(fishSyncChangeSchema),expiresAt:z.number().int().positive()}).strict();
export type FishSyncPreview=z.infer<typeof fishSyncPreviewSchema>;
export const fishSyncApplySchema=z.object({token:z.uuid(),operationId:operationIdSchema}).strict();
export const fishSyncResultSchema=z.object({auditId:z.uuid(),applied:z.number().int().nonnegative(),replayed:z.boolean()}).strict();
export const syncWidgetConfigSchema=z.object({region:fishRegionSchema.default('cn')}).strict();
export const SYNC_WIDGET_CONFIG_CONTRACTS:readonly WidgetConfigContract[]=[{widgetId:SYNC_WIDGET_ID,configSchemaVersion:1,
  schema:syncWidgetConfigSchema,defaultConfig:{region:'cn'},migrations:{}}];
export const SYNC_MODULE_MANIFEST:ModuleManifest={id:SYNC_MODULE_ID,version:'1.0.0',displayName:'数据同步',capabilities:['storage:own'],
  settingsSchemaVersion:1,lifecycle:{},widgets:[{id:SYNC_WIDGET_ID,moduleId:SYNC_MODULE_ID,displayName:'鱼糕导入与同步',allowMultiple:true,
    defaultSize:{w:6,h:5},minSize:{w:3,h:3},configSchemaVersion:1}]};
