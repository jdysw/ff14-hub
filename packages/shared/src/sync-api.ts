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
 * 游标前缀。**v2 的语义是「数据库单调变更序号」**，不是时间戳。
 *
 * 复核修正（真实缺陷）：v1 把 `updated_at` 当游标（`v1:<毫秒>`），隐含三个错误假设：
 * 同一毫秒内的后续写入/删除/显式恢复会被 `lastTs + 1` 永久跳过；多 Worker 时钟可能回退；
 * 墓碑与「同毫秒的合法新 revision」只能靠时间比较先后。因此 v2 改为
 * `v2:<workspace_changes.seq>`——由数据库 AUTOINCREMENT 保证严格递增且与时钟无关。
 *
 * 版本化前缀的意义：客户端拿着旧版本游标来请求时，服务端**明确拒绝**（`unsupported_version`），
 * 由客户端丢弃本地游标做一次全量重建；绝不把 v1 的毫秒值当 seq 解释（那会静默漏掉或重放变更）。
 */
export const SYNC_CURSOR_PREFIX = 'v2:';

/** v1（时间戳游标）的前缀：只用于**识别并拒绝**旧游标，禁止再产生。 */
export const LEGACY_SYNC_CURSOR_PREFIX = 'v1:';

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
 * - `seq` 是**数据库单调变更序号**（`workspace_changes.seq`，AUTOINCREMENT）：
 *   它是排序与去重的唯一依据，也是「谁更新」的唯一判据。**不要**再用 `updatedAt` 比较新旧：
 *   同一毫秒内完全可能既有删除又有恢复，时间无法表达先后，而 seq 可以。
 * - `revision` 是该行**当前**的 revision（墓碑时是墓碑那一次的 revision）；
 *   客户端据此判断「我手上的版本是否已经落后」。注意：它**不能**用来推导工作空间级修订号
 *   （那是响应 `meta` 里的字段）——行修订与全局修订是两个不同的计数器。
 * - `updatedAt` 仅作**展示/诊断**用（UTC 毫秒），不参与排序、去重或新旧判断。
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
    /** 单调变更序号：排序、去重、墓碑先后的**唯一**依据。 */
    seq: z.number().int().positive(),
    entityType: syncEntityTypeSchema,
    entityId: z.string().min(1).max(SYNC_ENTITY_ID_MAX_LENGTH),
    op: syncChangeOpSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    payload: z.unknown().nullable(),
  })
  .strict();

export type SyncChange = z.infer<typeof syncChangeSchema>;

/**
 * 与变更流同一快照读出的**权威工作空间级修订号**。
 *
 * 为什么必须由服务端显式给出（复核发现的真实缺陷）：客户端的导航界面曾用
 * `Math.max(snapshot.revision, change.revision)` 推导全局修订号，而 `change.revision`
 * 是**行**修订（成员关系甚至恒为 0）。于是远端每次新增/编辑之后，
 * 客户端手上的全局修订号都落后真实值，下一次重排/导入必然 409——除非用户手动刷新。
 *
 * 规则：**全局 CAS 只用这里的值；行 CAS 只用各行自己的 revision；两者不可互相推导。**
 */
export const syncMetaSchema = z
  .object({
    /** 导航工作空间修订号（`workspace_nav_state.revision`），缺失行时为 0。 */
    navRevision: z.number().int().nonnegative(),
    /** 工作台工作空间修订号（`workspace_workbench_state.revision`），缺失行时为 0。 */
    workbenchRevision: z.number().int().nonnegative(),
    /** 本页水位（最后一条返回变更的 seq；没有变更时为请求游标）。 */
    watermark: z.number().int().nonnegative(),
  })
  .strict();

export type SyncMeta = z.infer<typeof syncMetaSchema>;

/** `GET /me/sync/changes` 的响应（设备鉴权）。 */
export const syncChangesResponseSchema = z
  .object({
    changes: z.array(syncChangeSchema),
    /**
     * 下一轮要传回来的游标（`v2:<seq>`），**由 `nextSyncCursor` 产出**（唯一实现）。
     * 为 `null` 只表示「本次没有下一轮」（`hasMore === false` 的一种表达），
     * 而不是「以后都不用同步了」。
     */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    /**
     * **必须先读一次当前快照再增量**（复核修正：安全快照 + 稳定水位协议）。
     *
     * 为什么需要它：变更流的 `payload` 是**当前**实体内容，而不是「该事件发生时的内容」。
     * 因此把历史日志按 seq 顺序重放到一个**已经是当前状态**的本地副本上是不成立的：
     * 例如「导入 → 删除 → 显式恢复」之后，历史里的那条 `delete` 仍然存在（payload=null），
     * 重放它会把本地一条**已恢复**的链接删掉，直到更靠后的 restore 页才补回来——期间用户看到
     * 错误的删除、成员关系也一起丢。更一般地，历史行的 `revision` 与当前 payload 的
     * `revision` 也不一致。
     *
     * 因此协议规定：
     * - **`since` 缺省**（客户端没有游标）时，服务端**不返回历史变更**，而是返回
     *   `resetRequired: true` + `nextCursor = v2:<当前水位>` + `meta.watermark = 当前水位`；
     *   客户端必须先 `GET` 一次权威快照（导航/工作台），再把游标设为该水位开始增量。
     * - 只有 `since = v2:<某个水位>`（通常来自快照或上一页）时才返回 `seq > 水位` 的**真实增量**，
     *   此时「在快照之后发生的事件」按 seq 顺序应用是自洽的（后来的事件覆盖先前事件）。
     * - 客户端在 `hasMore === true`（还有页没取完）期间**不得**把 `meta` 里的权威全局修订号
     *   当作 CAS 基数：那对应的是服务端当前状态，而本地集合还不完整。
     */
    resetRequired: z.boolean(),
    /** 服务端时间：客户端据此对自身时钟偏移做估计，并给本地墓碑/草稿排序。 */
    serverTimeMs: z.number().int().nonnegative(),
    /**
     * 本次同步**实际覆盖**的实体类型（= 服务端已实现的扫描范围）。
     * 为什么必须显式返回：客户端不能靠「这次没收到某类型的变更」推断「该类型没有变化」——
     * 服务端尚未扫描的类型必须让客户端**看见**，否则它会误以为「服务端已确认无变更」，
     * 进而做出错误的本地清理。
     */
    entityTypes: z.array(syncEntityTypeSchema),
    /**
     * 与变更流**同一快照**读出的权威工作空间级修订号（见 `syncMetaSchema`）。
     *
     * 硬规则：客户端更新「全局 CAS 基数」只能用它；**不得**用 `Math.max(snapshot.revision,
     * change.revision)` 之类的方式从行修订推导全局修订（那是复核发现的真实缺陷：
     * 远端每次新增/编辑后客户端全局修订落后，下一次重排/导入必然 409）。
     */
    meta: syncMetaSchema,
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
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: SyncCursorDecodeFailure };

/** 十进制非负整数，**且不接受前导零**（保证一个序号只有一种规范写法）。 */
const CURSOR_DIGITS_PATTERN = /^(0|[1-9]\d*)$/;
/** 形如 `v<数字>:` 的前缀：用于区分「其他版本」与「损坏输入」。 */
const ANY_CURSOR_VERSION_PATTERN = /^v\d+:/;

/**
 * 编码水位游标：`v2:<单调变更序号>`。
 *
 * 语义是「我已经消费到 seq < N 的全部变更」，因此下一轮只需 `seq >= N`。
 * 非「非负安全整数」一律**抛错**而不是夹到 0：一个静默变成 0 的游标会让调用方
 * 以为自己拿到了合法值，掩盖真实的上游 bug（并可能静默重放整个变更流）。
 */
export function encodeSyncCursor(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError('encodeSyncCursor: seq 必须是非负安全整数（数据库单调变更序号）');
  }
  return `${SYNC_CURSOR_PREFIX}${String(seq)}`;
}

/**
 * 解码水位游标（**唯一实现**）。非法输入必须**明确拒绝**，绝不猜成 0。
 *
 * 三种失败刻意分开处理：
 * - `v1:<毫秒>` → `unsupported_version`：**旧版时间戳游标**。把毫秒值当 seq 解释会造成
 *   静默漏变更或重放，因此这里明确拒绝，由客户端丢弃本地游标做一次全量重建
 *   （服务端也可以用 `since` 缺省表达同样的「从头开始」）。
 * - `v3:` 等其他版本 → `unsupported_version`：升级过的客户端/回滚的服务端，应提示升级。
 * - `abc` / `v2:-1` / `v2:1.5` / `v2:` / `v2:007` → `malformed`：损坏或伪造输入。
 */
export function decodeSyncCursor(raw: unknown): SyncCursorDecodeResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (raw.startsWith(LEGACY_SYNC_CURSOR_PREFIX)) {
    // 时间戳游标：语义已经变了，绝不当成 seq 继续用。
    return { ok: false, reason: 'unsupported_version' };
  }
  if (!raw.startsWith(SYNC_CURSOR_PREFIX)) {
    return { ok: false, reason: ANY_CURSOR_VERSION_PATTERN.test(raw) ? 'unsupported_version' : 'malformed' };
  }
  const digits = raw.slice(SYNC_CURSOR_PREFIX.length);
  if (!CURSOR_DIGITS_PATTERN.test(digits)) {
    return { ok: false, reason: 'malformed' };
  }
  const seq = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(seq)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, seq };
}

// ---------------------------------------------------------------------------
// 排序与分页推进（唯一实现）
// ---------------------------------------------------------------------------

/**
 * 变更的稳定排序键：**只有 seq**。
 *
 * 为什么不再用 `(updatedAt, entityType, entityId)`：seq 由数据库 AUTOINCREMENT 分配，
 * 全局唯一且严格递增，因此它本身就是全序——不需要、也不应该再用时间做次级排序。
 * 同一毫秒内的多条变更、时钟回退、系统休眠都不会破坏这个次序。
 */
export function compareSyncChanges(a: SyncChange, b: SyncChange): number {
  if (a.seq === b.seq) {
    return 0;
  }
  return a.seq < b.seq ? -1 : 1;
}

export interface SyncCursorAdvanceInput {
  /** 本页实际返回的变更条数。 */
  readonly returned: number;
  /** 本页请求的 limit（服务端每请求的工作量上限）。 */
  readonly limit: number;
  /** 本页最后一条变更的 seq；没有变更时为 null。 */
  readonly lastSeq: number | null;
  /** 请求里带的游标（没有则为 null）；没有变更时用它原样回传。 */
  readonly requestSeq: number | null;
}

export interface SyncCursorAdvance {
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/**
 * 推进游标（唯一实现）。
 *
 * 语义（与 seq 水位一致，**没有**「停在同毫秒重复扫描」这种技巧）：
 * - 没有变更 → 游标不变，`hasMore = false`；
 * - 有变更但没填满一页 → 游标 = 最后一条 seq，`hasMore = false`；
 * - 填满一页 → 游标 = 最后一条 seq，`hasMore = true`（还有 seq 更大的变更）。
 *
 * 因为 seq 严格递增且每页恰好取 `limit` 条，工作量上限是**真实**的：
 * 不存在「同一个时间戳的行太多导致一页无限扩张」的情况。
 */
export function nextSyncCursor(input: SyncCursorAdvanceInput): SyncCursorAdvance {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new RangeError('nextSyncCursor: limit 必须是正整数');
  }
  if (!Number.isInteger(input.returned) || input.returned < 0) {
    throw new RangeError('nextSyncCursor: returned 必须是非负整数');
  }
  if (input.returned > input.limit) {
    throw new RangeError('nextSyncCursor: returned 不能大于 limit（服务端必须按 limit 截断）');
  }
  if (input.returned === 0) {
    return { nextCursor: encodeSyncCursor(input.requestSeq ?? 0), hasMore: false };
  }
  if (input.lastSeq === null) {
    throw new RangeError('nextSyncCursor: 有变更时必须给出 lastSeq');
  }
  return { nextCursor: encodeSyncCursor(input.lastSeq), hasMore: input.returned === input.limit };
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
