-- 公共活动编辑权限与人工修订，独立于定时覆盖的官方新闻快照。
-- 设备角色由服务器 D1 明确授予：普通配对设备不会自动继承。
CREATE TABLE IF NOT EXISTS calendar_admin_devices (
  device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL
);

-- 首次初始化工作空间的首台有效设备视为此部署的 owner。
-- 并非全部工作空间设备；后续配对设备仍需要数据库运维显式授权。
INSERT OR IGNORE INTO calendar_admin_devices (device_id, workspace_id, granted_at)
SELECT d.id, d.workspace_id, d.created_at
FROM devices d
INNER JOIN workspace_bootstrap_guard g ON g.workspace_id = d.workspace_id
WHERE g.singleton_key = 'primary' AND d.revoked_at IS NULL
ORDER BY d.created_at ASC, d.id ASC LIMIT 1;

-- upsert: 人工创建或覆盖官方条目；hide: 隐藏活动（不会破坏官方源快照）。
CREATE TABLE IF NOT EXISTS calendar_editor_entries (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('upsert','hide','restore')),
  payload TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  editor_device_id TEXT NOT NULL REFERENCES devices(id),
  updated_at INTEGER NOT NULL,
  CHECK((mode='upsert' AND payload IS NOT NULL) OR mode='hide' OR (mode='restore' AND payload IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_calendar_editor_entries_updated ON calendar_editor_entries(updated_at);

-- 每一次后台编辑与可恢复隐藏保留服务端审计，拒绝匿名或普通设备写入。
CREATE TABLE IF NOT EXISTS calendar_admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','hide','restore')),
  editor_device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_admin_audit_recent ON calendar_admin_audit(created_at);

-- 审计由数据库触发器在同一写入事务内产生：乐观锁冲突时不会留下假审计。
CREATE TRIGGER IF NOT EXISTS calendar_admin_audit_insert AFTER INSERT ON calendar_editor_entries
BEGIN
  INSERT INTO calendar_admin_audit (id,event_id,operation,editor_device_id,created_at)
  VALUES (lower(hex(randomblob(16))),NEW.id,NEW.mode,NEW.editor_device_id,NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS calendar_admin_audit_update AFTER UPDATE ON calendar_editor_entries
BEGIN
  INSERT INTO calendar_admin_audit (id,event_id,operation,editor_device_id,created_at)
  VALUES (lower(hex(randomblob(16))),NEW.id,NEW.mode,NEW.editor_device_id,NEW.updated_at);
END;
