-- 0004_module_operations.sql — HUB-050 生命周期「待完成操作」持久事实
--
-- 为什么是新表而不是给 workspace_modules 加列：
--   SQLite 没有 `ADD COLUMN IF NOT EXISTS`，加列会破坏「迁移可重复应用」这一不变量。
--   因此需要的额外状态一律落在新表里（与 0002 的处理方式一致）。
--
-- 语义：一行 = 一次已**原子准入**但尚未完成（或已失败待重试）的生命周期操作。
--   * 准入（workspace_modules 的条件 CAS + 本表的插入）在**同一个 D1 batch（事务）**里完成，
--     因此「状态已提交」与「存在未完成操作」是同一时刻的事实，不存在二义窗口。
--   * 副作用（模块 handler、当前 Host 实例清理、已排队任务取消）在准入之后执行；
--     全部成功才删除本行；失败则累加 attempts 并写入 last_error，保留等待**幂等重试**。
--   * 存在本行时门禁状态为 transitioning：不执行组件、不排入后台任务。
--     这是「effective gate 保持安全」的落点——待完成绝不被当成可运行。
--
-- 为什么不能只靠 isolate 内互斥：Workers 的多个 isolate 之间不共享内存，
--   互斥必须落在数据库上；这里的准入 CAS 就是数据库级互斥。
--
-- 作用域与生命周期：
--   * 主键 (workspace_id, module_id)：同一模块同时最多一个待完成操作。
--   * 复合外键指向 workspace_modules 的复合主键并 ON DELETE CASCADE，
--     因此它不可能脱离模块状态独立存在，也不会留下孤儿行。
--   * revision 记录本次准入后的模块 revision，用于「重试是否仍是同一次准入」的判定。
--
-- 本阶段刻意**不**做：通用分布式任务框架、后台自动重试调度、Cron。
--   恢复路径只有一条且是显式的：客户端用同一 action + 同一 expectedRevision 重试，
--   服务端检测到待完成操作后继续（而非重做）清理。多次重试必须幂等。
CREATE TABLE IF NOT EXISTS workspace_module_operations (
  workspace_id  TEXT    NOT NULL,
  module_id     TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('enable', 'disable', 'uninstall', 'restore')),
  target_status TEXT    NOT NULL CHECK (target_status IN ('enabled', 'disabled', 'uninstalled')),
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  started_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  -- 面向用户、已脱敏的失败原因；不含凭证、SQL 或内部路径。
  last_error    TEXT,
  PRIMARY KEY (workspace_id, module_id),
  FOREIGN KEY (workspace_id, module_id)
    REFERENCES workspace_modules (workspace_id, module_id) ON DELETE CASCADE
);
