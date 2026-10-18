/**
 * 跨设备变更/水位服务（HUB-051 / ADR-0004 D7）—— **只读**。
 *
 * ── 为什么水位是**数据库单调序号**，而不是 `updated_at` ─────────────────────────
 * 复核发现的真实缺陷：把 `updated_at` 当游标（`nextCursor = lastTs + 1`）隐含三个错误假设：
 *   ① 同一毫秒内后续发生的写入/删除/显式恢复，其 `updated_at` 会 < lastTs+1 而被**永久跳过**；
 *   ② 多个 Worker 实例的时钟可能回退/不一致，回退后的新写入落在已消费水位之前；
 *   ③ 墓碑与「同毫秒的合法新 revision」只能靠时间比较先后，真实恢复会被误判成旧数据。
 * 缺口在**游标本身**，不是「分页没补齐同毫秒组」。因此改用 `workspace_changes.seq`
 * （AUTOINCREMENT，只增不减、与时钟无关）：删除、恢复、更新各占一条新 seq，顺序天然正确。
 *
 * ── 为什么是**触发器**写的变更流，而不是各写路径手动记日志 ──────────────────────
 * 写路径远不止常规 CRUD：模块卸载清理（`modules/workbench/instance-store.ts` 的墓碑批处理）、
 * 模板重置（`POST /me/workbench/apply-template` 的 reset / replace）、备份导入与撤销恢复、
 * 页面/实例/链接的墓碑化与显式恢复……任何一处漏记，客户端就**永久**丢一次变更且无法补救。
 * 触发器（`migrations/0011_change_journal.sql`）由数据库保证「只要这一行变了，
 * 同一个事务里就有一条变更记录」，因此覆盖现在与将来的**所有**写路径。
 *
 * ── 一次一致快照 ──────────────────────────────────────────────────────────────
 * 本服务用**一个** `db.batch([...])` 同时读：变更页 + 各实体 payload + 工作空间级修订号（meta）。
 * D1 的 batch 是单个事务，因此「变更流」与「payload / meta」来自同一个快照：
 * 不会出现「读到 A 表的新版本、却用了旧水位」这种撕裂，也就不可能漏读或错读。
 *
 * payload 的「本页」限定用同一条子查询（见 `PAGE_SCOPE_SQL`）：它的上界是
 * 「本页第 `limit` 条的 seq（`OFFSET limit-1`）」，不足一页时退化为该工作空间的 `MAX(seq)`。
 * 因此 payload 的行集合与变更页**逐条对应**，页大小也有**真实上限**
 * （旧实现为了让同一毫秒的行不跨页，会让一页无限扩张）。
 *
 * ── payload 是**当前**实体内容，不是「事件发生时的内容」；禁止从 0 回放历史 ─────────
 * 这是本服务最容易被误用的语义，第三轮复核把它定为 P1 缺陷：
 * 日志条目（`workspace_changes`）记录的是**历史事件**（谁在什么顺序上被 upsert / delete），
 * 而响应里的 `payload` 是**这一刻读出来的实体快照**——两者刻意不是一回事，也不该是一回事：
 * 日志是只增的水位事实，payload 若要在日志里冻结就必须为每次写入存一份完整内容副本
 * （存储与"同一行反复写"的放大都不可接受），而「按 seq 应用当前内容」对**增量**是完全自洽的。
 *
 * 真正不成立的是「把历史日志重放到一个已经是当前状态的本地副本上」。反例（真实复现）：
 *   ① A 导入链接 → ② A 删除该链接（墓碑） → ③ A 显式恢复。
 * 此时 B 先读 `GET /me/navigation`（快照里链接**已是活跃的**），再「从 seq 0 回放」：
 * 日志里**每一条** upsert 携带的都是**当前**（已恢复）的内容（`payload` 不是事件快照），
 * 而夹在中间的那条 `delete` 照样会被投递——于是这条**已恢复**的链接
 * 又被从 B 的本地状态删掉（成员关系随之一并丢失），要等更靠后的 restore 页才补回来：
 * 期间用户看到的是错误的删除，而且这是「派生自当前快照的本地状态」被历史事件污染的必然结果。
 * 同时历史行的 `revision` 与当前 `payload.revision` 也不一致（行修订已经前进），
 * 而 `meta.navRevision` / `meta.workbenchRevision` 是服务端**当前**值，
 * 一页历史并不等于「当前完整状态」。
 *
 * 因此协议（见 `sync-api.ts` 的 `resetRequired` 注释）：
 * - **`since` 缺省**（路由把 `cursor` 置 null）：**不再扫描历史**，只在**一个** batch 里读
 *   本工作空间的 `MAX(seq)`（= 稳定水位）与两个全局修订号，返回
 *   `{changes: [], resetRequired: true, nextCursor: encodeSyncCursor(水位), meta.watermark: 水位}`，
 *   让客户端**先读一次权威快照**（导航/工作台）再从这个水位做增量。
 *   这就是本缺陷的根因修法：不从 0 投递历史，客户端就没有「重放历史」的机会。
 * - **`since = v2:N`**：仍按现有逻辑返回 `seq > N` 的变更页 + 本页 payload + meta，
 *   但 `resetRequired: false`。被投递的每一条都发生在**客户端快照之后**，
 *   按 seq 顺序应用是自洽的（后来的事件覆盖先前事件），中间态是真实历史而非错误状态。
 *
 * ── 为什么不 GC 墓碑 ──────────────────────────────────────────────────────────
 * 墓碑（`op: 'delete'`）是唯一能告诉设备「这一行已经不存在」的信息。设备的水位可能落后
 * 任意久（离线数周）。若在「早于某设备水位」之前删掉墓碑，那台设备下次同步时既看不到行、
 * 也看不到墓碑，于是**复活**一条已被删除的数据。阶段 04 不删除任何墓碑
 * （ADR-0004 D12），宁可持续占用存储，也不制造复活。
 *
 * ── 作用域 ────────────────────────────────────────────────────────────────────
 * 每条语句都带 `workspace_id = ?`（布局表没有该列，因此通过
 * `page_layout_revisions JOIN workspace_pages` 用页面的 `workspace_id` 限定）。
 * 本服务不接受客户端提交的 workspace，也不施加任何副作用。
 */
import {
  SYNC_ENTITY_ID_MAX_LENGTH,
  SYNC_ENTITY_TYPES,
  nextSyncCursor,
  type SyncChange,
  type SyncChangeOp,
  type SyncChangesResponse,
  type SyncEntityType,
} from '@ff14-hub/shared';

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export interface SyncServiceDeps {
  readonly db: D1Database;
  /** 可注入时钟：`serverTimeMs` 用它取值（测试可注入固定值）。 */
  readonly now?: () => number;
}

export interface ListChangesInput {
  readonly workspaceId: string;
  /**
   * 水位起点（`workspace_changes.seq`）。
   *
   * `null` 表示客户端**没有游标**（`since` 缺省）：服务端**不返回历史变更**，
   * 而是返回 `resetRequired: true` + `nextCursor = v2:<本工作空间当前水位>`（见文件头注释），
   * 由客户端先读一次权威快照再从这个水位做增量。
   *
   * 数字表示「已消费到 seq < N」：只返回 `seq > N` 的真实增量（`resetRequired: false`）。
   *
   * 为什么这里是**已解析的数字**而不是原始游标字符串：游标非法必须变成 HTTP 422，
   * 那是路由层的职责（`decodeSyncCursor` + `SYNC_MESSAGES`）。若把字符串塞进服务层，
   * 服务层只能「猜」（把 `abc` 当成 0 会静默触发全量拉取）或抛 500，两者都更糟。
   */
  readonly cursor: number | null;
  /** 页大小（> 0）。上限属于请求校验，由路由层负责（`SYNC_MAX_LIMIT`）。 */
  readonly limit: number;
}

export interface SyncService {
  listChanges(input: ListChangesInput): Promise<SyncChangesResponse>;
}

// ---------------------------------------------------------------------------
// D1 行读取：列名来自 migrations/0006 · 0007 · 0008 · 0009（事实来源）
// ---------------------------------------------------------------------------

/**
 * 一行原始 D1 结果。
 *
 * 为什么用「按列名取值的访问器」而不是 `as PageRow` 断言：SQLite 是动态类型，
 * 一旦某列意外为 NULL 或类型不符，直接断言会让 `undefined` 悄悄进入响应体，
 * 变成客户端解析失败的**静默**错误。这里选择「读不出来就抛」，让数据损坏显式暴露。
 */
type SyncRow = Record<string, unknown>;

function corruptColumn(column: string, expected: string): never {
  throw new Error(`同步扫描：列 ${column} 不是${expected}`);
}

function textAt(row: SyncRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    return corruptColumn(column, '字符串');
  }
  return value;
}

function msAt(row: SyncRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return corruptColumn(column, 'UTC 毫秒整数');
  }
  return value;
}

function nullableMsAt(row: SyncRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return corruptColumn(column, 'UTC 毫秒整数或 NULL');
  }
  return value;
}

function nullableTextAt(row: SyncRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return corruptColumn(column, '字符串或 NULL');
  }
  return value;
}

/** SQLite 没有布尔类型：`is_default` / `is_hidden` / `is_favorite` 都是 0/1。 */
function flagAt(row: SyncRow, column: string): boolean {
  return msAt(row, column) === 1;
}

interface ParsedJson {
  readonly parsed: unknown;
  /** `false` 表示 `JSON.parse` 失败（数据损坏），而不是「JSON 里写了 null」。 */
  readonly ok: boolean;
}

/** 防御性解析：单行损坏不应让整个接口 500，但也绝不伪造出「有配置」的假象。 */
function parseJsonAt(raw: string): ParsedJson {
  try {
    return { parsed: JSON.parse(raw) as unknown, ok: true };
  } catch {
    return { parsed: null, ok: false };
  }
}

/**
 * 解析 JSON 字符串数组（`tags_json` / `aliases_json`）。
 * 只接受「全是字符串」的数组；否则返回 `null` 明确表达「服务端读不出可用值」，
 * 而不是回落到空数组（那会把损坏伪装成「用户清空了标签」）。
 */
function parseStringArrayAt(raw: string): string[] | null {
  const parsed = parseJsonAt(raw);
  if (!parsed.ok || !Array.isArray(parsed.parsed)) {
    return null;
  }
  const values: unknown[] = parsed.parsed;
  const strings = values.filter((value): value is string => typeof value === 'string');
  return strings.length === values.length ? strings : null;
}

// ---------------------------------------------------------------------------
// SQL：变更页 + 本页 payload 的一致快照
// ---------------------------------------------------------------------------

/**
 * 变更页：按 `seq` 升序取本工作空间在请求水位之后的 `limit` 条。
 *
 * `LIMIT` 是**真实上限**（页大小不再取决于「同一毫秒有多少行」）；`seq` 严格递增，
 * 因此「下一页 = 本页最后一条 seq」既不漏也不重。
 */
const CHANGES_PAGE_SQL = `SELECT seq, entity_type, entity_id, op, revision, changed_at
                            FROM workspace_changes
                           WHERE workspace_id = ? AND seq > ?
                           ORDER BY seq ASC
                           LIMIT ?`;

/**
 * 「本页实体」子查询（`entity_id IN (…)` 或 `(…) IN (… )`）。
 *
 * 绑定顺序恒为 `[workspaceId, fromSeq, workspaceId, fromSeq, limit - 1, workspaceId]`：
 *  1) 本工作空间、请求水位之后；
 *  2) 上界 = 本页第 `limit` 条的 seq（`LIMIT 1 OFFSET limit-1`）；
 *  3) 不足一页时 `COALESCE` 退化为该工作空间的 `MAX(seq)`（页里就这么多行）。
 *
 * 为什么用子查询而不是「把 entity_id 列表拼进 IN (?, ?, …)」：子查询与变更页在**同一个
 * 事务快照**里求值，且 SQL 文本是常量（不按行数拼 SQL）。
 */
const PAGE_SCOPE_SQL = `(SELECT entity_id FROM workspace_changes
                          WHERE workspace_id = ? AND seq > ?
                            AND seq <= COALESCE(
                              (SELECT seq FROM workspace_changes
                                WHERE workspace_id = ? AND seq > ?
                                ORDER BY seq ASC LIMIT 1 OFFSET ?),
                              (SELECT MAX(seq) FROM workspace_changes WHERE workspace_id = ?)))`;

const PAGE_COLUMNS = 'id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at';
const WIDGET_COLUMNS =
  'id, page_id, module_id, widget_type, config_json, config_version, is_hidden, revision, ' +
  'created_revision, deleted_at, created_at, updated_at';
const LAYOUT_COLUMNS = 'r.page_id, r.breakpoint, r.revision, r.updated_at';
const NAV_LINK_COLUMNS =
  'id, source_catalog_id, imported_source_version, title, url, description, tags_json, aliases_json, ' +
  'icon, open_mode, region, status, is_favorite, sort_order, health, health_checked_at, revision, ' +
  'deleted_at, created_at, updated_at';
const NAV_GROUP_COLUMNS = 'id, name, sort_order, revision, deleted_at, created_at, updated_at';
const NAV_MEMBERSHIP_COLUMNS = 'link_id, group_id, sort_order, deleted_at, updated_at';
const MODULE_COLUMNS =
  'module_id, status, settings_json, settings_version, revision, installed_at, enabled_at, ' +
  'disabled_at, uninstalled_at, updated_at';
const EVENT_COLUMNS =
  'id, region, title, description, starts_at, ends_at, source_url, verification_status, ' +
  'revision, deleted_at, created_at, updated_at';

/**
 * 布局矩形：只取「本页出现的布局实体」对应的页面 × 断点下**实例未墓碑**的行。
 *
 * 为什么用同一条 `PAGE_SCOPE_SQL` 而不是把所有页面的矩形都拉回来：矩形是 payload 里最大的
 * 部分，必须与变更页严格同页；而且它天然只覆盖本页需要的页面（没有 N+1 查询）。
 */
const LAYOUT_RECTS_SQL = `SELECT wi.page_id, wl.breakpoint, wl.widget_id, wl.x, wl.y, wl.w, wl.h
                            FROM widget_layouts wl
                            JOIN widget_instances wi ON wi.id = wl.widget_id
                           WHERE wi.workspace_id = ? AND wi.deleted_at IS NULL
                             AND (wi.page_id || ':' || wl.breakpoint) IN ${PAGE_SCOPE_SQL}
                           ORDER BY wi.page_id ASC, wl.breakpoint ASC, wl.widget_id ASC`;

/** 工作空间级导航修订号（行缺失等价于 0）。 */
const NAV_STATE_REVISION_SQL = 'SELECT revision FROM workspace_nav_state WHERE workspace_id = ?';
/** 工作空间级工作台修订号（行缺失等价于 0）。 */
const WORKBENCH_STATE_REVISION_SQL = 'SELECT revision FROM workspace_workbench_state WHERE workspace_id = ?';

/**
 * 本工作空间变更流的**当前水位**（`MAX(seq)`；没有任何变更时为 `NULL` → 按 0 处理）。
 *
 * 只在 `cursor === null`（`since` 缺省）的**重置**分支里使用：它就是客户端读完权威快照后
 * 应该带回的游标。刻意带 `workspace_id = ?`：水位必须**按工作空间各算各的**
 * （`seq` 是全局自增的，A 的水位绝不等于全局最大值）。
 */
const WORKSPACE_WATERMARK_SQL =
  'SELECT MAX(seq) AS max_seq FROM workspace_changes WHERE workspace_id = ?';

// ---------------------------------------------------------------------------
// 来源定义：journal 行 → 响应变更
// ---------------------------------------------------------------------------

/** 布局矩形的紧凑形状：`i` 是 widget 实例 ID（`widget_layouts.widget_id`）。 */
interface LayoutRectPayload {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface PayloadContext {
  /** key = `${pageId}\u0000${breakpoint}` → 该页面该断点下**实例未墓碑**的矩形。 */
  readonly layoutRects: ReadonlyMap<string, readonly LayoutRectPayload[]>;
}

/**
 * 一个同步来源：一条 payload 只读语句 + 行到 entity_id / payload 的映射。
 *
 * `op` 与 `revision` **不**从这里来：它们取变更日志那一行（见 `journalEntryOf`），
 * 因为日志才是「这次写入发生了什么」的权威事实；实体行只提供内容。
 * `payload` 只在 `op: 'upsert'` 时构造；墓碑的响应一定是 `payload: null`。
 *
 * 注意（与旧实现的差异）：页面被墓碑时，**不再**由布局行的 `p.deleted_at` 推导出 `delete`
 * ——布局的 `op` 同样只由日志决定。页面墓碑本身会产生一条 `page = delete` 日志，
 * 客户端据此移除页面（及其布局）；而「页面已墓碑之后再 bump 布局」时，
 * 0011 的布局触发器会按页面状态直接记 `delete`（见 `migrations/0011` 的 CASE 分支）。
 */
interface SyncSource {
  readonly entityType: SyncEntityType;
  /** payload 语句（绑定：`[workspaceId, ...PAGE_SCOPE_SQL 的 6 个绑定]`）。 */
  readonly payloadSql: string;
  /** 行 → 变更日志里的 `entity_id`（与触发器写入的表示**完全一致**）。 */
  entityIdOf(row: SyncRow): string;
  payloadOf(row: SyncRow, context: PayloadContext): unknown;
}

function layoutKeyOf(pageId: string, breakpoint: string): string {
  return `${pageId}\u0000${breakpoint}`;
}

/**
 * 所有来源，顺序与 `SYNC_ENTITY_TYPES` 一致（清单顺序也是契约的一部分）。
 *
 * 刻意**不**写一条巨型 UNION：每个来源的行形状与 payload 映射都不同，拼成一条 SQL
 * 会让「哪些列属于哪个来源」变得不可读、不可测；这里宁可多发几条索引查询，
 * 把复杂度留在可读的映射函数里。它们全部在同一个 `db.batch`（单个事务）里执行。
 */
const SOURCES: readonly SyncSource[] = [
  {
    entityType: 'page',
    payloadSql: `SELECT ${PAGE_COLUMNS} FROM workspace_pages
                  WHERE workspace_id = ? AND id IN ${PAGE_SCOPE_SQL}`,
    entityIdOf: (row) => textAt(row, 'id'),
    payloadOf: (row) => ({
      id: textAt(row, 'id'),
      name: textAt(row, 'name'),
      slug: textAt(row, 'slug'),
      isDefault: flagAt(row, 'is_default'),
      sortOrder: msAt(row, 'sort_order'),
      revision: msAt(row, 'revision'),
      deletedAt: nullableMsAt(row, 'deleted_at'),
      createdAt: msAt(row, 'created_at'),
      updatedAt: msAt(row, 'updated_at'),
      // 刻意不含 workspace_id：作用域由认证决定，客户端不需要（也不应）拿到它。
    }),
  },
  {
    entityType: 'widget',
    payloadSql: `SELECT ${WIDGET_COLUMNS} FROM widget_instances
                  WHERE workspace_id = ? AND id IN ${PAGE_SCOPE_SQL}`,
    entityIdOf: (row) => textAt(row, 'id'),
    payloadOf: (row) => {
      const config = parseJsonAt(textAt(row, 'config_json'));
      return {
        id: textAt(row, 'id'),
        pageId: textAt(row, 'page_id'),
        moduleId: textAt(row, 'module_id'),
        widgetType: textAt(row, 'widget_type'),
        // 组件配置是**用户数据**，客户端必须能重建实例，因此回传解析后的值；
        // 刻意不回传 config_json 字符串本身。
        config: config.parsed,
        // 显式区分「配置是 JSON null」与「配置文本已损坏」：前者是合法的用户数据，
        // 后者需要客户端明确知道（两者若都用 null 表达就是在伪造事实）。
        configParsed: config.ok,
        configVersion: msAt(row, 'config_version'),
        isHidden: flagAt(row, 'is_hidden'),
        revision: msAt(row, 'revision'),
        createdRevision: msAt(row, 'created_revision'),
        deletedAt: nullableMsAt(row, 'deleted_at'),
        createdAt: msAt(row, 'created_at'),
        updatedAt: msAt(row, 'updated_at'),
      };
    },
  },
  {
    entityType: 'layout',
    payloadSql: `SELECT ${LAYOUT_COLUMNS}
                   FROM page_layout_revisions r
                   JOIN workspace_pages p ON p.id = r.page_id
                  WHERE p.workspace_id = ? AND (r.page_id || ':' || r.breakpoint) IN ${PAGE_SCOPE_SQL}`,
    // 断点级身份：`pageId:breakpoint`（与共享契约的冲突示例 `page-1:desktop` 一致）。
    entityIdOf: (row) => `${textAt(row, 'page_id')}:${textAt(row, 'breakpoint')}`,
    payloadOf: (row, context) => {
      const pageId = textAt(row, 'page_id');
      const breakpoint = textAt(row, 'breakpoint');
      return {
        pageId,
        breakpoint,
        revision: msAt(row, 'revision'),
        // 只取实例**未墓碑**的矩形：已移除实例的矩形不属于可重建的布局事实。
        rects: context.layoutRects.get(layoutKeyOf(pageId, breakpoint)) ?? [],
      };
    },
  },
  {
    entityType: 'nav_link',
    payloadSql: `SELECT ${NAV_LINK_COLUMNS} FROM workspace_nav_links
                  WHERE workspace_id = ? AND id IN ${PAGE_SCOPE_SQL}`,
    entityIdOf: (row) => textAt(row, 'id'),
    payloadOf: (row) => ({
      id: textAt(row, 'id'),
      sourceCatalogId: nullableTextAt(row, 'source_catalog_id'),
      importedSourceVersion: nullableMsAt(row, 'imported_source_version'),
      title: textAt(row, 'title'),
      url: textAt(row, 'url'),
      description: textAt(row, 'description'),
      tags: parseStringArrayAt(textAt(row, 'tags_json')),
      aliases: parseStringArrayAt(textAt(row, 'aliases_json')),
      icon: textAt(row, 'icon'),
      openMode: textAt(row, 'open_mode'),
      region: textAt(row, 'region'),
      status: textAt(row, 'status'),
      isFavorite: flagAt(row, 'is_favorite'),
      sortOrder: msAt(row, 'sort_order'),
      health: textAt(row, 'health'),
      healthCheckedAt: nullableMsAt(row, 'health_checked_at'),
      revision: msAt(row, 'revision'),
      deletedAt: nullableMsAt(row, 'deleted_at'),
      createdAt: msAt(row, 'created_at'),
      updatedAt: msAt(row, 'updated_at'),
    }),
  },
  {
    entityType: 'nav_group',
    payloadSql: `SELECT ${NAV_GROUP_COLUMNS} FROM workspace_nav_groups
                  WHERE workspace_id = ? AND id IN ${PAGE_SCOPE_SQL}`,
    entityIdOf: (row) => textAt(row, 'id'),
    payloadOf: (row) => ({
      id: textAt(row, 'id'),
      name: textAt(row, 'name'),
      sortOrder: msAt(row, 'sort_order'),
      revision: msAt(row, 'revision'),
      deletedAt: nullableMsAt(row, 'deleted_at'),
      createdAt: msAt(row, 'created_at'),
      updatedAt: msAt(row, 'updated_at'),
    }),
  },
  {
    entityType: 'nav_membership',
    payloadSql: `SELECT ${NAV_MEMBERSHIP_COLUMNS} FROM workspace_nav_memberships
                  WHERE workspace_id = ? AND (link_id || ':' || group_id) IN ${PAGE_SCOPE_SQL}`,
    entityIdOf: (row) => `${textAt(row, 'link_id')}:${textAt(row, 'group_id')}`,
    payloadOf: (row) => ({
      linkId: textAt(row, 'link_id'),
      groupId: textAt(row, 'group_id'),
      sortOrder: msAt(row, 'sort_order'),
      deletedAt: nullableMsAt(row, 'deleted_at'),
      updatedAt: msAt(row, 'updated_at'),
    }),
  },
  {
    entityType: 'module',
    payloadSql: `SELECT ${MODULE_COLUMNS} FROM workspace_modules
                  WHERE workspace_id = ? AND module_id IN ${PAGE_SCOPE_SQL}`,
    entityIdOf: (row) => textAt(row, 'module_id'),
    payloadOf: (row) => {
      const settings = parseJsonAt(textAt(row, 'settings_json'));
      return {
        moduleId: textAt(row, 'module_id'),
        status: textAt(row, 'status'),
        revision: msAt(row, 'revision'),
        settingsVersion: msAt(row, 'settings_version'),
        settings: settings.parsed,
        // 与 widget.config 同一规则：显式区分「设置是 JSON null」与「设置文本已损坏」。
        settingsParsed: settings.ok,
        installedAt: msAt(row, 'installed_at'),
        enabledAt: nullableMsAt(row, 'enabled_at'),
        disabledAt: nullableMsAt(row, 'disabled_at'),
        uninstalledAt: nullableMsAt(row, 'uninstalled_at'),
        updatedAt: msAt(row, 'updated_at'),
      };
    },
  },
  {
    entityType: 'workspace_event',
    payloadSql: `SELECT ${EVENT_COLUMNS} FROM workspace_events
                  WHERE workspace_id = ? AND id IN ${PAGE_SCOPE_SQL}`,
    entityIdOf: (row) => textAt(row, 'id'),
    payloadOf: (row) => ({
      id: textAt(row, 'id'),
      region: textAt(row, 'region'),
      title: textAt(row, 'title'),
      description: textAt(row, 'description'),
      startsAt: msAt(row, 'starts_at'),
      endsAt: msAt(row, 'ends_at'),
      sourceUrl: nullableTextAt(row, 'source_url'),
      verificationStatus: textAt(row, 'verification_status'),
      revision: msAt(row, 'revision'),
      deletedAt: nullableMsAt(row, 'deleted_at'),
      createdAt: msAt(row, 'created_at'),
      updatedAt: msAt(row, 'updated_at'),
      // 刻意不含 created_by_device：设备级标识不是同步需要的信息。
    }),
  },
];

const SOURCE_BY_TYPE: ReadonlyMap<string, SyncSource> = new Map(
  SOURCES.map((source) => [source.entityType, source]),
);

// ---------------------------------------------------------------------------
// 服务实现
// ---------------------------------------------------------------------------

/** 变更日志的一行（`workspace_changes`），只保留读取所需的最小事实。 */
interface JournalEntry {
  readonly seq: number;
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly op: SyncChangeOp;
  readonly revision: number;
  readonly updatedAt: number;
}

function entityTypeAt(row: SyncRow): SyncEntityType {
  const raw = textAt(row, 'entity_type');
  const source = SOURCE_BY_TYPE.get(raw);
  if (source === undefined) {
    // 迁移的 CHECK 已经把取值锁死在契约清单内；走到这里说明库被绕过约束改写。
    throw new Error(`同步扫描：变更日志里的 entity_type 不在契约清单内（${raw}）`);
  }
  return source.entityType;
}

function opAt(row: SyncRow): SyncChangeOp {
  const raw = textAt(row, 'op');
  if (raw !== 'upsert' && raw !== 'delete') {
    throw new Error(`同步扫描：变更日志里的 op 非法（${raw}）`);
  }
  return raw;
}

/**
 * 变更日志的一行 → 响应变更。
 *
 * **唯一**事实来源是日志行：`seq`（排序/去重）、`op`（upsert / delete）、`revision`
 * （实体自身修订；成员关系在触发器里恒记 0）、`changed_at`（仅展示用）。
 * payload 只提供内容，不参与「谁更新」的判断——同一毫秒内的删除与恢复只能靠 seq 分先后。
 */
function journalEntryOf(row: SyncRow): JournalEntry {
  const entityId = textAt(row, 'entity_id');
  if (entityId.length > SYNC_ENTITY_ID_MAX_LENGTH) {
    // 宁可显式 500，也不发出一个过不了 `syncChangesResponseSchema` 的半成品响应，
    // 更不截断（截断会让两个不同实体映射到同一键，客户端去重会互相覆盖）。
    throw new Error(
      `同步扫描：变更日志里的 entity_id 超过契约上限（${String(entityId.length)} > ${String(SYNC_ENTITY_ID_MAX_LENGTH)}）`,
    );
  }
  return {
    seq: msAt(row, 'seq'),
    entityType: entityTypeAt(row),
    entityId,
    op: opAt(row),
    revision: msAt(row, 'revision'),
    updatedAt: msAt(row, 'changed_at'),
  };
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const now = deps.now ?? ((): number => Date.now());

  return {
    async listChanges(input) {
      const { workspaceId, limit } = input;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError('sync.listChanges：limit 必须是正整数（请求校验由路由层负责）');
      }
      const requestSeq = input.cursor;

      /**
       * `since` 缺省（`cursor === null`）：**重置协议**——不返回历史变更，只给出稳定水位。
       *
       * 为什么**绝不**在这里扫描历史（本缺陷的根因）：`payload` 是**当前**实体内容，
       * 而日志条目是**历史事件**，把整段历史回放到「已经是当前状态」的本地副本上
       * 会误删已恢复的行（详见文件头「禁止从 0 回放历史」）。因此这里只做一件事：
       * 在**一个** batch（= 一个事务快照）里读本工作空间的 `MAX(seq)` 与两个全局修订号，
       * 让客户端先拿权威快照、再用返回的游标取**真实增量**。
       */
      if (requestSeq === null) {
        const results = await deps.db.batch([
          deps.db.prepare(WORKSPACE_WATERMARK_SQL).bind(workspaceId),
          deps.db.prepare(NAV_STATE_REVISION_SQL).bind(workspaceId),
          deps.db.prepare(WORKBENCH_STATE_REVISION_SQL).bind(workspaceId),
        ]);
        const watermarkRow = (results[0]?.results ?? [])[0] as SyncRow | undefined;
        // `MAX(seq)` 在空工作空间返回 NULL：按 0 处理（= 从 v2:0 开始就是全量）。
        const watermark = watermarkRow === undefined ? 0 : (nullableMsAt(watermarkRow, 'max_seq') ?? 0);
        const navRevisionRow = (results[1]?.results ?? [])[0] as SyncRow | undefined;
        const workbenchRevisionRow = (results[2]?.results ?? [])[0] as SyncRow | undefined;

        // 复用唯一实现 `nextSyncCursor`：returned=0 ⇒ 游标原地停在「当前水位」、hasMore=false。
        const advanced = nextSyncCursor({
          returned: 0,
          limit,
          lastSeq: null,
          requestSeq: watermark,
        });

        return {
          // 历史一律不投递：客户端必须先读一次权威快照（这就是 resetRequired 的含义）。
          changes: [],
          nextCursor: advanced.nextCursor,
          hasMore: false,
          resetRequired: true,
          serverTimeMs: now(),
          entityTypes: [...SYNC_ENTITY_TYPES],
          meta: {
            navRevision: navRevisionRow === undefined ? 0 : msAt(navRevisionRow, 'revision'),
            workbenchRevision:
              workbenchRevisionRow === undefined ? 0 : msAt(workbenchRevisionRow, 'revision'),
            // 水位 = 本工作空间当前 `MAX(seq)`：客户端读完快照后原样带回即可取增量。
            watermark,
          },
        };
      }

      const fromSeq = requestSeq;
      // 这一组绑定对应 `PAGE_SCOPE_SQL` 的六个占位符（见其文档）。
      const scopeBinds: readonly unknown[] = [
        workspaceId,
        fromSeq,
        workspaceId,
        fromSeq,
        limit - 1,
        workspaceId,
      ];

      /**
       * 一个 batch = 一个事务快照：变更页、各实体 payload、布局矩形与 meta 全部同时读出。
       * 若分开读，「A 已读、B 未读」之间发生的写入就可能落在两次读之间而被水位跳过。
       */
      const results = await deps.db.batch([
        deps.db.prepare(CHANGES_PAGE_SQL).bind(workspaceId, fromSeq, limit),
        ...SOURCES.map((source) => deps.db.prepare(source.payloadSql).bind(workspaceId, ...scopeBinds)),
        deps.db.prepare(LAYOUT_RECTS_SQL).bind(workspaceId, ...scopeBinds),
        deps.db.prepare(NAV_STATE_REVISION_SQL).bind(workspaceId),
        deps.db.prepare(WORKBENCH_STATE_REVISION_SQL).bind(workspaceId),
      ]);

      const journalRows = (results[0]?.results ?? []) as SyncRow[];
      const entries = journalRows.map((row) => journalEntryOf(row));

      // payload 按「来源 entityId → 行」索引：同页里同一实体可能有多条日志
      // （例如先墓碑后恢复），它们共用同一行内容；`delete` 一律不给 payload。
      const payloadRowsByType = new Map<SyncEntityType, Map<string, SyncRow>>();
      for (const [position, source] of SOURCES.entries()) {
        const rows = (results[1 + position]?.results ?? []) as SyncRow[];
        const index = new Map<string, SyncRow>();
        for (const row of rows) {
          index.set(source.entityIdOf(row), row);
        }
        payloadRowsByType.set(source.entityType, index);
      }

      const layoutRects = new Map<string, LayoutRectPayload[]>();
      const rectRows = (results[1 + SOURCES.length]?.results ?? []) as SyncRow[];
      for (const row of rectRows) {
        const key = layoutKeyOf(textAt(row, 'page_id'), textAt(row, 'breakpoint'));
        const rect: LayoutRectPayload = {
          i: textAt(row, 'widget_id'),
          x: msAt(row, 'x'),
          y: msAt(row, 'y'),
          w: msAt(row, 'w'),
          h: msAt(row, 'h'),
        };
        const existing = layoutRects.get(key);
        if (existing === undefined) {
          layoutRects.set(key, [rect]);
        } else {
          existing.push(rect);
        }
      }
      const context: PayloadContext = { layoutRects };

      const changes: SyncChange[] = entries.map((entry) => {
        const source = SOURCE_BY_TYPE.get(entry.entityType);
        if (source === undefined) {
          throw new Error(`同步扫描：缺少来源实现（${entry.entityType}）`);
        }
        if (entry.op === 'delete') {
          // 墓碑只带身份与修订：不重复传内容（并显式给出 payload 键）。
          return { ...entry, payload: null };
        }
        const row = payloadRowsByType.get(entry.entityType)?.get(entry.entityId);
        if (row === undefined) {
          // 所有业务表都用墓碑而非硬删除，因此「日志说 upsert 但行不在」只可能是数据损坏：
          // 明确抛错，而不是伪造一份内容或悄悄改判成 delete。
          throw new Error(`同步扫描：变更日志 ${String(entry.seq)} 指向的 ${entry.entityType} 行不存在`);
        }
        return { ...entry, payload: source.payloadOf(row, context) };
      });

      const navRevisionRow = (results[1 + SOURCES.length + 1]?.results ?? [])[0] as SyncRow | undefined;
      const workbenchRevisionRow = (results[1 + SOURCES.length + 2]?.results ?? [])[0] as
        | SyncRow
        | undefined;
      const lastSeq = entries.at(-1)?.seq ?? null;
      const advanced = nextSyncCursor({
        returned: entries.length,
        limit,
        lastSeq,
        requestSeq,
      });

      return {
        changes,
        nextCursor: advanced.nextCursor,
        hasMore: advanced.hasMore,
        // 有游标 ⇒ 客户端已经有（或即将先读）权威快照，本轮投递的就是真实增量。
        resetRequired: false,
        serverTimeMs: now(),
        entityTypes: [...SYNC_ENTITY_TYPES],
        meta: {
          // 行缺失等价于 0（与 `workspace_nav_state` / `workspace_workbench_state` 的约定一致）。
          navRevision: navRevisionRow === undefined ? 0 : msAt(navRevisionRow, 'revision'),
          workbenchRevision:
            workbenchRevisionRow === undefined ? 0 : msAt(workbenchRevisionRow, 'revision'),
          // 水位 = 本页最后一条 seq；没有变更时就是请求游标（本轮什么都没前移）。
          watermark: lastSeq ?? fromSeq,
        },
      };
    },
  };
}
