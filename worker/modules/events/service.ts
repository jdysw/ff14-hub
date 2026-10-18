/**
 * 个人活动服务（HUB-011 / ADR-0004 D9 · D11）。
 *
 * 定位与边界：
 * - 只做**人工维护的活动列表**：真实用户输入、UTC 起止时间、来源链接、区服（cn / global）、
 *   过期逻辑与验证状态。**不做**抓取器、不做鱼类计算、不做提醒调度、不注册 Cron
 *   （ADR-0004 D9 / D12 的显式边界，不是遗漏）。
 * - 公共来源活动（`events`，只读）与个人活动（`workspace_events`，工作空间私有）**分表**：
 *   本服务的 `listPublic` 只读公共表，个人行**永不**进入公共响应。
 * - 所有作用域只来自认证得到的 `workspaceId`；函数签名里没有「客户端提交的 workspace」。
 * - 所有写入经 `runIdempotentWrite`（ledger 唯一实现）：认领 + attempt_token 守卫 +
 *   请求指纹 + 原子 batch，任何约束冲突整体回滚（ADR-0004 D11）。
 *
 * 为什么筛选/排序/区间判定全部调用共享纯函数（`filterEvents` / `sortEvents` /
 * `validateEventRange` / `eventSourceUrlSchema`）：这三类判定同时存在于服务端与前端 Widget，
 * 各写一份必然漂移，而漂移的表现是「后端过滤掉了前端显示的活动」这类无法解释的差异（ADR-0004 D5）。
 */
import {
  EVENT_REGIONS,
  EVENT_VERIFICATION_STATUSES,
  MAX_EVENT_DESCRIPTION_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  eventSourceUrlSchema,
  filterEvents,
  operationIdSchema,
  sortEvents,
  validateEventRange,
  type EventListResponse,
  type EventPhase,
  type EventRegion,
  type EventSortOrder,
  type EventVerificationStatus,
  type PublicEvent,
  type PublicEventListResponse,
  type WorkspaceEvent,
} from '@ff14-hub/shared';
import { newId } from '../../lib/util';
import { describeIssues } from '../../lib/zod-issues';
import {
  EVENT_OP_KINDS,
  eventFailure,
  fingerprintOf,
  guardedStatements,
  readEventReplay,
  runIdempotentWrite,
  type EventFailure,
  type EventResult,
  type IdempotencyGuard,
} from './tx';

/**
 * 每个工作空间的个人活动**活跃行**上限。
 *
 * 为什么需要一个上限而不是无限增长：个人活动是用户自述数据，没有外部来源约束，
 * 客户端可以在一秒内提交成千上万条；没有上限就等于把「无界写入」暴露给单个设备凭证
 * （既是配额问题，也是容量问题）。上限取值 200 的理由：足够覆盖一个玩家「近期要参加的活动」
 * 这一真实用途（同时明确不做任何归档/GC——超限时**冲突**，由用户删除旧活动，
 * 绝不静默丢弃本次提交，也不偷偷删除别的东西）。
 */
export const MAX_PERSONAL_EVENTS_PER_WORKSPACE = 200;

/** 活跃行计数片段（认领前置条件与 explain 共用同一份 SQL，避免两处口径漂移）。 */
const SQL_COUNT_ACTIVE_EVENTS =
  '(SELECT COUNT(*) FROM workspace_events WHERE workspace_id = ? AND deleted_at IS NULL)';

const PUBLIC_EVENT_COLUMNS =
  'id, region, title, description, starts_at, ends_at, source_url, source_name, ' +
  'verification_status, created_at, updated_at';

const WORKSPACE_EVENT_COLUMNS =
  'id, workspace_id, title, description, region, starts_at, ends_at, source_url, ' +
  'verification_status, revision, deleted_at, created_at, updated_at';

/** 公共表一行（`migrations/0009_events.sql` 的列形状）。 */
interface PublicEventRow {
  readonly id: string;
  /**
   * 声明为 `EventRegion` 而不是 `string`：数据库 CHECK 只允许 cn / global，
   * 且 `filterEvents` 的区服语义依赖这个值域（`'both'` 不是通配符）。
   */
  readonly region: EventRegion;
  readonly title: string;
  readonly description: string;
  readonly starts_at: number;
  readonly ends_at: number;
  readonly source_url: string;
  readonly source_name: string;
  readonly verification_status: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** 个人表一行（可含墓碑；业务读一律带 `deleted_at IS NULL`）。 */
interface WorkspaceEventRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly description: string;
  readonly region: EventRegion;
  readonly starts_at: number;
  readonly ends_at: number;
  readonly source_url: string | null;
  readonly verification_status: string;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** 尚未加守卫的语句（守卫由 `guardedStatements` 统一追加，绑定顺序不会写错）。 */
interface Statement {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

/** 收窄后的可写字段（区服已确认在值域内，来源链接已通过共享 Schema）。 */
interface ValidatedEventFields {
  readonly title: string;
  readonly description: string;
  readonly region: EventRegion;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly sourceUrl: string | null;
}

/**
 * revision 冲突的结构化细节（ADR-0004 D7 / D11：不盲目覆盖，让客户端能程序化处理）。
 *
 * 只放**可安全回显**的内容：实体类型与 ID、字段（整体冲突时为 null）、
 * 客户端基数与服务端当前 revision、可选处理方式。不放凭证、SQL、内部路径。
 */
export interface RevisionConflictDetails {
  readonly reason: 'revision_conflict';
  readonly entityType: 'workspace_event';
  readonly entityId: string;
  readonly field: null;
  readonly baseRevision: number;
  readonly currentRevision: number;
  readonly resolutionOptions: readonly ('local' | 'server')[];
}

export interface CreatePersonalEventInput {
  readonly title: string;
  readonly description?: string;
  readonly region: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly sourceUrl?: string | null;
  readonly verificationStatus?: string;
}

export interface UpdatePersonalEventPatch {
  readonly title?: string;
  readonly description?: string;
  readonly region?: string;
  readonly startsAt?: number;
  readonly endsAt?: number;
  readonly sourceUrl?: string | null;
  readonly verificationStatus?: string;
}

export interface PublicEventListInput {
  readonly region?: EventRegion | null;
  readonly phase?: EventPhase | null;
  readonly text?: string | null;
  /** 阶段判定的「现在」（UTC 毫秒）。用于阶段筛选与 `serverTimeMs`，两者必须同一基准。 */
  readonly nowMs: number;
  readonly sort?: EventSortOrder;
}

export interface PersonalEventListInput {
  readonly region?: EventRegion | null;
  readonly phase?: EventPhase | null;
  readonly text?: string | null;
  readonly nowMs: number;
}

export interface PersonalEventCreateInput {
  readonly workspaceId: string;
  /** 创建行的 `created_by_device`（设备被删除时置空，活动本身保留）。 */
  readonly deviceId: string;
  readonly input: CreatePersonalEventInput;
  readonly operationId: string;
}

export interface PersonalEventUpdateInput {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly expectedRevision: number;
  readonly patch: UpdatePersonalEventPatch;
  readonly operationId: string;
}

export interface PersonalEventDeleteInput {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly expectedRevision: number;
  readonly operationId: string;
}

export interface EventServiceDeps {
  readonly db: D1Database;
  /** 可注入时钟，便于测试确定性时间戳。 */
  readonly now?: () => number;
}

export interface EventService {
  /** 公共来源活动列表（匿名可读；只读 `events`，个人行永不出现）。 */
  listPublic(input: PublicEventListInput): Promise<PublicEventListResponse>;
  /** 本工作空间的个人活动列表（只含未删除行）。 */
  listPersonal(workspaceId: string, input: PersonalEventListInput): Promise<EventListResponse>;
  /** 读取单条**活跃**个人活动（用于回读与精确报错；墓碑视为不存在）。 */
  readPersonal(workspaceId: string, eventId: string): Promise<WorkspaceEvent | null>;
  createPersonal(input: PersonalEventCreateInput): Promise<EventResult<{ readonly event: WorkspaceEvent }>>;
  updatePersonal(input: PersonalEventUpdateInput): Promise<EventResult<{ readonly event: WorkspaceEvent }>>;
  /** 墓碑化：不硬删，`deleted_at` 跨设备同步（ADR-0004 D7）。 */
  deletePersonal(input: PersonalEventDeleteInput): Promise<EventResult<{ readonly event: WorkspaceEvent }>>;
}

/** 区服类型守卫（真正的收窄：值域来自共享常量，与迁移 CHECK 一致）。 */
function isEventRegion(value: string): value is EventRegion {
  return (EVENT_REGIONS as readonly string[]).includes(value);
}

/** 验证状态类型守卫。 */
function isEventVerificationStatus(value: string): value is EventVerificationStatus {
  return (EVENT_VERIFICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * 无法识别的验证状态一律**降级为 `unverified`**（而不是原样返回）：
 * 数据库 CHECK 保证这不可达，但万一出现（人工改库/将来放宽值域），
 * 宁可显示「未验证」，也绝不把未知状态渲染成「已核对」。
 */
function verificationStatusOf(raw: string): EventVerificationStatus {
  return isEventVerificationStatus(raw) ? raw : 'unverified';
}

/**
 * 来源链接归一化：`undefined` / `null` / 空串都表示「没有来源链接」。
 *
 * 为什么空串要归一化成 NULL：`workspace_events.source_url` 的 CHECK 是
 * 「NULL 或长度 1–2048」，空串会直接违反约束。把「没填」写成 NULL 才是数据的本意，
 * 也避免把一次输入瑕疵变成 500。
 */
function normalizeSourceUrl(raw: string | null | undefined): string | null {
  return raw === undefined || raw === null || raw.length === 0 ? null : raw;
}

function toPublicEvent(row: PublicEventRow): PublicEvent {
  return {
    id: row.id,
    region: row.region,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    sourceUrl: row.source_url,
    sourceName: row.source_name,
    verificationStatus: verificationStatusOf(row.verification_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkspaceEvent(row: WorkspaceEventRow): WorkspaceEvent {
  return {
    id: row.id,
    region: row.region,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    // 空串同样归一化为 null（CHECK 已禁止，这里是防御性归一，不是可写的状态）。
    sourceUrl: normalizeSourceUrl(row.source_url),
    verificationStatus: verificationStatusOf(row.verification_status),
    revision: row.revision,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 校验并归一化一条活动的全部可写字段。
 *
 * 为什么服务层还要再校验一遍（路由已经用共享 Schema 校验过）：
 * 服务层是**权威校验点**。直连服务的调用（测试、将来的内部调用）不能因为「路由保证过」
 * 就把非法值写进数据库——那时数据库 CHECK 会让整个 batch 失败，客户端拿到 500
 * 而不是可解释的 422。这里先用共享纯函数给出**结构化**判定，数据库 CHECK 只作兜底。
 */
function validateEventFields(fields: {
  readonly title: string;
  readonly description: string;
  readonly region: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly sourceUrl: string | null | undefined;
}): ValidationOutcome<ValidatedEventFields> {
  if (fields.title.length === 0 || fields.title.length > MAX_EVENT_TITLE_LENGTH) {
    return { ok: false, detail: `标题长度必须在 1–${MAX_EVENT_TITLE_LENGTH} 之间` };
  }
  if (fields.description.length > MAX_EVENT_DESCRIPTION_LENGTH) {
    return { ok: false, detail: `描述长度不能超过 ${MAX_EVENT_DESCRIPTION_LENGTH}` };
  }
  if (!isEventRegion(fields.region)) {
    // 刻意没有 'both'：活动是分区服的事实（INV-08），含糊的 both 会让国服时间被展示给国际服用户。
    return { ok: false, detail: '区服必须是 cn 或 global（活动是分区服的事实，没有 both）' };
  }
  const range = validateEventRange({ startsAt: fields.startsAt, endsAt: fields.endsAt });
  if (!range.ok) {
    return {
      ok: false,
      detail: range.reason === 'not_integer' ? '起止时间必须是整数 UTC 毫秒' : '结束时间不能早于开始时间',
    };
  }
  const sourceUrl = normalizeSourceUrl(fields.sourceUrl);
  if (sourceUrl !== null) {
    // 共享 Schema 是 URL 策略的唯一判定（只接受 https、必须有主机名、不含用户名/密码）。
    const parsedUrl = eventSourceUrlSchema.safeParse(sourceUrl);
    if (!parsedUrl.success) {
      return { ok: false, detail: `来源链接不合法（${describeIssues(parsedUrl.error.issues)}）` };
    }
    return {
      ok: true,
      value: {
        title: fields.title,
        description: fields.description,
        region: fields.region,
        startsAt: fields.startsAt,
        endsAt: fields.endsAt,
        sourceUrl: parsedUrl.data,
      },
    };
  }
  return {
    ok: true,
    value: {
      title: fields.title,
      description: fields.description,
      region: fields.region,
      startsAt: fields.startsAt,
      endsAt: fields.endsAt,
      sourceUrl: null,
    },
  };
}

function validateOperationId(operationId: string): ValidationOutcome<string> {
  const parsed = operationIdSchema.safeParse(operationId);
  if (!parsed.success) {
    return { ok: false, detail: `operationId 不合法（${describeIssues(parsed.error.issues)}）` };
  }
  return { ok: true, value: parsed.data };
}

/** `expectedRevision` 必须是非负整数（否则 CAS 条件永远不成立，报错会含糊）。 */
function validateExpectedRevision(expectedRevision: number): ValidationOutcome<number> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, detail: 'expectedRevision 必须是非负整数' };
  }
  return { ok: true, value: expectedRevision };
}

/** 把补丁合并到当前行，并校验**最终**落库值（区间必须是合并后的完整区间）。 */
function mergePatch(
  current: WorkspaceEvent,
  patch: UpdatePersonalEventPatch,
): ValidationOutcome<ValidatedEventFields> {
  const hasAnyField =
    patch.title !== undefined ||
    patch.description !== undefined ||
    patch.region !== undefined ||
    patch.startsAt !== undefined ||
    patch.endsAt !== undefined ||
    patch.sourceUrl !== undefined ||
    patch.verificationStatus !== undefined;
  if (!hasAnyField) {
    return { ok: false, detail: '至少需要提供一个待修改字段' };
  }
  return validateEventFields({
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    region: patch.region ?? current.region,
    startsAt: patch.startsAt ?? current.startsAt,
    endsAt: patch.endsAt ?? current.endsAt,
    sourceUrl: patch.sourceUrl === undefined ? current.sourceUrl : patch.sourceUrl,
  });
}

const REVISION_CONFLICT_DETAIL = '该活动已被其他设备修改，请重新读取后再提交。';

/** 构造结构化 revision 冲突（客户端可据此选择「用本地覆盖 / 用服务端」）。 */
function revisionConflict(input: {
  readonly eventId: string;
  readonly baseRevision: number;
  readonly currentRevision: number;
}): EventFailure {
  const details: RevisionConflictDetails = {
    reason: 'revision_conflict',
    entityType: 'workspace_event',
    entityId: input.eventId,
    field: null,
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    resolutionOptions: ['local', 'server'],
  };
  return eventFailure('revision_conflict', REVISION_CONFLICT_DETAIL, details);
}

/**
 * 插入个人活动的语句。
 *
 * `verification_status` 用**字面量** `'unverified'` 而不是绑定参数：
 * 让「用户自述来源永不为 verified」成为结构上不可违反的事实——
 * 连构造这条语句的调用方都没有办法把 `verified` 传进来。
 */
function insertEventStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly fields: ValidatedEventFields;
  readonly now: number;
}): Statement {
  return {
    sql: `INSERT INTO workspace_events
            (id, workspace_id, title, description, region, starts_at, ends_at, source_url,
             verification_status, revision, deleted_at, created_at, updated_at, created_by_device)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', 0, NULL, ?, ?, ?
           WHERE 1 = 1`,
    binds: [
      input.id,
      input.workspaceId,
      input.fields.title,
      input.fields.description,
      input.fields.region,
      input.fields.startsAt,
      input.fields.endsAt,
      input.fields.sourceUrl,
      input.now,
      input.now,
      input.deviceId,
    ],
  };
}

/** 条件更新（CAS）：`revision` 不匹配即影响 0 行，绝不盲目覆盖。 */
function updateEventStatement(input: {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly fields: ValidatedEventFields;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workspace_events
             SET title = ?, description = ?, region = ?, starts_at = ?, ends_at = ?, source_url = ?,
                 verification_status = 'unverified', revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [
      input.fields.title,
      input.fields.description,
      input.fields.region,
      input.fields.startsAt,
      input.fields.endsAt,
      input.fields.sourceUrl,
      input.now,
      input.eventId,
      input.workspaceId,
      input.expectedRevision,
    ],
  };
}

/**
 * 墓碑化（**不硬删**）：`deleted_at` 让删除跨设备同步（ADR-0004 D7），
 * 且 `revision` 同样 +1，因此墓碑也是一次可 CAS 的写入。
 */
function tombstoneEventStatement(input: {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workspace_events
             SET deleted_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [input.now, input.now, input.eventId, input.workspaceId, input.expectedRevision],
  };
}

export function createEventService(deps: EventServiceDeps): EventService {
  const db = deps.db;
  const now = deps.now ?? ((): number => Date.now());

  /** 统一的写入入口：组装认领语句、构造带守卫的变更语句、执行原子幂等事务。 */
  function runOperation<T>(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    readonly requestFingerprint: string;
    readonly preconditionSql: string;
    readonly preconditionBinds: readonly unknown[];
    readonly build: () => readonly Statement[];
    readonly result: T;
    readonly explain: () => Promise<EventFailure | null>;
  }): Promise<EventResult<T>> {
    return runIdempotentWrite<T>({
      db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: input.requestFingerprint,
      now: now(),
      preconditionSql: input.preconditionSql,
      preconditionBinds: input.preconditionBinds,
      buildStatements: (guard: IdempotencyGuard) => guardedStatements(db, guard, input.build()),
      result: input.result,
      explain: input.explain,
    });
  }

  /**
   * 幂等入口守卫：先算本次意图的指纹，再看是否已有同 ID 的成功记录。
   *
   * 两件事必须成对出现——只查 ID 不查指纹会把「同 ID 换 body/换目标」当重放放行；
   * 只算指纹不先短路会让「响应丢失后原样重试」被前置条件早退成 409。
   *
   * 指纹覆盖「目标 ID + 动作 + 正文 + expectedRevision」（ADR-0004 D11）：
   * 同一 operationId 只要其中任何一项不同，就必须 409 且零写入。
   */
  async function replayGuard<T>(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    /** 参与指纹的**请求意图**（目标 ID / 正文 / expectedRevision），不含服务端观察到的状态。 */
    readonly intent: unknown;
  }): Promise<{ readonly fingerprint: string; readonly replay: EventResult<T> | null }> {
    const fingerprint = await fingerprintOf(input.kind, input.intent);
    const replay = await readEventReplay<T>({
      db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: fingerprint,
    });
    return { fingerprint, replay };
  }

  /** 本工作空间当前活跃（未删除）个人活动数。 */
  async function countActiveEvents(workspaceId: string): Promise<number> {
    const row = await db
      .prepare(`SELECT ${SQL_COUNT_ACTIVE_EVENTS} AS count`)
      .bind(workspaceId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  /** 只读**活跃**行的单条读取（墓碑视为不存在：越权与已删除都不泄露存在性）。 */
  async function readActiveRow(workspaceId: string, eventId: string): Promise<WorkspaceEvent | null> {
    const row = await db
      .prepare(`SELECT ${WORKSPACE_EVENT_COLUMNS} FROM workspace_events WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
      .bind(eventId, workspaceId)
      .first<WorkspaceEventRow>();
    return row === null ? null : toWorkspaceEvent(row);
  }

  return {
    /**
     * 公共来源活动列表。
     *
     * 刻意把「取行」与「筛选/排序」分开：SQL 只做「读公共表」这一件事，
     * 区服 / 阶段 / 关键字筛选与排序一律走共享纯函数（D5 的唯一实现）。
     * 本阶段公共表为空表、个人表有 200 条上限，因此不存在无界扫描。
     */
    async listPublic(input) {
      const result = await db
        .prepare(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events`)
        .all<PublicEventRow>();
      const all = result.results.map(toPublicEvent);
      const filtered = filterEvents(all, {
        region: input.region ?? null,
        phase: input.phase ?? null,
        text: input.text ?? null,
        nowMs: input.nowMs,
      });
      const events = sortEvents(filtered, input.sort ?? 'startsAt');
      // 形状由共享契约约束（严格 Schema）：只有 events / serverTimeMs 两个键，
      // serverTimeMs 与阶段判定用的是同一个 nowMs（否则前端复算会与筛选结果不一致）。
      const body: PublicEventListResponse = { events, serverTimeMs: input.nowMs };
      return body;
    },

    /**
     * 个人活动列表：SQL 只做「本工作空间 + 未删除」这一层作用域（越权与墓碑在 SQL 层），
     * 关键字 / 区服 / 阶段的筛选与排序同样调用共享纯函数，因此与前端 Widget 不会漂移。
     */
    async listPersonal(workspaceId, input) {
      const result = await db
        .prepare(`SELECT ${WORKSPACE_EVENT_COLUMNS} FROM workspace_events WHERE workspace_id = ? AND deleted_at IS NULL`)
        .bind(workspaceId)
        .all<WorkspaceEventRow>();
      const all = result.results.map(toWorkspaceEvent);
      const filtered = filterEvents(all, {
        region: input.region ?? null,
        phase: input.phase ?? null,
        text: input.text ?? null,
        nowMs: input.nowMs,
      });
      const body: EventListResponse = { events: sortEvents(filtered, 'startsAt'), serverTimeMs: input.nowMs };
      return body;
    },

    readPersonal(workspaceId, eventId) {
      return readActiveRow(workspaceId, eventId);
    },

    async createPersonal(input) {
      const operationId = validateOperationId(input.operationId);
      if (!operationId.ok) {
        return eventFailure('invalid_input', operationId.detail);
      }
      const fields = validateEventFields({
        title: input.input.title,
        description: input.input.description ?? '',
        region: input.input.region,
        startsAt: input.input.startsAt,
        endsAt: input.input.endsAt,
        sourceUrl: input.input.sourceUrl,
      });
      if (!fields.ok) {
        return eventFailure('invalid_input', fields.detail);
      }

      // 指纹里的 `description` / `sourceUrl` 是**归一化后的有效值**：
      // 「省略 description」与「显式 description: ''」对数据库是同一件事，
      // 不应因为客户端多写一个空串就把一次重试判成意图变更。
      // `verificationStatus` 保留客户端声明值（不归一化成服务端强制值）：
      // 若先归一化，『同一 operationId 先声明 verified 再声明 unverified』会被当成重放，
      // 等于把一次意图变更静默吞掉。
      const guard = await replayGuard<{ readonly event: WorkspaceEvent }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: EVENT_OP_KINDS.create,
        intent: {
          title: fields.value.title,
          description: fields.value.description,
          region: fields.value.region,
          startsAt: fields.value.startsAt,
          endsAt: fields.value.endsAt,
          sourceUrl: fields.value.sourceUrl,
          verificationStatus: input.input.verificationStatus ?? null,
        },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }

      const timestamp = now();
      // 行 ID 在**幂等短路之后**生成：它是服务端随机值，不属于客户端请求意图，
      // 因此不能进指纹（否则每次重试的指纹都不同，重放永远命中不了首次结果）。
      const eventId = newId();
      const event: WorkspaceEvent = {
        id: eventId,
        region: fields.value.region,
        title: fields.value.title,
        description: fields.value.description,
        startsAt: fields.value.startsAt,
        endsAt: fields.value.endsAt,
        sourceUrl: fields.value.sourceUrl,
        // 用户自述来源**永不**自动变成 verified（ADR-0004 D9）。
        verificationStatus: 'unverified',
        revision: 0,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return await runOperation<{ readonly event: WorkspaceEvent }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: EVENT_OP_KINDS.create,
        requestFingerprint: guard.fingerprint,
        // 上限是**认领的前置条件**：并发创建也不可能越过它（不是「先查再写」的时间窗判断）。
        preconditionSql: `${SQL_COUNT_ACTIVE_EVENTS} < ?`,
        preconditionBinds: [input.workspaceId, MAX_PERSONAL_EVENTS_PER_WORKSPACE],
        build: () => [
          insertEventStatement({
            id: eventId,
            workspaceId: input.workspaceId,
            deviceId: input.deviceId,
            fields: fields.value,
            now: timestamp,
          }),
        ],
        result: { event },
        explain: async () => {
          const count = await countActiveEvents(input.workspaceId);
          if (count >= MAX_PERSONAL_EVENTS_PER_WORKSPACE) {
            return eventFailure(
              'event_limit_reached',
              `每个工作空间最多 ${MAX_PERSONAL_EVENTS_PER_WORKSPACE} 条个人活动；请先删除不再需要的活动（本次提交未被接受，也没有丢弃任何数据）。`,
            );
          }
          return eventFailure('persist_failed', '创建活动的认领失败，且无法解释原因');
        },
      });
    },

    async updatePersonal(input) {
      const operationId = validateOperationId(input.operationId);
      if (!operationId.ok) {
        return eventFailure('invalid_input', operationId.detail);
      }
      const expectedRevision = validateExpectedRevision(input.expectedRevision);
      if (!expectedRevision.ok) {
        return eventFailure('invalid_input', expectedRevision.detail);
      }

      // 指纹必须来自**请求意图**（补丁本身），而不是合并后的值：合并需要先读当前行，
      // 而读取必须发生在幂等短路之后（否则重试会被 CAS 早退成 409）。
      const guard = await replayGuard<{ readonly event: WorkspaceEvent }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: EVENT_OP_KINDS.update,
        intent: {
          eventId: input.eventId,
          expectedRevision: expectedRevision.value,
          ...(input.patch.title === undefined ? {} : { title: input.patch.title }),
          ...(input.patch.description === undefined ? {} : { description: input.patch.description }),
          ...(input.patch.region === undefined ? {} : { region: input.patch.region }),
          ...(input.patch.startsAt === undefined ? {} : { startsAt: input.patch.startsAt }),
          ...(input.patch.endsAt === undefined ? {} : { endsAt: input.patch.endsAt }),
          ...(input.patch.sourceUrl === undefined ? {} : { sourceUrl: input.patch.sourceUrl }),
          ...(input.patch.verificationStatus === undefined
            ? {}
            : { verificationStatus: input.patch.verificationStatus }),
        },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }

      const current = await readActiveRow(input.workspaceId, input.eventId);
      if (current === null) {
        return eventFailure('event_not_found', '活动不存在或已被删除');
      }
      if (current.revision !== expectedRevision.value) {
        return revisionConflict({
          eventId: input.eventId,
          baseRevision: expectedRevision.value,
          currentRevision: current.revision,
        });
      }
      const merged = mergePatch(current, input.patch);
      if (!merged.ok) {
        return eventFailure('invalid_input', merged.detail);
      }

      const timestamp = now();
      const event: WorkspaceEvent = {
        id: current.id,
        region: merged.value.region,
        title: merged.value.title,
        description: merged.value.description,
        startsAt: merged.value.startsAt,
        endsAt: merged.value.endsAt,
        sourceUrl: merged.value.sourceUrl,
        verificationStatus: 'unverified',
        revision: current.revision + 1,
        deletedAt: null,
        createdAt: current.createdAt,
        updatedAt: timestamp,
      };

      /**
       * revision 相等就等价于「读取到的内容未被改过」：本模块的每条写入路径
       * （创建 / 更新 / 墓碑化）都会让 `revision + 1`，因此它是一个内容单调函数，
       * CAS 条件不需要再逐个比对各字段。
       */
      return await runOperation<{ readonly event: WorkspaceEvent }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: EVENT_OP_KINDS.update,
        requestFingerprint: guard.fingerprint,
        preconditionSql: `EXISTS (SELECT 1 FROM workspace_events e
                                    WHERE e.id = ? AND e.workspace_id = ? AND e.deleted_at IS NULL AND e.revision = ?)`,
        preconditionBinds: [input.eventId, input.workspaceId, expectedRevision.value],
        build: () => [
          updateEventStatement({
            eventId: input.eventId,
            workspaceId: input.workspaceId,
            expectedRevision: expectedRevision.value,
            fields: merged.value,
            now: timestamp,
          }),
        ],
        result: { event },
        explain: async () => {
          // 认领失败：读回**真实状态**给出精确原因（not_found 还是 revision_conflict），
          // 而不是笼统报「冲突」——客户端需要知道是「换一台设备重试」还是「行已消失」。
          const latest = await readActiveRow(input.workspaceId, input.eventId);
          if (latest === null) {
            return eventFailure('event_not_found', '活动不存在或已被删除');
          }
          return revisionConflict({
            eventId: input.eventId,
            baseRevision: expectedRevision.value,
            currentRevision: latest.revision,
          });
        },
      });
    },

    async deletePersonal(input) {
      const operationId = validateOperationId(input.operationId);
      if (!operationId.ok) {
        return eventFailure('invalid_input', operationId.detail);
      }
      const expectedRevision = validateExpectedRevision(input.expectedRevision);
      if (!expectedRevision.ok) {
        return eventFailure('invalid_input', expectedRevision.detail);
      }

      const guard = await replayGuard<{ readonly event: WorkspaceEvent }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: EVENT_OP_KINDS.delete,
        intent: { eventId: input.eventId, expectedRevision: expectedRevision.value },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }

      const current = await readActiveRow(input.workspaceId, input.eventId);
      if (current === null) {
        return eventFailure('event_not_found', '活动不存在或已被删除');
      }
      if (current.revision !== expectedRevision.value) {
        return revisionConflict({
          eventId: input.eventId,
          baseRevision: expectedRevision.value,
          currentRevision: current.revision,
        });
      }

      const timestamp = now();
      const event: WorkspaceEvent = {
        ...current,
        revision: current.revision + 1,
        deletedAt: timestamp,
        updatedAt: timestamp,
      };

      return await runOperation<{ readonly event: WorkspaceEvent }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: EVENT_OP_KINDS.delete,
        requestFingerprint: guard.fingerprint,
        preconditionSql: `EXISTS (SELECT 1 FROM workspace_events e
                                    WHERE e.id = ? AND e.workspace_id = ? AND e.deleted_at IS NULL AND e.revision = ?)`,
        preconditionBinds: [input.eventId, input.workspaceId, expectedRevision.value],
        build: () => [
          tombstoneEventStatement({
            eventId: input.eventId,
            workspaceId: input.workspaceId,
            expectedRevision: expectedRevision.value,
            now: timestamp,
          }),
        ],
        result: { event },
        explain: async () => {
          const latest = await readActiveRow(input.workspaceId, input.eventId);
          if (latest === null) {
            return eventFailure('event_not_found', '活动不存在或已被删除');
          }
          return revisionConflict({
            eventId: input.eventId,
            baseRevision: expectedRevision.value,
            currentRevision: latest.revision,
          });
        },
      });
    },
  };
}
