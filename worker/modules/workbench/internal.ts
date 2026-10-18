/**
 * 工作台服务的内部共享层（HUB-045 / HUB-046 / HUB-054）。
 *
 * 只放三样东西，供 `service.ts`（页面/实例/布局/模板）与 `backup.ts`（备份/恢复）共用：
 *   1. 行类型与「行 → 对外契约」的映射；
 *   2. 只读查询（页面、实例、矩形、布局修订、工作台修订、模块门禁）；
 *   3. **语句构造器**：全部返回 `{ sql, binds }`，由 `tx.ts` 统一追加「本次尝试」守卫后
 *      放进同一个 D1 batch。
 *
 * 语句构造器的硬约定（否则守卫会拼错）：
 * - 每条 SQL 必须以一个完整的 `WHERE ...` 结尾，这样 ` AND <guard>` 才是合法的；
 * - 需要 upsert 的地方一律拆成「不存在则插入」+「存在则更新」两条语句。
 *   之所以能这么拆：守卫是**独立的 EXISTS 判定**，与语句影响行数无关，
 *   因此「影响 0 行」是正常的，不会破坏后续语句（这正是本设计不使用 `changes()` 链的原因）。
 * - 单条语句的绑定参数必须远小于 D1 的 100 个上限；
 *   `MAX_WIDGETS_PER_PAGE = 40` 时最大的语句（布局保存的 ID 集合校验）约 53 个。
 */
import {
  MAX_PAGES_PER_WORKSPACE,
  MAX_WIDGET_CONFIG_BYTES,
  WORKBENCH_MESSAGES,
  columnsForBreakpoint,
  findFreeRect,
  findWidgetConfigContract,
  type GridRect,
  type LayoutBreakpoint,
  type ModuleGateStatus,
  type WidgetInstance,
  type WorkspacePage,
} from '@ff14-hub/shared';
import { stableStringify } from '../../lib/util';
import { readModuleSnapshot } from '../lifecycle/workspace-modules';
import type { ModuleRegistry } from '../registry/module-registry';
import { workbenchFailure, type WorkbenchFailure } from './tx';

export const LAYOUT_BREAKPOINT_LIST = ['desktop', 'tablet', 'mobile'] as const;

export interface PageRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly is_default: number;
  readonly sort_order: number;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface InstanceRow {
  readonly id: string;
  readonly page_id: string;
  readonly module_id: string;
  readonly widget_type: string;
  readonly config_json: string;
  readonly config_version: number;
  readonly is_hidden: number;
  readonly revision: number;
  readonly created_revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface LayoutRow {
  readonly widget_id: string;
  readonly breakpoint: LayoutBreakpoint;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Statement {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

/** 一组待执行语句（由 `tx.guardedStatements` 追加守卫后放进同一个 batch）。 */
export type StatementList = Statement[];

const PAGE_COLUMNS = 'id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at';
const INSTANCE_COLUMNS =
  'wi.id, wi.page_id, wi.module_id, wi.widget_type, wi.config_json, wi.config_version, ' +
  'wi.is_hidden, wi.revision, wi.created_revision, wi.created_at, wi.updated_at';

/** 活跃页面列表（快照与列表接口共用**同一份** SQL 文本，避免两处排序/过滤漂移）。 */
const ACTIVE_PAGES_SQL =
  `SELECT ${PAGE_COLUMNS} FROM workspace_pages
    WHERE workspace_id = ? AND deleted_at IS NULL
    ORDER BY sort_order ASC, created_at ASC`;
/** 工作空间级工作台修订号（行缺失等价于 0）。 */
const WORKBENCH_REVISION_SQL = 'SELECT revision FROM workspace_workbench_state WHERE workspace_id = ?';
/**
 * 本工作空间变更流的**当前水位**（`MAX(seq)`；没有任何变更时为 0）。
 *
 * 与 `modules/sync/service.ts` 的 `WORKSPACE_WATERMARK_SQL`（reset 协议的 `meta.watermark`）
 * 是同一个事实的第二个读取点；这里带 `COALESCE` 是因为快照的 `watermark` 若存在就必须是
 * 非负整数（空工作空间 = 0），不接受 NULL。
 */
const WORKSPACE_MAX_SEQ_SQL =
  'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM workspace_changes WHERE workspace_id = ?';

export function toPage(row: PageRow): WorkspacePage {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 防御性解析：某一行损坏不应让整个接口 500，也不能伪造出「有配置」的假象。 */
export function parseConfigJson(configJson: string): unknown {
  try {
    return JSON.parse(configJson);
  } catch {
    return null;
  }
}

export function toInstance(row: InstanceRow): WidgetInstance {
  return {
    id: row.id,
    pageId: row.page_id,
    moduleId: row.module_id,
    widgetType: row.widget_type,
    config: parseConfigJson(row.config_json),
    configVersion: row.config_version,
    hidden: row.is_hidden === 1,
    revision: row.revision,
    createdRevision: row.created_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// SQL 片段（前置条件用）
// ---------------------------------------------------------------------------

/** 页面存在、属于该工作空间、未删除。绑定：[pageId, workspaceId]。 */
export const SQL_PAGE_ACTIVE = `EXISTS (SELECT 1 FROM workspace_pages p
                                         WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL)`;

/** 实例存在、其页面属于该工作空间、两者都未删除。绑定：[widgetId, workspaceId]。 */
export const SQL_INSTANCE_ACTIVE = `EXISTS (SELECT 1 FROM widget_instances wi
                                            JOIN workspace_pages p ON p.id = wi.page_id
                                           WHERE wi.id = ? AND p.workspace_id = ?
                                             AND wi.deleted_at IS NULL AND p.deleted_at IS NULL)`;

/** 模块已启用且代际与本次读取一致。绑定：[workspaceId, moduleId, revision]。 */
export const SQL_MODULE_ENABLED_AT_REVISION = `EXISTS (SELECT 1 FROM workspace_modules m
                                                       WHERE m.workspace_id = ? AND m.module_id = ?
                                                         AND m.status = 'enabled' AND m.revision = ?)`;

/** 模块没有待完成操作（`transitioning` 门禁）。绑定：[workspaceId, moduleId]。 */
export const SQL_MODULE_NOT_TRANSITIONING = `NOT EXISTS (SELECT 1 FROM workspace_module_operations o
                                                          WHERE o.workspace_id = ? AND o.module_id = ?)`;

/**
 * 模块状态与 revision 与**观察值**一致（任何状态都适用）。
 * 绑定：[workspaceId, moduleId, status, revision]。
 *
 * 与 `SQL_MODULE_ENABLED_AT_REVISION` 的区别：后者只能表达「必须是 enabled」，
 * 而导入/模板需要能钉住「预览时它是 disabled / uninstalled」这一事实——
 * 否则被预览跳过的模块在提交前被启用，事务也拦不住。
 */
export const SQL_MODULE_STATUS_AT_REVISION = `EXISTS (SELECT 1 FROM workspace_modules m
                                                      WHERE m.workspace_id = ? AND m.module_id = ?
                                                        AND m.status = ? AND m.revision = ?)`;

/** 模块行仍然**不存在**（观察时是 `not_installed`，由行缺失派生）。绑定：[workspaceId, moduleId]。 */
export const SQL_MODULE_ABSENT = `NOT EXISTS (SELECT 1 FROM workspace_modules m
                                               WHERE m.workspace_id = ? AND m.module_id = ?)`;

/** 该模块**仍有**待完成操作（观察时是 `transitioning`，即有一次进行中的生命周期变更）。绑定：[workspaceId, moduleId]。 */
export const SQL_MODULE_TRANSITIONING = `EXISTS (SELECT 1 FROM workspace_module_operations o
                                                  WHERE o.workspace_id = ? AND o.module_id = ?)`;

/**
 * 把「一组模块的门禁观察值」原样钉成同一个事务的前置条件。
 *
 * 语义（复核要求：**所有相关模块**的门禁变化都要 409 重新预览，而不只是会被写入的那些）：
 * - `not_installed` → 模块行必须**仍然缺失**；
 * - `enabled` / `disabled` / `uninstalled` → 状态与 revision 必须与观察值一致，且**没有**待完成操作；
 * - `transitioning` → revision 一致且**仍有**待完成操作（钉住同一次进行中的变更）。
 *
 * 它**只读**这些模块的状态，不会启用/停用任何模块。
 */
export function moduleGateSnapshotConditions(input: {
  readonly workspaceId: string;
  readonly gates: readonly { readonly moduleId: string; readonly status: ModuleGateStatus; readonly revision: number }[];
}): { readonly sql: string; readonly binds: readonly unknown[] } {
  const seen = new Set<string>();
  const parts: string[] = [];
  const binds: unknown[] = [];
  const ordered = [...input.gates].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  for (const gate of ordered) {
    if (seen.has(gate.moduleId)) {
      continue;
    }
    seen.add(gate.moduleId);
    if (gate.status === 'not_installed') {
      parts.push(`(${SQL_MODULE_ABSENT})`);
      binds.push(input.workspaceId, gate.moduleId);
      continue;
    }
    if (gate.status === 'transitioning') {
      parts.push(
        `(EXISTS (SELECT 1 FROM workspace_modules m
                   WHERE m.workspace_id = ? AND m.module_id = ? AND m.revision = ?)
          AND ${SQL_MODULE_TRANSITIONING})`,
      );
      binds.push(input.workspaceId, gate.moduleId, gate.revision, input.workspaceId, gate.moduleId);
      continue;
    }
    parts.push(`(${SQL_MODULE_STATUS_AT_REVISION} AND ${SQL_MODULE_NOT_TRANSITIONING})`);
    binds.push(input.workspaceId, gate.moduleId, gate.status, gate.revision, input.workspaceId, gate.moduleId);
  }
  return { sql: parts.length === 0 ? '' : parts.join(' AND '), binds };
}

/** 该页面活跃实例数。绑定：[pageId]。 */
export const SQL_COUNT_PAGE_INSTANCES = `(SELECT COUNT(*) FROM widget_instances wi
                                          WHERE wi.page_id = ? AND wi.deleted_at IS NULL)`;

/**
 * 把「若干模块已启用且代际一致、且都不在 transitioning」拼成一个前置条件。
 *
 * 用途：模板与导入会**批量**写入多个模块的实例。它们的实例语句没有各自的模块门禁条件
 * （与 `addWidget` 不同），因此必须把这些条件整体放进认领语句，
 * 否则「读取门禁 → 组批 → 提交」之间存在模块被停用/卸载的时间窗，
 * 就会写入一个**未授权模块**的实例——这正是需求明确禁止的。
 *
 * 返回空字符串表示没有任何模块需要门禁（例如空白模板）。
 */
export function moduleGateConditions(input: {
  readonly workspaceId: string;
  readonly modules: readonly { readonly moduleId: string; readonly revision: number }[];
}): { readonly sql: string; readonly binds: readonly unknown[] } {
  const seen = new Set<string>();
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const module of input.modules) {
    if (seen.has(module.moduleId)) {
      continue;
    }
    seen.add(module.moduleId);
    // 每个模块两段条件：
    //   SQL_MODULE_ENABLED_AT_REVISION → workspaceId, moduleId, revision
    //   SQL_MODULE_NOT_TRANSITIONING    → workspaceId, moduleId
    parts.push(`(${SQL_MODULE_ENABLED_AT_REVISION} AND ${SQL_MODULE_NOT_TRANSITIONING})`);
    binds.push(input.workspaceId, module.moduleId, module.revision, input.workspaceId, module.moduleId);
  }
  return { sql: parts.length === 0 ? '' : parts.join(' AND '), binds };
}

/** 该工作空间活跃页面数。绑定：[workspaceId]。 */
export const SQL_COUNT_ACTIVE_PAGES = `(SELECT COUNT(*) FROM workspace_pages p
                                        WHERE p.workspace_id = ? AND p.deleted_at IS NULL)`;

/** 工作台级修订号（导入预览的新鲜度令牌；行不存在即 0）。绑定：[workspaceId]。 */
export const SQL_WORKBENCH_REVISION = `COALESCE((SELECT s.revision FROM workspace_workbench_state s
                                                  WHERE s.workspace_id = ?), 0)`;

/** 某断点当前的布局修订号（行不存在即 0）。绑定：[pageId, breakpoint]。 */
export const SQL_LAYOUT_REVISION = `COALESCE((SELECT r.revision FROM page_layout_revisions r
                                               WHERE r.page_id = ? AND r.breakpoint = ?), 0)`;

// ---------------------------------------------------------------------------
// 语句构造器
// ---------------------------------------------------------------------------

export function insertPageStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly isDefault: boolean;
  readonly sortOrder: number;
  readonly now: number;
}): Statement {
  return {
    sql: `INSERT INTO workspace_pages
            (id, workspace_id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?
           WHERE 1 = 1`,
    binds: [
      input.id,
      input.workspaceId,
      input.name,
      input.slug,
      input.isDefault ? 1 : 0,
      input.sortOrder,
      input.now,
      input.now,
    ],
  };
}

export function updatePageStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly name: string;
  readonly sortOrder: number;
  readonly isDefault: boolean;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workspace_pages
             SET name = ?, sort_order = ?, is_default = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [
      input.name,
      input.sortOrder,
      input.isDefault ? 1 : 0,
      input.now,
      input.id,
      input.workspaceId,
      input.expectedRevision,
    ],
  };
}

/** 把其他页面的默认标记清掉（只在显式「设为本页为默认」时使用）。 */
export function clearOtherDefaultsStatement(input: {
  readonly workspaceId: string;
  readonly keepPageId: string;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workspace_pages SET is_default = 0, updated_at = ?
           WHERE workspace_id = ? AND is_default = 1 AND deleted_at IS NULL AND id <> ?`,
    binds: [input.now, input.workspaceId, input.keepPageId],
  };
}

/**
 * 墓碑一个页面。
 * 只标记页面本身：其下的实例与布局**保持原样**，因此恢复页面能把内容整体带回来。
 */
export function tombstonePageStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workspace_pages
             SET deleted_at = ?, is_default = 0, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    binds: [input.now, input.now, input.id, input.workspaceId],
  };
}

export function restorePageStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workspace_pages
             SET deleted_at = NULL, is_default = 0, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL`,
    binds: [input.now, input.id, input.workspaceId],
  };
}

/**
 * 重新推导默认页：**仅当当前没有默认页时**，把 sort_order 最小的活跃页面设为默认。
 *
 * 为什么必须带 `NOT EXISTS(默认页)`：否则每次删除/恢复页面都会把默认页重设成
 * 「sort_order 最小者」，等于悄悄改掉用户选的默认页。
 */
export function rederiveDefaultPageStatement(input: {
  readonly workspaceId: string;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workspace_pages SET is_default = 1, updated_at = ?
           WHERE workspace_id = ? AND deleted_at IS NULL AND is_default = 0
             AND NOT EXISTS (SELECT 1 FROM workspace_pages d
                              WHERE d.workspace_id = ? AND d.deleted_at IS NULL AND d.is_default = 1)
             AND id = (SELECT p.id FROM workspace_pages p
                        WHERE p.workspace_id = ? AND p.deleted_at IS NULL
                        ORDER BY p.sort_order ASC, p.created_at ASC LIMIT 1)`,
    binds: [input.now, input.workspaceId, input.workspaceId, input.workspaceId],
  };
}

export function insertInstanceStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly pageId: string;
  readonly moduleId: string;
  readonly widgetType: string;
  readonly configJson: string;
  readonly configVersion: number;
  readonly hidden: boolean;
  readonly createdRevision: number;
  readonly now: number;
}): Statement {
  return {
    sql: `INSERT INTO widget_instances
            (id, workspace_id, page_id, module_id, widget_type, config_json, config_version,
             is_hidden, revision, created_revision, deleted_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?
           WHERE 1 = 1`,
    binds: [
      input.id,
      input.workspaceId,
      input.pageId,
      input.moduleId,
      input.widgetType,
      input.configJson,
      input.configVersion,
      input.hidden ? 1 : 0,
      input.createdRevision,
      input.now,
      input.now,
    ],
  };
}

export function updateInstanceStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly configJson: string;
  readonly configVersion: number;
  readonly hidden: boolean;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE widget_instances
             SET config_json = ?, config_version = ?, is_hidden = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
    binds: [
      input.configJson,
      input.configVersion,
      input.hidden ? 1 : 0,
      input.now,
      input.id,
      input.workspaceId,
      input.expectedRevision,
    ],
  };
}

/** 墓碑一个实例（「移除」，不是「隐藏」，也不影响模块与个人数据）。 */
export function tombstoneInstanceStatement(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE widget_instances
             SET deleted_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    binds: [input.now, input.now, input.id, input.workspaceId],
  };
}

export function insertLayoutStatement(input: {
  readonly widgetId: string;
  readonly breakpoint: LayoutBreakpoint;
  readonly rect: GridRect;
}): Statement {
  return {
    sql: `INSERT INTO widget_layouts (widget_id, breakpoint, x, y, w, h)
          SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1`,
    binds: [input.widgetId, input.breakpoint, input.rect.x, input.rect.y, input.rect.w, input.rect.h],
  };
}

/** 删除某个实例的全部布局行（实例被移除时使用）。 */
export function deleteInstanceLayoutsStatement(widgetId: string): Statement {
  return { sql: 'DELETE FROM widget_layouts WHERE widget_id = ?', binds: [widgetId] };
}

/** 删除某一页面在某断点下的全部布局行（整页保存时先清后写）。 */
export function deletePageBreakpointLayoutsStatement(input: {
  readonly pageId: string;
  readonly breakpoint: LayoutBreakpoint;
}): Statement {
  return {
    sql: `DELETE FROM widget_layouts
           WHERE breakpoint = ?
             AND widget_id IN (SELECT id FROM widget_instances WHERE page_id = ?)`,
    binds: [input.breakpoint, input.pageId],
  };
}

/**
 * 把某页面某断点的布局修订号 +1。
 *
 * 拆成「不存在则插入 0」+「存在则 +1」两条语句：守卫与影响行数无关，因此
 * 「插入了 0 行」不会影响第二条。插入的是 **0** 而不是 1——行缺失本来就等价于 revision 0，
 * 若插入 1 再被第二条 +1，首次 bump 会变成 2，与后续每次 +1 不一致。
 */
export function bumpLayoutRevisionStatements(input: {
  readonly pageId: string;
  readonly breakpoint: LayoutBreakpoint;
  readonly now: number;
}): Statement[] {
  return [
    {
      sql: `INSERT INTO page_layout_revisions (page_id, breakpoint, revision, updated_at)
            SELECT ?, ?, 0, ?
             WHERE NOT EXISTS (SELECT 1 FROM page_layout_revisions r
                                WHERE r.page_id = ? AND r.breakpoint = ?)`,
      binds: [input.pageId, input.breakpoint, input.now, input.pageId, input.breakpoint],
    },
    {
      sql: `UPDATE page_layout_revisions SET revision = revision + 1, updated_at = ?
             WHERE page_id = ? AND breakpoint = ?`,
      binds: [input.now, input.pageId, input.breakpoint],
    },
  ];
}

/** 把布局修订号设为指定值（整页保存：baseRevision + 1）。 */
export function setLayoutRevisionStatements(input: {
  readonly pageId: string;
  readonly breakpoint: LayoutBreakpoint;
  readonly revision: number;
  readonly now: number;
}): Statement[] {
  return [
    {
      sql: `INSERT INTO page_layout_revisions (page_id, breakpoint, revision, updated_at)
            SELECT ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM page_layout_revisions r
                                WHERE r.page_id = ? AND r.breakpoint = ?)`,
      binds: [input.pageId, input.breakpoint, input.revision, input.now, input.pageId, input.breakpoint],
    },
    {
      sql: `UPDATE page_layout_revisions SET revision = ?, updated_at = ?
             WHERE page_id = ? AND breakpoint = ?`,
      binds: [input.revision, input.now, input.pageId, input.breakpoint],
    },
  ];
}

/** 工作台级修订号 +1（行缺失等价于 0，因此先插 0 再 +1，首次 bump 结果恰为 1）。 */
export function bumpWorkbenchRevisionStatements(input: {
  readonly workspaceId: string;
  readonly now: number;
}): Statement[] {
  return [
    {
      sql: `INSERT INTO workspace_workbench_state (workspace_id, revision, updated_at)
            SELECT ?, 0, ?
             WHERE NOT EXISTS (SELECT 1 FROM workspace_workbench_state s WHERE s.workspace_id = ?)`,
      binds: [input.workspaceId, input.now, input.workspaceId],
    },
    {
      sql: `UPDATE workspace_workbench_state SET revision = revision + 1, updated_at = ?
             WHERE workspace_id = ?`,
      binds: [input.now, input.workspaceId],
    },
  ];
}

// ---------------------------------------------------------------------------
// 只读查询
// ---------------------------------------------------------------------------

export async function readActivePages(db: D1Database, workspaceId: string): Promise<PageRow[]> {
  const result = await db.prepare(ACTIVE_PAGES_SQL).bind(workspaceId).all<PageRow>();
  return result.results;
}

/** 工作台快照的一致读取结果（页面 + 修订号 + 水位，全部来自同一批）。 */
export interface WorkbenchSnapshotRead {
  readonly pages: PageRow[];
  readonly revision: number;
  readonly watermark: number;
}

/**
 * 读取 `GET /me/workbench` 快照所依据的**一致**状态：活跃页面 + 工作台修订号 + 变更流水位。
 *
 * 三条 SELECT 放进**同一个 `db.batch`**（D1 的 batch = 单个事务，因此只有一个观察时刻）：
 *   - 「页面列表」与「修订号」此前是两次独立读，并发写入下可以组合出「新页面 + 旧 revision」；
 *   - `watermark`（`workspace_changes` 的 `MAX(seq)`）必须与页面内容同批，否则客户端会拿着
 *     「内容已更新」的快照配「更新之前的水位」——若这两次观察之间发生了
 *     `delete(W+1) → 显式恢复(W+2)`，客户端就会把 W+1 的历史 `delete` 应用到已恢复的内容上
 *     （导航快照的同一竞态，见 `modules/nav/service.ts` 的 `readSnapshotBatch`）。
 *
 * 原子性论证：迁移 0011 的 `AFTER INSERT/UPDATE` 触发器把变更行写进 `workspace_changes`，
 * 与业务写入同事务提交；本批既然能看到页面的最新状态，产生该状态的变更行也必然可见，
 * 且 `seq` 是只增不减的 AUTOINCREMENT 主键，故 `MAX(seq) ≥ 快照里任何一行的最新变更 seq`。
 */
export async function readWorkbenchSnapshotBatch(
  db: D1Database,
  workspaceId: string,
): Promise<WorkbenchSnapshotRead> {
  const results = await db.batch([
    db.prepare(ACTIVE_PAGES_SQL).bind(workspaceId),
    db.prepare(WORKBENCH_REVISION_SQL).bind(workspaceId),
    db.prepare(WORKSPACE_MAX_SEQ_SQL).bind(workspaceId),
  ]);
  const revisionRow = ((results[1]?.results ?? []) as { revision: number }[])[0];
  const watermarkRow = ((results[2]?.results ?? []) as { max_seq: number }[])[0];
  return {
    pages: (results[0]?.results ?? []) as PageRow[],
    revision: revisionRow?.revision ?? 0,
    // `COALESCE` 保证这一行一定存在；`?? 0` 只是防御（空工作空间的水位是 0）。
    watermark: watermarkRow?.max_seq ?? 0,
  };
}

export async function readPageRow(
  db: D1Database,
  workspaceId: string,
  pageId: string,
): Promise<PageRow | null> {
  return await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM workspace_pages WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .bind(pageId, workspaceId)
    .first<PageRow>();
}

export async function readAnyPageRow(
  db: D1Database,
  workspaceId: string,
  pageId: string,
): Promise<PageRow | null> {
  return await db
    .prepare(`SELECT ${PAGE_COLUMNS} FROM workspace_pages WHERE id = ? AND workspace_id = ?`)
    .bind(pageId, workspaceId)
    .first<PageRow>();
}

export async function readActiveInstances(
  db: D1Database,
  workspaceId: string,
  pageId: string,
): Promise<InstanceRow[]> {
  const result = await db
    .prepare(
      `SELECT ${INSTANCE_COLUMNS}
         FROM widget_instances wi
         JOIN workspace_pages p ON p.id = wi.page_id
        WHERE wi.page_id = ? AND p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL
        ORDER BY wi.created_at ASC, wi.id ASC`,
    )
    .bind(pageId, workspaceId)
    .all<InstanceRow>();
  return result.results;
}

export async function readInstanceRow(
  db: D1Database,
  workspaceId: string,
  widgetId: string,
): Promise<InstanceRow | null> {
  return await db
    .prepare(
      `SELECT ${INSTANCE_COLUMNS}
         FROM widget_instances wi
         JOIN workspace_pages p ON p.id = wi.page_id
        WHERE wi.id = ? AND p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL`,
    )
    .bind(widgetId, workspaceId)
    .first<InstanceRow>();
}

export async function readLayoutRows(db: D1Database, pageId: string): Promise<LayoutRow[]> {
  const result = await db
    .prepare(
      `SELECT wl.widget_id, wl.breakpoint, wl.x, wl.y, wl.w, wl.h
         FROM widget_layouts wl
         JOIN widget_instances wi ON wi.id = wl.widget_id
        WHERE wi.page_id = ? AND wi.deleted_at IS NULL`,
    )
    .bind(pageId)
    .all<LayoutRow>();
  return result.results;
}

export async function readLayoutRevisions(
  db: D1Database,
  pageId: string,
): Promise<Map<LayoutBreakpoint, number>> {
  const result = await db
    .prepare('SELECT breakpoint, revision FROM page_layout_revisions WHERE page_id = ?')
    .bind(pageId)
    .all<{ breakpoint: LayoutBreakpoint; revision: number }>();
  const map = new Map<LayoutBreakpoint, number>();
  for (const row of result.results) {
    map.set(row.breakpoint, row.revision);
  }
  return map;
}

/** 规划新实例所依据的**一致快照**：页面 + 活跃实例集合 + 矩形 + 三个断点修订号。 */
export interface PlanningSnapshot {
  readonly page: PageRow | null;
  readonly instances: InstanceRow[];
  readonly rects: LayoutRow[];
  readonly layoutRevisions: Map<LayoutBreakpoint, number>;
}

/**
 * 读取「规划空位」所依据的一致快照。
 *
 * **四条 SELECT 放进同一个 `db.batch`**：D1 的 batch 是单个事务，因此
 * 「页面 / 实例集合 / 矩形 / 三断点修订号」必然来自同一时刻。
 *
 * 为什么这很重要（复核给出的确定性反例）：
 * 若分四次独立读，A 可能先读到「组件在 x=0」，随后 B 把它移到 x=4 并把 revision 升到 2，
 * A 再读到 revision=2；A 按**旧矩形**把新实例规划到 x=4，而它记录的 revision 恰好等于当前值，
 * 于是前置条件全部成立、提交后形成重叠。快照化之后，矩形与 revision 只能来自同一时刻，
 * 规划与前置条件因此不可能互相矛盾。
 *
 * 模块门禁不在这条快照里：它在认领语句中以**等值条件**被钉住（状态 + revision），
 * 单独读取不会造成「规划依据」与「提交条件」错配。
 */
export async function readPlanningSnapshot(
  db: D1Database,
  workspaceId: string,
  pageId: string,
): Promise<PlanningSnapshot> {
  const results = await db.batch([
    db
      .prepare(
        `SELECT ${PAGE_COLUMNS} FROM workspace_pages
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .bind(pageId, workspaceId),
    db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS}
           FROM widget_instances wi
           JOIN workspace_pages p ON p.id = wi.page_id
          WHERE wi.page_id = ? AND p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL
          ORDER BY wi.created_at ASC, wi.id ASC`,
      )
      .bind(pageId, workspaceId),
    db
      .prepare(
        `SELECT wl.widget_id, wl.breakpoint, wl.x, wl.y, wl.w, wl.h
           FROM widget_layouts wl
           JOIN widget_instances wi ON wi.id = wl.widget_id
          WHERE wi.page_id = ? AND wi.deleted_at IS NULL`,
      )
      .bind(pageId),
    db
      .prepare('SELECT breakpoint, revision FROM page_layout_revisions WHERE page_id = ?')
      .bind(pageId),
  ]);

  const revisionRows = (results[3]?.results ?? []) as { breakpoint: LayoutBreakpoint; revision: number }[];
  const layoutRevisions = new Map<LayoutBreakpoint, number>();
  for (const row of revisionRows) {
    layoutRevisions.set(row.breakpoint, row.revision);
  }

  return {
    page: ((results[0]?.results ?? []) as PageRow[])[0] ?? null,
    instances: (results[1]?.results ?? []) as InstanceRow[],
    rects: (results[2]?.results ?? []) as LayoutRow[],
    layoutRevisions,
  };
}

export async function readWorkbenchRevision(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(WORKBENCH_REVISION_SQL)
    .bind(workspaceId)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

export async function readTakenSlugs(db: D1Database, workspaceId: string): Promise<Set<string>> {
  const result = await db
    .prepare('SELECT slug FROM workspace_pages WHERE workspace_id = ?')
    .bind(workspaceId)
    .all<{ slug: string }>();
  return new Set(result.results.map((row) => row.slug));
}

/**
 * 生成一个在工作空间内（**含墓碑**）唯一的 slug。
 *
 * 为什么必须包含墓碑：`idx_workspace_pages_slug` 是覆盖全部行的唯一索引
 * （这样「恢复已删除页面」永远不会与新页面撞 slug）。因此任何写入新页面的路径
 * ——新建、模板重置、**导入**——都必须先避开已存在的 slug。
 * 导入尤其重要：把一份导出重新导回同一个工作空间时，备份里的 slug 一定已被占用，
 * 若原样写入会撞唯一索引并让整个导入事务回滚。
 */
/**
 * 去掉首尾的连字符。
 *
 * 刻意**不用** `/^-+|-+$/g`：带 `g` 的「两侧锚点 + 量词」组合在引擎里会对每个起始位置重试，
 * 属于超线性回溯的写法（Sonar 安全规则会标记它）。这里用一次线性扫描，行为完全等价，
 * 且对任意长度的输入都是 O(n)。
 */
function stripEdgeDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charAt(start) === '-') {
    start += 1;
  }
  while (end > start && value.charAt(end - 1) === '-') {
    end -= 1;
  }
  return value.slice(start, end);
}

export function pickUniqueSlug(base: string, taken: Set<string>): string {
  const normalized = stripEdgeDashes(
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 48),
  );
  const root = normalized.length > 0 ? normalized : 'page';
  if (!taken.has(root)) {
    return root;
  }
  for (let index = 2; index <= MAX_PAGES_PER_WORKSPACE * 8; index += 1) {
    const candidate = `${root}-${String(index)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  // 极端兜底：用一个必然不冲突的后缀（调用方仍会把它加入 taken 集合）。
  return `${root}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// 模块门禁与注册表
// ---------------------------------------------------------------------------

export interface ModuleGate {
  readonly status: ModuleGateStatus;
  readonly revision: number;
}

/** 该工作空间内该模块的门禁事实（状态 + revision + 是否有待完成操作）。 */
export async function readModuleGate(
  db: D1Database,
  workspaceId: string,
  moduleId: string,
): Promise<ModuleGate> {
  const snapshot = await readModuleSnapshot(db, workspaceId, moduleId);
  if (snapshot === null) {
    return { status: 'not_installed', revision: 0 };
  }
  if (snapshot.pendingRow !== null) {
    return { status: 'transitioning', revision: snapshot.row.revision };
  }
  return { status: snapshot.row.status, revision: snapshot.row.revision };
}

/** 门禁不通过时的可读原因（不回显任何内部标识之外的信息）。 */
export function moduleNotReadyDetail(gate: ModuleGate): string {
  switch (gate.status) {
    case 'not_installed':
      return '模块尚未安装，无法写入组件实例';
    case 'transitioning':
      return '模块正在执行生命周期变更，暂时不能写入组件实例';
    case 'disabled':
      return '模块已停用，请先启用后再添加组件';
    case 'uninstalled':
      return '模块已卸载，请先恢复后再添加组件';
    case 'enabled':
      return '模块代际已变化，请重新读取后再提交';
  }
}

export function moduleIdOfWidget(registry: ModuleRegistry, widgetType: string): string | null {
  return registry.findWidget(widgetType)?.module.manifest.id ?? null;
}

export function allowMultipleOfWidget(registry: ModuleRegistry, widgetType: string): boolean | null {
  const found = registry.findWidget(widgetType);
  return found === undefined ? null : found.widget.allowMultiple;
}

export function sizeConstraintOfWidget(
  registry: ModuleRegistry,
  widgetType: string,
): { minW: number; minH: number; maxW: number | null; maxH: number | null } | null {
  const found = registry.findWidget(widgetType);
  if (found === undefined) {
    return null;
  }
  return {
    minW: found.widget.minSize.w,
    minH: found.widget.minSize.h,
    maxW: found.widget.maxSize?.w ?? null,
    maxH: found.widget.maxSize?.h ?? null,
  };
}

export interface NormalizedConfig {
  readonly ok: true;
  readonly json: string;
  readonly configVersion: number;
}

/**
 * 校验并归一化实例配置。
 *
 * 服务端**从不**信任客户端提交的 configVersion：它总是写入注册表当前的
 * `configSchemaVersion`。旧版本配置必须由前端显式迁移后再提交，
 * 服务端不做隐式猜测（与 `resolveWidgetConfig` 的规则保持一致）。
 */
export function normalizeWidgetConfig(
  registry: ModuleRegistry,
  widgetType: string,
  rawConfig: unknown,
): NormalizedConfig | WorkbenchFailure {
  const found = registry.findWidget(widgetType);
  const contract = findWidgetConfigContract(widgetType);
  if (found === undefined || contract === null) {
    return workbenchFailure('widget_unknown', WORKBENCH_MESSAGES.widget_unknown);
  }
  if (contract.configSchemaVersion !== found.widget.configSchemaVersion) {
    // 契约与 Manifest 漂移属于构建期问题（有测试保证一致），这里 fail-closed。
    return workbenchFailure('widget_unknown', '组件配置契约与 Manifest 版本不一致');
  }
  const parsed = contract.schema.safeParse(rawConfig === undefined ? contract.defaultConfig : rawConfig);
  if (!parsed.success) {
    return workbenchFailure('widget_config_invalid', WORKBENCH_MESSAGES.widget_config_invalid);
  }
  const json = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(json).byteLength > MAX_WIDGET_CONFIG_BYTES) {
    return workbenchFailure('widget_config_too_large', WORKBENCH_MESSAGES.widget_config_too_large);
  }
  return { ok: true, json, configVersion: contract.configSchemaVersion };
}

/** 配置是否与已存值语义相同（忽略键顺序），用于幂等 no-op 判定。 */
export function configEquals(storedJson: string, nextJson: string): boolean {
  return stableStringify(parseConfigJson(storedJson)) === stableStringify(parseConfigJson(nextJson));
}

/** 为三个断点各找一个不与现有项重叠的空位；某个断点放不下即返回 null。 */
export function planInitialRects(input: {
  readonly registry: ModuleRegistry;
  readonly widgetType: string;
  readonly widgetId: string;
  readonly existing: readonly LayoutRow[];
}): Record<LayoutBreakpoint, GridRect> | null {
  const found = input.registry.findWidget(input.widgetType);
  if (found === undefined) {
    return null;
  }
  const planned = {} as Record<LayoutBreakpoint, GridRect>;
  for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
    const cols = columnsForBreakpoint(breakpoint);
    const existing = input.existing
      .filter((row) => row.breakpoint === breakpoint)
      .map((row) => ({ x: row.x, y: row.y, w: row.w, h: row.h }));
    const placed = findFreeRect({
      existing,
      w: found.widget.defaultSize.w,
      h: found.widget.defaultSize.h,
      cols,
    });
    if (placed === null) {
      return null;
    }
    planned[breakpoint] = { i: input.widgetId, ...placed };
  }
  return planned;
}

// 从 shared 重新导出，避免本文件的使用方各自 import 一份。
export { columnsForBreakpoint, findFreeRect, stableStringify };
