# D1 单文件初始化基线（2026-10-24）

## 1. 范围与目的

FF14 Hub 目前为维护者本人使用的 Local-first 站点，普通访问者不创建账号。已主动停用旧设备工作空间、服务端 Widget 工作台、Hub 多设备同步与旧通知框架；新的 **`migrations/0001_core.sql`** 将旧的 21 份迁移合并为**唯一一份**，供全新 Cloudflare D1 初始化。

新基线只创建 16 张当前业务必需表、10 个显式索引及 6 个审计触发器：

| 业务域 | 表 |
| --- | --- |
| 公共导航 | `nav_catalog_links`、`nav_catalog_edits`、`nav_catalog_audit` |
| 公共活动与国服公告 | `events`、`official_calendar_snapshots`、`calendar_editor_entries`、`calendar_admin_audit` |
| 游戏鱼类 | `fish_catalog` |
| 唯一 owner | `calendar_admin_accounts`、`calendar_admin_sessions`、`calendar_admin_rate_limits` |
| 站点管理配置 | `site_admin_settings`、`site_admin_settings_audit` |
| 请求限流 | `auth_rate_limits`（现行匿名导航简介和独立通知仍在使用） |
| 独立通知 | `local_push_devices`、`local_push_jobs` |

原身份 `workspaces` / `devices` / `device_pairings`、`workspace_*`、服务端工作台、跨设备 Hub 同步、旧 `notification_jobs` / `push_subscriptions`、`scheduler_observations`、`curated_calendar_events` 等，不在新基线中。

## 2. 已部署的旧 D1：为什么不会重新建表

原历史的第一份迁移文件名也是 `0001_core.sql`。Cloudflare D1 通过 `d1_migrations` 保存**已应用迁移文件名**。本 PR **保留原名称**、替换文件内容，并移除其余 `0002–0021` 文件：

- **全新空 D1**：`d1_migrations` 尚无记录，将完整执行新版 `0001_core.sql`，获得精简 schema。
- **已应用原 0001 的 D1**：若 `d1_migrations` 中已有 `0001_core.sql`，Wrangler 会按记录跳过，**不会**重新执行新版建表语句；原有管理员账号、公告、目录修改和提醒设备行因此不会仅因合并迁移而改变。
- **并不等于线上旧表已清理**：已有库中旧 `workspace_*` 表仍可能存在，需先备份、清点实际数据与外键，再安排**单独增量迁移**删除。不要在本次 PR 中执行 `DROP TABLE` 或批量清空。
- **极端历史情况**：若某已有数据库仅应用了早期一部分迁移（例如已记录 0001，但没执行 0019–0021），它**不会**被新版 0001 自动补齐。必须先把该库升级到原 0021（从历史 Git commit 取迁移），或迁入经过验证的全新 D1；不得直接部署新 Worker 后假定所需表存在。
- **将来的迁移**：统一从 **`0022_*.sql`** 开始，避免与原部署 `d1_migrations` 已记账的 0002–0021 文件名/编号重叠。后续每份迁移需同时支持“新基线库”和“历史已完整迁移的旧库”。

以上安全边界依据 [Cloudflare D1 migration 文档](https://developers.cloudflare.com/d1/reference/migrations/)。不要清空、重建、修改生产的 `d1_migrations` 表以追求表面上的单一记录；它是历史事实。

## 3. 无生产写入的验证路径

1. `pnpm install --frozen-lockfile`。
2. `pnpm run test:db-baseline`：静态核对 0001 基线的 16 张表、必须的触发器/索引且没有旧表与破坏性 SQL；新增管理功能通过 0022 及后续增量迁移升级。
3. `pnpm --filter @ff14-hub/worker test`：Vitest 的 `cloudflare:test` 在隔离 D1 中应用新基线；`worker/test/migrations.spec.ts` 真实验证数据库清单、CHECK、外键、级联删除、审计触发器以及 `d1_migrations` 幂等。
4. `pnpm run verify:release`：Web/Worker 类型检查、回归、构建和预览/生产 Wrangler 干跑。
5. **历史生产路径单独检查**：仅在确认只读目标后查询 `SELECT name FROM d1_migrations ORDER BY id`，核实已应用 0018/0019/0020/0021，检查保留的现行业务表存在；执行前按现有流程备份。这里没有自动执行远程 SQL。

## 4. 严格不执行的操作

- 不自动切换 Cloudflare 生产 D1 `database_id`，也不创建同名生产库。
- 不在此次重构中删除现有数据库的任何业务行或废弃表。
- 不把生产 `d1_migrations` 伪造为只有 0001 一条。
- 不把 SQLite 静态解析视为完整 workerd/D1 测试；必须在实际可用的构建/测试环境执行完整门禁。

## 5. 回滚与恢复

生产已完成 0021 的旧库仍保留旧表，允许暂时回滚 Worker 代码，但**不是**未来持续维护旧 API 的承诺。全新基线的 D1 从一开始没有旧表，不能直接运行依赖旧表的旧 Worker；需要时只能从对应版本的独立备份恢复到另一环境验证，不能混用库与 Worker 版本。

## 6. 新版业务就绪检查（PR A）

全新 D1 应先执行 `pnpm exec wrangler d1 migrations apply DB --env preview --remote`。**建表成功不等于鱼类业务就绪**：公开 `/api/v1/fish`、Android 桌面小组件使用 D1 的 `fish_catalog`，而网页钓鱼看板读取随前端发布的 `public/fishing/catalog-*.json`。

只读核查（需要本地 Wrangler 凭据，但不读取 Secret、不打印业务行内容、不修改数据库）：

```bash
pnpm run db:ready:preview
pnpm run db:ready:production
# 独立本地 D1：
pnpm run db:ready:local
```

脚本要求当前 21 张业务表（0001 的 16 张核心表和 0022 的 5 张管理表）、合法 `d1_migrations` 基线、无外键错误，并且 `cn`、`global` 两个区服 `fish_catalog` 均有有效行。返回 exit 0 = ready、2 = 未就绪、1 = 查询失败。只报告缺失表、历史链是否完整和数据行数，不输出敏感数据。导航目录由首次公开 `GET /navigation/catalog` 惰性写入种子；国服公告有独立的远端快照刷新路径，所以不强制首次就存在。

初次导入先本地执行转换检查（需要只读 GitHub Token）：

```bash
DRY_RUN=1 GH_TOKEN=... bash scripts/ops/refresh-fish-catalog.sh
```

确认来源、条目数量与授权后再明确导入到预览：

```bash
TARGET_ENV=preview GH_TOKEN=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bash scripts/ops/refresh-fish-catalog.sh
pnpm run db:ready:preview
```

**生产导入不是自动步骤**。确有必要时先备份、检查 Preview 数据和代码，再显式设置 `TARGET_ENV=production CONFIRM_PRODUCTION_IMPORT=ff14-hub-production` 执行同一导入脚本；随后运行 `pnpm run db:ready:production`。不得自动根据环境变量缺失切换到生产。现有库的历史表报告只是只读审计输出，不会自动删除；如需删除，应单独备份并审查 SQL。

## 7. 后续历史库清理原则

不在发布流程顺带 `DROP TABLE`。对生产旧表的后续删除应另立编号 **0022 或更后** 的增量迁移，在隔离的完整历史备份上先验证外键关系、数据清点与恢复步骤；要求同时兼容全新 0001 单文件库和生产已执行 0001–0021 的库。全新库已不存在的表不得使用无条件 `DROP TABLE`；清理工作不应成为首次部署前置条件。
