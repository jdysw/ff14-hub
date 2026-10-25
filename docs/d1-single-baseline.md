# 数据库迁移

迁移目录当前包含：

- `0001_core.sql`：新库的核心基线，16 张表、10 个索引、6 个审计触发器。
- `0022_content_management.sql`：5 张管理表及内容审计触发器，支持回收站、来源屏蔽、游戏数据版本和手动同步记录。

完整新库共 21 张业务表。网页个人导航、待办和钓鱼标记保存在浏览器，不依赖旧工作空间表。

## 新库与历史库

**新空库**依次应用 0001、0022 及后续迁移。

**已经完整应用旧 0001–0021 的库**按 `d1_migrations` 跳过 0001，继续应用 0022 及后续迁移。新版基线沿用原文件名，不会因仓库中合并了旧 SQL 而自动重建或删除生产表。

**仅应用部分旧迁移的库**不能依赖新版 0001 补齐缺失表。先用对应 Git 历史中的迁移完成旧链，或在隔离新库验证迁移方案，再发布新 Worker。

不要修改已发布的迁移、清空 `d1_migrations` 或借发布顺手删除历史表。新的迁移从 0023 或当前最大编号之后递增，并兼容新基线库和完整历史库。

## 本地验证

```sh
pnpm run test:db-baseline
pnpm run db:migrate:local
pnpm --filter @ff14-hub/worker test
```

静态守卫检查 0001 的核心清单；真实 workerd/D1 测试检查全量迁移、约束、外键和审计。构建通过不代表远程业务库就绪。

只读就绪检查：

```sh
pnpm run db:ready:local
pnpm run db:ready:preview
pnpm run db:ready:production
```

检查当前业务表、迁移链、外键，以及 `fish_catalog` 中两个区服的有效记录。exit 0 表示就绪，2 表示未就绪，1 表示查询失败。远程检查需要相应 Wrangler 权限，不应用迁移或输出业务行。

## 鱼类目录

网页读取随前端发布的静态目录；公开鱼类 API 和 Android 摘要还需要 D1 中的目录。建表不会自动导入鱼类。

- 静态目录与跨源核对：`node scripts/refresh-fishing-catalog.mjs`，见 [数据核对说明](fishing-cross-source-audit.md)。
- D1 导入：`scripts/ops/refresh-fish-catalog.sh` 下载并转换来源，经 `prepare-fish-import.mjs` 验证后生成 SQL。设置 `DRY_RUN=1` 只转换检查，不连接 Cloudflare；需要 GitHub 只读访问配置。
- 远程导入默认 preview。production 必须明确设置 `TARGET_ENV=production` 和 `CONFIRM_PRODUCTION_IMPORT=ff14-hub-production`，在备份和预览核验后执行。凭证通过环境提供，不写入命令记录或仓库。

静态重建与 D1 导入是不同流程，都要先核对来源版本和数据许可。

## 备份与回滚

迁移前备份目标库并在隔离环境验证恢复。SQL 备份不含 Worker Secrets，须独立保管恢复所需的配置。代码版本回退不逆转数据库结构；新增表可保留，不能为了回退删除现有数据。

历史废弃表若需清理，应单独清点、备份并审查增量迁移。这次仓库清理不操作远程数据库。
