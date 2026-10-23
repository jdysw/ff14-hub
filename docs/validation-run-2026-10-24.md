# PR #78 验证记录：2026-10-24（隔离 SQLite 验证；真实构建阻塞）

## 执行目标

维护者要求实际运行全新 Cloudflare D1 初始化测试，以及完整 `pnpm run verify:release`。此次只允许本地、隔离数据库和构建验证；未部署到预览/生产，也未修改任何现网 D1 数据。

## 实际执行的内容

执行环境：沙盒 Linux，Node.js `v22.16.0`，Python `sqlite3` 链接 SQLite `3.46.1`。

- 基于 PR #78 的 `migrations/0001_core.sql` SQL 定义，在沙盒重新构造了不含注释的等价执行脚本，并在**独立的 SQLite 内存数据库**中执行；第二次执行同一脚本成功。
- 实际创建 **16 张数据表、10 个显式索引、6 个触发器**；`PRAGMA foreign_keys=ON` 且 `PRAGMA foreign_key_check` 返回空列表。
- 根据 GitHub 中的 `scripts/ops/check-d1-baseline.mjs` 复现了 Node 结构守卫，Node `--check` 及脚本执行成功。
- 执行另外 **13 项数据库行为检查，13/13 通过**：
  1. 拒绝鱼类目录非法区服
  2. 拒绝鱼类目录非法 JSON
  3. 拒绝活动非法区服
  4. 拒绝活动结束时间早于开始时间
  5. 拒绝通知任务引用不存在的订阅设备
  6. 删除通知设备级联删除任务
  7. 站点设置新增/更新审计触发器
  8. 导航覆盖新增/更新审计触发器
  9. 活动编辑新增/更新审计触发器
  10. 拒绝非法活动编辑模式
  11. 唯一 owner 与会话删除级联
  12. 数据库外键完整性
  13. 全新库无退役工作空间相关表

> **证据边界**：测试执行的 SQL 是根据 GitHub 当前迁移文件**人工同步为无注释等价脚本**的副本，不是从当前 Git Checkout 直接读取的原文件；SQLite 引擎不等于 Cloudflare D1/workerd。它证明相同定义在 SQLite 上的行为，但不能将其记为仓库级 `pnpm run test` 或真实 D1 PASS。

## 未能实际执行的验证（阻塞，而不是通过）

| 检查 | 状态 | 原因 |
| --- | --- | --- |
| DevSpace 中 `git status`、实际 Checkout | 阻塞 | `mcp__devspace__open_workspace` 和历史 workspaceId `bash` 均返回工具内部错误 |
| `pnpm install --frozen-lockfile` | 未执行 | 沙盒无本仓库 Checkout、pnpm 和网络 DNS，无法取得私有代码/依赖 |
| `pnpm run test:db-baseline`（仓库目录） | 未执行 | 无 Checkout；仅独立重现 Node 脚本的功能 |
| workerd + Miniflare 的 `worker/test/migrations.spec.ts` | 未执行 | 缺 `@cloudflare/vitest-pool-workers`、Wrangler、workerd |
| `pnpm run verify:release` | 未执行 | 仓库与依赖不可用 |
| Web/Worker TypeScript、Vitest、ESLint、Vite build、Wrangler dry-run | 未执行 | 同上 |
| Android Gradle | 未执行 | 原生构建未纳入默认 verify，也无完整 Android 工程 Checkout |
| GitHub Actions CI | 未启动 | 遵照维护者此前禁用付费 CI 的决定 |

## 合并决策

仅将本次标记为**隔离 SQLite 可执行性验证通过、真实 D1/完整构建待验证**。PR #78 继续 Draft；不得据此合并或部署。成功解锁 DevSpace 或具备仓库与依赖的独立机器后，先核对分支 HEAD，再执行：

```bash
pnpm install --frozen-lockfile
pnpm run test:db-baseline
pnpm --filter @ff14-hub/worker test
pnpm run verify:release
```

任何一步失败必须修代码后重跑，不修改测试期望以换取虚假通过；生产 D1 不参与测试。
