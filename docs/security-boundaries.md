# 安全边界说明（阶段 01 已生效）

本文件描述**当前代码里真实生效**的边界，以及每条边界的落点和对应测试。
未实现的项会明确标注为未实现，避免把计划读成现状。

## 1. 统一错误结构

- 对外响应严格为 `{ code, message, requestId }`，形状由 `packages/shared/src/errors.ts` 的
  `apiErrorBodySchema` 定义；`HTTP_STATUS_BY_ERROR_CODE` 是错误码到状态码的唯一映射。
- 未知异常一律降级为 `internal_error`；堆栈、SQL、表名、绑定名、文件路径都不进响应。
- `ApiError.logDetail` 用 **ES 私有字段**保存，因此不会出现在 `JSON.stringify(error)`
  或对象展开里——避免「顺手打个日志就泄露诊断细节」。
- 测试：`worker/test/errors.spec.ts`。

## 2. 认证边界

- 所有 `/api/v1/me/*` 必须先通过 `deviceAuth()` 中间件。
- 缺少凭证、形状非法、未知 Token、已撤销 Token **全部返回同一个 401** 且文案一致，
  不提供可用于枚举的差异（测试对比了两者响应体）。
- 服务端只保存 SHA-256 摘要；查询命中后再做一次固定时序比较。
- 数据作用域只能来自认证结果（`c.get('workspaceId')`），不接受客户端提交的 workspace id。
- 响应中绝不出现明文 Token、`token_hash`、`recovery_hash`。
- `ENABLE_TEST_ROUTES` 未开启时，自检路由表现为 **404**（而不是 403），不暴露其存在。
- 测试：`worker/test/auth.spec.ts`。

## 3. 写请求边界（纵深防御，不是身份认证）

| 校验 | 行为 | 依据 |
|---|---|---|
| `Origin` 存在且不等于同源/白名单 | 403 `forbidden` | 阻断跨源浏览器写请求 |
| `Origin` 缺失 | **允许** | 凭证走 `Authorization` 头，不是 ambient credential（Cookie）；Tampermonkey 等客户端可能不带 Origin |
| `Origin` 无法解析 | 403 | 不猜测、不放行 |
| `Content-Type` 非 `application/json` / 非 `+json` | 415 | 阻断表单与 fetch「简单请求」路径 |
| `Content-Length` 超过 64 KiB | 413 | 提前拒绝，避免为超大体分配内存 |
| 实际读取字节数超过 64 KiB | 413 | 不信任 `Content-Length`（可缺失或撒谎） |
| JSON 语法错误 | 400 | 语法问题与语义问题分开 |
| Schema 校验失败 | 422 | `validation_failed` |

白名单中的 `"*"` 会在解析阶段被**丢弃**（`parseAllowedOrigins`），不存在通配放行。

- 测试：`worker/test/security.spec.ts`、`worker/test/unit.spec.ts`。

## 4. 校验失败不泄露提交值

Zod 的若干默认文案会把「收到的值」拼进 message（例如非法枚举值的提示），直接透传会把
凭证写进响应体与日志。因此本项目的校验失败消息只由**字段路径 + 问题类别**构成
（`worker/middleware/validation.ts` 的 `describeIssues`）。

测试用「把像 Token 的字符串放进错误类型的字段」来验证响应体不含该字符串。

## 5. 安全响应头与 CSP

由 Worker 顶层 `fetch` 统一施加，覆盖 **所有**响应（含 500/404/静态资源）；
这正是 `run_worker_first: true` 的原因——否则同域 HTML 拿不到 CSP。

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self';
  worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=(), serial=()
Strict-Transport-Security: max-age=31536000; includeSubDomains   ← 仅在请求为 HTTPS 时
```

- 不包含 `unsafe-eval`；`script-src` 不含 `unsafe-inline`。
- 预览/生产额外加 `upgrade-insecure-requests`；本地开发不加，避免破坏 http 调试。
- API 响应一律 `Cache-Control: no-store`。
- 尚未启用 `require-trusted-types-for 'script'`（React 与后续第三方组件的兼容性需要单独验证）。
- 测试：`worker/test/security.spec.ts`。

## 6. 日志脱敏

`worker/lib/redact.ts` 在写日志前做模式脱敏：

- `ffh_dev_` / `ffh_rec_` / `ffh_pair_` 高熵凭证；
- `Authorization` 头（连方案一起吞掉）；
- 64 位十六进制摘要（`token_hash` / `recovery_hash` 形态）；
- 敏感字段名（含 `webdav_password`、`p256dh`、`auth_secret`、`private_key` 等，对应 INV-06）；
- URL 查询串中的 `token=`/`key=`/`secret=`/`sig=`。

脱敏是**兜底**，不是许可：代码本身就不应把凭证放进错误信息。

## 7. 请求 ID

- 只接受形状受限（`[A-Za-z0-9._:-]{8,128}`）的传入 `X-Request-Id`，否则重新生成 UUID。
- 含 CRLF 的头值在平台层就会被 `Headers` 构造拒绝（第二道防线）。
- 响应 `X-Request-Id` 与错误体 `requestId` 一致，便于跨日志追踪。

## 8. 明确未做的安全项（不要读成已完成）

- **速率限制**：配对、恢复、认证失败的限流属于 HUB-006，本轮未实现。
- **审计写入**：`identity_audit` 表已建，但认证失败事件因 `workspace_id` 为 NOT NULL
  而无法记录（见下方「已知限制」）。本轮只写脱敏日志。
- **Web Push / SSRF 防护**：阶段 05 才涉及，本轮没有任何服务端外发请求。
- **URL 协议白名单**（拒绝 `javascript:`/`data:`）：阶段 04 导航功能才需要，本轮无导航数据。
- **SPA 凭证存储**：本轮前端不持有任何凭证；HUB-006 起改用 IndexedDB，不使用 localStorage。

## 9. 已知限制（留给 HUB-006 决策）

`identity_audit.workspace_id` 为 `NOT NULL`，且 `device_id` 可空。这意味着**无法记录
「未知 Token 的认证失败」**这类没有工作空间归属的事件。HUB-006 需要二选一：

1. 把 `workspace_id` 放宽为可空（需一次新的迁移，并处理既有数据）；
2. 另建一张无归属的审计表（例如 `auth_attempts`）。

本轮选择的临时方案是：只写脱敏结构化日志，不写库。
