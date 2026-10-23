/** SQL 查询、行投影和变更语句工厂。与业务调度隔离，保留原 CAS/事务 SQL 语义。 */
import {navCatalogEntrySchema} from '@ff14-hub/shared';
import type {NavCatalogEntry,NavGroup,NavLink,NavMembership,NavOpenMode,NavRegion,NavLinkStatus} from '@ff14-hub/shared';
import type {NavCatalogRow} from './catalog';
import type {NavStatement} from './tx';

// ---------------------------------------------------------------------------
// 行形状（与 migrations/0008_navigation.sql 的列一一对应）
// ---------------------------------------------------------------------------

export interface NavLinkRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly source_catalog_id: string | null;
  readonly imported_source_version: number | null;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly tags_json: string;
  readonly aliases_json: string;
  readonly icon: string;
  readonly open_mode: string;
  readonly region: string;
  readonly status: string;
  readonly is_favorite: number;
  readonly sort_order: number;
  readonly health: string;
  readonly health_checked_at: number | null;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface NavGroupRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface NavMembershipRow {
  readonly link_id: string;
  readonly group_id: string;
  readonly workspace_id: string;
  readonly sort_order: number;
  readonly deleted_at: number | null;
  readonly updated_at: number;
}

const LINK_COLUMNS =
  'id, workspace_id, source_catalog_id, imported_source_version, title, url, description, ' +
  'tags_json, aliases_json, icon, open_mode, region, status, is_favorite, sort_order, health, ' +
  'health_checked_at, revision, deleted_at, created_at, updated_at';
const GROUP_COLUMNS = 'id, workspace_id, name, sort_order, revision, deleted_at, created_at, updated_at';
export const MEMBERSHIP_COLUMNS = 'link_id, group_id, workspace_id, sort_order, deleted_at, updated_at';

/** 防御性解析：一个坏 JSON 值不应让整个接口 500，但也不能凭空造出标签（与工作台 internal.ts 同策略）。 */
export function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/** 行 → 契约链接。枚举列由迁移的 CHECK 约束保证取值，这里只做一次显式窄化（不用断言）。 */
export function toNavLink(row: NavLinkRow): NavLink {
  return {
    id: row.id,
    sourceCatalogId: row.source_catalog_id,
    importedSourceVersion: row.imported_source_version,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: parseStringArray(row.tags_json),
    aliases: parseStringArray(row.aliases_json),
    icon: row.icon,
    openMode: row.open_mode === 'same_tab' ? 'same_tab' : 'new_tab',
    region: toRegion(row.region),
    status: row.status === 'archived' ? 'archived' : 'active',
    isFavorite: row.is_favorite === 1,
    sortOrder: row.sort_order,
    health: toHealth(row.health),
    healthCheckedAt: row.health_checked_at,
    revision: row.revision,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRegion(value: string): NavRegion {
  return value === 'global' || value === 'both' ? value : 'cn';
}

function toHealth(value: string): NavLink['health'] {
  return value === 'ok' || value === 'maybe_blocked' || value === 'unreachable' ? value : 'unknown';
}

export function toNavGroup(row: NavGroupRow): NavGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    revision: row.revision,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toNavMembership(row: NavMembershipRow): NavMembership {
  return {
    linkId: row.link_id,
    groupId: row.group_id,
    sortOrder: row.sort_order,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 只读查询（全部带 workspace_id）
// ---------------------------------------------------------------------------


/**
 * 目录关联行（**含墓碑**）。
 *
 * 为什么需要它：快照刻意只返回活跃行，但「这条目录条目被你删除过」这个状态只有墓碑能证明。
 * 若让前端拿活跃快照去算目录状态，被删掉的条目会被显示成「尚未导入」并默认勾选，
 * 用户点导入却什么都不会发生——界面在误导人（复核发现的真实缺陷）。
 * 因此服务端在这里（也只有这里）读墓碑，只用于**计算目录状态投影**，不进入 links 数组。
 *
 * 读取语句常量：它必须与快照的其它语句待在**同一个 batch** 里（见 `readSnapshotBatch`，
 * 那里解释了为什么「分别读」在并发写入下会产生自相矛盾的结果）。
 */
const CATALOG_LINKED_ROWS_SQL =
  `SELECT ${LINK_COLUMNS} FROM workspace_nav_links
    WHERE workspace_id = ? AND source_catalog_id IS NOT NULL`;

/** 快照 / 导出所需的**全部**读取语句常量。顺序必须与 `readSnapshotBatch` 的解构一一对应。 */
const ACTIVE_LINK_ROWS_SQL =
  `SELECT ${LINK_COLUMNS} FROM workspace_nav_links
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC, id ASC`;
const ACTIVE_GROUP_ROWS_SQL =
  `SELECT ${GROUP_COLUMNS} FROM workspace_nav_groups
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC, id ASC`;
const ACTIVE_MEMBERSHIP_ROWS_SQL =
  `SELECT ${MEMBERSHIP_COLUMNS} FROM workspace_nav_memberships
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY sort_order ASC, link_id ASC, group_id ASC`;
const NAV_STATE_REVISION_SQL = 'SELECT revision FROM workspace_nav_state WHERE workspace_id = ?';
const CATALOG_SOURCE_VERSION_SQL = 'SELECT COALESCE(MAX(source_version), 0) AS value FROM nav_catalog_links';
/**
 * 快照的**原子同步水位**：本工作空间变更流的 `MAX(seq)`（没有任何变更时为 0）。
 *
 * 与 `modules/sync/service.ts` 的 `WORKSPACE_WATERMARK_SQL` 是**同一条事实的第二个读取点**
 * （那边用于 reset 协议的 `meta.watermark`）；这里刻意写成 `COALESCE(...)`，因为快照契约
 * （共享 `navSnapshotSchema.watermark`）是**必填非负整数**，不接受 NULL——空工作空间的水位
 * 必须显式是 `0`，否则客户端拿不到可用的游标。
 *
 * 它**只能**在 `readSnapshotBatch` 的同一个 batch 里读：单独读一次就等于引入两个观察时刻
 * （见那里的原子性论证）。
 */
const WATERMARK_SQL =
  'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM workspace_changes WHERE workspace_id = ?';
/** 目录条目列（与 `modules/nav/catalog.ts` 的 `CATALOG_COLUMNS` 逐列一致）。 */
const CATALOG_ENTRY_ROWS_SQL =
  `SELECT id, source_version, title, url, description, category, tags_json, aliases_json, icon,
          open_mode, region, sort_order, source_url, source_name, verified_at, verification_status, updated_at
     FROM nav_catalog_links
    ORDER BY sort_order ASC, id ASC`;

/**
 * 目录行 → 契约对象。
 *
 * 为什么服务层也要有一份（而不是只调 `catalog.ts` 的 `toCatalogEntry`）：快照 / 目录导入的
 * **全部**读取必须待在同一个 batch 里，而 batch 需要语句**常量**，因此这里把「列清单 + 行投影」
 * 一并落地；判定标准与 `catalog.ts` 完全一致（严格 Schema，不合法即抛错，绝不把可疑的
 * 推荐内容当作事实返回）。`catalog.ts` 仍是该表唯一的**写**入口。
 */
function toBatchCatalogEntry(row: NavCatalogRow): NavCatalogEntry {
  const parsed = navCatalogEntrySchema.safeParse({
    id: row.id,
    sourceVersion: row.source_version,
    title: row.title,
    url: row.url,
    description: row.description,
    category: row.category,
    tags: parseStringArray(row.tags_json),
    aliases: parseStringArray(row.aliases_json),
    icon: row.icon,
    openMode: row.open_mode,
    region: row.region,
    sortOrder: row.sort_order,
    sourceUrl: row.source_url,
    sourceName: row.source_name,
    verifiedAt: row.verified_at,
    verificationStatus: row.verification_status,
    updatedAt: row.updated_at,
  });
  if (!parsed.success) {
    // 不把行内容写进错误消息（可能被日志链路带出去），只给出 ID。
    throw new Error(`目录行不符合契约：${row.id}`);
  }
  return parsed.data;
}

/** 单条活跃链接；不属于本工作空间时返回 null（调用方据此给 404）。 */
export async function readLinkRow(db: D1Database, workspaceId: string, linkId: string): Promise<NavLinkRow | null> {
  return await db
    .prepare(`SELECT ${LINK_COLUMNS} FROM workspace_nav_links WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .bind(linkId, workspaceId)
    .first<NavLinkRow>();
}

export async function readGroupRows(db: D1Database, workspaceId: string): Promise<NavGroupRow[]> {
  const result = await db.prepare(ACTIVE_GROUP_ROWS_SQL).bind(workspaceId).all<NavGroupRow>();
  return result.results;
}

export async function readGroupRow(db: D1Database, workspaceId: string, groupId: string): Promise<NavGroupRow | null> {
  return await db
    .prepare(`SELECT ${GROUP_COLUMNS} FROM workspace_nav_groups WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .bind(groupId, workspaceId)
    .first<NavGroupRow>();
}

/** 工作空间级导航修订号（行缺失等价于 0）。**单独**读只用于只读/解释路径，决策路径必须用批次里的值。 */
export async function readNavStateRevision(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(NAV_STATE_REVISION_SQL)
    .bind(workspaceId)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

/**
 * 带目录来源的链接行（**含墓碑**）的读取语句：目录导入决策要区分 `unchanged` 与 `tombstoned`。
 *
 * 为什么读全量再在内存里按目录 ID 分组：`source_catalog_id` 只可能是系统种子里的少量 ID
 * （「每个目录条目至多一条活跃副本」是数据库约束），因此这个集合天然很小；
 * 而拼 `IN (?, ?, …)` 会按请求长度生成 SQL 文本。两条路都不需要复杂查询。
 * 它只出现在 `readCatalogImportBatch` 的语句常量里（不能单独读：决策必须与 CAS 基准同批）。
 */
const CATALOG_SOURCED_LINK_ROWS_SQL =
  `SELECT ${LINK_COLUMNS} FROM workspace_nav_links
    WHERE workspace_id = ? AND source_catalog_id IS NOT NULL
    ORDER BY deleted_at IS NULL DESC, updated_at DESC, id ASC`;

// ---------------------------------------------------------------------------
// 一致快照读取（单 batch）
// ---------------------------------------------------------------------------

/** 从一个 batch 结果里取出行数组；`index` 越界时返回空数组（而不是抛错）。 */
function rowsAt<T>(results: readonly D1Result<unknown>[], index: number): T[] {
  const result = results[index];
  return result === undefined ? [] : (result.results as T[]);
}

/**
 * 快照 / 导出**唯一**的读取入口：活跃链接 + 活跃分组 + 活跃成员关系 + 工作空间修订号 +
 * 目录版本 + 变更流水位 + 目录条目 + 目录关联行（含墓碑），全部在**一个 `db.batch`** 内读出。
 *
 * ── 为什么必须是同一个 batch（复核发现的真实缺陷）─────────────────────────────
 * `batch` 在 D1 里是**单个事务**，因此这一批语句看到的是同一个数据库状态；而分别读
 * （`Promise.all` 若干条独立查询）在并发写入下可以组合出「旧行 + 新 revision」：
 * 例如成员关系读在「分组墓碑化」之前、而活跃分组读在它之后，导出文档里就会留下
 * 指向已删除分组的**悬空成员关系**；目录导入也会按旧墓碑做出「用户没删过」的错误决策。
 * 因此这里宁可多一次 batch，也不允许任何决策建立在两个不同时刻的读之上。
 *
 * ── 为什么水位也必须进这一批（第四轮复核修正的竞态）──────────────────────────
 * 客户端此前先用 `GET /me/sync/changes`（无 `since`）拿水位 W，再 `GET /me/navigation` 读快照 S；
 * 若两个请求之间远端做了「`delete(W+1)` → 显式恢复 `(W+2)`」，S **已经**包含恢复后的链接与
 * 成员关系，但客户端仍会收到 W+1 的历史 `delete` 并把它应用上去——把刚恢复的数据删掉。
 * 根因是**请求发起顺序不能证明数据库观察顺序**：W 与 S 来自两个不同的观察时刻。
 * 把 `MAX(seq)` 放进**同一个 batch** 之后，S 自带「S 是站在哪个水位上读出来的」这一事实，
 * 客户端只需把游标设成 `S.watermark`，W+1 那条历史 `delete` 就落在游标**之后**、永不被应用。
 *
 * ── 原子性论证（为什么 `watermark` 一定 ≥ 快照里任何一行的最新变更 seq）─────────
 * 设某行 R 出现在本批快照里，其最近一次写入的变更日志序号为 N（即 R 的最新状态由 seq=N
 * 那次写入产生）。由于：
 *   ① 迁移 0011 的 `AFTER INSERT/UPDATE` 触发器把变更行写进 `workspace_changes`，它与业务
 *      写入处于**同一个事务**（触发器内的 DML 属于该语句所在事务），二者要么一起提交、要么
 *      一起回滚；
 *   ② 本批语句是**一个事务**，看到的是同一个数据库状态——既然 R 的最新状态可见，那么产生该
 *      状态的变更行 N 也必然已提交可见（它们同事务）；
 *   ③ `seq` 是 AUTOINCREMENT 主键（只增不减、不复用），且 `MAX(seq)` 按 `workspace_id` 过滤，
 * 因此本批里读到的 `MAX(seq) ≥ N` 对快照里的**每一行**都成立。「内容更新 ⇒ 水位更大」不是断言，
 * 而是①②③的直接推论：先 `delete(W+1)` 再恢复 `(W+2)` 之后，快照里的链接是恢复后的活跃行，
 * 它的最新变更 seq 是 W+2，于是同批读到的水位必然 ≥ W+2（而不是 W）。
 *
 * 只读「活跃行」的语义**没有改变**：`links` / `groups` / `memberships` 仍只含未删除行；
 * `catalogLinked` 含墓碑，但仅用于目录状态投影与目录导入判定，绝不进入用户快照。
 */
export async function readSnapshotBatch(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly withCatalog: boolean;
}): Promise<{
  readonly linkRows: NavLinkRow[];
  readonly groupRows: NavGroupRow[];
  readonly membershipRows: NavMembershipRow[];
  readonly revision: number;
  readonly watermark: number;
  readonly catalogSourceVersion: number;
  readonly catalogRows: NavCatalogEntry[];
  readonly catalogLinkedRows: NavLinkRow[];
}> {
  const { db, workspaceId, withCatalog } = input;
  const statements: D1PreparedStatement[] = [
    db.prepare(ACTIVE_LINK_ROWS_SQL).bind(workspaceId),
    db.prepare(ACTIVE_GROUP_ROWS_SQL).bind(workspaceId),
    db.prepare(ACTIVE_MEMBERSHIP_ROWS_SQL).bind(workspaceId),
    db.prepare(NAV_STATE_REVISION_SQL).bind(workspaceId),
    db.prepare(CATALOG_SOURCE_VERSION_SQL),
    // 水位与上面的内容、revision 同批（同一事务）：这是「快照自带水位」的全部机制。
    db.prepare(WATERMARK_SQL).bind(workspaceId),
  ];
  if (withCatalog) {
    statements.push(
      db.prepare(CATALOG_ENTRY_ROWS_SQL),
      db.prepare(CATALOG_LINKED_ROWS_SQL).bind(workspaceId),
    );
  }
  const results = await db.batch<unknown>(statements);
  const catalogSourceVersion = rowsAt<{ value: number }>(results, 4)[0]?.value ?? 0;
  return {
    linkRows: rowsAt<NavLinkRow>(results, 0),
    groupRows: rowsAt<NavGroupRow>(results, 1),
    membershipRows: rowsAt<NavMembershipRow>(results, 2),
    revision: rowsAt<{ revision: number }>(results, 3)[0]?.revision ?? 0,
    catalogSourceVersion,
    // `COALESCE(MAX(seq), 0)` 保证这一行一定存在；`?? 0` 只是防御（空工作空间的水位是 0）。
    watermark: rowsAt<{ max_seq: number }>(results, 5)[0]?.max_seq ?? 0,
    catalogRows: withCatalog ? rowsAt<NavCatalogRow>(results, 6).map(toBatchCatalogEntry) : [],
    catalogLinkedRows: withCatalog ? rowsAt<NavLinkRow>(results, 7) : [],
  };
}

/** 导入规划所需的最小一致读取：活跃链接 + 活跃分组 + 工作空间修订号（单 batch）。 */
export async function readImportPlanBatch(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
}): Promise<{
  readonly linkRows: NavLinkRow[];
  readonly groupRows: NavGroupRow[];
  readonly revision: number;
}> {
  const { db, workspaceId } = input;
  const results = await db.batch<unknown>([
    db.prepare(ACTIVE_LINK_ROWS_SQL).bind(workspaceId),
    db.prepare(ACTIVE_GROUP_ROWS_SQL).bind(workspaceId),
    db.prepare(NAV_STATE_REVISION_SQL).bind(workspaceId),
  ]);
  return {
    linkRows: rowsAt<NavLinkRow>(results, 0),
    groupRows: rowsAt<NavGroupRow>(results, 1),
    revision: rowsAt<{ revision: number }>(results, 2)[0]?.revision ?? 0,
  };
}

/**
 * **写路径**的前置条件读取：活跃链接 + 活跃分组 + 导航修订号，同样来自**一个 batch**。
 *
 * 为什么写路径也要一致快照（复核发现的同类缺陷）：`createLink` / `updateLink` / `reorderLinks` /
 * `reorderGroups` 此前是「读链接（Promise.all）读分组（另一次查询）读修订号（又一次查询）」，
 * 期间并发写入能组合出「旧行 + 新 revision」，于是容量判定、集合判定与 CAS 基准可能互相矛盾：
 * 要么按旧集合拒绝一次合法重排，要么按旧 revision 放行一次本该 409 的写入。
 * 现在这三样都在同一个事务里读，CAS 基准就是判定所用的同一个观察值。
 */
export async function readWritePrecondition(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
}): Promise<{
  readonly linkRows: NavLinkRow[];
  readonly groupRows: NavGroupRow[];
  readonly revision: number;
}> {
  return await readImportPlanBatch(input);
}

/**
 * 目录导入规划所需的一致读取：目录条目 + 目录关联行（**含墓碑**）+ 活跃分组 + 活跃链接 +
 * 工作空间修订号（单 batch）。
 *
 * 「决策」与「CAS 基准」必须来自同一批：否则会出现「按旧 revision 判定的墓碑/个人修改」
 * 被写进以新 revision 为前提的事务里——那正是复核发现的『旧行 + 新 revision』。
 */
export async function readCatalogImportBatch(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly catalogIds: readonly string[];
}): Promise<{
  readonly catalogById: Map<string, NavCatalogEntry>;
  readonly sourcedRows: NavLinkRow[];
  readonly groupRows: NavGroupRow[];
  readonly linkRows: NavLinkRow[];
  readonly revision: number;
}> {
  const { db, workspaceId, catalogIds } = input;
  const results = await db.batch<unknown>([
    db.prepare(CATALOG_ENTRY_ROWS_SQL),
    db.prepare(CATALOG_SOURCED_LINK_ROWS_SQL).bind(workspaceId),
    db.prepare(ACTIVE_GROUP_ROWS_SQL).bind(workspaceId),
    db.prepare(ACTIVE_LINK_ROWS_SQL).bind(workspaceId),
    db.prepare(NAV_STATE_REVISION_SQL).bind(workspaceId),
  ]);
  const wanted = new Set(catalogIds);
  const catalogById = new Map<string, NavCatalogEntry>();
  for (const entry of rowsAt<NavCatalogRow>(results, 0)) {
    if (wanted.has(entry.id)) {
      catalogById.set(entry.id, toBatchCatalogEntry(entry));
    }
  }
  return {
    catalogById,
    sourcedRows: rowsAt<NavLinkRow>(results, 1),
    groupRows: rowsAt<NavGroupRow>(results, 2),
    linkRows: rowsAt<NavLinkRow>(results, 3),
    revision: rowsAt<{ revision: number }>(results, 4)[0]?.revision ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 写入语句
// ---------------------------------------------------------------------------

/** 工作空间级修订号 +1（行缺失等价于 0，因此先插 0 再 +1，首次 bump 结果恰为 1）。 */
export function bumpNavStateStatements(input: { readonly workspaceId: string; readonly now: number }): NavStatement[] {
  return [
    {
      sql: `INSERT INTO workspace_nav_state (workspace_id, revision, updated_at)
            SELECT ?, 0, ?
             WHERE NOT EXISTS (SELECT 1 FROM workspace_nav_state s WHERE s.workspace_id = ?)`,
      binds: [input.workspaceId, input.now, input.workspaceId],
    },
    {
      sql: `UPDATE workspace_nav_state SET revision = revision + 1, updated_at = ?
             WHERE workspace_id = ?`,
      binds: [input.now, input.workspaceId],
    },
  ];
}

/**
 * 新建链接（`WHERE 1 = 1` 供账本守卫追加；INSERT…SELECT 不能以 VALUES 形式追加条件）。
 *
 * `health` / `healthCheckedAt` 可显式给出：restore 导入必须**保留**用户的功能字段，
 * 而健康状态是「阶段 04 不做服务端探测」的唯一例外——它一律按 `unknown` / `null` 写入
 * （导入不复活任何探测结论）。默认值即这两个，因此其它调用点不需要感知该参数。
 */
export function insertLinkStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceCatalogId: string | null;
  readonly importedSourceVersion: number | null;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly icon: string;
  readonly openMode: NavOpenMode;
  readonly region: NavRegion;
  readonly status: NavLinkStatus;
  readonly isFavorite: boolean;
  readonly sortOrder: number;
  readonly health?: NavLink['health'];
  readonly healthCheckedAt?: number | null;
  readonly now: number;
}): NavStatement {
  const health = input.health ?? 'unknown';
  const healthCheckedAt = input.healthCheckedAt ?? null;
  return {
    sql: `INSERT INTO workspace_nav_links
            (id, workspace_id, source_catalog_id, imported_source_version, title, url, description,
             tags_json, aliases_json, icon, open_mode, region, status, is_favorite, sort_order,
             health, health_checked_at, revision, deleted_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?
           WHERE 1 = 1`,
    binds: [
      input.id,
      input.workspaceId,
      input.sourceCatalogId,
      input.importedSourceVersion,
      input.title,
      input.url,
      input.description,
      JSON.stringify(input.tags),
      JSON.stringify(input.aliases),
      input.icon,
      input.openMode,
      input.region,
      input.status,
      input.isFavorite ? 1 : 0,
      input.sortOrder,
      health,
      healthCheckedAt,
      input.now,
      input.now,
    ],
  };
}

/** 覆盖链接内容（含乐观并发条件）。`revision = revision + 1` 是唯一的修订推进方式。 */
export function updateLinkContentStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly icon: string;
  readonly openMode: NavOpenMode;
  readonly region: NavRegion;
  readonly status: NavLinkStatus;
  readonly isFavorite: boolean;
  readonly sortOrder: number;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_links
             SET title = ?, url = ?, description = ?, tags_json = ?, aliases_json = ?, icon = ?,
                 open_mode = ?, region = ?, status = ?, is_favorite = ?, sort_order = ?,
                 revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [
      input.title,
      input.url,
      input.description,
      JSON.stringify(input.tags),
      JSON.stringify(input.aliases),
      input.icon,
      input.openMode,
      input.region,
      input.status,
      input.isFavorite ? 1 : 0,
      input.sortOrder,
      input.now,
      input.id,
      input.workspaceId,
      input.expectedRevision,
    ],
  };
}

/** 墓碑化链接（行保留，`deleted_at` 非空；跨设备同步据此下发 `op: 'delete'`）。 */
export function tombstoneLinkStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_links
             SET deleted_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [input.now, input.now, input.id, input.workspaceId, input.expectedRevision],
  };
}

/** 新建分组。 */
export function insertGroupStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly now: number;
}): NavStatement {
  return {
    sql: `INSERT INTO workspace_nav_groups (id, workspace_id, name, sort_order, revision, deleted_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, 0, NULL, ?, ?
           WHERE 1 = 1`,
    binds: [input.id, input.workspaceId, input.name, input.sortOrder, input.now, input.now],
  };
}

/** 改分组名 / 手动顺序（乐观并发）。 */
export function updateGroupStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly name: string;
  readonly sortOrder: number;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_groups
             SET name = ?, sort_order = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [input.name, input.sortOrder, input.now, input.id, input.workspaceId, input.expectedRevision],
  };
}

/** 墓碑化分组。 */
export function tombstoneGroupStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_groups
             SET deleted_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [input.now, input.now, input.id, input.workspaceId, input.expectedRevision],
  };
}

/** 墓碑化某个链接的全部活跃成员关系（删除链接时用）。 */
export function tombstoneMembershipsOfLinkStatement(input: {
  readonly linkId: string;
  readonly workspaceId: string;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_memberships SET deleted_at = ?, updated_at = ?
           WHERE link_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    binds: [input.now, input.now, input.linkId, input.workspaceId],
  };
}

/** 墓碑化某个分组的全部活跃成员关系（删除分组时用；链接本身保留）。 */
export function tombstoneMembershipsOfGroupStatement(input: {
  readonly groupId: string;
  readonly workspaceId: string;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_memberships SET deleted_at = ?, updated_at = ?
           WHERE group_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    binds: [input.now, input.now, input.groupId, input.workspaceId],
  };
}

/** 移除一个具体成员关系（墓碑；已经墓碑化的行不再改动 updated_at，保证同步幂等）。 */
export function tombstoneMembershipStatement(input: {
  readonly linkId: string;
  readonly groupId: string;
  readonly workspaceId: string;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_memberships SET deleted_at = ?, updated_at = ?
           WHERE link_id = ? AND group_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    binds: [input.now, input.now, input.linkId, input.groupId, input.workspaceId],
  };
}

/**
 * 「补插缺失的成员关系」这一条语句（revive 墓碑那一条由调用方自行决定是否一起入批）。
 *
 * 用 `FROM workspace_nav_links l JOIN workspace_nav_groups g
 * ON l.workspace_id = g.workspace_id` 取行：**在同一事务内**保证成员关系的
 * `workspace_id` 与链接、分组两行的 `workspace_id` 相同（ADR-0004 D2 的硬要求，
 * 外键证明不了这一点）。跨工作空间分组在这里取不到任何行，因此写不进去。
 * `NOT EXISTS` 让已存在的行不被重复插入（主键是 (link_id, group_id)）。
 */
export function insertMembershipStatement(input: {
  readonly linkId: string;
  readonly groupId: string;
  readonly workspaceId: string;
  readonly sortOrder: number;
  readonly now: number;
}): NavStatement {
  return {
    sql: `INSERT INTO workspace_nav_memberships (link_id, group_id, workspace_id, sort_order, deleted_at, updated_at)
          SELECT l.id, g.id, l.workspace_id, ?, NULL, ?
            FROM workspace_nav_links l
            JOIN workspace_nav_groups g
              ON g.id = ? AND g.workspace_id = l.workspace_id AND g.deleted_at IS NULL
           WHERE l.id = ? AND l.workspace_id = ? AND l.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM workspace_nav_memberships m
                              WHERE m.link_id = l.id AND m.group_id = g.id)`,
    binds: [input.sortOrder, input.now, input.groupId, input.linkId, input.workspaceId],
  };
}

/**
 * 「把链接加入分组」的两条语句（复活墓碑 + 不存在才插入）。
 *
 * 为什么不用 `INSERT … ON CONFLICT (link_id, group_id) DO UPDATE`：账本的守卫 SQL 是
 * **追加在语句末尾**的（`guardedStatements` 的契约），而 upsert 的 `ON CONFLICT` 子句必须
 * 位于 `WHERE` 之后、语句末尾之前——守卫一旦被追加到 upsert 之后就变成语法错误。
 * 因此改成两条语义等价的语句：先复活（UPDATE 命中已存在的行，含墓碑），再补插缺失的行。
 * 两条都带守卫，仍处于同一个原子 batch 内。
 */
export function addMembershipStatements(input: {
  readonly linkId: string;
  readonly groupId: string;
  readonly workspaceId: string;
  readonly sortOrder: number;
  readonly now: number;
}): NavStatement[] {
  return [
    {
      sql: `UPDATE workspace_nav_memberships SET deleted_at = NULL, sort_order = ?, updated_at = ?
             WHERE link_id = ? AND group_id = ? AND workspace_id = ?`,
      binds: [input.sortOrder, input.now, input.linkId, input.groupId, input.workspaceId],
    },
    insertMembershipStatement(input),
  ];
}

/** 组内顺序与链接手动顺序保持一致（reorder 时同步刷新，避免成员关系上的顺序陈旧）。 */
export function syncMembershipOrderStatement(input: {
  readonly linkId: string;
  readonly workspaceId: string;
  readonly sortOrder: number;
  readonly now: number;
}): NavStatement {
  return {
    sql: `UPDATE workspace_nav_memberships SET sort_order = ?, updated_at = ?
           WHERE link_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    binds: [input.sortOrder, input.now, input.linkId, input.workspaceId],
  };
}

