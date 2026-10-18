/**
 * 跨设备变更/水位服务（HUB-051 / ADR-0004 D7）—— **只读**。
 *
 * ── 为什么按行扫描 `updated_at`，而不是在 CRUD 里记一条变更日志 ──────────────────
 * 变更日志方案要求「每一个写路径都记得写日志」，而写路径并不只有常规 CRUD：
 * 模块卸载清理（`modules/workbench/instance-store.ts` 的墓碑批处理）、模板重置
 * （`POST /me/workbench/apply-template` 的 reset / replace）、备份导入、墓碑化都会改数据。
 * 任何一条路径漏写日志，客户端就**永久**丢一次变更，而且这种漏是静默的、客户端无法补救。
 * 反过来，参与同步的每张表都带 `updated_at`（UTC 毫秒）并且**所有**写路径都会更新它，
 * 所以 `updated_at >= cursor` 的扫描是**完备**的：新增 / 修改 / 删除（墓碑）/
 * 卸载清理 / 模板重置 / 备份导入天然全部进入同步流。
 *
 * ── 为什么分页以「毫秒组」为边界 ───────────────────────────────────────────────
 * 排序键是 `(updated_at, entityType, entityId)`（`compareSyncChanges`，唯一实现）。
 * 若一页正好停在某个毫秒的**一半**（同一毫秒写入的行比 limit 还多），
 * `nextCursor = lastTs + 1` 会把这一毫秒剩下的行**永久跳过**；而停在 `lastTs`
 * 又会在「整页都落在同一毫秒」时原地打转。因此规则是：
 *   1) 先取 `limit` 行；若取满且最后一行的 `updated_at = lastTs`，把 `updated_at = lastTs`
 *      的**全部**候选行补齐到本页（页大小可以略大于 limit）；
 *   2) `nextCursor = encodeSyncCursor(lastTs + 1)`，因此**必然前进**，不会重复整个毫秒组；
 *   3) `hasMore` 由「是否存在 `updated_at > lastTs` 的行」决定，而不是由「这一页是否装满」猜。
 * 这样同一毫秒永远不会被切成两页，也没有任何一行会被边界跳过。
 *
 * ── 为什么先取 `limit + 1` 再补齐毫秒组 ────────────────────────────────────────
 * 阶段一每个来源取 `limit + 1` 行：若某个来源被截断，它必然贡献 `limit + 1` 行，
 * 于是全局候选数 > limit，我们就知道「边界毫秒需要补齐」；反之候选数 ≤ limit 时，
 * 没有任何来源被截断，这一页就是「从游标起的全部行」——不需要额外的边界查询。
 *
 * ── 为什么不 GC 墓碑 ──────────────────────────────────────────────────────────
 * 墓碑（`op: 'delete'`）是唯一能告诉设备「这一行已经不存在」的信息。设备的水位可能落后
 * 任意久（离线数周）。若在「早于某设备水位」之前删掉墓碑，那台设备下次同步时既看不到行、
 * 也看不到墓碑，于是**复活**一条已被删除的数据。阶段 04 不删除任何墓碑
 * （ADR-0004 D12），宁可持续占用存储，也不制造复活。
 *
 * ── 作用域 ────────────────────────────────────────────────────────────────────
 * 每个来源的每条语句都带 `workspace_id = ?`（布局表没有该列，因此通过
 * `page_layout_revisions JOIN workspace_pages` 用页面的 `workspace_id` 限定）。
 * 本服务不接受客户端提交的 workspace，也不施加任何副作用。
 */
import {
  SYNC_ENTITY_ID_MAX_LENGTH,
  SYNC_ENTITY_TYPES,
  compareSyncChanges,
  encodeSyncCursor,
  type SyncChange,
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
   * 水位起点（UTC 毫秒）；`null` 表示首次全量（从 0 开始）。
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
// 来源定义
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

interface SyncIdentity {
  readonly entityId: string;
  readonly updatedAt: number;
  readonly revision: number;
}

/**
 * 一个同步来源：三条只读语句 + 行到变更的映射。
 *
 * `payload` 只在 `op: 'upsert'` 时调用；`delete` 的响应一定是 `payload: null`
 * （由 `changeOf` 统一保证），因此这里不需要（也不允许）为墓碑构造内容。
 */
interface SyncSource {
  readonly entityType: SyncEntityType;
  /** `updated_at >= ?`：本页候选行（绑定 [workspaceId, fromMs, limit]）。 */
  readonly sinceSql: string;
  /** `updated_at = ?`：边界毫秒组的**全部**行（绑定 [workspaceId, ts]）。 */
  readonly atSql: string;
  /** `updated_at > ?` 是否存在：`hasMore` 的事实依据（绑定 [workspaceId, ts]，LIMIT 1）。 */
  readonly afterSql: string;
  identity(row: SyncRow): SyncIdentity;
  /** 该行是否是墓碑（`deleted_at` 非空；模块卸载不是墓碑，见 module 来源）。 */
  isDelete(row: SyncRow): boolean;
  payload(row: SyncRow, context: PayloadContext): unknown;
}

/**
 * 组合实体 ID（`layout` 的 `pageId:breakpoint`、`nav_membership` 的 `linkId:groupId`）。
 *
 * 上限取契约里的 `SYNC_ENTITY_ID_MAX_LENGTH`（96）：两个 36 字符 UUID + 分隔符 = 73，
 * 原来的 64 会让「只要有成员关系，整份响应就过不了 `syncChangesResponseSchema`」——
 * 那是复核时发现的契约冲突，已在共享契约侧放宽（而不是在服务端截断 ID：
 * 截断会让极端情况下两个不同关系映射到同一键，客户端按 ID 去重就会互相覆盖）。
 *
 * `compose()` 仍然保留长度断言式的截断作为**最后一道防线**：一旦将来有人加入更长的
 * 组件而忘了同步契约，宁可在这里显式截断（并有测试盯着），也不要让整个响应变成非法。
 */
const MAX_ENTITY_ID_LENGTH = SYNC_ENTITY_ID_MAX_LENGTH;

function composeEntityId(parts: readonly string[]): string {
  const composite = parts.join(':');
  return composite.length <= MAX_ENTITY_ID_LENGTH ? composite : composite.slice(0, MAX_ENTITY_ID_LENGTH);
}

function layoutKeyOf(pageId: string, breakpoint: string): string {
  return `${pageId}\u0000${breakpoint}`;
}

const PAGE_COLUMNS = 'id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at';
const WIDGET_COLUMNS =
  'id, page_id, module_id, widget_type, config_json, config_version, is_hidden, revision, ' +
  'created_revision, deleted_at, created_at, updated_at';
const LAYOUT_COLUMNS = 'r.page_id, r.breakpoint, r.revision, r.updated_at, p.deleted_at AS page_deleted_at';
const LAYOUT_JOIN = 'FROM page_layout_revisions r JOIN workspace_pages p ON p.id = r.page_id';
const LAYOUT_ORDER = 'ORDER BY r.updated_at ASC, r.page_id ASC, r.breakpoint ASC';
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
 * 所有来源，顺序与 `SYNC_ENTITY_TYPES` 一致（清单顺序也是契约的一部分）。
 *
 * 刻意**不**写一条巨型 UNION：每个来源的行形状、墓碑语义与 payload 映射都不同，
 * 拼成一条 SQL 会让「哪些列属于哪个来源」变得不可读、不可测；这里宁可多发几条
 * 索引查询，把复杂度留在可读的映射函数里。
 */
const SOURCES: readonly SyncSource[] = [
  {
    entityType: 'page',
    sinceSql: `SELECT ${PAGE_COLUMNS} FROM workspace_pages
                WHERE workspace_id = ? AND updated_at >= ?
                ORDER BY updated_at ASC, id ASC LIMIT ?`,
    atSql: `SELECT ${PAGE_COLUMNS} FROM workspace_pages
             WHERE workspace_id = ? AND updated_at = ?
             ORDER BY id ASC`,
    afterSql: `SELECT 1 AS present FROM workspace_pages
                WHERE workspace_id = ? AND updated_at > ? LIMIT 1`,
    identity: (row) => ({
      entityId: textAt(row, 'id'),
      updatedAt: msAt(row, 'updated_at'),
      revision: msAt(row, 'revision'),
    }),
    // 页面删除是墓碑：客户端据此移除本地页面，**不允许**因为某行没出现在增量里就推断删除。
    isDelete: (row) => nullableMsAt(row, 'deleted_at') !== null,
    payload: (row) => ({
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
    sinceSql: `SELECT ${WIDGET_COLUMNS} FROM widget_instances
                WHERE workspace_id = ? AND updated_at >= ?
                ORDER BY updated_at ASC, id ASC LIMIT ?`,
    atSql: `SELECT ${WIDGET_COLUMNS} FROM widget_instances
             WHERE workspace_id = ? AND updated_at = ?
             ORDER BY id ASC`,
    afterSql: `SELECT 1 AS present FROM widget_instances
                WHERE workspace_id = ? AND updated_at > ? LIMIT 1`,
    identity: (row) => ({
      entityId: textAt(row, 'id'),
      updatedAt: msAt(row, 'updated_at'),
      revision: msAt(row, 'revision'),
    }),
    isDelete: (row) => nullableMsAt(row, 'deleted_at') !== null,
    payload: (row) => {
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
    sinceSql: `SELECT ${LAYOUT_COLUMNS} ${LAYOUT_JOIN}
                WHERE p.workspace_id = ? AND r.updated_at >= ?
                ${LAYOUT_ORDER} LIMIT ?`,
    atSql: `SELECT ${LAYOUT_COLUMNS} ${LAYOUT_JOIN}
             WHERE p.workspace_id = ? AND r.updated_at = ?
             ${LAYOUT_ORDER}`,
    afterSql: `SELECT 1 AS present ${LAYOUT_JOIN}
                WHERE p.workspace_id = ? AND r.updated_at > ? LIMIT 1`,
    identity: (row) => ({
      // 断点级身份：`pageId:breakpoint`（与共享契约的冲突示例 `page-1:desktop` 一致）。
      entityId: composeEntityId([textAt(row, 'page_id'), textAt(row, 'breakpoint')]),
      updatedAt: msAt(row, 'updated_at'),
      revision: msAt(row, 'revision'),
    }),
    // 页面本身已墓碑时，该页面的每个断点布局也随之「不存在」：必须以 delete 传播，
    // 否则客户端会一直保留一个已删除页面的布局。
    isDelete: (row) => nullableMsAt(row, 'page_deleted_at') !== null,
    payload: (row, context) => {
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
    sinceSql: `SELECT ${NAV_LINK_COLUMNS} FROM workspace_nav_links
                WHERE workspace_id = ? AND updated_at >= ?
                ORDER BY updated_at ASC, id ASC LIMIT ?`,
    atSql: `SELECT ${NAV_LINK_COLUMNS} FROM workspace_nav_links
             WHERE workspace_id = ? AND updated_at = ?
             ORDER BY id ASC`,
    afterSql: `SELECT 1 AS present FROM workspace_nav_links
                WHERE workspace_id = ? AND updated_at > ? LIMIT 1`,
    identity: (row) => ({
      entityId: textAt(row, 'id'),
      updatedAt: msAt(row, 'updated_at'),
      revision: msAt(row, 'revision'),
    }),
    isDelete: (row) => nullableMsAt(row, 'deleted_at') !== null,
    payload: (row) => ({
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
    sinceSql: `SELECT ${NAV_GROUP_COLUMNS} FROM workspace_nav_groups
                WHERE workspace_id = ? AND updated_at >= ?
                ORDER BY updated_at ASC, id ASC LIMIT ?`,
    atSql: `SELECT ${NAV_GROUP_COLUMNS} FROM workspace_nav_groups
             WHERE workspace_id = ? AND updated_at = ?
             ORDER BY id ASC`,
    afterSql: `SELECT 1 AS present FROM workspace_nav_groups
                WHERE workspace_id = ? AND updated_at > ? LIMIT 1`,
    identity: (row) => ({
      entityId: textAt(row, 'id'),
      updatedAt: msAt(row, 'updated_at'),
      revision: msAt(row, 'revision'),
    }),
    isDelete: (row) => nullableMsAt(row, 'deleted_at') !== null,
    payload: (row) => ({
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
    sinceSql: `SELECT ${NAV_MEMBERSHIP_COLUMNS} FROM workspace_nav_memberships
                WHERE workspace_id = ? AND updated_at >= ?
                ORDER BY updated_at ASC, link_id ASC, group_id ASC LIMIT ?`,
    atSql: `SELECT ${NAV_MEMBERSHIP_COLUMNS} FROM workspace_nav_memberships
             WHERE workspace_id = ? AND updated_at = ?
             ORDER BY link_id ASC, group_id ASC`,
    afterSql: `SELECT 1 AS present FROM workspace_nav_memberships
                WHERE workspace_id = ? AND updated_at > ? LIMIT 1`,
    identity: (row) => ({
      entityId: composeEntityId([textAt(row, 'link_id'), textAt(row, 'group_id')]),
      updatedAt: msAt(row, 'updated_at'),
      // 该表没有 revision 列（多分组关系只需要墓碑与顺序）：用 0 而不是伪造一个修订号。
      revision: 0,
    }),
    isDelete: (row) => nullableMsAt(row, 'deleted_at') !== null,
    payload: (row) => ({
      linkId: textAt(row, 'link_id'),
      groupId: textAt(row, 'group_id'),
      sortOrder: msAt(row, 'sort_order'),
      deletedAt: nullableMsAt(row, 'deleted_at'),
      updatedAt: msAt(row, 'updated_at'),
    }),
  },
  {
    entityType: 'module',
    sinceSql: `SELECT ${MODULE_COLUMNS} FROM workspace_modules
                WHERE workspace_id = ? AND updated_at >= ?
                ORDER BY updated_at ASC, module_id ASC LIMIT ?`,
    atSql: `SELECT ${MODULE_COLUMNS} FROM workspace_modules
             WHERE workspace_id = ? AND updated_at = ?
             ORDER BY module_id ASC`,
    afterSql: `SELECT 1 AS present FROM workspace_modules
                WHERE workspace_id = ? AND updated_at > ? LIMIT 1`,
    identity: (row) => ({
      entityId: textAt(row, 'module_id'),
      updatedAt: msAt(row, 'updated_at'),
      revision: msAt(row, 'revision'),
    }),
    // `deleted_at` 的概念在这里不适用：模块卸载是 `status = 'uninstalled'`，行仍然存在
    // （个人设置保留，可 restore），因此它永远是 upsert —— 用 delete 表达卸载会让客户端
    // 删掉本地模块设置，而服务端其实还留着。
    isDelete: () => false,
    payload: (row) => {
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
    sinceSql: `SELECT ${EVENT_COLUMNS} FROM workspace_events
                WHERE workspace_id = ? AND updated_at >= ?
                ORDER BY updated_at ASC, id ASC LIMIT ?`,
    atSql: `SELECT ${EVENT_COLUMNS} FROM workspace_events
             WHERE workspace_id = ? AND updated_at = ?
             ORDER BY id ASC`,
    afterSql: `SELECT 1 AS present FROM workspace_events
                WHERE workspace_id = ? AND updated_at > ? LIMIT 1`,
    identity: (row) => ({
      entityId: textAt(row, 'id'),
      updatedAt: msAt(row, 'updated_at'),
      revision: msAt(row, 'revision'),
    }),
    isDelete: (row) => nullableMsAt(row, 'deleted_at') !== null,
    payload: (row) => ({
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

/** 某个页面的全部「实例未墓碑」矩形（按断点与实例 ID 稳定排序）。 */
const LAYOUT_RECTS_SQL = `SELECT wl.widget_id, wl.breakpoint, wl.x, wl.y, wl.w, wl.h
                            FROM widget_layouts wl
                            JOIN widget_instances wi ON wi.id = wl.widget_id
                           WHERE wi.workspace_id = ? AND wi.page_id = ? AND wi.deleted_at IS NULL
                           ORDER BY wl.breakpoint ASC, wl.widget_id ASC`;

// ---------------------------------------------------------------------------
// 服务实现
// ---------------------------------------------------------------------------

interface PendingChange {
  /** 排序/分页用的变更骨架；`payload` 在此阶段恒为 `null`（稍后按需补齐）。 */
  readonly change: SyncChange;
  readonly source: SyncSource;
  readonly row: SyncRow;
}

function changeKeyOf(change: SyncChange): string {
  return `${change.entityType}\u0000${change.entityId}`;
}

/** 用来源的行事实造出变更骨架；`delete` 的 payload 在这里就是 `null`（显式给出该键）。 */
function pendingOf(source: SyncSource, row: SyncRow): PendingChange {
  const identity = source.identity(row);
  const deleted = source.isDelete(row);
  return {
    source,
    row,
    change: {
      entityType: source.entityType,
      entityId: identity.entityId,
      op: deleted ? 'delete' : 'upsert',
      revision: identity.revision,
      updatedAt: identity.updatedAt,
      payload: null,
    },
  };
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const now = deps.now ?? ((): number => Date.now());

  /**
   * 执行一组查询并返回每个语句的结果行。
   *
   * 为什么用 `db.batch`（单个事务）而不是逐条 await：D1 的 batch 是**同一个快照**。
   * 若各来源分别读取，「A 表已读、B 表未读」之间发生的写入可能落在两次读之间，
   * 从而被 `lastTs + 1` 的游标永久跳过。快照化之后，「一行不漏」的论证才成立。
   */
  async function readRows(statements: readonly D1PreparedStatement[]): Promise<readonly SyncRow[][]> {
    const results = await deps.db.batch([...statements]);
    return results.map((result) => result.results as SyncRow[]);
  }

  /** 为布局 payload 预取矩形：只查本页真正需要的页面（避免 N+1 式的逐行查询）。 */
  async function readPayloadContext(
    pending: readonly PendingChange[],
    workspaceId: string,
  ): Promise<PayloadContext> {
    const pageIds = new Set<string>();
    for (const item of pending) {
      if (item.source.entityType === 'layout' && item.change.op === 'upsert') {
        pageIds.add(textAt(item.row, 'page_id'));
      }
    }
    const layoutRects = new Map<string, LayoutRectPayload[]>();
    if (pageIds.size === 0) {
      return { layoutRects };
    }
    const results = await readRows(
      [...pageIds].map((pageId) => deps.db.prepare(LAYOUT_RECTS_SQL).bind(workspaceId, pageId)),
    );
    let position = 0;
    for (const pageId of pageIds) {
      const rows = results[position] ?? [];
      position += 1;
      for (const row of rows) {
        const key = layoutKeyOf(pageId, textAt(row, 'breakpoint'));
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
    }
    return { layoutRects };
  }

  /** 补齐 payload：`delete` 恒为 `null`；`upsert` 才调用来源的 payload 构造器。 */
  async function materialize(
    pending: readonly PendingChange[],
    workspaceId: string,
  ): Promise<SyncChange[]> {
    const context = await readPayloadContext(pending, workspaceId);
    return pending.map((item) =>
      item.change.op === 'delete'
        ? item.change
        : { ...item.change, payload: item.source.payload(item.row, context) },
    );
  }

  return {
    async listChanges(input) {
      const { workspaceId, limit } = input;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError('sync.listChanges：limit 必须是正整数（请求校验由路由层负责）');
      }
      const fromMs = input.cursor ?? 0;
      // 多取一行：被截断的来源必然贡献 limit + 1 行，因此「候选数 > limit」等价于
      // 「存在来源被截断，边界毫秒需要补齐」。
      const probeLimit = limit + 1;

      const phaseOneRows = await readRows(
        SOURCES.map((source) => deps.db.prepare(source.sinceSql).bind(workspaceId, fromMs, probeLimit)),
      );

      const index = new Map<string, PendingChange>();
      for (const [position, source] of SOURCES.entries()) {
        for (const row of phaseOneRows[position] ?? []) {
          const pending = pendingOf(source, row);
          index.set(changeKeyOf(pending.change), pending);
        }
      }

      const serverTimeMs = now();
      const sorted = [...index.values()].sort((left, right) => compareSyncChanges(left.change, right.change));

      if (sorted.length <= limit) {
        // 没有任何来源被截断 → 这一页就是「从游标起的全部行」：`hasMore` 必为 false，
        // 游标前移到 lastTs + 1。
        const last = sorted.at(-1);
        const lastTs = last === undefined ? null : last.change.updatedAt;
        return {
          changes: await materialize(sorted, workspaceId),
          // 空页时游标停在起点（契约：无行时 nextCursor = encodeSyncCursor(cursor ?? 0)）。
          nextCursor: encodeSyncCursor(lastTs === null ? fromMs : lastTs + 1),
          hasMore: false,
          serverTimeMs,
          entityTypes: [...SYNC_ENTITY_TYPES],
        };
      }

      const boundary = sorted.at(limit - 1);
      if (boundary === undefined) {
        // 不可能：sorted.length > limit。显式抛错而不是 `!` 断言，避免静默发出错误的分页。
        throw new Error('同步扫描：分页边界缺失（内部错误）');
      }
      const lastTs = boundary.change.updatedAt;

      // 阶段二：补齐边界毫秒组的**全部**行，并探测是否还有更晚的行（hasMore 的事实依据）。
      const phaseTwoRows = await readRows([
        ...SOURCES.map((source) => deps.db.prepare(source.atSql).bind(workspaceId, lastTs)),
        ...SOURCES.map((source) => deps.db.prepare(source.afterSql).bind(workspaceId, lastTs)),
      ]);
      for (const [position, source] of SOURCES.entries()) {
        for (const row of phaseTwoRows[position] ?? []) {
          const pending = pendingOf(source, row);
          index.set(changeKeyOf(pending.change), pending);
        }
      }
      let hasMore = false;
      for (let position = 0; position < SOURCES.length; position += 1) {
        if ((phaseTwoRows[SOURCES.length + position] ?? []).length > 0) {
          hasMore = true;
        }
      }

      // 只返回 `updated_at <= lastTs` 的行：更晚的行留给下一轮（本页的边界就是这一毫秒）。
      const page = [...index.values()]
        .sort((left, right) => compareSyncChanges(left.change, right.change))
        .filter((item) => item.change.updatedAt <= lastTs);

      return {
        changes: await materialize(page, workspaceId),
        nextCursor: encodeSyncCursor(lastTs + 1),
        hasMore,
        serverTimeMs,
        entityTypes: [...SYNC_ENTITY_TYPES],
      };
    },
  };
}
