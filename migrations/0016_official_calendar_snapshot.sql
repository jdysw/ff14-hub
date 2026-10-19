-- 国服官方活动快照：仅含公共公告，不含任何个人/设备数据。
-- Cloudflare 出站访问官方源不可用时，仍由 GitHub 定时拉取官方数据后写入 D1。
-- source 主键防止多任务并发创建多个版本；每次 UPSERT 原子替换整个快照。
CREATE TABLE IF NOT EXISTS official_calendar_snapshots (
  source TEXT PRIMARY KEY CHECK (source = 'cn'),
  payload TEXT NOT NULL,
  checked_at_ms INTEGER NOT NULL CHECK (checked_at_ms > 0)
);
