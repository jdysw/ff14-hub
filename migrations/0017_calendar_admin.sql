-- 管理员与普通工作空间完全分离：本站最多一个站点 owner，必须完成密码+TOTP 注册。
-- 账号创建只允许掌握 BOOTSTRAP_SECRET 的部署所有者，一次性注册，不支持匿名注册。
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
