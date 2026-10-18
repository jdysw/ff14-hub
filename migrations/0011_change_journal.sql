-- 0011_change_journal.sql — 跨设备同步的**单调变更序号**（HUB-051 修正）
--
-- 为什么必须换掉 `updated_at` 水位（复核发现的真实缺陷）：
--   以 `updated_at` 当游标时，`nextCursor = lastTs + 1` 隐含了三个错误假设：
--   ① 同一毫秒内后续发生的写入/删除/显式恢复，其 `updated_at` 会 < lastTs+1 而被**永久跳过**；
--   ② 多个 Worker 实例的时钟可能回退/不一致；
--   ③ 墓碑与「同毫秒的合法新 revision」只能靠时间比较先后，会把真实恢复误判成旧数据。
--   这些都不是"分页没补齐同毫秒组"能解决的——缺口在**游标本身**。
--   因此改用**数据库单调序号**：`workspace_changes.seq`（AUTOINCREMENT，只增不减、与时钟无关），
--   游标 = 最后一条已消费的 seq。删除、恢复、更新各占一条新 seq，顺序天然正确。
--
-- 为什么用**触发器**而不是在每个写路径里手动记日志：
--   既有写路径远不止常规 CRUD：模块卸载清理、模板重置、备份导入、墓碑化、未来的新代码……
--   任何一处漏记都会让客户端**永久**丢一次变更，而且无法在客户端补救。
--   触发器由数据库保证「只要这一行变了，同一个事务里就有一条变更记录」，覆盖现在与将来的所有路径。
--
-- 幂等性（与 0001–0010 一致，且本文件必须能被**逐条重放**）：
--   - 建表/索引/触发器全部 `IF NOT EXISTS`；
--   - 回填用 `INSERT ... SELECT ... WHERE NOT EXISTS (...)`，重复执行不会产生重复行；
--   - 不修改任何既有表的结构。
--
-- 明确不做：不做 GC（墓碑与变更记录都保留）；不改变任何既有业务表的语义。

-- ---------------------------------------------------------------------------
-- 关于 DELETE 触发器（刻意**不建立**，复核修正）
-- ---------------------------------------------------------------------------
-- 业务实体一律用墓碑（deleted_at），硬删除只发生在「整个工作空间被删除」时由外键级联触发。
-- 而级联删除时父行 `workspaces` 已经被删，DELETE 触发器若再往 `workspace_changes` 插一行，
-- 其 `workspace_id` 外键指向的父行已不存在 → `FOREIGN KEY constraint failed`，
-- 于是「删除工作空间」这个测试/运维动作会直接失败（复核实测）。
-- 由于级联删除本来就会把该工作空间的变更流一起删掉，没有记录它的意义，因此不建立 DELETE 触发器。
--
-- 关于 `meta.changes`（重要，复核修正）：
-- D1/SQLite 的 `meta.changes`（以及 SQL `changes()`）**会把触发器内的 DML 计入**。
-- 因此本文件给这些表加 AFTER 触发器之后，任何「单行 CAS 更新后判定 `changes === 1`」的地方
-- 都会读到 2。既有代码中依赖该判定的生命周期门禁已同步改为「`>= 1` 表示本次 CAS 生效」
-- （语义仍严格：条件更新命中了行才继续；只是不再假设触发器不存在），并有回归用例盯着。
-- ---------------------------------------------------------------------------
-- 1) workspace_changes —— 每个工作空间一条只增不减的变更流
-- ---------------------------------------------------------------------------
--
-- `seq` 是 **AUTOINCREMENT 主键**：SQLite 保证它严格递增且不复用（即使行被删除），
-- 因此「客户端已消费到 seq=N」是一个安全的水位：任何 seq>N 的变更都还没被它看到。
-- 与时间无关，因而时钟回退、同一毫秒多次写入、系统休眠都不会造成漏变更。
--
-- `entity_type` 与 `sync-api.ts` 的 `SYNC_ENTITY_TYPES` 一一对应（有测试断言两边一致）。
-- `op`：墓碑/硬删除记 'delete'，其余记 'upsert'（客户端据此移除或更新，绝不"因没出现而复活"）。
-- `revision`：该实体**自身**的修订号（memberships 没有 revision 列，记 0）；
--   **不**用它推导工作空间级修订号（那是另一个字段，见响应里的 meta）。
CREATE TABLE IF NOT EXISTS workspace_changes (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  entity_type  TEXT    NOT NULL
                 CHECK (entity_type IN ('page', 'widget', 'layout', 'nav_link',
                                        'nav_group', 'nav_membership', 'module', 'workspace_event')),
  entity_id    TEXT    NOT NULL CHECK (length (entity_id) BETWEEN 1 AND 120),
  op           TEXT    NOT NULL CHECK (op IN ('upsert', 'delete')),
  revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at   INTEGER NOT NULL
);

-- 游标扫描的唯一索引：`WHERE workspace_id = ? AND seq > ? ORDER BY seq`。
CREATE INDEX IF NOT EXISTS idx_workspace_changes_workspace_seq
  ON workspace_changes (workspace_id, seq);

-- ---------------------------------------------------------------------------
-- 2) 触发器：把「行变了」变成「变更流里多一条」
-- ---------------------------------------------------------------------------
--
-- 说明：所有业务表都用**墓碑**（deleted_at）而不是硬删除，因此 `op` 由 `deleted_at` 是否非空决定。
-- 布局实体（layout）没有自己的表：它的身份是「页面 × 断点」，状态存在 `page_layout_revisions`，
-- 而矩形存在 `widget_layouts`。因此 layout 的变更源是 `page_layout_revisions` 的 INSERT/UPDATE
-- （布局保存与模块卸载清理都会 bump 它的 revision 与 updated_at）。

CREATE TRIGGER IF NOT EXISTS trg_workspace_pages_change_insert
AFTER INSERT ON workspace_pages
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'page', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_pages_change_update
AFTER UPDATE ON workspace_pages
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'page', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_widget_instances_change_insert
AFTER INSERT ON widget_instances
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'widget', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_widget_instances_change_update
AFTER UPDATE ON widget_instances
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'widget', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

-- 布局：实体 ID 是 `${pageId}:${breakpoint}`；工作空间通过页面回溯。
-- 页面已被墓碑时，布局变更记为 delete（页面整体不可见）。
CREATE TRIGGER IF NOT EXISTS trg_page_layout_revisions_change_insert
AFTER INSERT ON page_layout_revisions
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  SELECT p.workspace_id, 'layout', NEW.page_id || ':' || NEW.breakpoint,
         CASE WHEN p.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
         NEW.revision, NEW.updated_at
    FROM workspace_pages p
   WHERE p.id = NEW.page_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_page_layout_revisions_change_update
AFTER UPDATE ON page_layout_revisions
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  SELECT p.workspace_id, 'layout', NEW.page_id || ':' || NEW.breakpoint,
         CASE WHEN p.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
         NEW.revision, NEW.updated_at
    FROM workspace_pages p
   WHERE p.id = NEW.page_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_nav_links_change_insert
AFTER INSERT ON workspace_nav_links
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'nav_link', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_nav_links_change_update
AFTER UPDATE ON workspace_nav_links
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'nav_link', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_nav_groups_change_insert
AFTER INSERT ON workspace_nav_groups
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'nav_group', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_nav_groups_change_update
AFTER UPDATE ON workspace_nav_groups
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'nav_group', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

-- 成员关系：实体 ID 是 `${linkId}:${groupId}`（两个 36 字符 UUID + 分隔符 = 73）
CREATE TRIGGER IF NOT EXISTS trg_workspace_nav_memberships_change_insert
AFTER INSERT ON workspace_nav_memberships
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'nav_membership', NEW.link_id || ':' || NEW.group_id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          0, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_nav_memberships_change_update
AFTER UPDATE ON workspace_nav_memberships
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'nav_membership', NEW.link_id || ':' || NEW.group_id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          0, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_modules_change_insert
AFTER INSERT ON workspace_modules
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'module', NEW.module_id, 'upsert', NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_modules_change_update
AFTER UPDATE ON workspace_modules
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'module', NEW.module_id, 'upsert', NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_events_change_insert
AFTER INSERT ON workspace_events
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'workspace_event', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_events_change_update
AFTER UPDATE ON workspace_events
BEGIN
  INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
  VALUES (NEW.workspace_id, 'workspace_event', NEW.id,
          CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
          NEW.revision, NEW.updated_at);
END;

-- ---------------------------------------------------------------------------
-- 3) 回填：让「迁移之前就存在的行」也有一条初始变更记录
-- ---------------------------------------------------------------------------
--
-- 为什么必须回填：游标为 null 的首次同步也走同一条变更流；若历史行没有记录，
-- 已存在的导航链接/页面/实例永远同步不到新设备。
-- 每条都带 `WHERE NOT EXISTS`：迁移语句被逐条重放时不会重复插入（迁移可重放是既定验收点）。

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT p.workspace_id, 'page', p.id,
       CASE WHEN p.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
       p.revision, p.updated_at
  FROM workspace_pages p
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = p.workspace_id AND c.entity_type = 'page' AND c.entity_id = p.id
 );

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT w.workspace_id, 'widget', w.id,
       CASE WHEN w.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
       w.revision, w.updated_at
  FROM widget_instances w
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = w.workspace_id AND c.entity_type = 'widget' AND c.entity_id = w.id
 );

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT p.workspace_id, 'layout', r.page_id || ':' || r.breakpoint,
       CASE WHEN p.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
       r.revision, r.updated_at
  FROM page_layout_revisions r
  JOIN workspace_pages p ON p.id = r.page_id
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = p.workspace_id AND c.entity_type = 'layout'
      AND c.entity_id = r.page_id || ':' || r.breakpoint
 );

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT l.workspace_id, 'nav_link', l.id,
       CASE WHEN l.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
       l.revision, l.updated_at
  FROM workspace_nav_links l
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = l.workspace_id AND c.entity_type = 'nav_link' AND c.entity_id = l.id
 );

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT g.workspace_id, 'nav_group', g.id,
       CASE WHEN g.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
       g.revision, g.updated_at
  FROM workspace_nav_groups g
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = g.workspace_id AND c.entity_type = 'nav_group' AND c.entity_id = g.id
 );

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT m.workspace_id, 'nav_membership', m.link_id || ':' || m.group_id,
       CASE WHEN m.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
       0, m.updated_at
  FROM workspace_nav_memberships m
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = m.workspace_id AND c.entity_type = 'nav_membership'
      AND c.entity_id = m.link_id || ':' || m.group_id
 );

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT wm.workspace_id, 'module', wm.module_id, 'upsert', wm.revision, wm.updated_at
  FROM workspace_modules wm
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = wm.workspace_id AND c.entity_type = 'module' AND c.entity_id = wm.module_id
 );

INSERT INTO workspace_changes (workspace_id, entity_type, entity_id, op, revision, changed_at)
SELECT e.workspace_id, 'workspace_event', e.id,
       CASE WHEN e.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
       e.revision, e.updated_at
  FROM workspace_events e
 WHERE NOT EXISTS (
   SELECT 1 FROM workspace_changes c
    WHERE c.workspace_id = e.workspace_id AND c.entity_type = 'workspace_event' AND c.entity_id = e.id
 );
