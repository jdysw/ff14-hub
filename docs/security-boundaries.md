# 安全边界说明

本文件描述**当前代码里真实生效**的边界，以及每条边界的落点与对应测试。
未实现的项会明确标注为未实现，避免把计划读成现状。

## 1. 统一错误结构

- 对外响应严格为 `{ code, message, requestId }`，形状由 `packages/shared/src/errors.ts` 的
  `apiErrorBodySchema` 定义；`HTTP_STATUS_BY_ERROR_CODE` 是错误码到状态码的唯一映射。
- 未知异常一律降级为 `internal_error`；堆栈、SQL、表名、绑定名、文件路径都不进响应。
- `ApiError.logDetail` 用 **ES 私有字段**保存，因此不会出现在 `JSON.stringify(error)`
  或对象展开里——避免「顺手打个日志就泄露诊断细节」。
- 测试：`worker/test/errors.spec.ts`。

## 2. 身份系统（HUB-006，已实现）

### 2.1 工作空间初始化是「一次且仅一次」

- `POST /api/v1/identity/bootstrap` 需要部署环境中的高熵初始化密钥，通过**请求头**
  `X-Bootstrap-Secret` 传递（不放请求体：body 更容易被日志与错误上报捕获）。
- **未配置**（或配置长度不足 32 字符）密钥时返回 **503**，且不解释原因（fail-closed）。
- 密钥比较走 `credentialsEqual()`：两侧各自 SHA-256 后用平台的
  `crypto.subtle.timingSafeEqual` 比较；「没带」与「带错」在时间与响应上都不可区分（均为 401）。
- 「只能初始化一次」由 `workspace_bootstrap_guard.singleton_key` 的**主键唯一约束**在数据库层保证，
  而不是「先查有没有工作空间再插入」。
- 守卫行、工作空间、首台设备与审计写在**同一个 `db.batch()`（D1 中是 SQL 事务）**里，
  因此并发中的失败者整批回滚，不会留下「有 workspace 没 device」这类半初始化状态。
- 测试：`worker/test/identity.spec.ts`（含 4 路并发初始化恰好 1 个成功）、
  `worker/test/identity-security.spec.ts`。

### 2.2 设备凭证：高熵、只存摘要、独立

- 每台设备的 Token 是 32 字节（256-bit）随机值的 base64url 编码，形状由
  `DEVICE_TOKEN_PATTERN` 约束；恢复密钥与配对凭证各有独立前缀与形状，互不通用。
- 服务端只保存 SHA-256 摘要；`devices` 表没有明文列（有测试断言列集合）。
- 明文凭证只在发放响应中出现一次，且该响应显式 `Cache-Control: no-store`。

### 2.3 撤销立即生效，无进程内缓存

- 认证中间件**每个请求都查库**，不存在「进程内令牌缓存」这种会让撤销延迟生效的结构。
- 撤销是条件更新（`revoked_at IS NULL`），重复撤销幂等；撤销自己也被允许，
  后续请求立即 401。
- 撤销同时清理该设备创建的未消费配对，使其配对码立即失效。
- 测试：`worker/test/identity.spec.ts`（撤销后同一 Token 立刻 401）。

### 2.4 配对凭证：一次性、有限期、与撤销联动

- 有效期由 `expires_at` 强制，且请求给定的 TTL 会被**夹紧**到 60–3600 秒
  （不能只信请求参数；超限的直接 422）。
- **消费、新设备创建与审计在同一个 `db.batch()` 内完成**：
  - 独占判定用 `pairing_claims.pairing_id`（主键）与本次调用独有的 `device_id`（UUID），
    **不用毫秒时间戳**——时间戳在同一毫秒会撞，UUID 不会。
  - 「未消费 / 未过期 / 发起设备未撤销」三项检查与消费写在同一批语句内，
    因此不存在「读到有效状态、提交前状态被改变」的 TOCTOU 窗口。
  - 竞争失败者是合法的空操作：**不创建设备、不写审计、不留下消费标记**。
  - 任何一句失败（含被故障注入的触发器阻止）都会整批回滚，配对码不会被烧毁，可重试。
- `pairing_claims` 通过 `pairing_id → device_pairings → workspaces` 的受约束 FK 链唯一回溯到
  工作空间（规划 5.1），并在配对记录被删除时 `ON DELETE CASCADE` 清理，不留孤儿行。
- 对外失败一律 401（不区分不存在 / 过期 / 已消费 / 发起设备已撤销），真实原因只写脱敏日志。
- 测试：`worker/test/identity.spec.ts`、`worker/test/identity-atomicity.spec.ts`。

### 2.5 恢复访问

- 恢复密钥是独立的高熵随机值，只存摘要；查询按唯一索引命中。
- 换发新设备凭证与审计在同一事务内提交。
- **有意不轮换恢复密钥**：用户被要求离线备份该密钥，若在此轮换，旧备份立即失效，
  而一旦客户端没收到新密钥（网络中断、响应丢失）就永久失去恢复能力。
  轮换应作为独立、带二次确认与备份引导的显式操作。
- 测试：`worker/test/identity.spec.ts`。

### 2.6 速率限制

- 覆盖 bootstrap / pairing.claim / pairing.create / recover，每端点两层：客户端标识 + 全局。
- 实现是 D1 上的固定窗口计数，靠 `UPDATE ... WHERE attempt_count < limit` 的**条件更新**
  与 `INSERT ... ON CONFLICT DO NOTHING` 的插入结果判定，不做「读-判断-写」。
- 限流表只保存「端点 + 客户端标识摘要」的哈希，**不保存明文 IP**。
- 被限流的请求返回 429 并带 `Retry-After`；限流施加在**任何凭证判断之前**，
  因此暴力猜测在到达比较逻辑前就会被挡住。
- 测试：`worker/test/rate-limit.spec.ts`（含并发 25 次恰好放行 20 次）。

### 2.7 作用域

- 所有私有查询都带 `workspace_id = ?`，该值**只能**来自认证中间件写入的 context。
- 因此拿 A 工作空间的凭证操作 B 工作空间的设备只会得到 404，不泄露对象是否存在。
- 测试：`worker/test/identity-security.spec.ts`。

### 2.8 常量时间比较

- Worker 侧统一使用平台提供的 `crypto.subtle.timingSafeEqual`
  （`worker/lib/util.ts` 的 `constantTimeEqualStrings`、`credentials.ts` 的 `credentialsEqual`）。
- `packages/shared` **刻意不提供**常量时间比较原语：纯 JS 循环经 JIT 优化后不具备
  可声称的时序安全保证，放在共享契约层容易被误用。

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

- 测试：`worker/test/security.spec.ts`、`worker/test/identity-security.spec.ts`、`worker/test/unit.spec.ts`。

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
身份端点的失败日志只记录 `route` 与 `reason` 这类枚举值，不记录任何原始输入。

## 7. 请求 ID

- 只接受形状受限（`[A-Za-z0-9._:-]{8,128}`）的传入 `X-Request-Id`，否则重新生成 UUID。
- 含 CRLF 的头值在平台层就会被 `Headers` 构造拒绝（第二道防线）。
- 响应 `X-Request-Id` 与错误体 `requestId` 一致，便于跨日志追踪。

## 8. D1 事务语义（一致性所依赖的事实）

- 官方文档明确：`batch()` 中的语句是一个 SQL 事务，任一条失败即**整批回滚**。
  本项目的身份写入依赖这一点，并且**实测验证**：
  - `worker/test/identity-security.spec.ts`：中途外键失败 → 先前的 INSERT 不保留。
  - `worker/test/identity-atomicity.spec.ts`：`changes()` 反映上一条语句的受影响行数；
    故障注入（触发器阻止设备/审计插入）→ 消费标记、设备、审计一起回滚。
- 撤销审计的条件判定改用**实际受影响行数**（`changes()`）而非时间戳相等；
  另有部分唯一索引 `idx_identity_audit_device_revoked_once` 作为数据库级去重保证。
- 迁移本身不写 `PRAGMA foreign_keys`：D1 默认开启外键约束。
- **模块生命周期同样依赖这一点**：条件 CAS（`WHERE revision = ?`）与待完成标记的插入在
  **同一个 batch** 里完成，`INSERT ... SELECT ... WHERE changes() = 1` 保证「只有 CAS 赢家
  才会留下待完成标记」。抢输的一方因此在任何可变副作用之前就以 409 退出。

## 9. 模块运行时的边界（阶段 02 / HUB-043 · HUB-044 · HUB-050）

- **作用域只来自认证结果**：`/me/modules*` 全部经 `deviceAuth()`，workspace 一律取
  `c.get('workspaceId')`；请求体里出现 `workspaceId` 会被严格 Schema 拒绝（422）。
- **能力是执行期门禁**：交给模块的调度视图在 `schedule` 前查注册表授予结果
  （`registry.hasCapability(moduleId, 'scheduled:own')`）；Manifest 的声明不参与判定。
- **作用域闭包绑定**：模块拿到的 `ModuleScopedScheduler` 入参没有 workspace/module 字段，
  实现只按闭包构造委派入参，多传的作用域字段被丢弃 → 伪造在类型与运行时都无效。
- **不把平台端口交给模块**：带任意作用域的管理端口与实例清理端口只存在于平台代码；
  模块 handler 的上下文里没有 D1、没有 `env`、没有请求对象、没有设备标识。
- **初始化豁免受数据库核对**：唯一能越过 `transitioning` 门禁的路径是「模块自己的
  enable/restore + 数据库里同 action 同 revision 的待完成操作 + 已授予 `scheduled:own`」，
  模块无法伪造（见 ADR-0002 D15）。
- **防静默覆盖**：`PATCH` 必须带 `expectedRevision`，全部状态变更以 `WHERE revision = ?`
  条件更新提交；抢占失败返回 409 且**不产生任何副作用**（副作用在准入之后）。
- **独占执行 + fence**：待完成操作的续做必须先抢到 `workspace_module_operation_claims` 的唯一 token
  （或原子抢占**已过期**的租约）；收尾与失败记录都以 token 为条件，被取代者写不进去。
  端口清理额外带 revision fence（`maxRevision` / `upToRevision`），
  因此不假设「租约到期旧执行者已停止」——它删不掉 restore 之后的新实例与新任务。
- **状态读取是单一 SQL 快照**：状态与「是否有待完成操作」来自同一条 `LEFT JOIN`，
  不会因为两次读之间插入一次准入而组合出「enabled 且无 pending」的假快照；
  准入的 CAS 也把「该模块没有待完成操作」写进同一个条件，不会出现状态提交而标记被吞掉。
- **清数据不可达**：`purge` 恒返回 501 且不写库；代码中不存在删除 `workspace_modules` 行的路径。
  以后实现清数据必须是「先备份 + 显式二次确认」的独立流程。
- **前端会话隔离**：凭证快照只含 `{ generation, authenticated }`，明文只交给 API 客户端内部；
  会话作用域容器在整个会话期间保持挂载、只在代际变化时重挂，因此切换视图不会残留/丢失旧数据，
  而切换凭证会立刻清空；旧会话迟到的 GET 不写状态、迟到的写返回 `stale` 并跳过 Host 联动。
  前端还只接受**不小于已知 revision** 的写响应，避免用过期响应删除新一代实例（见 ADR-0002 D20）。
- **Widget Host 以注册表为归属权威**：实例自述的 `moduleId` 与注册表不一致时拒绝执行组件；
  配置迁移抛错降级为本实例配置错误；旧 attempt 的迟到回调被忽略（见 ADR-0002 D17）。
- **设置校验不回显提交值**：失败只回字段路径 + 问题类别（`worker/lib/zod-issues.ts`），
  为将来可能包含 WebDAV 口令之类敏感值的模块设置留出安全边界。

## 10. 明确未做的安全项（不要读成已完成）

- **认证失败审计未落库**：`identity_audit.workspace_id` 为 NOT NULL，无法承载
  「未知 Token 认证失败」这类没有工作空间归属的事件；这类失败只写脱敏日志。
  若要落库需要新增一张无归属审计表（属于后续工作）。
- **恢复密钥轮换**：未实现，理由见 2.5（避免让离线备份失效）。
- **前端身份界面**：只有阶段 02 补的「会话内存凭证」最小入口；
  初始化向导、配对、恢复、设备管理 UI 仍未实现。将来接入持久化时必须使用 IndexedDB
  而非 localStorage，并沿用严格 CSP。
- **模块设置里的敏感值**：当前没有 WebDAV / 推送凭证类设置；若将来加入，
  必须改成专门的密文存储与掩码回显，不能继续明文放在 `settings_json`。
- **待完成操作的自动恢复**：只有客户端显式重试这一条路径，没有后台自动重试或定时对账；
  租约到期后的抢占也必须有新请求触发（`EXECUTION_LEASE_MS = 15s`）。
- **Web Push / SSRF 防护**：阶段 05 才涉及，本轮没有任何服务端外发请求。
- **URL 协议白名单**（拒绝 `javascript:`/`data:`）：阶段 04 导航功能才需要，本轮无导航数据。
