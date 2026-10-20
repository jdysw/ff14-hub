# FF14 Hub

FF14 导航、国服活动、钓鱼预测与个人资料工具站。当前前端采用浏览器本机数据模式：普通浏览不需要工作空间或设备令牌。生产站为 [ff14.zhixia.uk](https://ff14.zhixia.uk/)。

## 当前功能

- 首页展示全部导航分类、国服活动和未来 24 小时鱼窗；支持超宽屏及模块详情层。
- 个人导航、收藏、备忘和两个区服的钓鱼标记保存在 IndexedDB。
- **设置 → 数据管理**统一提供 WebDAV/S3 双向同步、鱼糕格式导入导出、个人备份与恢复。
- 通知独立设置：网页内临近提醒，以及 Server 酱 Turbo / Resend 邮件每日汇总。汇总可包含今天、明天的关注鱼窗及活动结束前 3 天、1 天提醒。
- 独立 owner 后台管理公共目录、活动和网站设置，账号密码 + TOTP 登录。

具体配置与限制见 [个人同步和通知](docs/personal-sync-and-notifications.md)、[管理员运维](docs/site-admin-operations.md)、[源码审核与架构调整](docs/source-audit-and-cleanup.md)。

## 开发与验证

Node.js >= 22.12.0，pnpm 固定为 package.json 声明的版本。依赖精确版本由 pnpm catalog 和锁文件维护。

```bash
pnpm install --frozen-lockfile
pnpm run verify                  # lint、类型、单测、运维测试、构建干跑
pnpm run db:migrate:local         # 仅本地数据库
pnpm run build:web
pnpm run dev:api                 # 同源 Worker + ASSETS，默认 localhost:8787
pnpm run smoke:local
```

`pnpm run dev` 启动前端 Vite 热更新服务器。真实 API 联调使用同源 Worker。持续集成可使用保留的 `e2e:navigation` 和 `e2e:local-personal`，后者需要预先启动对应的本地服务。已移除依赖旧前端的 phase02–06 浏览器验收入口；服务端契约继续由真实 workerd / D1 测试覆盖。

## 数据与安全边界

- 前端入口：`apps/web/src/main.tsx → app/App.tsx → local/LocalApp.tsx`。离线数据管理随应用加载，owner 后台按需加载。
- `local/store.ts` 负责个人资料的原子事务；`local/secure-storage.ts` 独立加密保存设备配置，采用 revision CAS 处理跨页面更新。
- WebDAV/S3 由浏览器直接访问；密钥不交给本站。远端必须支持 CORS、强 ETag 和条件写。同步先预览、显式解决冲突，再应用；写入前保留可恢复快照。
- 通知渠道凭证因后台投递需要而在服务端加密保存；随机管理令牌仅在本机加密存储，不进入个人备份。
- 生产环境每 5 分钟检查到期汇总；没有到期任务时不计算鱼窗、不发送通知。公告同步仍受全站 6 小时间隔限制。
- `.dev.vars.example` 仅含占位示例；实际本地凭证保存在忽略文件或进程环境中，不能提交或输出。不得随意替换生产 `BOOTSTRAP_SECRET`，它同时参与管理员验证和通知密文派生。
- 当前前端不使用旧设备工作空间 UI，但已注册的 `/identity`、`/me`、模块与备份 API 保持兼容。删除旧 UI 不等于删除旧工作空间或数据。

## 数据库与部署

`migrations/*.sql` 是数据库结构的事实来源。所有迁移保持可重放；已移除无人调用的 ORM 客户端和重复表结构镜像。不要删除历史迁移或通过清理代码直接清空业务表。

预览与生产使用独立 Worker、数据库及配置。发布前先执行验证和 `ops:preflight`；涉及数据库变更时先备份并核对待执行迁移。部署使用对应环境并保留线上变量，随后用 `node scripts/ops/verify-live.mjs production` 校验健康状态、域名和静态资源。

## 历史资料

`docs/adr/`、阶段说明与原开发规划保留为历史设计和服务端协议背景，不表示旧工作台、Widget 宿主或未发布的三副本同步框架仍在当前网页运行。当前模块入口、保留范围和删除依据以本 README 及源码审核报告为准。
