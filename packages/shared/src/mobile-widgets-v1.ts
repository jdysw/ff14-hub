/** Android 首期、iOS 未来共用的公开桌面小部件数据协议。无平台字段、无账号、无私有令牌。 */
import {z} from 'zod';

const timestamp=z.number().int().nonnegative();
const mapRotation=z.object({
  current:z.string().min(1),
  next:z.string().min(1),
  startsAtMs:timestamp,
  changesAtMs:timestamp,
  anchorUtcMs:timestamp,
  anchorIndex:z.number().int().nonnegative(),
  periodMs:z.number().int().positive(),
  cycle:z.array(z.string().min(1)).min(1).max(12),
  ruleVersion:z.string().min(1),
}).strict();

const fishEntry=z.object({
  fishId:z.number().int().positive(),
  name:z.string().min(1).max(100),
  startsAtMs:timestamp,
  endsAtMs:timestamp,
  validationStatus:z.enum(['verified','unverified','incomplete']),
  candidateOnly:z.boolean(),
}).strict();

const eventEntry=z.object({
  id:z.string().min(1).max(300),
  title:z.string().min(1).max(120),
  startsAtMs:timestamp,
  endsAtMs:timestamp,
}).strict();

export const mobileWidgetResponseV1Schema=z.object({
  schemaVersion:z.literal(1),
  generatedAtMs:timestamp,
  refreshAfterMs:timestamp,
  staleAfterMs:timestamp,
  timezone:z.literal('Asia/Shanghai'),
  region:z.enum(['cn','global']),
  pvp:z.object({frontline:mapRotation,crystalline:mapRotation}).strict(),
  fish:z.object({
    status:z.enum(['ready','selection_required','unavailable']),
    items:z.array(fishEntry).max(20),
  }).strict(),
  events:z.object({
    status:z.enum(['ready','stale','unavailable']),
    sourceCheckedAtMs:timestamp.nullable(),
    items:z.array(eventEntry).max(5),
  }).strict(),
}).strict();
export type MobileWidgetResponseV1=z.infer<typeof mobileWidgetResponseV1Schema>;

export const mobileWidgetQueryV1Schema=z.object({
  region:z.enum(['cn','global']).default('cn'),
  // 仅用户主动选择的鱼。绝不随机截取首十条目录记录来冒充“关注鱼窗”。
  fishIds:z.string().regex(/^\d+(,\d+){0,9}$/).max(130)
    .transform(raw=>raw.split(',').map(Number))
    .refine(ids=>new Set(ids).size===ids.length&&ids.every(id=>Number.isSafeInteger(id)&&id>0),
      'fishIds 必须为最多十个不重复的正整数').optional(),
}).strict();
export type MobileWidgetQueryV1=z.infer<typeof mobileWidgetQueryV1Schema>;
