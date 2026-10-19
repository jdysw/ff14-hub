-- 网站管理员是明确授予的设备身份，不等于普通工作空间成员。
-- 初始化不授予任何人权限；由站长在 Cloudflare D1 控制台针对可信设备 ID 授权。
CREATE TABLE IF NOT EXISTS site_admin_devices (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL
);

-- 手工录入和官方覆盖分别保留；人工编辑始终具有最高优先级。
-- hidden=1 为管理员隐藏官方活动的覆盖记录，官方定时快照无法还原它。
CREATE TABLE IF NOT EXISTS curated_calendar_events (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES devices(id)
);
CREATE INDEX IF NOT EXISTS curated_calendar_events_updated ON curated_calendar_events(updated_at);
