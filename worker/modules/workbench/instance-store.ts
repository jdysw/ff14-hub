/**
 * 持久化的 Widget 实例清理端口（阶段 03，含复核修复）。
 *
 * 需求：卸载模块要移除/标记该 workspace 内**所有页面**上该模块的实例与布局，
 * 保留模块个人数据/设置；清理的 SQL 把 `workspace + module + revision 上界` 作为**同一个原子条件**；
 * 旧执行者不能删掉 restore 之后创建的新实例。
 *
 * 复核修复（幂等）：原实现里「删除布局行 / 补断点修订行 / bump 页面 revision / bump 工作台 revision」
 * 按「该模块下**所有历史墓碑**」过滤，于是**没有新增墓碑的重试**也会再推一轮 revision，
 * 让 restore 之后的新布局草稿无端 409，且清理本身不幂等。
 *
 * 现在：每次调用生成随机 `cleanupToken`，先把「本次将要墓碑化的实例」（与墓碑 UPDATE
 * **完全相同的条件**、同一事务）写进 `widget_cleanup_marks`，后续所有语句都以该 token 过滤：
 *   - 0 个新增墓碑 → 后续每条语句影响 0 行 → **零 revision 变更**（真正幂等）；
 *   - 部分命中 → 只 bump 真正被影响的那几个页面。
 * 刻意**不**用时间戳猜「本次」：同毫秒内的两次调用无法区分。
 *
 * 整个过程仍在同一个 `db.batch()` 事务内完成：要么整套生效，要么整体回滚。
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
      // 本次清理的唯一标记：**不**用时间戳，避免同毫秒内的两次调用无法区分。
      const cleanupToken = crypto.randomUUID();

      const results = await deps.db.batch([
        // 1) 记录「本次将要墓碑化」的实例。条件与第 2 条完全一致，且同处一个事务，
        //    因此这个集合必然等于第 2 条真正墓碑化的行。
        deps.db
          .prepare(
            `INSERT INTO widget_cleanup_marks (cleanup_token, widget_id, workspace_id, module_id, page_id, created_at)
             SELECT ?, wi.id, wi.workspace_id, wi.module_id, wi.page_id, ?
               FROM widget_instances wi
              WHERE wi.workspace_id = ? AND wi.module_id = ?
                AND wi.deleted_at IS NULL AND wi.created_revision <= ?`,
          )
          .bind(cleanupToken, timestamp, input.workspaceId, input.moduleId, input.maxRevision),
        // 2) 墓碑化：workspace + module + 代际上界是**同一个原子条件**；
        //    范围再收紧到本次标记集合（与第 1 条同集合，等价于原来的 WHERE）。
        deps.db
          .prepare(
            `UPDATE widget_instances
                SET deleted_at = ?, revision = revision + 1, updated_at = ?
              WHERE deleted_at IS NULL
                AND id IN (SELECT widget_id FROM widget_cleanup_marks WHERE cleanup_token = ?)`,
          )
          .bind(timestamp, timestamp, cleanupToken),
        // 3) 只删除**本次墓碑**的实例的布局行。
        deps.db
          .prepare(
            `DELETE FROM widget_layouts
              WHERE widget_id IN (SELECT widget_id FROM widget_cleanup_marks WHERE cleanup_token = ?)`,
          )
          .bind(cleanupToken),
        // 4) 为「本次受影响页面」补齐缺失的断点修订行（初始 0，随后由第 5 条 +1 → 首次结果为 1）。
        deps.db
          .prepare(
            `INSERT INTO page_layout_revisions (page_id, breakpoint, revision, updated_at)
             SELECT DISTINCT m.page_id, b.breakpoint, 0, ?
               FROM widget_cleanup_marks m
               CROSS JOIN ${BREAKPOINT_UNION} b
              WHERE m.cleanup_token = ?
                AND NOT EXISTS (SELECT 1 FROM page_layout_revisions r
                                 WHERE r.page_id = m.page_id AND r.breakpoint = b.breakpoint)`,
          )
          .bind(timestamp, cleanupToken),
        // 5) 只 bump「本次受影响页面」的三个断点 revision。
        deps.db
          .prepare(
            `UPDATE page_layout_revisions SET revision = revision + 1, updated_at = ?
              WHERE page_id IN (SELECT DISTINCT page_id FROM widget_cleanup_marks WHERE cleanup_token = ?)`,
          )
          .bind(timestamp, cleanupToken),
        // 6) 工作台级 revision 只有在「本次确实移除了实例」时才推进。
        deps.db
          .prepare(
            `INSERT INTO workspace_workbench_state (workspace_id, revision, updated_at)
             SELECT ?, 0, ?
              WHERE NOT EXISTS (SELECT 1 FROM workspace_workbench_state s WHERE s.workspace_id = ?)
                AND EXISTS (SELECT 1 FROM widget_cleanup_marks WHERE cleanup_token = ?)`,
          )
          .bind(input.workspaceId, timestamp, input.workspaceId, cleanupToken),
        deps.db
          .prepare(
            `UPDATE workspace_workbench_state SET revision = revision + 1, updated_at = ?
              WHERE workspace_id = ?
                AND EXISTS (SELECT 1 FROM widget_cleanup_marks WHERE cleanup_token = ?)`,
          )
          .bind(timestamp, input.workspaceId, cleanupToken),
        // 7) 在清理标记**删除之前**数一次本次的墓碑数：
        //    不能用第 2 条语句的 `meta.changes` 计数——D1 的 `meta.changes` 会计入触发器写入
        //    （widget_instances 上的同步变更日志触发器会再加 1 行），那样会把数量算成两倍。
        //    这条 SELECT 与后续语句在同一个 batch（同一事务）里，因此读到的是权威值。
        deps.db
          .prepare('SELECT COUNT(*) AS count FROM widget_cleanup_marks WHERE cleanup_token = ?')
          .bind(cleanupToken),
        // 8) 本次标记用完即清（表不会无限增长；重试会用新 token 重新收集）。
        deps.db
          .prepare('DELETE FROM widget_cleanup_marks WHERE cleanup_token = ?')
          .bind(cleanupToken),
      ]);

      // 第 7 条语句（SELECT COUNT(*)）的结果就是本次真正新增的墓碑数；0 表示本次没有任何变化。
      const removedRows = results[results.length - 2]?.results as { count: number }[] | undefined;
      return { removed: removedRows?.[0]?.count ?? 0 };
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
