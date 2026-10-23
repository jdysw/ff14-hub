-- FF14 Hub D1 单用户版完整初始结构（2026-10-24）
-- 本文件保留原有 0001_core.sql 文件名，使已执行过该文件的生产 D1 不会重新执行。
-- 全新 D1 从本文件一次创建全部现行表、索引与触发器。
-- 不创建旧 workspaces/devices、服务器端 Widget 工作台或旧同步/通知表。
-- 所有 CREATE 使用 IF NOT EXISTS；生产历史表不会被本文件删除。
-- 注意：后续跨新旧数据库的增量迁移应从 0022 开始，不复用旧 0002-0021 编号。

-- ─── 请求速率限制（公开接口与唯一 owner 使用） ───
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope_key     TEXT    PRIMARY KEY NOT NULL,
  window_start  INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at    INTEGER NOT NULL
);

-- 便于运维清理过期窗口。
CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_window
  ON auth_rate_limits (window_start);


-- ─── 公开导航目录 ───
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


-- ─── 公开活动目录 ───
CREATE TABLE IF NOT EXISTS events (
  id                  TEXT    NOT NULL PRIMARY KEY,
  region              TEXT    NOT NULL CHECK (region IN ('cn', 'global')),
  title               TEXT    NOT NULL CHECK (length (title) BETWEEN 1 AND 120),
  description         TEXT    NOT NULL DEFAULT '' CHECK (length (description) <= 1000),
  starts_at           INTEGER NOT NULL,
  ends_at             INTEGER NOT NULL,
  source_url          TEXT    NOT NULL CHECK (length (source_url) BETWEEN 1 AND 2048),
  source_name         TEXT    NOT NULL DEFAULT '' CHECK (length (source_name) <= 80),
  verification_status TEXT    NOT NULL CHECK (verification_status IN ('verified', 'unverified')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  -- 区间合法性由数据库兜底（服务层另有同一判定的纯函数与结构化错误）。
  CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_events_region_start
  ON events (region, starts_at);

CREATE INDEX IF NOT EXISTS idx_events_start
  ON events (starts_at);


-- ─── 公共鱼类目录 ───
CREATE TABLE IF NOT EXISTS fish_catalog (
  region TEXT NOT NULL CHECK(region IN ('cn','global')),
  fish_id INTEGER NOT NULL CHECK(fish_id > 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  PRIMARY KEY(region,fish_id)
);


-- ─── 国服官方活动快照 ───
CREATE TABLE IF NOT EXISTS official_calendar_snapshots (
  source TEXT PRIMARY KEY CHECK (source = 'cn'),
  payload TEXT NOT NULL,
  checked_at_ms INTEGER NOT NULL CHECK (checked_at_ms > 0)
);


-- ─── 唯一 owner、TOTP、活动人工覆盖与操作审计 ───
CREATE TABLE IF NOT EXISTS calendar_admin_accounts (
  id TEXT PRIMARY KEY CHECK (id='owner'),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_ciphertext TEXT NOT NULL,
  totp_last_step INTEGER NOT NULL DEFAULT -1,
  activated_at INTEGER,
  created_at INTEGER NOT NULL
);
-- Bearer 只在管理员本次内存会话持有，D1 中只存 SHA-256 摘要，8h 后过期。
CREATE TABLE IF NOT EXISTS calendar_admin_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES calendar_admin_accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_admin_sessions_expires ON calendar_admin_sessions(expires_at);

-- 失败尝试计数由 D1 事务维护，不按 IP 写入敏感信息；每次请求都校验。
CREATE TABLE IF NOT EXISTS calendar_admin_rate_limits (
  scope TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

-- upsert: 人工创建或覆盖官方条目；hide: 隐藏活动；restore: 恢复官方源的当前内容。
CREATE TABLE IF NOT EXISTS calendar_editor_entries (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('upsert','hide','restore')),
  payload TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  editor_account_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((mode='upsert' AND payload IS NOT NULL) OR mode='hide' OR (mode='restore' AND payload IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_calendar_editor_entries_updated ON calendar_editor_entries(updated_at);

-- 人工操作永久审计，不泄露密码、TOTP seed 或会话令牌。
CREATE TABLE IF NOT EXISTS calendar_admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','hide','restore')),
  editor_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_admin_audit_recent ON calendar_admin_audit(created_at);

CREATE TRIGGER IF NOT EXISTS calendar_admin_audit_insert AFTER INSERT ON calendar_editor_entries
BEGIN
  INSERT INTO calendar_admin_audit (id,event_id,operation,editor_account_id,created_at)
  VALUES (lower(hex(randomblob(16))),NEW.id,NEW.mode,NEW.editor_account_id,NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS calendar_admin_audit_update AFTER UPDATE ON calendar_editor_entries
BEGIN
  INSERT INTO calendar_admin_audit (id,event_id,operation,editor_account_id,created_at)
  VALUES (lower(hex(randomblob(16))),NEW.id,NEW.mode,NEW.editor_account_id,NEW.updated_at);
END;


-- ─── 站点公共配置与修订审计 ───
CREATE TABLE IF NOT EXISTS site_admin_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_admin_settings_audit (
  id TEXT PRIMARY KEY NOT NULL,
  previous_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS site_admin_settings_audit_insert AFTER INSERT ON site_admin_settings
BEGIN
  INSERT INTO site_admin_settings_audit(id,previous_revision,revision,account_id,updated_at)
  VALUES (lower(hex(randomblob(16))),0,NEW.revision,'owner',NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS site_admin_settings_audit_update AFTER UPDATE ON site_admin_settings
BEGIN
  INSERT INTO site_admin_settings_audit(id,previous_revision,revision,account_id,updated_at)
  VALUES (lower(hex(randomblob(16))),OLD.revision,NEW.revision,'owner',NEW.updated_at);
END;

-- ─── 公共导航管理员覆盖与审计 ───
CREATE TABLE IF NOT EXISTS nav_catalog_edits (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  canonical_url TEXT NOT NULL UNIQUE,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nav_catalog_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  hidden INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS nav_catalog_audit_insert AFTER INSERT ON nav_catalog_edits
BEGIN
  INSERT INTO nav_catalog_audit(catalog_id,payload,hidden,revision,created_at)
  VALUES(new.id,new.payload,new.hidden,new.revision,new.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS nav_catalog_audit_update AFTER UPDATE ON nav_catalog_edits
BEGIN
  INSERT INTO nav_catalog_audit(catalog_id,payload,hidden,revision,created_at)
  VALUES(new.id,new.payload,new.hidden,new.revision,new.updated_at);
END;

-- ─── 独立设备通知订阅和任务 ───
CREATE TABLE IF NOT EXISTS local_push_devices (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, endpoint_hash TEXT NOT NULL UNIQUE,
 channel_ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 daily_limit INTEGER NOT NULL DEFAULT 5, sent_day TEXT NOT NULL DEFAULT '', sent_count INTEGER NOT NULL DEFAULT 0,
 digest_json TEXT, digest_next_at INTEGER
);
CREATE TABLE IF NOT EXISTS local_push_jobs (
 device_id TEXT NOT NULL REFERENCES local_push_devices(id) ON DELETE CASCADE,
 job_key TEXT NOT NULL, payload TEXT NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','leased','sent','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, claim_token TEXT,
 PRIMARY KEY(device_id,job_key)
);
CREATE INDEX IF NOT EXISTS local_push_due ON local_push_jobs(status,due_at);
CREATE INDEX IF NOT EXISTS local_push_digest_due ON local_push_devices(digest_next_at);
