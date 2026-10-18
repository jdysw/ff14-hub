-- 0009_events.sql — 阶段 04 手工活动模块（HUB-011）
--
-- 幂等性：与 0001–0008 一致，只使用 `CREATE ... IF NOT EXISTS`；本文件不含任何 INSERT/UPDATE，
-- 因此可以安全重复应用与逐条重放。
--
-- 边界说明（ADR-0004 D9，规划边界变更的显式记录）：
--   规划 5.2 把 `events` 列在「阶段 05–06（游戏、通知、同步）」的表清单里。
--   阶段 04 提前实现的是**人工维护的活动列表**：真实用户输入、UTC 起止时间、来源链接、
--   区服（cn / global）、过期逻辑与验证状态。
--   明确**不实现**：爬虫 / 抓取器、鱼类计算、提醒调度、Cron。
--   公共来源活动与个人活动分表，个人数据不可能经公共接口泄露。
--
-- 「不捆绑未经核实的活动数据」：`events`（公共表）在阶段 04 是**空表**——没有任何种子写入。
--   界面与 API 会诚实报告「没有可验证的公共来源活动」，而不是编造。
--   机制由测试夹具（真实插入 + 校验约束）验证，不靠假数据充数。
--
-- 工作空间回溯（规划 5.1）：workspace_events 带 NOT NULL 的 workspace_id 外键。
--   events（公共）刻意**不带** workspace_id：它是全局只读参考数据，不属于任何工作空间。
--
-- 删除策略：个人活动用墓碑（deleted_at），跨设备同步；公共表本阶段无写入路径。

-- ---------------------------------------------------------------------------
-- 1) events —— 公共来源活动（只读参考数据）
-- ---------------------------------------------------------------------------
--
-- region 只允许 cn / global：活动是**分区服**的事实（INV-08：国服与国际服不能混用规则）。
--   「通用活动」不是合法状态——宁可分别录两条，也不要一个含糊的 both。
-- verification_status 只区分「已核对」与「未验证」；本阶段没有任何已核对条目。
-- starts_at / ends_at 是 UTC 毫秒；显示时区由客户端决定（国服默认 Asia/Shanghai）。
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

-- ---------------------------------------------------------------------------
-- 2) workspace_events —— 个人活动（工作空间私有）
-- ---------------------------------------------------------------------------
--
-- 与公共表分开的理由（验收要求）：公共 API 只读 events；个人行永不进入公共响应。
-- source_url 可为 NULL：用户自己记的活动可能没有来源链接；一旦填写就必须通过 https 校验
--   （与服务端 URL 策略一致，见 ADR-0004 D3）。
-- 个人活动**不接受 'both'**：区服必须明确（CHECK 里只有 cn / global）。
CREATE TABLE IF NOT EXISTS workspace_events (
  id                  TEXT    NOT NULL PRIMARY KEY,
  workspace_id        TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title               TEXT    NOT NULL CHECK (length (title) BETWEEN 1 AND 120),
  description         TEXT    NOT NULL DEFAULT '' CHECK (length (description) <= 1000),
  region              TEXT    NOT NULL CHECK (region IN ('cn', 'global')),
  starts_at           INTEGER NOT NULL,
  ends_at             INTEGER NOT NULL,
  source_url          TEXT    CHECK (source_url IS NULL OR length (source_url) BETWEEN 1 AND 2048),
  -- 用户自述来源永远默认 unverified；界面必须原样标注，不声称准确提醒。
  verification_status TEXT    NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('verified', 'unverified')),
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  deleted_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  created_by_device   TEXT REFERENCES devices (id) ON DELETE SET NULL,
  CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_workspace_events_active
  ON workspace_events (workspace_id, deleted_at, starts_at);

CREATE INDEX IF NOT EXISTS idx_workspace_events_region
  ON workspace_events (workspace_id, deleted_at, region, starts_at);

-- 同步水位扫描（HUB-051）。
CREATE INDEX IF NOT EXISTS idx_workspace_events_sync
  ON workspace_events (workspace_id, updated_at);
