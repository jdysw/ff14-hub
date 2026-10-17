-- 0005_module_operation_claims.sql — HUB-050 生命周期副作用的**独占执行认领**
--
-- 为什么需要它（复核指出的真实缺陷）：
--   仅凭 `workspace_module_operations` 的「有待完成操作」无法限制**并发续做**——
--   多个重试可以同时读到同一行 pending，然后各自执行副作用（移除实例、取消任务）。
--   本表是数据库级的**独占认领**：主键 (workspace_id, module_id) 保证同一时刻
--   只有一个执行者持有 token。
--
-- 语义：
--   * 认领 = `INSERT ... ON CONFLICT DO NOTHING`（0 行即「别人正在执行」→ 立即 409，无副作用），
--     或「租约已过期」时的原子 `UPDATE ... WHERE expires_at <= now`（同样只有一方能成功）。
--   * 所有副作用写入都以 `token` 为条件（completion / 失败记录），因此**被取代的执行者写不进去**。
--   * 端口清理额外用模块 `revision` 作为 fence（取消任务时传 `upToRevision`），
--     因此即便某个旧执行者侥幸越过检查，也删不掉新一代（restore 之后）产生的任务。
--   * 租约（`expires_at`）只解决「执行者崩溃后无人收尾」的活性问题，
--     **不**假设 TTL 到期旧执行者已经停止 —— 这正是上面 fence 存在的原因。
--   * 认领行随 operations 行级联删除；执行者成功收尾时也会一并删除。
--
-- 幂等性：与既有迁移一致，只使用 CREATE ... IF NOT EXISTS，重复应用安全。
CREATE TABLE IF NOT EXISTS workspace_module_operation_claims (
  workspace_id TEXT    NOT NULL,
  module_id    TEXT    NOT NULL,
  -- 本次执行的唯一标识；被取代后，旧 token 的所有写入都会影响 0 行。
  token        TEXT    NOT NULL CHECK (token <> ''),
  claimed_at   INTEGER NOT NULL,
  -- 租约到期时间。到期后允许**原子抢占**，但旧执行者仍会被 token / revision fence 挡住。
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, module_id),
  FOREIGN KEY (workspace_id, module_id)
    REFERENCES workspace_module_operations (workspace_id, module_id) ON DELETE CASCADE
);
