# FF14 Hub 当前 API 与数据所有权（2026-10-24）

## 决策

当前项目仅供站点所有者本人使用。根据维护者本次确认，**不再保留旧设备账号、工作空间/Widget 工作台与跨设备 Hub 同步 API 的兼容性**。现行个人状态采用 IndexedDB，用户 WebDAV/S3 直接同步；站点管理员与后台通知均为独立机制。

本 PR 已移除旧路由 `/api/v1/identity/*`、`/api/v1/me/*`、`/api/v1/modules/catalog` 以及对应的服务器端认证、工作台、模块生命周期、工作空间导航与旧提醒调度。访问这些旧路径必须是 JSON 404，不能误回 SPA HTML、伪装为未认证 401，也不提供临时兼容代理。

## 共享包退役边界（PR B）

`packages/shared` 只在主入口导出现行业务契约；已删除原 `identity-api.ts`、`module-api.ts`、`module-manifest.ts`、`builtin-modules.ts`、`operations-api.ts`、`sync-api.ts`、`workbench-api.ts`、旧 `reminder-api.ts` 和 `identity.ts`。将现行的 `operationIdSchema` 独立于工作台，Web Push 订阅校验独立于旧提醒规则；鱼糕导入/导出继续调用 `@ff14-hub/fish-sync`。删除的旧服务器协议不承诺 API/TS 类型兼容。

## 现行保留 API

| 路径 | 用途与归属 |
| --- | --- |
| `/api/v1/health` | 公开 Worker/D1 就绪检查 |
| `/api/v1/navigation/catalog`、`/metadata` | 公共网站目录与用户主动触发的简介查询 |
| `/api/v1/events`、`/calendar`、`/calendar.ics` | 公共活动及国服活动 ICS |
| `/api/v1/fish`、`/windows` | 公开鱼类目录与规则计算 |
| `/api/v1/widgets/v1/summary` | Android 原生桌面组件公开聚合信息 |
| `/api/v1/site` | 站点公共配置 |
| `/api/v1/admin` | 唯一 owner 管理后台：独立密码、TOTP 与短期会话 |
| `/api/v1/local-notifications` | 独立匿名设备提醒订阅，渠道信息在 D1 中加密保存 |
| `/api/v1/__test__` | 测试专用路由，生产默认不可用 |

## 数据归属

- 个人链接、收藏、钓鱼标记、备忘、偏好：浏览器 IndexedDB，手动/按配置同步到自己的 WebDAV/S3。
- WebDAV/S3 凭证：浏览器独立加密配置；不存放于本站 Worker。
- 公开目录、活动快照、站点管理员配置与审计：Cloudflare D1。
- 后台投递：D1 独立的 `local_push_devices` / `local_push_jobs`，渠道凭证按订阅设备加密。
- **新 D1 基线**：`migrations/0001_core.sql` 已将旧 21 份迁移压缩为 16 张现行业务表的一份全新初始结构，参见 [单文件基线与生产过渡](d1-single-baseline.md)。历史 0002–0021 文件已从活动迁移目录移除。**旧生产 D1 仍可能保留其历史表与全部数据**；本 PR 未运行任何 `DROP TABLE`、未重置 `d1_migrations`，实际数据清理必须另行备份并评估。

## 设计约束

1. 普通浏览者不注册传统账户；个人功能全程本机优先。
2. 不通过恢复 `/identity` 或 `/me` 解决现行功能缺失。新功能应直接建立在本地数据、公共服务或独立订阅之上。
3. 不把已下线测试保留为要求旧接口 200 的回归。以当前公开接口、站点管理员、本机同步、Android 和独立后台提醒为验收边界。
4. 仍需确保本地个人备份可恢复，但不保证旧工作空间账号、Token、操作流水及布局备份能导入现行 UI。
