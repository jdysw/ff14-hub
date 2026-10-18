/**
 * 跨设备同步契约（HUB-051 / ADR-0004 D7）——Worker 与前端**共用**。
 *
 * 定位：只放**纯类型与纯函数**（水位游标的编解码、稳定排序、分页推进），
 * 无 DOM、无 D1、无 React、无网络。服务端 `GET /api/v1/me/sync/changes` 与前端同步循环
 * 调用**同一份**实现，因此「谁该出现在第几页」不会因为两端各写一遍而漂移。
 *
 * ── 为什么水位按 `updated_at` **扫描行**，而不是「在 CRUD 里记一条变更日志」──────────
 * 变更日志方案要求「每一个写路径都记得写日志」，而写路径并不只有常规 CRUD：
 * 模块卸载清理、模板重置、备份导入、墓碑化（删除）都会改数据。任何一条路径漏写日志，
 * 客户端就**永久**丢一次变更，而且这种漏是静默的、无法在客户端补救。
 * 反过来，这些表都有 `updated_at`（UTC 毫秒）并且**所有**写路径都会更新它
 * （这是各模块写入代码的共同约束），所以按 `updated_at >= cursor` 扫描是**完备**的：
 * 新增、修改、删除（墓碑化）、模块卸载清理、模板重置、备份导入天然全部进入同步流。
 * 代价是「没有变更时也要扫一遍索引」以及「同一毫秒多行需要靠游标停驻 + 客户端幂等去重」
 * ——这两项都由本文件的规则明确定义，而不是靠运气。
 *
 * ── 为什么不自动 GC 墓碑 ──────────────────────────────────────────────────────
 * 墓碑（`op: 'delete'`）是唯一能告诉设备「这一行已经不存在了」的信息。设备的水位可能
 * 落后任意久（离线数周）。若在「早于某设备水位」之前删掉墓碑，那台设备下次同步时
 * 既看不到行、也看不到墓碑，于是**复活**一条已被删除的数据。
 * 因此阶段 04 **不删除任何墓碑**（ADR-0004 D12），宁可持续占用存储，也不制造复活。
 * 将来若要 GC，前置条件是「所有已知设备的水位都超过该墓碑的 updated_at」，那需要一个
 * 设备水位表；现在没有它，就不做。
 *
 * ── 为什么 403 与健康状态无关 ────────────────────────────────────────────────
 * `/me/sync/changes` 的 `403`（`forbidden`）含义只有一个：**这次请求的来源/凭证不被允许**
 * （Origin 校验不通过、凭证作用域不对、设备已被撤销）。它**不**表示服务不可用、
 * 数据库不可用，也**不**表示工作空间的数据有问题——这些分别由 `503` / 健康检查
 * 与具体响应体表达。客户端因此**不得**把一次 403 推断成「同步服务故障」或「数据损坏」，
 * 更不得据此清空本地数据或进入离线降级；正确处理是提示重新认证（或在必要时重新配对）。
 * 同理，导航健康探测里对外部 URL 的 403 也只映射为 `maybe_blocked`（ADR-0004 D4），
 * 绝不映射成「永久失效」——`403` 永远只是一个关于**本次请求**的事实。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 常量（单一来源）
// ---------------------------------------------------------------------------

/**
 * 参与同步的实体类型。
 *
 * 与 ADR-0004 D7 的清单一致，顺序也是**契约的一部分**（响应 `entityTypes` 按它输出，
 * 便于客户端稳定比较）。新增类型必须同时改这里与服务端扫描实现，不允许「只在一个地方加」。
 */
export const SYNC_ENTITY_TYPES = [
  'page',
  'widget',
  'layout',
  'nav_link',
  'nav_group',
  'nav_membership',
  'module',
  /**
   * 个人活动（HUB-011）。
   *
   * 追加在**末尾**而不是插在中间：顺序也是契约（响应 `entityTypes` 按它输出），
   * 插到中间会让既有客户端「按顺序索引」的假设失效。
   * 个人活动与导航/布局一样带 `updated_at` 与墓碑，因此同一条扫描规则直接适用。
   */
  'workspace_event',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/**
 * 游标前缀（含冒号）。版本化游标：将来改变语义（例如换成复合键游标）时必须换前缀，
 * 好让老客户端**明确**收到 `unsupported_version`，而不是把新值当旧值用错。
 */
export const SYNC_CURSOR_PREFIX = 'v1:';

/** 默认页大小。取 200：一次响应在 64 KiB 响应预算内、且远小于「要求客户端频繁往返」的规模。 */
export const SYNC_DEFAULT_LIMIT = 200;

/**
 * 页大小上限。必须显著大于默认值但仍有限：它同时是服务端每请求的工作量上限
 * （防止一个 `limit=100000` 把 Worker 的 CPU/内存预算打穿），因此超出即拒绝而不是截断。
 */
export const SYNC_MAX_LIMIT = 500;

/** 变更操作。`delete` 表示**墓碑**（行仍在，`deleted_at` 非空），不是物理删除。 */
export const SYNC_CHANGE_OPS = ['upsert', 'delete'] as const;
export type SyncChangeOp = (typeof SYNC_CHANGE_OPS)[number];

/** 结构化冲突原因（与 ADR-0004 D7 / D11 的 409 `details.conflict` 对应）。 */
export const SYNC_CONFLICT_REASONS = [
  /** 提交方的 `expectedRevision` 与服务器当前 revision 不一致（真并发修改）。 */
  'revision_conflict',
  /** 同一个 `operationId` 被用于不同内容（意图变了）：拒绝且零写入，绝不当重放。 */
  'operation_payload_mismatch',
  /** 目标行不存在（已被其他设备删除或从未存在）：不泄露存在性细节，只给结构化原因。 */
  'entity_not_found',
] as const;

export type SyncConflictReason = (typeof SYNC_CONFLICT_REASONS)[number];

/** 可选的冲突处理方式。只有两项：保留本地（重试/覆盖）或以服务端为准。 */
export const SYNC_CONFLICT_RESOLUTIONS = ['local', 'server'] as const;
export type SyncConflictResolution = (typeof SYNC_CONFLICT_RESOLUTIONS)[number];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const syncEntityTypeSchema = z.enum(SYNC_ENTITY_TYPES);
export const syncChangeOpSchema = z.enum(SYNC_CHANGE_OPS);
export const syncConflictReasonSchema = z.enum(SYNC_CONFLICT_REASONS);
export const syncConflictResolutionSchema = z.enum(SYNC_CONFLICT_RESOLUTIONS);

/**
 * 单条变更。
 *
 * - `revision` 是该行**当前**的 revision（删除时是墓碑那一次的 revision）；
 *   客户端据此判断「我手上的版本是否已经落后」。
 * - `updatedAt` 是水位字段：它与游标同一单位（UTC 毫秒），也就是排序键。
 * - `payload` 是**已通过服务端校验的**实体快照（`op: 'upsert'` 时），
 *   `op: 'delete'` 时为 `null`（墓碑只带身份与修订，不重复传内容）。
 *   刻意用 `unknown`：本文件不重复定义 7 种实体的形状（那是各模块契约的事），
 *   调用方在拿到 `entityType` 后再用对应 Schema 解析 payload；**不要**在这里
 *   用一个大 union 猜类型。
 *   注意（诚实记录）：zod 的 `unknown` 也接受 `undefined`，因此**缺省** `payload` 键
 *   不会报错。服务端构造响应时必须**显式**给出该键（`delete` 为 `null`），
 *   客户端也不得依据「键缺失」做任何判断。
 */
/**
 * 实体 ID。
 *
 * 上限 96（而不是 64）：组合实体 ID 由两个 36 字符 UUID 加分隔符构成
 * （`nav_membership` 的 `linkId:groupId` = 73 字符），64 会让「只要有成员关系，
 * 整份响应就过不了 Schema」——这是复核时发现的契约冲突，因此把上限放到能容纳
 * 「两个 UUID + 分隔符 + 断点」的量级，而不是在服务端截断 ID（截断会让不同关系
 * 在极端情况下映射到同一键，客户端去重就会互相覆盖）。
 */
export const SYNC_ENTITY_ID_MAX_LENGTH = 96;

export const syncChangeSchema = z
  .object({
    entityType: syncEntityTypeSchema,
    entityId: z.string().min(1).max(SYNC_ENTITY_ID_MAX_LENGTH),
    op: syncChangeOpSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    payload: z.unknown().nullable(),
  })
  .strict();

export type SyncChange = z.infer<typeof syncChangeSchema>;

/** `GET /me/sync/changes` 的响应（设备鉴权）。 */
export const syncChangesResponseSchema = z
  .object({
    changes: z.array(syncChangeSchema),
    /**
     * 下一轮要传回来的游标，**由 `advanceCursor` 产出**（唯一实现）。
     * 为 `null` 只表示「本次没有下一轮」（`hasMore === false` 的一种表达），
     * 而不是「以后都不用同步了」。
     */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    /** 服务端时间：客户端据此对自身时钟偏移做估计，并给本地墓碑/草稿排序。 */
    serverTimeMs: z.number().int().nonnegative(),
    /**
     * 本次同步**实际覆盖**的实体类型（= 服务端已实现的扫描范围）。
     * 为什么必须显式返回：客户端不能靠「这次没收到某类型的变更」推断「该类型没有变化」——
     * 服务端尚未扫描的类型必须让客户端**看见**，否则它会误以为「服务端已确认无变更」，
     * 进而做出错误的本地清理。
     */
    entityTypes: z.array(syncEntityTypeSchema),
  })
  .strict();

export type SyncChangesResponse = z.infer<typeof syncChangesResponseSchema>;

/**
 * 结构化冲突（放进 409 的 `details.conflict`，见 ADR-0004 D7 / D11）。
 *
 * `baseRevision` / `currentRevision` 均可为 null：`entity_not_found` 没有「当前 revision」
 * 可言，此时给 0 就是在伪造事实。`field` 也是 null 表示「整行级冲突」而不是某个字段。
 */
export const syncConflictSchema = z
  .object({
    reason: syncConflictReasonSchema,
    entityType: syncEntityTypeSchema,
    entityId: z.string().min(1).max(SYNC_ENTITY_ID_MAX_LENGTH),
    field: z.string().min(1).max(64).nullable(),
    baseRevision: z.number().int().nonnegative().nullable(),
    currentRevision: z.number().int().nonnegative().nullable(),
    /**
     * 可用的处理方式。
     *
     * 这里用「非空、至多两项、取值受枚举约束」的数组而不是固定两项的元组：
     * 某些冲突（例如 `entity_not_found`）服务端可能只提供其中**一种**合法处理方式，
     * 契约必须能表达「就这一种」，而不是逼服务端列出一个它其实不支持的选项。
     * 空数组与未知取值一律被判为非法（默认拒绝：不能让客户端拿到一个无法执行的冲突）。
     */
    resolutionOptions: z.array(syncConflictResolutionSchema).min(1).max(SYNC_CONFLICT_RESOLUTIONS.length),
  })
  .strict();

export type SyncConflict = z.infer<typeof syncConflictSchema>;

// ---------------------------------------------------------------------------
// 游标编解码（唯一实现）
// ---------------------------------------------------------------------------

export type SyncCursorDecodeFailure = 'malformed' | 'unsupported_version';

export type SyncCursorDecodeResult =
  | { readonly ok: true; readonly updatedAtMs: number }
  | { readonly ok: false; readonly reason: SyncCursorDecodeFailure };

/** 十进制非负整数，**且不接受前导零**（保证一个时间戳只有一种规范写法）。 */
const CURSOR_DIGITS_PATTERN = /^(0|[1-9]\d*)$/;
/** 形如 `v<数字>:` 的前缀：用于区分「未来版本」与「损坏输入」。 */
const ANY_CURSOR_VERSION_PATTERN = /^v\d+:/;

/**
 * 编码水位游标：`v1:<UTC 毫秒>`。
 *
 * 非「非负安全整数」一律**抛错**而不是夹到 0：游标偏小会导致重复扫描（可恢复），
 * 但一个静默变成 0 的游标会让调用方以为自己拿到了合法值，掩盖真实的上游 bug。
 * 用 `Number.isSafeInteger` 而不是 `Number.isInteger`：`2**53` 之后的整数无法精确表示，
 * 放进游标会导致「编码后再解码得到不等于原值」的往返破坏。
 */
export function encodeSyncCursor(updatedAtMs: number): string {
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
    throw new RangeError('encodeSyncCursor: updatedAtMs 必须是非负安全整数（UTC 毫秒）');
  }
  return `${SYNC_CURSOR_PREFIX}${String(updatedAtMs)}`;
}

/**
 * 解码水位游标（**唯一实现**）。非法输入必须**明确拒绝**，绝不猜成 0。
 *
 * 为什么「猜成 0」是严重错误：0 等价于「从时间原点重新全量同步」。用户一旦传进一个
 * 打错的游标，把 0 猜出来就等于悄悄触发全量拉取；更糟的是若客户端把它写回本地水位，
 * 每次同步都会重来一遍，且表越大越慢。宁可返回 `malformed` 让调用方显式处理。
 *
 * `unsupported_version` 与 `malformed` 刻意分开：
 * - `v2:...` 是**未来版本**（升级过的客户端/回滚的服务端）→ 应提示升级或拒绝，不是数据损坏；
 * - `abc` / `v1:-1` / `v1:1.5` / `v1:abc` / `v1:` / `v1:007` 是**损坏或伪造**输入 → 必须重新全量引导。
 */
export function decodeSyncCursor(raw: unknown): SyncCursorDecodeResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (!raw.startsWith(SYNC_CURSOR_PREFIX)) {
    // 前缀不是 v1：——只有形如 `v<数字>:` 才可能是「未来版本」，其余一律当作损坏输入。
    return { ok: false, reason: ANY_CURSOR_VERSION_PATTERN.test(raw) ? 'unsupported_version' : 'malformed' };
  }
  const digits = raw.slice(SYNC_CURSOR_PREFIX.length);
  if (!CURSOR_DIGITS_PATTERN.test(digits)) {
    return { ok: false, reason: 'malformed' };
  }
  const updatedAtMs = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(updatedAtMs)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, updatedAtMs };
}

// ---------------------------------------------------------------------------
// 排序与分页推进（唯一实现）
// ---------------------------------------------------------------------------

/** 数值升序（不用减法：大时间戳相减会损失精度）。 */
function compareNumbers(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** 字符串按 UTF-16 码元比较：与 locale 无关，因此跨设备顺序完全一致。 */
function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * 变更的稳定排序键：`(updatedAt, entityType, entityId)`。
 *
 * 为什么必须有完整的次序（而不是只比 `updatedAt`）：同一毫秒内可能有多行（同一事务里
 * 改了多个实体、或模板一次性重置整页）。只按时间排序时，两次扫描（服务端一次、客户端
 * 重放一次）在同一毫秒上的相对顺序不确定，分页边界就会漂移：
 * 可能出现「某行在第一轮被跳过、在第二轮也因为边界错过」的丢行。
 * 加上 `entityType` 与 `entityId` 后，整序唯一，`>= cursor` 的重复扫描一定收敛。
 */
export function compareSyncChanges(a: SyncChange, b: SyncChange): number {
  return (
    compareNumbers(a.updatedAt, b.updatedAt) ||
    compareStrings(a.entityType, b.entityType) ||
    compareStrings(a.entityId, b.entityId)
  );
}

export interface SyncCursorAdvanceInput {
  /** 本轮实际返回给客户端的行数（<= `limit`）。 */
  readonly returned: number;
  /** 本轮请求的页大小（> 0）。 */
  readonly limit: number;
  /** 本轮返回的**最后一行**的 `updatedAt`；`returned === 0` 时没有意义但必须给（沿用本轮起点）。 */
  readonly lastUpdatedAtMs: number;
}

export interface SyncCursorAdvance {
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 计算下一轮游标与 `hasMore`（**唯一实现**，最容易被写错的一段）。
 *
 * 三种情形（ADR-0004 D7 的硬规则）：
 * 1. `returned === 0`：没有行 → `hasMore: false`，游标前移到 `lastUpdatedAtMs + 1`
 *    （不能停在原处，否则空轮之后每次都会重新扫同一个毫秒区间）。
 * 2. `returned === limit`：**刚好装满** → `hasMore: true`，且游标**停在最后一个时间戳**
 *    （即 `lastUpdatedAtMs`，不 +1）。查询用的是 `updated_at >= cursor`（**含**边界），
 *    所以下一轮会**重复**返回这同一毫秒的行；这样做是**故意的**：我们无法知道
 *    「同一毫秒里是否还有没返回的行」，只有停在原地再扫一次才能保证不漏。
 *    重复由客户端按**实体 ID 幂等去重**（同一 entityType + entityId 后到的覆盖先到的），
 *    因此重复是免费且安全的，漏行才是不可恢复的。
 * 3. `0 < returned < limit`：这一毫秒及之前的行已经全部返回 → `hasMore: false`，
 *    游标前移到 `lastUpdatedAtMs + 1`，下一轮从更晚的时间开始。
 *
 * 输入不合法一律抛错（不猜）：`returned > limit` 说明调用方计数与查询不一致，
 * 静默修正只会把「丢行」掩盖过去。
 */
export function advanceCursor(input: SyncCursorAdvanceInput): SyncCursorAdvance {
  const { returned, limit, lastUpdatedAtMs } = input;
  if (!isNonNegativeSafeInteger(returned) || !isNonNegativeSafeInteger(lastUpdatedAtMs)) {
    throw new RangeError('advanceCursor: returned 与 lastUpdatedAtMs 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('advanceCursor: limit 必须是正整数');
  }
  if (returned > limit) {
    throw new RangeError(
      `advanceCursor: returned(${String(returned)}) 不得大于 limit(${String(limit)})`,
    );
  }
  if (returned === 0) {
    return { nextCursor: encodeSyncCursor(lastUpdatedAtMs + 1), hasMore: false };
  }
  if (returned === limit) {
    return { nextCursor: encodeSyncCursor(lastUpdatedAtMs), hasMore: true };
  }
  return { nextCursor: encodeSyncCursor(lastUpdatedAtMs + 1), hasMore: false };
}

// ---------------------------------------------------------------------------
// 面向调用方的提示文案（错误码复用 `errors.ts` 的既有集合）
// ---------------------------------------------------------------------------

/** 冲突与游标问题的可见说明；服务端用它构造 `409` 的可读 message。 */
export const SYNC_MESSAGES = {
  revision_conflict: '该数据已被其他设备修改，请先比较差异再提交。',
  operation_payload_mismatch: '该操作 ID 已用于不同的请求内容，请用新的操作 ID 重试。',
  entity_not_found: '目标数据不存在（可能已被其他设备删除）。',
  cursor_malformed: '同步游标无效，需要重新进行一次完整同步。',
  cursor_unsupported_version: '同步游标来自更新的版本，请升级客户端后重试。',
  /** 明确「不自称已完成」：本轮没返回的行不代表没有变更，必须继续拉取。 */
  has_more: '还有更多变更未返回，请用 nextCursor 继续拉取。',
} as const;
