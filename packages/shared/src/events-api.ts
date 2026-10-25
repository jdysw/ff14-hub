/** Public events, official calendar and shared filtering. */
import { z } from 'zod';

export const EVENT_REGIONS = ['cn', 'global'] as const;

export type EventRegion = (typeof EVENT_REGIONS)[number];

export const MAX_EVENT_TITLE_LENGTH = 120;

export const MAX_EVENT_DESCRIPTION_LENGTH = 1000;

export const MAX_EVENT_SOURCE_URL_LENGTH = 2048;

export const MAX_EVENT_SOURCE_NAME_LENGTH = 80;

export const EVENT_VERIFICATION_STATUSES = ['verified', 'unverified'] as const;

export type EventVerificationStatus = (typeof EVENT_VERIFICATION_STATUSES)[number];

export const EVENT_PHASES = ['upcoming', 'active', 'ended'] as const;

export type EventPhase = (typeof EVENT_PHASES)[number];

export const EVENT_SORT_ORDERS = ['startsAt', 'startsAtDesc'] as const;

export type EventSortOrder = (typeof EVENT_SORT_ORDERS)[number];

export interface EventTimeRange {
  /** UTC 毫秒。 */
  readonly startsAt: number;
  /** UTC 毫秒。 */
  readonly endsAt: number;
}

export interface EventSearchableFields extends EventTimeRange {
  readonly region: string;
  readonly title: string;
  readonly description: string;
}

export function eventPhase(event: EventTimeRange, nowMs: number): EventPhase {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('eventPhase: nowMs 必须是有限的 UTC 毫秒数（不接受 NaN / Infinity）');
  }
  if (event.startsAt > nowMs) {
    return 'upcoming';
  }
  if (nowMs <= event.endsAt) {
    return 'active';
  }
  return 'ended';
}

export function normalizeEventText(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface EventFilter {
  /**
   * 区服精确匹配；`null` / 缺省表示**不按区服筛**。
   * `'both'` 不在 `EVENT_REGIONS` 内，因此它**不是**通配符（见 `filterEvents` 注释）。
   */
  readonly region?: EventRegion | null | undefined;
  /** 阶段筛选；`null` / 缺省表示不按阶段筛。给出它时必须同时给出 `nowMs`。 */
  readonly phase?: EventPhase | null | undefined;
  /** 关键字；空串 / 缺省表示不按文本筛。 */
  readonly text?: string | null | undefined;
  /**
   * 用于阶段判定的「现在」（UTC 毫秒）。
   *
   * 为什么必填而不是默认 `Date.now()`：默认值会让「同一批数据两次调用结果不同」
   * 出现在纯函数里，测试与服务端复算都无法复现。服务端传 `nowUtcMs()`，
   * 前端传服务端给的 `serverTimeMs`（避免设备时钟偏差改变筛选结果）。
   */
  readonly nowMs: number;
}

export function filterEvents<T extends EventSearchableFields>(
  events: readonly T[],
  filter: EventFilter,
): T[] {
  const region = filter.region ?? null;
  const phase = filter.phase ?? null;
  const normalized = normalizeEventText(filter.text ?? '');
  const tokens = normalized === '' ? [] : normalized.split(' ');
  const regionIsUsable = region !== null && (EVENT_REGIONS as readonly string[]).includes(region);

  return events.filter((event) => {
    if (region !== null && (!regionIsUsable || event.region !== region)) {
      return false;
    }
    if (tokens.length > 0) {
      const haystack = normalizeEventText(`${event.title} ${event.description}`);
      if (!tokens.every((token) => haystack.includes(token))) {
        return false;
      }
    }
    if (phase !== null && eventPhase(event, filter.nowMs) !== phase) {
      return false;
    }
    return true;
  });
}

function compareScalar<T extends number|string>(a:T,b:T):number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

const compareNumbers=compareScalar<number>;

const compareIds=compareScalar<string>;

export function sortEvents<T extends EventTimeRange & { readonly id: string }>(
  events: readonly T[],
  order: EventSortOrder,
): T[] {
  const direction = order === 'startsAt' ? 1 : -1;
  return [...events].sort((a, b) => {
    const byStart = compareNumbers(a.startsAt, b.startsAt);
    if (byStart !== 0) {
      return byStart * direction;
    }
    return compareIds(a.id, b.id);
  });
}

const HTTPS_SCHEME_PATTERN = /^https:\/\//i;

function hasControlOrSpace(raw: string): boolean {
  for (let index = 0; index < raw.length; index += 1) {
    const code = (raw.codePointAt(index) ?? Number.NaN);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isHttpsEventSourceUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_EVENT_SOURCE_URL_LENGTH) {
    return false;
  }
  if (hasControlOrSpace(raw)) {
    return false;
  }
  if (!HTTPS_SCHEME_PATTERN.test(raw)) {
    return false;
  }
  const rest = raw.slice('https://'.length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.length === 0) {
    return false;
  }
  if (authority.includes('@')) {
    return false;
  }
  // IPv6 字面量形如 `[::1]:8080`：方括号即主机名，其余情形取 `host:port` 的 host 部分。
  if (authority.startsWith('[')) {
    return true;
  }
  const host = authority.split(':')[0] ?? '';
  return host.length > 0;
}

export const eventRegionSchema = z.enum(EVENT_REGIONS);

export const eventVerificationStatusSchema = z.enum(EVENT_VERIFICATION_STATUSES);

export const eventPhaseSchema = z.enum(EVENT_PHASES);

export const eventSourceUrlSchema = z
  .string()
  .min(1)
  .max(MAX_EVENT_SOURCE_URL_LENGTH)
  .refine(isHttpsEventSourceUrl, {
    message: '来源链接必须是 https URL（含主机名、不含用户名与密码、长度不超过 2048）',
  });

export const publicEventSchema = z
  .object({
    id: z.string().min(1).max(64),
    region: eventRegionSchema,
    title: z.string().min(1).max(MAX_EVENT_TITLE_LENGTH),
    description: z.string().max(MAX_EVENT_DESCRIPTION_LENGTH),
    startsAt: z.number().int(),
    endsAt: z.number().int(),
    /** 公共行一定有来源（NOT NULL）；缺来源的条目不属于「公共来源活动」。 */
    sourceUrl: eventSourceUrlSchema,
    sourceName: z.string().max(MAX_EVENT_SOURCE_NAME_LENGTH),
    verificationStatus: eventVerificationStatusSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type PublicEvent = z.infer<typeof publicEventSchema>;

export const publicEventListResponseSchema = z
  .object({
    events: z.array(publicEventSchema),
    /**
     * 服务端时间：客户端据此计算阶段，避免设备时钟偏差把「进行中」显示成「已结束」。
     * 这也让「同一次响应内的阶段判定」有一致的基准。
     */
    serverTimeMs: z.number().int().nonnegative(),
  })
  .strict();

export type PublicEventListResponse = z.infer<typeof publicEventListResponseSchema>;

export const eventCalendarItemSchema = z.object({
  id: z.string().min(1).max(300),
  region: z.literal('cn'),
  title: z.string().min(1).max(120),
  description: z.string().max(600),
  category: z.string().max(32),
  location: z.string().max(120),
  startsAt: z.number().int().nonnegative().nullable(),
  endsAt: z.number().int().nonnegative().nullable(),
  allDay: z.boolean(),
  sourceUrl: eventSourceUrlSchema.nullable(),
}).strict();

export type EventCalendarItem = z.infer<typeof eventCalendarItemSchema>;

export const eventCalendarResponseSchema = z.object({
  events: z.array(eventCalendarItemSchema).max(250),
  serverTimeMs: z.number().int().nonnegative(),
  source: z.object({
    name: z.string().min(1).max(80),
    homeUrl: eventSourceUrlSchema,
    checkedAtMs: z.number().int().nonnegative(),
    stale: z.boolean(),
  }).strict(),
}).strict();

export type EventCalendarResponse = z.infer<typeof eventCalendarResponseSchema>;
