-- 0003_modules.sql — HUB-050 模块生命周期状态（规划 5.2 workspace_modules）
--
-- 幂等性：与 0001 / 0002 一致，**只使用 CREATE ... IF NOT EXISTS**，
--   因此重复应用是安全的（缺失的列无法用 ADD COLUMN IF NOT EXISTS 表达，
--   所以本阶段需要的状态全部落在这一张新表里，不改动既有列）。
--
-- 命名说明：规划 5.2 把设置版本列写作 `config_version`；本迁移使用 `settings_version`，
--   以便与**已经提交**的契约 `ModuleManifest.settingsSchemaVersion` 同名。
--   同一个概念刻意只保留一种叫法，避免第三套命名出现（记录于 docs/adr/0002）。
--
-- 工作空间回溯（规划 5.1）：workspace_id 是 NOT NULL 外键，且与 module_id 组成主键，
--   因此「模块状态」天然按工作空间隔离，任何查询都必须带 workspace_id。
--   注意 module_id **没有**外键：模块是代码里的静态注册项（worker/modules/registry），
--   不是数据库行，其合法性由注册表校验，无法用 FK 表达。
--
-- 防静默覆盖（规划 5.3）：revision 是单调修订号。所有变更都以
--   UPDATE ... WHERE workspace_id = ? AND module_id = ? AND revision = ?
-- 这种条件更新提交；受影响行数为 0 即并发冲突（409），绝不盲目覆盖别人的修改。
--
-- 数据保留（规划规则 7：卸载 ≠ 清数据）：
--   本表只存「状态 + 个人设置」。停用与卸载**都不删除本行**，因此设置会保留；
--   恢复（restore）只是把 status 改回 enabled 并沿用同一行与同一份设置。
--   本阶段刻意不提供任何 DELETE 语句：清除数据（purge）被显式拒绝（501），
--   将来必须实现为「先备份 + 显式二次确认」的独立流程。
--
-- 时间列的语义：enabled_at / disabled_at / uninstalled_at 表示**当前状态**对应的时间戳，
--   因此同一时刻最多只有一个非空（enabled 时 enabled_at 非空，其余为 NULL）。
--   installed_at 只在首次插入时写入，之后不再改动，用来表达「这个模块曾经被装过」。
CREATE TABLE IF NOT EXISTS workspace_modules (
  workspace_id     TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  module_id        TEXT    NOT NULL,
  -- 只允许三种持久状态；「未安装」是行缺失时的派生值，永远不会被写进来。
  status           TEXT    NOT NULL CHECK (status IN ('enabled', 'disabled', 'uninstalled')),
  settings_json    TEXT    NOT NULL DEFAULT '{}',
  settings_version INTEGER NOT NULL CHECK (settings_version >= 0),
  -- 从 1 开始单调递增；每次真实变更 +1。
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  installed_at     INTEGER NOT NULL,
  enabled_at       INTEGER,
  disabled_at      INTEGER,
  uninstalled_at   INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, module_id)
);

-- 模块管理界面按「工作空间 + 状态」筛选（例如列出已启用模块）。
CREATE INDEX IF NOT EXISTS idx_workspace_modules_workspace_status
  ON workspace_modules (workspace_id, status);
