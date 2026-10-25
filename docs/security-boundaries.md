# 安全边界

## 访问与写入

普通访问者浏览公开导航、活动、鱼类和移动端摘要，不创建服务端玩家账号。个人导航、待办和钓鱼标记由浏览器保存；旧 `/api/v1/identity/*`、`/api/v1/me/*` 和 `/api/v1/modules/catalog` 已退役，返回 JSON 404。

管理操作由唯一 owner 密码、TOTP 和短期 Bearer 会话授权，见 [后台说明](site-admin-operations.md)。前端入口或按钮显隐不能代替服务端鉴权。

写请求守卫检查 Origin、JSON 类型及实际请求体字节上限。Origin 存在时仅接受同源或明确白名单；缺少 Origin 不作为身份凭据。各路由继续独立校验权限与输入，SQL 使用绑定参数。

## 浏览器与外部服务

Worker 为 API、静态资源和错误响应统一加安全头。脚本、字体和 Worker 限同源；为用户的 WebDAV/S3 放行 HTTPS 连接，未开放 `unsafe-eval`。API 响应禁止缓存，Service Worker 不缓存管理员或个人 API 数据。

个人云存储凭证通过本机加密存储保存，浏览器直连远端。同步先预览和解决冲突，依赖强 ETag 与条件写，不静默覆盖并发修改。备份不包含这些凭证。

后台通知渠道凭证因投递需要在服务端加密保存，管理令牌只在本机加密保存。停用会删除渠道配置及其任务。生产 Cron 只处理现行独立通知队列；供应商接受请求不代表用户实际收件。

公开网页元数据提取限制 HTTPS 公网目标、重定向、时长和响应体积。鱼糕互通校验来源、消息身份、绑定区服和写前快照；脚本不能用来读取云存储密钥。

## 密钥、日志与恢复

`.dev.vars`、`.env*`、私钥、备份和临时凭证不得入库。日志使用 requestId 与脱敏信息，不记录密码、Token、渠道密钥或完整私人正文；对外错误不返回任意异常文本。

`BOOTSTRAP_SECRET` 是现有管理员和通知密文的恢复依赖，不得随意轮换。D1 备份也可能含敏感信息，应私密保存；SQL 备份不包含 Worker Secrets。

当前机制和自动测试不等于全历史密钥扫描或渗透测试。此前只做过历史补丁检查及部分 CI 日志抽样，不能据此断言所有历史对象和日志均无泄露。新增公开资产或准备重写历史时，须另行核对相应范围。

## 回归入口

- `worker/test/security.spec.ts`、`error-privacy.spec.ts`、`calendar-admin.spec.ts`。
- `worker/test/retired-legacy-api.spec.ts`、`local-notifications.spec.ts`。
- `apps/web/test/remote-sync.spec.ts`、`fishcake-sync.spec.ts`、`pwa-asset-cache.spec.ts`。
- `scripts/ops/release-worker.test.mjs`、`fishcake-runtime.test.mjs`。
