-- 0007_workbench_hardening.sql — 阶段 03 复核修复（幂等意图绑定与清理幂等）
--
-- 幂等性：与 0001–0006 一致，**只使用 `CREATE ... IF NOT EXISTS`**，因此重复应用安全。
-- 说明：为什么用「配套表」而不是给既有表 `ADD COLUMN`——
--   SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，给既有表加列会让「原始语句逐条重放」
--   在第二次执行时报 `duplicate column name`，从而破坏本仓库明确要求的
--   「重复应用迁移安全」（HUB-003 验收点，CI 与测试都覆盖）。
--   因此这里新增两张**只增不改**的配套表，语义等价且天然幂等。
--
-- 回退：删除这两张表即可（不涉及既有表的数据变更）。

-- ---------------------------------------------------------------------------
-- 1) workbench_operation_intents —— 幂等键绑定**请求意图**
-- ---------------------------------------------------------------------------
--
-- 只按 (workspace, operationId, kind) 判定重放是不够的：
--   - 同一个 kind 可以指向不同目标（page.update 对 A 页 / B 页）；
--   - layout.save 的 kind 只有断点，不含 page；
--   - 同一个 operationId 换一份 body 也会被当成「重放成功」。
-- 因此把「规范化请求指纹」（SHA-256，含目标 ID / 动作 / 正文 / 预期 revision / 断点）
-- 与幂等记录一起存下来；读取重放与事务冲突路径都比对它：
--   完全相同的请求 → 返回首次结果；指纹不同 → 409 且零写入。
--
-- 为什么单独一张表而不是给 workbench_operations 加列：见文件头（迁移幂等）。
-- 两份记录在**同一个 batch** 里写入，因此不存在「有结果没指纹」的持久半状态；
-- 早期版本写入的行没有指纹（LEFT JOIN 得到空串），服务层按「无法判定」保守处理
-- （要求客户端换新 operationId，不返回旧结果）。
CREATE TABLE IF NOT EXISTS workbench_operation_intents (
  workspace_id        TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operation_id        TEXT    NOT NULL CHECK (length (operation_id) BETWEEN 8 AND 64),
  kind                TEXT    NOT NULL,
  request_fingerprint TEXT    NOT NULL CHECK (length (request_fingerprint) BETWEEN 16 AND 128),
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_workbench_operation_intents_created
  ON workbench_operation_intents (created_at);

-- ---------------------------------------------------------------------------
-- 2) widget_cleanup_marks —— 清理的**本次影响标记**
-- ---------------------------------------------------------------------------
--
-- 复核发现的缺陷：`removeInstancesForModule` 在「没有新增墓碑」的重试里，
-- 仍会按**所有历史墓碑**去 bump 受影响页面的三个断点 revision 与工作台 revision。
-- 旧执行者虽然删不掉新实例，却能让 restore 之后的新布局草稿无端冲突；
-- 而且这让清理本身不幂等。
--
-- 修复方式：每次清理调用先生成随机 `cleanupToken`，并把「本次将要墓碑化的实例」
-- 写进本表（与墓碑 UPDATE 用**完全相同的条件**，且在同一事务内，因此集合必然一致）。
-- 后续的「删除布局行 / 补断点修订行 / bump 页面 revision / bump 工作台 revision」
-- 全部以 `cleanup_token = 本次 token` 为过滤条件：
--   0 个新增墓碑 → 0 行受影响 → 零 revision 变更（真正幂等）；
--   部分命中 → 只 bump 真正被影响的那几个页面。
-- 刻意**不**用时间戳猜「本次」：同毫秒内的两次调用无法区分。
--
-- `page_id` 冗余存一份是为了让「受影响页面」的查询不必再 JOIN 回 widget_instances
-- （被墓碑化的行仍然存在，但少一层 JOIN 更不容易写错过滤条件）。
-- 本表在每次清理事务末尾按 token 清理，因此不会无限增长。
CREATE TABLE IF NOT EXISTS widget_cleanup_marks (
  cleanup_token TEXT    NOT NULL,
  widget_id     TEXT    NOT NULL,
  workspace_id  TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  module_id     TEXT    NOT NULL,
  page_id       TEXT    NOT NULL REFERENCES workspace_pages (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (cleanup_token, widget_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_cleanup_marks_token
  ON widget_cleanup_marks (cleanup_token);

CREATE INDEX IF NOT EXISTS idx_widget_cleanup_marks_workspace
  ON widget_cleanup_marks (workspace_id, module_id, cleanup_token);
