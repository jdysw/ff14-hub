/**
 * 持久化的 Widget 实例清理端口（阶段 03 替换阶段 02 的 no-op 替身）。
 *
 * 需求原文：「用 D1 持久实例端口替换阶段 02 的 no-op 实例清理」「卸载模块应移除/标记该
 * workspace 内所有页面的该模块实例及布局，保留模块个人数据/设置」「清理的 SQL 要把
 * workspace、模块、revision 上界作为同一个原子条件」「不让旧执行者在 restore 后删新实例」。
 *
 * 实现要点：
 * - 三条条件（`workspace_id` + `module_id` + `created_revision <= 上界`）写在**同一条**
 *   `UPDATE ... WHERE` 里，因此不存在「先按模块查出来、再按 revision 过滤」的时间窗。
 * - 标记为墓碑（`deleted_at`）而不是硬删除：卸载 ≠ 删除个人数据，墓碑也让跨设备同步
 *   （阶段 04/051）能观察到「这里少了一个组件」。
 * - 布局行**硬删除**：实例墓碑本身才是权威记录；一个已墓碑的实例不该再占有网格位置。
 *   同时把受影响页面的三个断点修订号 +1，客户端据此知道该页面布局变了。
 * - `created_revision` 由写入路径记录（新建实例时的模块 revision）。
 *   一个被取代的旧执行者传入的是它自己的准入 revision，因此
 *   **删不掉 restore 之后（代际更大）创建的新实例**。
 * - 清理在同一 `db.batch()` 事务内完成：要么整套生效，要么整体回滚。
 */
import type { ModuleInstanceStore } from '../ports';

export interface D1InstanceStoreDeps {
  readonly db: D1Database;
  /** 可注入时钟，便于测试确定性时间戳。 */
  readonly now?: () => number;
}

const BREAKPOINT_UNION = `(SELECT 'desktop' AS breakpoint
                            UNION ALL SELECT 'tablet'
                            UNION ALL SELECT 'mobile')`;

export function createD1InstanceStore(deps: D1InstanceStoreDeps): ModuleInstanceStore {
  const now = deps.now ?? ((): number => Date.now());

  return {
    persistent: true,

    async removeInstancesForModule(input) {
      const timestamp = now();
      const results = await deps.db.batch([
        // 1) 墓碑化：workspace + module + 代际上界是**同一个原子条件**。
        deps.db
          .prepare(
            `UPDATE widget_instances
                SET deleted_at = ?, revision = revision + 1, updated_at = ?
              WHERE workspace_id = ? AND module_id = ?
                AND deleted_at IS NULL AND created_revision <= ?`,
          )
          .bind(timestamp, timestamp, input.workspaceId, input.moduleId, input.maxRevision),
        // 2) 删除这些实例的布局行（含此前已被其他路径墓碑、代际仍在界内的行）。
        deps.db
          .prepare(
            `DELETE FROM widget_layouts
              WHERE widget_id IN (SELECT id FROM widget_instances
                                   WHERE workspace_id = ? AND module_id = ?
                                     AND deleted_at IS NOT NULL AND created_revision <= ?)`,
          )
          .bind(input.workspaceId, input.moduleId, input.maxRevision),
        // 3) 受影响页面的三个断点修订号 +1（行不存在则先补一行 revision = 0，
        //    再被下一条 +1，于是首次结果恰好是 1，与后续每次 +1 语义一致）。
        deps.db
          .prepare(
            `INSERT INTO page_layout_revisions (page_id, breakpoint, revision, updated_at)
             SELECT DISTINCT wi.page_id, b.breakpoint, 0, ?
               FROM widget_instances wi
               CROSS JOIN ${BREAKPOINT_UNION} b
              WHERE wi.workspace_id = ? AND wi.module_id = ?
                AND wi.deleted_at IS NOT NULL AND wi.created_revision <= ?
                AND NOT EXISTS (SELECT 1 FROM page_layout_revisions r
                                 WHERE r.page_id = wi.page_id AND r.breakpoint = b.breakpoint)`,
          )
          .bind(timestamp, input.workspaceId, input.moduleId, input.maxRevision),
        deps.db
          .prepare(
            `UPDATE page_layout_revisions SET revision = revision + 1, updated_at = ?
              WHERE page_id IN (SELECT DISTINCT wi.page_id FROM widget_instances wi
                                 WHERE wi.workspace_id = ? AND wi.module_id = ?
                                   AND wi.deleted_at IS NOT NULL AND wi.created_revision <= ?)`,
          )
          .bind(timestamp, input.workspaceId, input.moduleId, input.maxRevision),
        // 4) 工作台级修订号 +1（同样先补 0 再 +1）。
        deps.db
          .prepare(
            `INSERT INTO workspace_workbench_state (workspace_id, revision, updated_at)
             SELECT ?, 0, ?
              WHERE NOT EXISTS (SELECT 1 FROM workspace_workbench_state s WHERE s.workspace_id = ?)`,
          )
          .bind(input.workspaceId, timestamp, input.workspaceId),
        deps.db
          .prepare('UPDATE workspace_workbench_state SET revision = revision + 1, updated_at = ? WHERE workspace_id = ?')
          .bind(timestamp, input.workspaceId),
      ]);

      // 第 1 条语句的 changes 就是被移除（墓碑化）的实例数。
      return { removed: results[0]?.meta.changes ?? 0 };
    },

    async countInstancesForModule(input) {
      const row = await deps.db
        .prepare(
          `SELECT COUNT(*) AS count FROM widget_instances wi
            JOIN workspace_pages p ON p.id = wi.page_id
           WHERE wi.workspace_id = ? AND wi.module_id = ?
             AND wi.deleted_at IS NULL AND p.deleted_at IS NULL`,
        )
        .bind(input.workspaceId, input.moduleId)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
  };
}
