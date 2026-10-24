/**
 * 活动契约（HUB-011 / ADR-0004 D8 · D9）——Worker 与前端**共用**。
 *
 * 定位：现行活动的纯函数/格式契约：只放**纯类型与纯函数**，
 * 无 DOM、无 D1、无 React、无网络。因此「什么算即将开始 / 进行中」「什么算合法区间」
 * 「区服怎么匹配」这三类判定在服务端校验、前端渲染与测试里是**同一份实现**，
 * 不会出现「前端这样显示、后端那样过滤」的漂移。
 *
 * 阶段 04 的显式边界（ADR-0004 D9，规划边界的显式记录，不是静默变更）：
 * - 本阶段只做**人工维护**的活动列表：真实用户输入、UTC 起止时间、来源链接、区服
 *   （cn / global）、过期逻辑与验证状态。
 * - **不做**抓取器 / 爬虫、**不做**鱼类计算、**不做**提醒调度，也不注册 Cron——这三项
 *   仍然留在阶段 05；因此这里没有任何「数据源 Adapter」「轮询」「通知计划」的形状。
 * - 「不捆绑未经核实的活动数据」：公共来源表 `events` 在阶段 04 是**空表**（零种子）。
 *   本文件提供的是**机制**（Schema + 纯函数），不是数据；界面必须诚实显示
 *   `EVENTS_MESSAGES.publicEmpty`，而不是编造活动填充列表。
 *
 * 事实来源：`migrations/0009_events.sql` 的表结构与 CHECK 约束。本文件的常量/枚举
 * 必须与之一致（尤其：区服**没有** `both`，与公共导航目录的 `CATALOG_REGIONS` 不同）。
 */
import { z } from 'zod';
import { operationIdSchema } from './operation-id';

// ---------------------------------------------------------------------------
// 常量（单一来源：Worker、前端与测试都从这里取值）
// ---------------------------------------------------------------------------

/** 模块 ID：内置**真实**模块（不再是 `demo.*` 名义）。注册表与公开目录共用它。 */
export const EVENTS_MODULE_ID = 'ff14.events';

/** Widget 类型 ID。与 `EVENTS_MODULE_MANIFEST.widgets[].id` 必须一致（有测试保证）。 */
export const EVENTS_WIDGET_IDS = {
  /** 活动时间表：即将开始 / 进行中。 */
  upcoming: 'events-upcoming',
  /** 活动维护：手工增删改个人活动。 */
  manage: 'events-manage',
  /** 国服来源日历：开始/结束倒计时及状态过滤。 */
  calendar: 'events-calendar',
} as const;

export type EventsWidgetId = (typeof EVENTS_WIDGET_IDS)[keyof typeof EVENTS_WIDGET_IDS];

/**
 * 合法区服。
 *
 * 为什么刻意**没有** `both`：活动是**分区服**的事实（规划 INV-08：国服与国际服不能混用规则）。
 * 与迁移 `0009_events.sql` 的 `CHECK (region IN ('cn', 'global'))` 完全一致。
 * 「通用活动」不是合法状态——宁可分别录两条，也不要一个含糊的 both；
 * 把它当成通配符会让「国服时间」被错误地展示给国际服用户。
 */
export const EVENT_REGIONS = ['cn', 'global'] as const;
export type EventRegion = (typeof EVENT_REGIONS)[number];

/** 标题长度上限（与迁移 CHECK 一致）。 */
export const MAX_EVENT_TITLE_LENGTH = 120;
/** 描述长度上限（与迁移 CHECK 一致）。 */
export const MAX_EVENT_DESCRIPTION_LENGTH = 1000;
/** 来源链接长度上限（与迁移 CHECK 一致；ADR-0004 D3 的 URL 策略）。 */
export const MAX_EVENT_SOURCE_URL_LENGTH = 2048;
/** 来源名称长度上限（与迁移 CHECK 一致）。 */
export const MAX_EVENT_SOURCE_NAME_LENGTH = 80;

/**
 * 验证状态。
 * 只有「已核对」与「未验证」两档：本阶段公共表为空，个人活动默认 `unverified`，
 * 界面必须**原样标注**，且绝不声称能给出准确提醒（ADR-0004 D9）。
 */
export const EVENT_VERIFICATION_STATUSES = ['verified', 'unverified'] as const;
export type EventVerificationStatus = (typeof EVENT_VERIFICATION_STATUSES)[number];

/** 活动阶段（由 `eventPhase` 推导，**不落库**：它是时间的函数，不是可独立写坏的字段）。 */
export const EVENT_PHASES = ['upcoming', 'active', 'ended'] as const;
export type EventPhase = (typeof EVENT_PHASES)[number];

/** `events-upcoming` Widget 的阶段筛选（多一个 `all`：它不是活动状态，而是「不筛」）。 */
export const EVENTS_UPCOMING_PHASE_FILTERS = ['upcoming', 'active', 'all'] as const;
export type EventsUpcomingPhaseFilter = (typeof EVENTS_UPCOMING_PHASE_FILTERS)[number];

/** 列表排序方式。`startsAtDesc` 用于「最新的排前面」的维护视图。 */
export const EVENT_SORT_ORDERS = ['startsAt', 'startsAtDesc'] as const;
export type EventSortOrder = (typeof EVENT_SORT_ORDERS)[number];

/**
 * 面向用户/界面的诚实文案（单一来源，避免各处各写一遍或越写越像承诺）。
 * 尤其 `publicEmpty`：公共表本阶段为空，界面必须显示它，**不得**用编造数据充数。
 */
export const EVENTS_MESSAGES = {
  /** 公共来源列表为空时的诚实说明（阶段 04 的正常状态，不是错误）。 */
  publicEmpty: '没有可验证的公共来源活动。',
  /** 未验证来源的可见标注。 */
  unverifiedBadge: '未验证来源',
  /** 边界说明：人工维护、不抓取、不提醒。 */
  manualOnly: '活动为人工维护；本阶段不抓取来源、不计算鱼类窗口、不发送提醒。',
  /** 已过期活动的标注（`eventPhase === 'ended'`）。 */
  endedBadge: '已结束',
} as const;

// ---------------------------------------------------------------------------
// 时间与区间的形状
// ---------------------------------------------------------------------------

/** 任何「有起止时间」的东西都能参与阶段判定（公共活动与个人活动都满足它）。 */
export interface EventTimeRange {
  /** UTC 毫秒。 */
  readonly startsAt: number;
  /** UTC 毫秒。 */
  readonly endsAt: number;
}

/** 可参与筛选的字段（标题/描述用于文本匹配，区服用于精确匹配）。 */
export interface EventSearchableFields extends EventTimeRange {
  readonly region: string;
  readonly title: string;
  readonly description: string;
}

export type EventRangeInvalidReason = 'ends_before_starts' | 'not_integer';

export type EventRangeValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: EventRangeInvalidReason };

/**
 * 区间合法性校验（**唯一实现**）。
 *
 * 两条规则，顺序固定（先判类型再判大小），这样「NaN」不会因为比较恒为 false
 * 而被误判成合法区间：
 * 1. 起止都必须是整数（UTC 毫秒；`NaN` / `Infinity` / `1.5` 一律 `not_integer`）；
 * 2. `endsAt >= startsAt`（零长度活动合法：恰好一瞬，不是错误）。
 *
 * 数据库层另有 `CHECK (ends_at >= starts_at)` 兜底，但服务层必须先用本函数给出
 * **结构化**错误（`reason` 可程序化处理），而不是把 SQL 约束冲突抛给用户。
 */
export function validateEventRange(range: EventTimeRange): EventRangeValidation {
  if (!Number.isInteger(range.startsAt) || !Number.isInteger(range.endsAt)) {
    return { ok: false, reason: 'not_integer' };
  }
  if (range.endsAt < range.startsAt) {
    return { ok: false, reason: 'ends_before_starts' };
  }
  return { ok: true };
}

/**
 * 活动阶段（**唯一实现**，唯一判定入口）。
 *
 * 边界是**包含**关系，写死如下：
 * - `startsAt > nowMs` → `upcoming`（严格早于开始时刻才算未开始）；
 * - `startsAt <= nowMs <= endsAt` → `active`（`nowMs === startsAt` 与 `nowMs === endsAt`
 *   都算进行中：开始的那一毫秒已经可见，结束的那一毫秒尚未过期）；
 * - 其余（`nowMs > endsAt`）→ `ended`。
 *
 * `nowMs` 不是有限数时**明确抛错**（而不是返回某个阶段）：
 * 阶段是「相对某个时刻」的事实，时钟坏了就没有正确答案；若悄悄回落到 `upcoming`，
 * 界面会把所有活动都显示成「即将开始」，那是伪造状态。调用方（路由/Widget）
 * 必须传入 `nowUtcMs()` 或 `serverTimeMs`，绝不能传 `NaN`。
 */
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

// ---------------------------------------------------------------------------
// 文本规范化（与 ADR-0004 D5 的导航搜索同规则：NFKC + 小写 + 折叠空白）
// ---------------------------------------------------------------------------

/**
 * 规范化用于匹配的文本：NFKC（统一全角/半角与兼容字符）+ 小写 + 折叠空白 + 去首尾空白。
 *
 * 为什么全角也要匹配：中文输入法下用户经常打出全角字母/数字（"ＡＣＴ"），
 * 不折叠的话「搜不到自己刚录的标题」。这条规则是筛选行为的唯一实现，
 * 服务端查询端点与前端 Widget 都调用它。
 */
export function normalizeEventText(raw: string): string {
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 筛选与排序（唯一实现：服务端查询端点与前端 Widget 共用）
// ---------------------------------------------------------------------------

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

/**
 * 按区服 / 阶段 / 关键字筛选活动（**唯一实现**）。
 *
 * 语义细节（都是刻意的）：
 * - 区服是**精确匹配**：`'both'` 之类的值不在 `EVENT_REGIONS` 内，此时结果为空数组，
 *   绝不退化成「两个区服都返回」的隐式通配——那正是 INV-08 禁止的混用。
 * - 关键字按 `normalizeEventText` 规范化后**按空白分词**，每个词都必须出现在
 *   「标题 + 描述」里（AND）。多词是「收窄」，不是「任一命中」。
 * - 阶段过滤**调用 `eventPhase`**（同一实现），因此列表显示与筛选不可能各判各的。
 *
 * 不改变入参顺序（排序是 `sortEvents` 的职责）；返回新数组。
 */
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

/** 数值升序比较（不用减法：避免大时间戳相减时的精度损失）。 */
function compareNumbers(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** 字符串按 UTF-16 码元比较：**与 locale 无关**，因此跨设备/跨运行结果完全一致。 */
function compareIds(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * 按开始时间排序（**确定性**）。
 *
 * - `'startsAt'` 升序（即将开始在前），`'startsAtDesc'` 降序（最新在前）；
 * - 同一开始时间的并列项用 **id 升序**兜底，且这一兜底**不随排序方向翻转**：
 *   否则 `desc` 只是 `asc` 的反转，两次调用（服务端一次、前端一次）在并列项上
 *   仍可能给出不同顺序，用户会看到列表「自己抖动」。
 * - 返回**新数组**，不原地修改入参（入参可能来自 React 状态或缓存）。
 */
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

// ---------------------------------------------------------------------------
// 来源链接安全（ADR-0004 D3：服务端只接受 https）
// ---------------------------------------------------------------------------

/** 协议前缀：`https:` 大小写不敏感（RFC 3986 里 scheme 不区分大小写）。 */
const HTTPS_SCHEME_PATTERN = /^https:\/\//i;

/**
 * 是否含控制字符或空白（空格、换行、制表符、DEL）。
 *
 * 为什么不用正则：`no-control-regex` 明确禁止把控制字符写进正则字面量
 * （可读性差且容易看错区间边界）。逐码元判断既准确又不需要禁用规则豁免。
 * 原始 URL 里出现这些字符通常是拼接错误或注入尝试（例如把 `\n` 塞进头字段）。
 */
function hasControlOrSpace(raw: string): boolean {
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * 是否是允许的**活动来源**链接（唯一判定）。
 *
 * 与 ADR-0004 D3 的导航 URL 策略同一条底线：只接受 `https:`、必须有主机名、
 * 不得包含用户名/密码（`user@host`）、长度不超过 2048，并拒绝任何控制字符/空白。
 * 刻意**没有** http 例外：将来若确有理由放行，必须逐条写进 ADR，不允许在代码里放宽。
 *
 * 这里只做保守的「前缀 + authority」检查而**不使用** `URL`（shared 层不引入运行时全局，
 * 见 `index.ts` 的定位说明）；服务端在真正解析 URL 的路径上必须再用平台 `URL` 复核一次。
 * 另：阶段 04 **没有**主动探测，来源链接绝不会进入服务端 fetch，因此不存在 SSRF 入口
 * （ADR-0004 D3 / D12）。
 */
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** 区服（无 `both`）。 */
export const eventRegionSchema = z.enum(EVENT_REGIONS);
/** 验证状态。 */
export const eventVerificationStatusSchema = z.enum(EVENT_VERIFICATION_STATUSES);
/** 活动阶段。 */
export const eventPhaseSchema = z.enum(EVENT_PHASES);

/**
 * 来源链接：只允许 https（`isHttpsEventSourceUrl` 是唯一判定）。
 * 个人活动可以**整体省略或为 null**（用户自记的活动可能没有来源链接）；
 * 公共表 `events` 的 `source_url` 是 NOT NULL，因此公共 Schema 里它是必填。
 */
export const eventSourceUrlSchema = z
  .string()
  .min(1)
  .max(MAX_EVENT_SOURCE_URL_LENGTH)
  .refine(isHttpsEventSourceUrl, {
    message: '来源链接必须是 https URL（含主机名、不含用户名与密码、长度不超过 2048）',
  });

/** 公共来源活动（`events` 表，全局只读参考数据；**不含** workspace_id）。 */
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

/**
 * 个人活动（`workspace_events` 表，工作空间私有）。
 *
 * 字段取舍的「为什么」：
 * - **不含** `workspaceId`：作用域由认证决定（ADR-0002 / D2），响应里重复携带它只会
 *   给「拿 A 工作空间的行配 B 的凭证」制造混淆空间；
 * - **不含** `createdByDevice`：设备级标识不是这个 UI 需要的信息，少暴露一个关联面；
 * - `deletedAt` / `revision` 必须对外可见：前者让客户端按墓碑删除（跨设备同步，D7），
 *   后者是并发写入的乐观锁（`expectedRevision`）。
 */
export const workspaceEventSchema = z
  .object({
    id: z.string().min(1).max(64),
    region: eventRegionSchema,
    title: z.string().min(1).max(MAX_EVENT_TITLE_LENGTH),
    description: z.string().max(MAX_EVENT_DESCRIPTION_LENGTH),
    startsAt: z.number().int(),
    endsAt: z.number().int(),
    /** 可为 null：用户自记的活动可能没有来源链接；一旦填写就必须是 https。 */
    sourceUrl: eventSourceUrlSchema.nullable(),
    verificationStatus: eventVerificationStatusSchema,
    revision: z.number().int().nonnegative(),
    /** 非 null 即墓碑：同步以 `op: 'delete'` 传播，不做硬删除（ADR-0004 D7）。 */
    deletedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

/**
 * 新建个人活动。
 *
 * `verificationStatus` 可省略（服务端默认 `unverified`）：用户自述的来源**不构成证据**，
 * 前端不得据此显示「已核实」；本阶段没有公共写入路径，因此 `verified` 事实上不可达。
 */
export const createWorkspaceEventRequestSchema = z
  .object({
    title: z.string().min(1).max(MAX_EVENT_TITLE_LENGTH),
    description: z.string().max(MAX_EVENT_DESCRIPTION_LENGTH).optional(),
    region: eventRegionSchema,
    startsAt: z.number().int(),
    endsAt: z.number().int(),
    sourceUrl: eventSourceUrlSchema.nullable().optional(),
    verificationStatus: eventVerificationStatusSchema.optional(),
    operationId: operationIdSchema,
  })
  .strict()
  .refine((value) => validateEventRange(value).ok, {
    message: '起止时间必须是整数且 endsAt 不早于 startsAt',
    path: ['endsAt'],
  });

export type CreateWorkspaceEventRequest = z.infer<typeof createWorkspaceEventRequestSchema>;

/**
 * 更新个人活动：`expectedRevision` + `operationId` 必填。
 * 前者防静默覆盖（CAS），后者保证「同一操作 ID 重试」不会重复施加副作用（ADR-0004 D11）。
 */
export const updateWorkspaceEventRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    title: z.string().min(1).max(MAX_EVENT_TITLE_LENGTH).optional(),
    description: z.string().max(MAX_EVENT_DESCRIPTION_LENGTH).optional(),
    region: eventRegionSchema.optional(),
    startsAt: z.number().int().optional(),
    endsAt: z.number().int().optional(),
    sourceUrl: eventSourceUrlSchema.nullable().optional(),
    verificationStatus: eventVerificationStatusSchema.optional(),
    operationId: operationIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.region !== undefined ||
      value.startsAt !== undefined ||
      value.endsAt !== undefined ||
      value.sourceUrl !== undefined ||
      value.verificationStatus !== undefined,
    { message: '至少需要提供一个待修改字段' },
  )
  .refine(
    // 只改其中一个端点时无法在这里判完整区间（另一半在库里），但两个都给出时必须合法；
    // 服务端落库前仍会调用 `validateEventRange` 对最终区间复核一次。
    (value) => value.startsAt === undefined || value.endsAt === undefined || value.endsAt >= value.startsAt,
    { message: 'endsAt 不早于 startsAt', path: ['endsAt'] },
  );

export type UpdateWorkspaceEventRequest = z.infer<typeof updateWorkspaceEventRequestSchema>;

/** 删除个人活动（墓碑）：同样是 CAS + 幂等。 */
export const deleteWorkspaceEventRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    operationId: operationIdSchema,
  })
  .strict();

export type DeleteWorkspaceEventRequest = z.infer<typeof deleteWorkspaceEventRequestSchema>;

/** 公共活动列表响应（`GET /api/v1/events`，匿名只读）。 */
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

/** 国服官方活动公告的展示契约：时间允许缺失，绝不把发布日期伪装成起止时间。 */
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

export const EVENTS_CALENDAR_CONFIG_VERSION = 1;
export const eventsCalendarConfigSchema = z.object({
  title: z.string().min(1).max(40).default('国服活动日历'),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export type EventsCalendarConfig = z.infer<typeof eventsCalendarConfigSchema>;

/** 个人活动列表响应（`GET /api/v1/me/events`，设备鉴权）。 */
export const eventListResponseSchema = z
  .object({
    events: z.array(workspaceEventSchema),
    serverTimeMs: z.number().int().nonnegative(),
  })
  .strict();

export type EventListResponse = z.infer<typeof eventListResponseSchema>;

// ---------------------------------------------------------------------------
// Widget 配置契约
// ---------------------------------------------------------------------------

/** Widget 配置 Schema 版本（必须与 Manifest 中同名 Widget 的 `configSchemaVersion` 一致）。 */
export const EVENTS_UPCOMING_CONFIG_VERSION = 1;
export const EVENTS_MANAGE_CONFIG_VERSION = 1;

/** `events-upcoming`：活动时间表的展示偏好（不写入任何业务数据）。 */
export const eventsUpcomingConfigSchema = z
  .object({
    title: z.string().min(1).max(40).default('活动'),
    /** `null` = 国服与国际服都显示；**不是** `'both'`（区服值域里没有它）。 */
    region: z.enum(EVENT_REGIONS).nullable().default(null),
    phase: z.enum(EVENTS_UPCOMING_PHASE_FILTERS).default('upcoming'),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export type EventsUpcomingConfig = z.infer<typeof eventsUpcomingConfigSchema>;

/** `events-manage`：手工维护视图的展示偏好。 */
export const eventsManageConfigSchema = z
  .object({
    title: z.string().min(1).max(40).default('活动维护'),
    region: z.enum(EVENT_REGIONS).nullable().default(null),
  })
  .strict();

export type EventsManageConfig = z.infer<typeof eventsManageConfigSchema>;
