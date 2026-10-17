-- 0001_core.sql — 阶段 01 核心身份表（规划 5.2）
--
-- 适用范围：HUB-003。只建阶段 01 必需的四张表；
--   可定制工作台 / 导航（阶段 02–04）与鱼类 / 通知 / 同步（阶段 05–06）的表不在本次迁移内。
--
-- 通用约定（规划 5.1）：
--   * ID 一律 TEXT（UUID/ULID），不使用名称当主键。
--   * 时间一律 UTC Unix 毫秒、INTEGER。
--   * 所有私有表都带 workspace_id（或可通过受约束 FK 唯一回溯到它）。
--
-- 幂等性：本文件通篇使用 IF NOT EXISTS，因此**重复应用是安全的**（HUB-003 验收）。
--   即使某次执行在中途被中断、或 d1_migrations 记账表被重建，重新执行也不会报错。
--
-- 外键：D1 默认开启外键约束（PRAGMA foreign_keys 默认 ON），
--   因此这里不写 PRAGMA，也不能依赖「在迁移里打开 PRAGMA」来获得约束行为。
--
-- 凭证：本迁移只保存摘要列（recovery_hash / token_hash / pairing_hash），
--   明文 Token 与恢复密钥永不落库。

-- 单个私有工作空间（INV-05：无传统注册，一个工作空间 + 多设备独立凭证）。
CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT    PRIMARY KEY NOT NULL,
  region        TEXT    NOT NULL CHECK (region IN ('cn', 'global')),
  timezone      TEXT    NOT NULL,
  locale        TEXT    NOT NULL,
  recovery_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 恢复密钥摘要唯一：保证「一个恢复密钥只对应一个工作空间」。
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_recovery_hash
  ON workspaces (recovery_hash);

-- 设备身份。每台设备一个独立凭证，可单独撤销。
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT    PRIMARY KEY NOT NULL,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  -- 非空表示已撤销；撤销后该凭证的后续请求必须立即被拒绝。
  revoked_at   INTEGER,
  last_seen_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- Token 摘要唯一：既是约束，也是认证查询的索引。
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token_hash
  ON devices (token_hash);
CREATE INDEX IF NOT EXISTS idx_devices_workspace
  ON devices (workspace_id);
-- 设备列表接口按「未撤销优先」过滤，专门为此建复合索引。
CREATE INDEX IF NOT EXISTS idx_devices_workspace_active
  ON devices (workspace_id, revoked_at);

-- 一次性、有限期的配对凭证（HUB-006 实现领取流程）。
CREATE TABLE IF NOT EXISTS device_pairings (
  id                TEXT    PRIMARY KEY NOT NULL,
  workspace_id      TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pairing_hash      TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL,
  -- 非空表示已被消费；「一次性」由该列 + 条件 UPDATE 共同保证，不能只靠应用层判断。
  used_at           INTEGER,
  created_by_device TEXT    NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_pairings_pairing_hash
  ON device_pairings (pairing_hash);
CREATE INDEX IF NOT EXISTS idx_device_pairings_workspace
  ON device_pairings (workspace_id);
CREATE INDEX IF NOT EXISTS idx_device_pairings_expires
  ON device_pairings (expires_at);

-- 身份操作审计。detail_json 只允许放非敏感事实（配对 id、原因等），禁止放凭证或其摘要。
CREATE TABLE IF NOT EXISTS identity_audit (
  id           TEXT    PRIMARY KEY NOT NULL,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  event_type   TEXT    NOT NULL CHECK (
    event_type IN (
      'workspace_bootstrapped',
      'device_paired',
      'device_pairing_created',
      'device_recovered',
      'device_revoked',
      'device_auth_failed'
    )
  ),
  -- 设备被删除时置空，审计记录本身保留。
  device_id    TEXT    REFERENCES devices (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  detail_json  TEXT    NOT NULL DEFAULT '{}'
);

-- 审计按工作空间 + 时间倒序读取。
CREATE INDEX IF NOT EXISTS idx_identity_audit_workspace_created
  ON identity_audit (workspace_id, created_at);
