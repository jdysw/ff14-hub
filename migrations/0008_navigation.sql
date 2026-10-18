-- 0008_navigation.sql — 阶段 04 自由导航（HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009）
--
-- 幂等性：与 0001–0007 一致，只使用 `CREATE ... IF NOT EXISTS`，因此重复应用（含把本文件的
-- 语句逐条重放）都是安全的。本文件**没有** INSERT/UPDATE：目录种子在代码里（见
-- worker/modules/nav/catalog.ts 的版本化 upsert），因此迁移本身不会写入任何数据。
--
-- 本迁移建立 7 张表：
--   1) nav_catalog_links             系统推荐目录（只读；只有种子代码写入）
--   2) workspace_nav_links           个人链接副本（完全可编辑，含墓碑与修订号）
--   3) workspace_nav_groups          个人分类 / 分组
--   4) workspace_nav_memberships     链接 × 分组（多分组 + 组内顺序，含墓碑）
--   5) workspace_nav_state           工作空间级导航修订号（新鲜度令牌）
--   6) nav_operations                幂等 operationId 的结果留痕（与工作台同一套算法）
--   7) nav_operation_intents         幂等记录的请求意图指纹
--
-- 工作空间回溯（规划 5.1）：workspace_nav_links / workspace_nav_groups /
--   workspace_nav_memberships / workspace_nav_state / nav_operations 都带 NOT NULL 的
--   workspace_id 外键。memberships 同时外键到 links 与 groups，因此**外键本身不足以**
--   证明三者的 workspace 一致：服务层必须在同一事务内校验三者相等（有测试覆盖）。
--   这里额外冗余一列 workspace_id 不是为了替代该校验，而是让「按工作空间扫描同步水位」
--   不必 join，并让「跨工作空间关联」在索引层面更容易被审计发现。
--
-- 目录与个人副本分离（ADR-0004 D1）：workspace_nav_links.source_catalog_id **刻意不加外键**。
--   目录条目被下线/改名后个人副本必须继续存在；「至多一条活跃副本」由部分唯一索引保证。
--
-- 删除策略（规划 5.3）：链接/分组/成员关系一律**墓碑**（deleted_at），不做硬删除。
--   墓碑跨设备同步（HUB-051），且本阶段**不做 GC**——不假装有保留策略实现，
--   因此不会出现「早于某设备水位被删掉」的情况。
--
-- 明确不建立：本迁移不建立任何远程资源、Cron 触发或 fish_*/notification_* 表。

-- ---------------------------------------------------------------------------
-- 1) nav_catalog_links —— 系统推荐目录（只读）
-- ---------------------------------------------------------------------------
--
-- 只有 worker/modules/nav/catalog.ts 的版本化 upsert 会写这张表；没有任何用户 API 能修改它。
-- `source_version` 单调递增：代码里的种子版本更大时才覆盖，永不降级。
-- `source_url` + `verified_at` 是「这条推荐来自哪里、什么时候核对过」的留痕，
--   没有来源与核对时间的条目不允许进入种子（见 nav-catalog.spec.ts）。
-- `verification_status` 只表示**来源条目本身**是否核对过，不代表网站当前在线状态；
--   在线健康状态是 workspace_nav_links.health（本阶段一律 unknown，不做探测）。
CREATE TABLE IF NOT EXISTS nav_catalog_links (
  id                  TEXT    NOT NULL PRIMARY KEY,
  source_version      INTEGER NOT NULL CHECK (source_version >= 1),
  title               TEXT    NOT NULL CHECK (length (title) BETWEEN 1 AND 80),
  url                 TEXT    NOT NULL CHECK (length (url) BETWEEN 1 AND 2048),
  description         TEXT    NOT NULL DEFAULT '' CHECK (length (description) <= 500),
  category            TEXT    NOT NULL CHECK (length (category) BETWEEN 1 AND 40),
  tags_json           TEXT    NOT NULL DEFAULT '[]',
  aliases_json        TEXT    NOT NULL DEFAULT '[]',
  icon                TEXT    NOT NULL DEFAULT '',
  open_mode           TEXT    NOT NULL DEFAULT 'new_tab' CHECK (open_mode IN ('new_tab', 'same_tab')),
  region              TEXT    NOT NULL CHECK (region IN ('cn', 'global', 'both')),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  source_url          TEXT    NOT NULL CHECK (length (source_url) BETWEEN 1 AND 2048),
  source_name         TEXT    NOT NULL DEFAULT '' CHECK (length (source_name) <= 80),
  verified_at         INTEGER NOT NULL,
  verification_status TEXT    NOT NULL CHECK (verification_status IN ('verified', 'unverified')),
  updated_at          INTEGER NOT NULL
);

-- 目录浏览：按分类 / 区服筛选。
CREATE INDEX IF NOT EXISTS idx_nav_catalog_links_category
  ON nav_catalog_links (category, region, sort_order);

-- 目录浏览：按区服排序。
CREATE INDEX IF NOT EXISTS idx_nav_catalog_links_region
  ON nav_catalog_links (region, sort_order);

-- ---------------------------------------------------------------------------
-- 2) workspace_nav_links —— 个人链接副本
-- ---------------------------------------------------------------------------
--
-- 导入即完全独立：用户可以改名、改 URL、改分类归属、删除；目录升级**不会**覆盖这些修改，
--   也**不会**复活墓碑。
-- 字段完整性：名称 / URL / 描述 / 标签 / 别名 / 图标 / 打开方式 / 区服 / 收藏 / 状态 /
--   手动顺序 / 健康状态（人工或后续探测，本阶段 unknown）。
CREATE TABLE IF NOT EXISTS workspace_nav_links (
  id                      TEXT    NOT NULL PRIMARY KEY,
  workspace_id            TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- 弱关联：刻意无外键（目录条目可以下线；个人副本必须能活下去）。
  source_catalog_id       TEXT,
  imported_source_version INTEGER CHECK (imported_source_version IS NULL OR imported_source_version >= 1),
  title                   TEXT    NOT NULL CHECK (length (title) BETWEEN 1 AND 80),
  url                     TEXT    NOT NULL CHECK (length (url) BETWEEN 1 AND 2048),
  description             TEXT    NOT NULL DEFAULT '' CHECK (length (description) <= 500),
  tags_json               TEXT    NOT NULL DEFAULT '[]',
  aliases_json            TEXT    NOT NULL DEFAULT '[]',
  icon                    TEXT    NOT NULL DEFAULT '' CHECK (length (icon) <= 200),
  open_mode               TEXT    NOT NULL DEFAULT 'new_tab' CHECK (open_mode IN ('new_tab', 'same_tab')),
  region                  TEXT    NOT NULL DEFAULT 'cn' CHECK (region IN ('cn', 'global', 'both')),
  status                  TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_favorite             INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  sort_order              INTEGER NOT NULL DEFAULT 0,
  -- 健康状态。阶段 04 不做服务端探测，因此默认 unknown；403 永远映射为 maybe_blocked，
  --   绝不写 'blocked'（枚举里也没有）。
  health                  TEXT    NOT NULL DEFAULT 'unknown'
                            CHECK (health IN ('ok', 'maybe_blocked', 'unreachable', 'unknown')),
  health_checked_at       INTEGER,
  -- 乐观并发与同步水位：任何写入都必须 bump 它。
  revision                INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  deleted_at              INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

-- 「每个目录条目在每个工作空间至多一条活跃副本」：数据库级硬约束。
-- 墓碑行不受约束，因此「删除后再次显式导入」可以复用同一行（复活墓碑）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_nav_links_catalog_active
  ON workspace_nav_links (workspace_id, source_catalog_id)
  WHERE source_catalog_id IS NOT NULL AND deleted_at IS NULL;

-- 列表与手动排序。
CREATE INDEX IF NOT EXISTS idx_workspace_nav_links_active
  ON workspace_nav_links (workspace_id, deleted_at, sort_order);

-- 收藏视图。
CREATE INDEX IF NOT EXISTS idx_workspace_nav_links_favorite
  ON workspace_nav_links (workspace_id, deleted_at, is_favorite);

-- 区服筛选。
CREATE INDEX IF NOT EXISTS idx_workspace_nav_links_region
  ON workspace_nav_links (workspace_id, deleted_at, region);

-- 同步水位扫描（HUB-051）：按 updated_at 取增量。
CREATE INDEX IF NOT EXISTS idx_workspace_nav_links_sync
  ON workspace_nav_links (workspace_id, updated_at);

-- ---------------------------------------------------------------------------
-- 3) workspace_nav_groups —— 个人分类 / 分组
-- ---------------------------------------------------------------------------
--
-- 「分类」与「分组」在本项目里是同一个用户产出物（ADR-0004 D2）：推荐目录条目自带的
--   category 只在导入时用于**创建/关联一个同名分组**，此后完全由用户控制。
-- 名称不是标识：主键是稳定 ID，名称可以重复也可以随时改（因此没有名称唯一约束）。
CREATE TABLE IF NOT EXISTS workspace_nav_groups (
  id           TEXT    NOT NULL PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL CHECK (length (name) BETWEEN 1 AND 40),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_nav_groups_active
  ON workspace_nav_groups (workspace_id, deleted_at, sort_order);

CREATE INDEX IF NOT EXISTS idx_workspace_nav_groups_sync
  ON workspace_nav_groups (workspace_id, updated_at);

-- ---------------------------------------------------------------------------
-- 4) workspace_nav_memberships —— 链接 × 分组（多分组）
-- ---------------------------------------------------------------------------
--
-- 主键 (link_id, group_id)：同一对关系只有一行；删除是墓碑，因此「再次加入同一分组」
--   复用同一行（不产生重复）。
-- workspace_id 冗余列的意义见文件头：它**不替代**服务层的三者一致性校验。
CREATE TABLE IF NOT EXISTS workspace_nav_memberships (
  link_id      TEXT    NOT NULL REFERENCES workspace_nav_links (id) ON DELETE CASCADE,
  group_id     TEXT    NOT NULL REFERENCES workspace_nav_groups (id) ON DELETE CASCADE,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (link_id, group_id)
);

-- 分组详情：按组取活跃成员并排序。
CREATE INDEX IF NOT EXISTS idx_workspace_nav_memberships_group
  ON workspace_nav_memberships (workspace_id, group_id, deleted_at, sort_order);

-- 同步水位扫描。
CREATE INDEX IF NOT EXISTS idx_workspace_nav_memberships_sync
  ON workspace_nav_memberships (workspace_id, updated_at);

-- ---------------------------------------------------------------------------
-- 5) workspace_nav_state —— 工作空间级导航修订号
-- ---------------------------------------------------------------------------
--
-- 与 workspace_workbench_state 同构：给「导航有没有变」一个便宜信号，
--   并让导入/目录升级的新鲜度判断有可比较的基准。行缺失等价于 revision = 0。
CREATE TABLE IF NOT EXISTS workspace_nav_state (
  workspace_id TEXT    NOT NULL PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at   INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 6) nav_operations —— 幂等 operationId（与工作台共用同一套算法）
-- ---------------------------------------------------------------------------
--
-- 算法与语义与 workbench_operations 完全一致（见 migrations/0006 的详细注释与
--   worker/modules/idempotency/ledger.ts 的单一实现）：
--   认领（前置条件 + ON CONFLICT DO NOTHING）→ 变更（attempt_token 守卫）→ 收尾，
--   全部在同一个 D1 batch（单个事务）内完成，失败整体回滚。
-- 拆成独立表的理由：导航写入与工作台写入的 kind 命名空间不同，混在一张表里会让
--   「同一 operationId 换意图」的判定跨域误伤。算法仍然只有一份实现。
CREATE TABLE IF NOT EXISTS nav_operations (
  workspace_id  TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operation_id  TEXT    NOT NULL CHECK (length (operation_id) BETWEEN 8 AND 64),
  kind          TEXT    NOT NULL,
  result_json   TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  attempt_token TEXT,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_nav_operations_created
  ON nav_operations (created_at);

-- ---------------------------------------------------------------------------
-- 7) nav_operation_intents —— 请求意图指纹
-- ---------------------------------------------------------------------------
--
-- 单独一张表的原因与 0007 相同：SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，
--   给既有表加列会破坏「迁移语句可逐条重放」的验收点。
CREATE TABLE IF NOT EXISTS nav_operation_intents (
  workspace_id        TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operation_id        TEXT    NOT NULL CHECK (length (operation_id) BETWEEN 8 AND 64),
  kind                TEXT    NOT NULL,
  request_fingerprint TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_nav_operation_intents_created
  ON nav_operation_intents (created_at);
