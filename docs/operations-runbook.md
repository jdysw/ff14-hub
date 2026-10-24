# FF14 Hub 运维手册：单用户本机优先架构

> 适用现行站点：公开 FF14 导航/活动/鱼类服务、Android Widget、唯一 owner 后台、浏览器本地个人资料与独立后台提醒。旧设备工作空间与 Widget 工作台 API 已下线，不再以其登录/配对/同步链路作为发布或恢复验收条件。

## 手动发布门禁（不依赖付费 CI）

| 命令 | 用途 |
| --- | --- |
| `pnpm run verify` | ESLint、类型检查、Web/Worker/Vitest、运维测试、Android PVP 规则文件一致性及构建 |
| `pnpm run verify:release` | 在 verify 基础上，追加 preview/production Wrangler dry-run 配置验证 |
| `pnpm run ops:preflight` | 检查环境分离、绑定与公开配置；不读取 Secrets |
| `pnpm run test:ops` | 发布脚本、迁移清单/备份格式、配置负例与运维脚本测试 |
| `pnpm run smoke:local` | 同源静态首页、健康检查、旧 /me 路径 404 和未知 API JSON 404 |
| `pnpm run e2e:navigation` | 真实浏览器下的导航与 owner 管理交互 |
| `pnpm run e2e:local-personal` | 真实浏览器下的本机个人资料与鱼糕导入等数据操作 |
| `pnpm run audit:prod` | 检索生产依赖公开漏洞报告；离线视作未执行 |

原 `smoke:identity` 和 `ops:rehearse` 对应已移除的服务端账号、配对、工作台与三副本同步协议，已从脚本入口和仓库移除。**不能拿旧演练流程成功作为当前发布验收的条件。**

Android 原生组件的 JDK17/SDK35 Gradle 测试、lint、构建和真实设备验收独立进行。完整步骤详见 [手动发布清单](manual-release-verification.md)。

## 当前持久数据与备份

- **浏览器 IndexedDB**：个人网址、备忘、钓鱼标记、模块布局与配置。这是个人数据的本地主副本；常规可恢复备份通过设置中的数据管理导出，需定期验证导入恢复。
- **浏览器保险箱**：WebDAV/S3、通知设备等凭证配置独立加密，不在普通备份 JSON 中。换设备需手动重新授权与配置。
- **WebDAV/S3**：用户自行配置远端备份，采用强 ETag、条件写和冲突预览。还原前先确认远端历史版本与本机待同步修改，不可自动覆盖冲突。
- **Cloudflare D1**：公共目录、活动快照、站点管理员状态与独立通知设备和队列；需在变更前备份，并验证可在隔离库恢复。
- **Worker Secrets**：包括用于管理员认证及通知密文处理的 `BOOTSTRAP_SECRET`；不在 D1 SQL 备份中。更换它可能使旧加密通知配置无法解密，不能作为正常回滚步骤。

D1 SQL 备份可能含通知投递地址密文、Token 摘要、管理员哈希和历史表中的个人信息，属于敏感文件。不要提交仓库、公开分享或上传第三方日志。现行活动迁移文件已压缩为唯一的 `0001_core.sql`，仍沿用原文件名以尊重现有 D1 `d1_migrations` 已应用记录；过去的 0002–0021 不再位于迁移目录，新库不会生成旧工作空间表。**旧生产 D1 不会因压缩历史 SQL 自动删表或重建现行结构**，未来新增迁移统一从 `0022_*.sql` 开始，具体执行前置条件见 [D1 单文件基线说明](d1-single-baseline.md)。如需清理废弃表，应另建增量迁移并在确认备份与引用后执行。

## 部署与故障恢复

1. 固定待发布提交，运行 `verify:release`、相关 Web E2E、Android 专项和 `ops:preflight`，保留退出码；禁用付费 GitHub Actions 的策略不变。
2. 对 preview 和 production 分别核对 D1 绑定、域名、Secret 是否存在、Origin 允许列表与 `ENABLE_TEST_ROUTES=0`。不把生产密钥打印到日志。
3. 如涉及 D1 迁移，先备份并在独立的预览/恢复数据库应用和检查外键完整性；不可直接把备份 SQL 覆盖到正在运行的生产数据库。
4. 先部署 preview，验证健康、导航、活动、Android Widget、隐藏的站点管理员入口、普通个人资料和通知订阅。在真实浏览器核查 IndexedDB → WebDAV/S3 的同步和冲突预览。
5. 只有审核通过后才运行 `pnpm run release:production`。使用 `node scripts/ops/verify-live.mjs production` 核对线上静态资源与健康状态。
6. 出现故障先停止受影响的新增写入或提醒发送，回退 Worker 到已知稳定版本；若牵涉 D1 内容损坏，先在隔离库恢复验证，再按受控计划切换绑定。不要恢复已退役的 `/identity` 或 `/me` 路由来绕过问题。

## 后台通知专项

每五分钟 Cron 只规划并处理 `local_push_devices` / `local_push_jobs` 的现行独立通知任务，不再运行旧 `notification_jobs` 与工作空间 outbox。外部渠道返回 2xx 仅表示其接受请求，不代表设备最终显示；0/429/5xx 及超时要遵循有限重试，处理好每日额度的预留和返还。首次修复与 D1 回归见 PR #78 的 `worker/test/local-notifications.spec.ts`。

线上事故使用 requestId、脱敏错误日志、D1 工作状态与供应商接受结果定位，不打印原始渠道密钥、通知正文和个人身份信息。
