-- 0010_event_operations.sql — 个人活动写入的幂等账本（HUB-011 / HUB-051）
--
-- 幂等性：只使用 `CREATE ... IF NOT EXISTS`，可重复应用与逐条重放。
--
-- 为什么单独一对表而不是复用 nav_operations：
--   两者 kind 命名空间不同（`event.create` / `link.create`）。混在一张表里会让
--   「同一 operationId 换意图」的判定跨域误伤，也让保留/审计边界含糊。
--   算法仍然只有一份实现（worker/modules/idempotency/ledger.ts）——这里只是换账本表。
--
-- 语义与 workbench_operations / nav_operations 完全一致：
--   认领（前置条件 + ON CONFLICT DO NOTHING）→ 变更（attempt_token 守卫）→ 收尾，
--   全部在同一个 D1 batch（单个事务）内完成，任何约束冲突整体回滚。
-- 保留策略：本阶段不自动清理（不假装有 GC）。
CREATE TABLE IF NOT EXISTS event_operations (
  workspace_id  TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operation_id  TEXT    NOT NULL CHECK (length (operation_id) BETWEEN 8 AND 64),
  kind          TEXT    NOT NULL,
  result_json   TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  attempt_token TEXT,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_event_operations_created
  ON event_operations (created_at);

CREATE TABLE IF NOT EXISTS event_operation_intents (
  workspace_id        TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  operation_id        TEXT    NOT NULL CHECK (length (operation_id) BETWEEN 8 AND 64),
  kind                TEXT    NOT NULL,
  request_fingerprint TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_event_operation_intents_created
  ON event_operation_intents (created_at);
