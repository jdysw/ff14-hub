-- 0002_identity.sql — HUB-006 身份系统支撑（规划 5.2 / 6.3）
--
-- 幂等性：本文件**只使用 CREATE ... IF NOT EXISTS**。
--   刻意不对 0001 已建表使用 `ALTER TABLE ADD COLUMN`——SQLite 没有
--   `ADD COLUMN IF NOT EXISTS`，那会破坏「迁移可重复应用」这一不变量。
--   因此 HUB-006 需要的额外状态全部落在**新表**里。
--
-- 不改动任何既有列的含义，因此 0001 的数据无需迁移。

-- 单工作空间初始化守卫。
--
-- 作用（INV-05：无传统注册，只存在一个工作空间）：
--   `singleton_key` 是固定主键 'primary'，因此「只有一个工作空间」由**数据库唯一约束**保证，
--   而不是靠应用层先查后写。并发 Bootstrap 时，只有一个事务能插入这一行，
--   其余因主键冲突整批回滚——不会留下半初始化的 workspace / device。
--
-- 刻意**不**对该表建到 workspaces 的外键：插入顺序上守卫先于 workspace 建成，
-- 且该表是「初始化通道已消费」的事实记录。
-- 注意：当前没有任何删除 workspace 的代码路径；如需人工重置，必须同时清理本表。
CREATE TABLE IF NOT EXISTS workspace_bootstrap_guard (
  singleton_key TEXT    PRIMARY KEY NOT NULL CHECK (singleton_key = 'primary'),
  workspace_id  TEXT    NOT NULL,
  claimed_at    INTEGER NOT NULL
);

-- 认证/初始化速率限制计数（固定窗口 + 原子条件自增）。
--
-- 隐私：scope_key 是「端点 + 客户端标识摘要」的哈希结果（见 worker/lib/rate-limit.ts），
--       **不保存明文 IP**。
-- 原子性：并发安全由 `UPDATE ... WHERE attempt_count < limit` 的条件更新保证，
--       不依赖读取-判断-写入这种有竞态的写法。
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope_key     TEXT    PRIMARY KEY NOT NULL,
  window_start  INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at    INTEGER NOT NULL
);

-- 便于运维清理过期窗口。
CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_window
  ON auth_rate_limits (window_start);

-- 配对领取记录：让「消费配对」与「创建新设备」落在**同一个事务**里的独占标记。
--
-- 为什么必须单独建表，而不是只依赖 device_pairings.used_at：
--   `used_at` 是毫秒时间戳。若并发/重放的两个请求落在同一毫秒，用 `used_at = 本次时间戳`
--   去判断「是不是我消费的」会产生歧义，进而可能多铸造一台设备。
--   本表的 `pairing_id` 是主键（并发下只有一个事务能插入成功），
--   `device_id` 是本次调用独有的 UUID，作为「这一次」的无歧义标记。
--
-- 生命周期：一行记录一次成功领取。若同一事务内的后续语句失败，整批回滚，本行也不会留下，
-- 因此配对码不会被烧毁，可以重试。
--
-- 工作空间可回溯（规划 5.1：私有表必须含 workspace_id 或能通过受约束的 FK 唯一回溯到它）：
--   pairing_id 是到 device_pairings 的外键（该配对在占位时必然已存在），
--   而 device_pairings.workspace_id 是 NOT NULL 外键。因此
--   pairing_claims -> device_pairings -> workspaces 是一条受约束、唯一的回溯链。
--   本表刻意不再存一份 workspace_id：副本会引入两处不一致的可能，
--   而 join 链上的约束已足够表达作用域。
--   ON DELETE CASCADE：配对记录被删除（例如撤销设备时清理未使用配对、或将来清理过期配对）时，
--   其占位记录一并消失，不留孤儿行。
CREATE TABLE IF NOT EXISTS pairing_claims (
  pairing_id TEXT    PRIMARY KEY NOT NULL
                     REFERENCES device_pairings (id) ON DELETE CASCADE,
  device_id  TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_claims_device
  ON pairing_claims (device_id);

-- 数据库级审计去重：同一工作空间的同一设备**最多一条** device_revoked 审计。
-- 这是"重复/并发撤销只产生一条审计"的最终保证（应用层另外以 changes() 为条件写入）。
-- 使用部分唯一索引，只约束 device_revoked 这一种事件，不影响其它审计类型。
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_audit_device_revoked_once
  ON identity_audit (workspace_id, device_id)
  WHERE event_type = 'device_revoked';

