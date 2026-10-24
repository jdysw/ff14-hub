# FF14 Hub

FF14 导航、国服活动、钓鱼预测与个人资料工具站。当前前端采用浏览器本机数据模式：普通浏览不需要工作空间或设备令牌。生产站为 [ff14.zhixia.uk](https://ff14.zhixia.uk/)。

## 当前功能

- 首页展示全部导航分类、国服活动和未来 24 小时鱼窗；支持超宽屏及模块详情层。
- 个人导航、收藏、备忘和两个区服的钓鱼标记保存在 IndexedDB。
- **设置 → 数据管理**统一提供 WebDAV/S3 双向同步、鱼糕格式导入导出、个人备份与恢复。
- 通知独立设置：网页内临近提醒，以及 Server 酱 Turbo / Resend 邮件每日汇总。汇总可包含今天、明天的关注鱼窗及活动结束前 3 天、1 天提醒。
- 独立 owner 后台管理公共目录、活动和网站设置，账号密码 + TOTP 登录。

具体配置与限制见 [个人同步和通知](docs/personal-sync-and-notifications.md)、[管理员运维](docs/site-admin-operations.md)、[源码审核与架构调整](docs/source-audit-and-cleanup.md)。

代码质量与架构整理见 [2026-10-24 审计与修复记录](docs/code-architecture-audit-2026-10-24.md)，完整 Web/Worker 与 Android 本地测试门禁见 [免费手动发布验证清单](docs/manual-release-verification.md)。默认 `verify` **不执行 Android Gradle**；需要 JDK 17 / Android SDK 的原生测试时，须单独按清单运行。

## 开发与验证

Node.js >= 22.12.0，pnpm 固定为 package.json 声明的版本。依赖精确版本由 pnpm catalog 和锁文件维护。

```bash
pnpm install --frozen-lockfile
pnpm run verify                  # lint、类型、单测、运维测试、Android 规则一致性、构建干跑
pnpm run verify:release          # 上述验证 + preview/production Wrangler 配置干跑
pnpm run db:migrate:local         # 仅本地数据库
pnpm run build:web
pnpm run dev:api                 # 同源 Worker + ASSETS，默认 localhost:8787
pnpm run smoke:local
```

`pnpm run dev` 启动前端 Vite 热更新服务器。真实 API 联调使用同源 Worker。持续集成可使用保留的 `e2e:navigation` 和 `e2e:local-personal`，后者需要预先启动对应的本地服务。已移除旧工作空间身份/布局/同步验收脚本及其实现，验收目标转为现行公开 API、唯一管理员、本机优先数据、独立提醒与 Android；服务端通过 workerd/D1 回归，浏览器端仍需单独验证。

## 数据与安全边界

- 前端入口：`apps/web/src/main.tsx → app/App.tsx → local/LocalApp.tsx`。离线数据管理随应用加载，owner 后台按需加载。
- `local/store.ts` 负责个人资料的原子事务；`local/secure-storage.ts` 独立加密保存设备配置，采用 revision CAS 处理跨页面更新。
- WebDAV/S3 由浏览器直接访问；密钥不交给本站。远端必须支持 CORS、强 ETag 和条件写。同步先预览、显式解决冲突，再应用；写入前保留可恢复快照。
- 通知渠道凭证因后台投递需要而在服务端加密保存；随机管理令牌仅在本机加密存储，不进入个人备份。
- 生产环境每 5 分钟检查到期汇总；没有到期任务时不计算鱼窗、不发送通知。公告同步仍受全站 6 小时间隔限制。
- `.dev.vars.example` 仅含占位示例；实际本地凭证保存在忽略文件或进程环境中，不能提交或输出。不得随意替换生产 `BOOTSTRAP_SECRET`，它同时参与管理员验证和通知密文派生。
- **单用户架构约束**：目前仅站点所有者本人使用，不需要保留旧设备工作空间的兼容层。旧 `/api/v1/identity/*`、`/api/v1/me/*` 和服务端 Widget 工作台接口已移除；现行网站、管理员、Android 小组件与独立提醒继续保留。旧 D1 表可能仍含数据，本次不执行删除表和清空历史数据。

## 数据库与部署

**数据库初始结构现已整理为唯一的 `migrations/0001_core.sql`**：新建 D1 时创建 16 张现行业务表、10 个索引和 6 个审计触发器，旧工作空间与服务端工作台表不再出现。已部署 D1 因保存了原 `0001_core.sql` 的迁移记录而跳过新版基线，其实际历史表和数据不自动删除。将来的增量迁移从 `0022_*.sql` 开始。发布前务必阅读 [D1 单文件基线及既有数据库升级规则](docs/d1-single-baseline.md)，不能把修改 SQL 文件等同于生产数据库清理。

预览与生产使用独立 Worker、数据库及配置。发布前先执行验证和 `ops:preflight`；涉及数据库变更时先备份并核对待执行迁移。部署使用对应环境并保留线上变量，随后用 `node scripts/ops/verify-live.mjs production` 校验健康状态、域名和静态资源。

## 历史资料

`docs/adr/`、阶段说明与原开发规划保留为历史设计和服务端协议背景，不表示旧工作台、Widget 宿主或未发布的三副本同步框架仍在当前网页运行。当前模块入口、保留范围和删除依据以本 README 及源码审核报告为准。
