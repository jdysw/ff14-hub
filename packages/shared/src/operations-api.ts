import {z} from 'zod';
const count=z.number().int().nonnegative();const time=count.nullable();
export const OPERATION_ALERTS=['scheduler_not_observed','scheduler_failed','scheduler_stale','due_backlog','stale_leases','delivery_failures','push_unconfigured','catalog_unverified','source_stale','modules_pending'] as const;
export const operationsSnapshotSchema=z.object({
  region:z.enum(['cn','global']),observedAt:count,
  scheduler:z.object({last:z.object({status:z.enum(['running','succeeded','failed','abandoned']),scheduledAt:count,startedAt:count,finishedAt:time,
    failureStage:z.enum(['plan','deliver','finish','abandoned']).nullable()}).strict().nullable(),lastSuccessAt:time,cadenceVerified:z.literal(false)}).strict(),
  modules:z.array(z.object({id:z.string(),status:z.enum(['enabled','disabled','uninstalled']),pending:z.boolean()}).strict()).max(5),
  reminders:z.object({activeRules:count,unplannedRules:count,due:count,blocked:count,staleLeases:count,failed24h:count,oldestDueAt:time,
    accepted24h:count,temporary24h:count,permanent24h:count,pushConfigurationPresent:z.boolean()}).strict(),
  catalog:z.object({total:count,verified:count,demo:count,staleVerified:count,oldestFetchedAt:time,fetchMonitoringAvailable:z.literal(false)}).strict(),
  sync:z.object({lastImportedAt:time,imports24h:count,watermark:count,webdavFreshnessAvailable:z.literal(false)}).strict(),
  alerts:z.array(z.object({code:z.enum(OPERATION_ALERTS),severity:z.enum(['info','warning'])}).strict()),
}).strict();
export type OperationsSnapshot=z.infer<typeof operationsSnapshotSchema>;
