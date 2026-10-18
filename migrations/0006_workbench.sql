-- 0006_workbench.sql — 阶段 03 自定义工作台（HUB-045 / HUB-046 / HUB-049 / HUB-054）
--
-- 幂等性：与 0001–0005 一致，只使用 `CREATE ... IF NOT EXISTS`，因此重复应用是安全的。
--
-- 本迁移建立 7 张表：
--   1) workspace_pages            多页面（含默认页与墓碑）
--   2) widget_instances           Widget 实例（含墓碑与模块代际标记）
--   3) widget_layouts             「实例 × 断点」矩形（ADR-010：各端独立）
--   4) page_layout_revisions      「页面 × 断点」独立修订号（乐观并发 + 冲突检测）
--   5) workspace_workbench_state  工作空间级工作台修订号（导入预览的新鲜度令牌）
--   6) workbench_operations       幂等 operationId 的结果留痕
--   7) workbench_backups          替换导入前的可恢复备份（"先备份、可撤销"）
--
-- 工作空间回溯（规划 5.1）：
--   workspace_pages / widget_instances / workspace_workbench_state / workbench_operations /
--   workbench_backups 都带 NOT NULL 的 workspace_id 外键。
--   widget_layouts 与 page_layout_revisions 通过 widget_id / page_id 的约束外键唯一回溯：
--   两者指向的行都带 NOT NULL 的 workspace_id，且外键为 ON DELETE CASCADE。
--   → 私有数据不可能出现「无法回溯到工作空间」的行。
--
-- 删除策略（规划 5.3）：页面与实例一律**墓碑**（deleted_at），不做硬删除。
--   墓碑保留供后续跨设备同步（阶段 04/051）；本阶段不实现 GC（不假装已实现同步水位）。
--
-- 为什么 module_id / widget_type **没有**外键：
--   模块与组件是代码里的静态注册项（worker/modules/registry、apps/web 的静态组件映射），
--   不是数据库行。合法性由注册表校验；用 FK 表达反而会暗示「模块是可插入的数据」。
--
-- 明确不建立的表：本阶段**不**建立 nav_* / fish_* / notification_* / push_* 等
--   阶段 04–06 的表。也不建立任何 Cron 触发或远程资源。
--
-- 回滚/兼容说明：本迁移只新增表与索引，不改动既有列，因此对阶段 01/02 的功能
--   完全无影响；若需回退，删除这 7 张表即可（不含对既有表的数据变更）。

-- ---------------------------------------------------------------------------
-- 1) workspace_pages —— 多页面工作台
-- ---------------------------------------------------------------------------
--
-- 「有活跃页面时默认页唯一」由**两条**保证共同构成（复核要求：数据库/事务不变量）：
--   a) 部分唯一索引 `idx_workspace_pages_single_default`：
--      `WHERE is_default = 1 AND deleted_at IS NULL` 保证活跃页面中默认页**至多一个**；
--      它是数据库级硬约束，任何绕过服务层的写入（包括导入与手工 SQL）都撞得上。
--   b) 服务层事务：任何可能改变活跃页面集合的写入，都在**同一 D1 batch** 内把
--      「恰好一个默认页」重新推导一次（无活跃页面时允许 0 个）。
--      SQLite 无法声明式表达「集合非空时恰好一个」，因此这一半必须由事务补足，并有测试覆盖。
--
-- slug 在**整个工作空间**（含墓碑）内唯一：这样「恢复已删除页面」永远不会与
--   新页面撞 slug，代价是已删除页面的 slug 被永久保留（页面数上限 30，可以接受）。
CREATE TABLE IF NOT EXISTS workspace_pages (
  id           TEXT    NOT NULL PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL CHECK (length (name) BETWEEN 1 AND 60),
  slug         TEXT    NOT NULL CHECK (length (slug) BETWEEN 1 AND 60),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sort_order   INTEGER NOT NULL,
  -- 页面级修订号（改名 / 排序 / 默认页 / 恢复），从 0 开始单调递增。
  revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  -- 非空即已删除（墓碑）。墓碑页面不参与任何「活跃页面」判定。
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- slug 唯一（包含墓碑，见文件头说明）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_pages_slug
  ON workspace_pages (workspace_id, slug);

-- 「活跃页面中默认页至多一个」：数据库级硬约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_pages_single_default
  ON workspace_pages (workspace_id)
  WHERE is_default = 1 AND deleted_at IS NULL;

-- 列表查询：按工作空间取活跃页面并排序。
CREATE INDEX IF NOT EXISTS idx_workspace_pages_active
  ON workspace_pages (workspace_id, deleted_at, sort_order);

-- ---------------------------------------------------------------------------
-- 2) widget_instances —— 页面上的 Widget 实例
-- ---------------------------------------------------------------------------
--
-- created_revision 是**模块代际标记**（生命周期清理端口的 fence 依据）：
--   创建实例时写入该 workspace 内该模块当时的 `workspace_modules.revision`；
--   模块未安装时写 0。卸载模块时的清理 SQL 把
--   「workspace_id + module_id + created_revision <= 上界」作为**同一个原子条件**，
--   因此一个被取代的旧执行者删不掉 restore 之后创建的新实例（ADR-0002 D4 / D13）。
--
-- hidden 与「移除」是两件事（规划规则 7）：
--   is_hidden = 1 只是不渲染；deleted_at 非空才是移除（墓碑）。两者都不影响模块状态与个人数据。
CREATE TABLE IF NOT EXISTS widget_instances (
  id               TEXT    NOT NULL PRIMARY KEY,
  workspace_id     TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  page_id          TEXT    NOT NULL REFERENCES workspace_pages (id) ON DELETE CASCADE,
  module_id        TEXT    NOT NULL,
  widget_type      TEXT    NOT NULL,
  -- 实例配置的 JSON 文本。大小上限由服务层按 MAX_WIDGET_CONFIG_BYTES 校验（4 KiB）。
  config_json      TEXT    NOT NULL,
  config_version   INTEGER NOT NULL CHECK (config_version >= 0),
  is_hidden        INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  revision         INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_revision INTEGER NOT NULL DEFAULT 0 CHECK (created_revision >= 0),
  deleted_at       INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 页面实例列表（含隐藏；排除墓碑由查询条件负责）。
CREATE INDEX IF NOT EXISTS idx_widget_instances_page
  ON widget_instances (page_id, deleted_at, created_at);

-- 生命周期清理路径的索引：三条件（workspace + module + 代际上界）一次命中。
CREATE INDEX IF NOT EXISTS idx_widget_instances_workspace_module
  ON widget_instances (workspace_id, module_id, deleted_at, created_revision);

-- 单例组件（allowMultiple = false）的服务层校验按「工作空间 + widget_type」查活跃实例。
CREATE INDEX IF NOT EXISTS idx_widget_instances_workspace_widget
  ON widget_instances (workspace_id, widget_type, deleted_at);

-- ---------------------------------------------------------------------------
-- 3) widget_layouts —— 「实例 × 断点」矩形
-- ---------------------------------------------------------------------------
--
-- 主键 (widget_id, breakpoint) 保证每个实例在每个断点最多一个矩形。
-- 服务层保存布局时以「页面 + 断点」为整体替换（DELETE + INSERT），并只接受
-- `validateLayoutRects` 通过的数据；数据库这一层用 CHECK 兜住坐标与尺寸的基本合法性。
--
-- 注意：min/maxSize 来自**静态注册表**，不是数据库能知道的，因此不在 CHECK 里表达；
--   越界与非法重叠由服务层（同一份纯函数）统一判定。
CREATE TABLE IF NOT EXISTS widget_layouts (
  widget_id  TEXT    NOT NULL REFERENCES widget_instances (id) ON DELETE CASCADE,
  breakpoint TEXT    NOT NULL CHECK (breakpoint IN ('desktop', 'tablet', 'mobile')),
  x          INTEGER NOT NULL CHECK (x >= 0),
  y          INTEGER NOT NULL CHECK (y >= 0),
  w          INTEGER NOT NULL CHECK (w >= 1),
  h          INTEGER NOT NULL CHECK (h >= 1),
  PRIMARY KEY (widget_id, breakpoint)
);

-- ---------------------------------------------------------------------------
-- 4) page_layout_revisions —— 「页面 × 断点」独立修订号
-- ---------------------------------------------------------------------------
--
-- 这是 ADR-010 的核心：桌面/平板/手机各自独立修订。
--   手机端保存布局只会 bump mobile 的 revision，因此**不会**让桌面端在途保存变成 409。
--   反过来说，任意一端保存都会 bump `workspace_workbench_state.revision`（工作台级令牌），
--   用于导入预览的新鲜度判断——那是「工作台整体」的语义，与断点级并发是两件事。
--
-- 行缺失等价于 revision = 0（尚未保存过布局），由服务层派生，不预先插行。
CREATE TABLE IF NOT EXISTS page_layout_revisions (
  page_id    TEXT    NOT NULL REFERENCES workspace_pages (id) ON DELETE CASCADE,
  breakpoint TEXT    NOT NULL CHECK (breakpoint IN ('desktop', 'tablet', 'mobile')),
  revision   INTEGER NOT NULL CHECK (revision >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, breakpoint)
);

-- ---------------------------------------------------------------------------
-- 5) workspace_workbench_state —— 工作空间级工作台修订号
-- ---------------------------------------------------------------------------
--
-- 用途只有两个，都很具体：
--   a) 给「导入预览」一个新鲜度令牌：预览时返回 revision，apply 时若已被改动则 409
--      （避免「按旧预览替换掉别人刚做的工作」）；
--   b) 给前端一个便宜的「工作台有没有变」信号（避免为了判断变化而拉全量快照）。
-- 行不存在等价于 revision = 0；由 upsert 创建。
CREATE TABLE IF NOT EXISTS workspace_workbench_state (
  workspace_id TEXT    NOT NULL PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 6) workbench_operations —— 幂等 operationId
-- ---------------------------------------------------------------------------
--
-- 语义（规划 5.3：幂等 operationId）：
--   客户端每次「意图」生成一个 operationId，重试时**复用同一个**。
--   服务端在事务内先尝试插入本表；插入失败即表示这是一次重放，
--   此时直接返回已存的 result_json，**不重复施加副作用**。
--   `kind` 记录操作类别：同一个 operationId 被用于不同类别时返回 409
--   （这是客户端 bug 或探测行为，不能静默当成重放放行）。
--
-- attempt_token 是**本次尝试的随机标记**（复核要求：避免「重放也满足守卫」）：
--   一次写入用同一个 D1 batch 完成「认领 + 全部变更 + 落结果」，batch 内每条变更语句都以
--     `EXISTS (SELECT 1 FROM workbench_operations WHERE workspace_id=? AND operation_id=? AND attempt_token=?)`
--   为守卫。重放会生成**新的**随机 token，永远不会与已存行匹配，因此重放不可能再次施加副作用；
--   并发抢输的一方因 `ON CONFLICT DO NOTHING` 未插入该 token，其全部语句同样不生效。
--   收尾语句清空 attempt_token 并写入真实 result_json；由于 batch 是原子的，
--   「已认领但未收尾」的状态在事务外不可观测，不需要额外的崩溃恢复流程。
--
-- 结果里只存**可安全回显**的内容（不含任何凭证——本阶段的结果本身也不含凭证）。
CREATE TABLE IF NOT EXISTS workbench_operations (
  workspace_id  TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operation_id  TEXT    NOT NULL CHECK (length (operation_id) BETWEEN 8 AND 64),
  kind          TEXT    NOT NULL,
  result_json   TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  attempt_token TEXT,
  PRIMARY KEY (workspace_id, operation_id)
);

-- 保留策略：本阶段不自动清理（不假装有 GC）；索引便于将来按时间裁剪。
CREATE INDEX IF NOT EXISTS idx_workbench_operations_created
  ON workbench_operations (created_at);

-- ---------------------------------------------------------------------------
-- 7) workbench_backups —— 替换导入前的可恢复备份
-- ---------------------------------------------------------------------------
--
-- 需求原文：「替换导入先提供可恢复备份或撤销，失败不能留下半导入」。
--   因此 replace 模式在**同一事务**里先写入一份 kind='pre_import' 的当前快照，
--   再把工作台替换成备份内容；用户事后可调用恢复端点回到导入前。
--
-- 内容边界（与导出完全一致）：只有工作台配置，**不含**设备 Token / 恢复密钥 /
--   WebDAV 凭证 / VAPID 私钥 / 任何环境变量或服务端秘密。
--
-- 保留策略：每个工作空间最多保留最近 5 份（由服务层裁剪，含 pre_import 与 manual）。
--   恢复后把 consumed_at 置为非空，便于界面区分「已用过的撤销点」。
CREATE TABLE IF NOT EXISTS workbench_backups (
  id                TEXT    NOT NULL PRIMARY KEY,
  workspace_id      TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind              TEXT    NOT NULL CHECK (kind IN ('pre_import', 'manual')),
  schema_version    INTEGER NOT NULL CHECK (schema_version >= 0),
  payload_json      TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  -- 设备被删除时置空，保留备份本身（与 identity_audit 的处理一致）。
  created_by_device TEXT REFERENCES devices (id) ON DELETE SET NULL,
  consumed_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workbench_backups_workspace
  ON workbench_backups (workspace_id, created_at DESC);
