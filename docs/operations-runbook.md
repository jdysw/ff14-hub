# 运维与恢复

## 日常检查

发布前执行 [验证清单](manual-release-verification.md)。当前自动发布使用 Cloudflare Workers Builds，没有 GitHub Actions 工作流，见 [部署说明](automatic-deployment.md)。

- `pnpm run ops:preflight`：环境分离、公开配置与绑定检查。
- `pnpm run db:ready:preview` / `db:ready:production`：只读核对业务表、迁移链、外键和鱼类数据。
- `node scripts/ops/verify-live.mjs production`：环境、安全头和当前静态资源哈希核验。

## 持久数据

| 位置 | 内容与恢复方式 |
| --- | --- |
| 浏览器本机 | 个人链接、待办、鱼类标记和首页配置；通过设置中的备份恢复。 |
| 本机加密存储 | 云存储凭证、同步状态、通知管理令牌；不随普通个人备份迁移，新设备需要重新配置。 |
| 用户的 WebDAV/S3 | 主动同步的个人资料；恢复前检查远端历史和当前冲突。 |
| D1 | 公共目录、活动、owner、内容与游戏数据修订、审计及独立通知队列。 |
| Worker Secrets | 管理员与通知密文所需密钥；不包含在 SQL 备份中。 |

D1 SQL 备份属于敏感文件，私密保存并验证可恢复。`scripts/ops/backup.mjs` 提供备份清单工具，不把生成清单等同于已完成数据库导出。

## 故障处理

用 requestId、脱敏日志、构建 SHA、数据库状态与供应商返回结果定位。先停止受影响的新增写入或投递，再回退到已验证的 Worker 版本。不要通过恢复退役的 `/identity`、`/me` API 绕过故障。

Worker 回退不撤销 D1 迁移；数据损坏时先在隔离库恢复验证，再审查切换或修复方案。不要直接向正在运行的生产库覆盖整份备份，也不要清空迁移记账或顺带 DROP 历史表。见 [数据库说明](d1-single-baseline.md)。

`BOOTSTRAP_SECRET` 同时参与管理员验证、TOTP 和通知密文处理。随意替换会使既有认证或密文失效，不能用作普通恢复步骤。

## 通知

生产 Cron 每五分钟处理现行 `local_push_devices` / `local_push_jobs`，按租约、每日额度和有限重试投递。渠道 2xx 只表示供应商接受，不保证终端展示；失败与并发的额度处理由 `worker/test/local-notifications.spec.ts` 回归。

检查状态时不要输出渠道密钥、收件地址或私人正文。后台汇总与网页内通知的差别见 [同步与通知](personal-sync-and-notifications.md)。
