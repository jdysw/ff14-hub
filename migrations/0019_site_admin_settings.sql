-- 全站可在线编辑的公开配置：仅站长会话可写；任何浏览者只读安全的展示字段。
-- 管理员账号仍沿用 0018 的唯一 owner；严禁在 HTTP 接口创建新管理员。
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
