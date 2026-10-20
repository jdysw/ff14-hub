import {z} from 'zod';
import {pushSubscriptionInputSchema} from './reminder-api';
export const localNotificationChannelSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('serverchan'),sendKey:z.string().regex(/^SCT[A-Za-z0-9_-]{10,200}$/)}).strict(),
  z.object({kind:z.literal('resend'),apiKey:z.string().regex(/^re_[A-Za-z0-9_-]{10,200}$/),from:z.email().max(254),to:z.email().max(254)}).strict(),
  z.object({kind:z.literal('webpush'),subscription:pushSubscriptionInputSchema}).strict(),
]);
export type LocalNotificationChannel=z.infer<typeof localNotificationChannelSchema>;
export const fishDigestSchema=z.object({enabled:z.boolean(),time:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
  eventEndDays:z.array(z.union([z.literal(1),z.literal(3)])).max(2),
  targets:z.array(z.object({region:z.enum(['cn','global']),fishId:z.number().int().positive()}).strict()).max(50)}).strict();
export type FishDigestSettings=z.infer<typeof fishDigestSchema>;
export const localNotificationJobSchema=z.object({key:z.string().regex(/^[A-Za-z0-9:._-]{1,160}$/),
  title:z.string().min(1).max(80),body:z.string().max(200),dueAt:z.number().int().nonnegative(),expiresAt:z.number().int().nonnegative()}).strict();
export const localNotificationJobsSchema=z.array(localNotificationJobSchema).max(30)
  .refine(jobs=>new Set(jobs.map(job=>job.key)).size===jobs.length,'Duplicate notification keys');
export type LocalNotificationJob=z.infer<typeof localNotificationJobSchema>;
