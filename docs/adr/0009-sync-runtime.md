# ADR 0009 — 06C 客户端运行时端口与多设备验收

06A/06B 的协议与协调器继续复用。本阶段补上两种可注入的运行时端口，并用真实浏览器连接本地 Worker/D1 验证协作；不启用产品自动同步。

## Hub 端口

`@ff14-hub/fish-sync/hub` 提供 `createHubSyncPort`。构造时固定 HTTPS Hub 源、工作空间和区服（开发仅允许 HTTP 回环）。调用方只能执行 snapshot、preview、apply，不能指定任意地址。设备令牌由内存回调按请求取得，不进入计划、检查点、URL 或日志。

每次操作先读取受信 `/api/v1/me/profile`，确认工作空间与构造时一致，再使用同一设备令牌访问固定同步接口；请求前后检查会话是否切换。服务端仍是认证、撤销、模块状态和数据隔离的最终权威。会话切换不能撤回已在服务端提交的请求；客户端停止后续推进，保留原操作检查点。

请求使用 no-store、omit cookies、redirect:error 和 15 秒超时。响应流上限 4MiB，验证 JSON 形状、区服和字段唯一性；preview 必须回显相同的最小字段意图。输入拒绝凭证/扩展字段、重复字段和超过 200 项的计划。错误使用固定文案及状态码，不回显任意服务端响应或底层异常。

SDK 只解析协调器需要的响应投影，避免从底层 fish-sync 反向依赖 shared（shared 已依赖 fish-sync）。浏览器验收用真实 Worker 契约检查这层投影，防止两边漂移。

## 跨标签互斥

`@ff14-hub/fish-sync/browser-lock` 提供 `createBrowserProfileLock`，替换 06B 的内存锁端口。根据 [Web Locks request 文档](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request)，用固定前缀和档案 UUID 请求 exclusive/ifAvailable 锁；拿不到即 lock-busy，不排队、不 steal。释放函数幂等，且等待浏览器确认释放；关闭持锁标签后由浏览器释放，测试等待其实际完成。

API 不可用或被权限拒绝时失败关闭，绝不降级成内存锁。同源且共享浏览器存储分区的标签页可以互斥；不同浏览器/设备仍依靠 DAV ETag 和 Hub 修订防止覆盖。调用方必须给同一档案使用相同 UUID，所有参与写入的代码也必须遵守同一锁约定。

## 验收与夹具边界

`pnpm run e2e:phase06c` 构建独立测试入口，输出到被忽略的 `.wrangler/phase06c-fixture/`。Playwright 在内存中提供测试文档和脚本；生产前端入口不引用它，服务端不注册测试页面，生产 CSP 不变。

实际执行的是客户端 SDK、浏览器 Web Locks/Fetch/WebCrypto/IndexedDB、两个独立设备凭证、真实 Worker HTTP 和本地 D1。覆盖：

- 两标签互斥、幂等释放及标签关闭后的锁释放。
- 两设备三集合同步、首次分歧显式选择、已钓取消传播和陈旧计划拒绝。
- 未知鱼 ID 保留，扩展字段只留客户端/DAV，不进入 D1 同步响应。
- 服务端已提交但浏览器丢失响应时，持久检查点保留，原操作幂等回执可恢复。
- CN/Global 分离，设备撤销后立即拒绝访问。

DAV 是 Playwright 拦截的有状态 HTTP 夹具，模拟强 ETag、条件写和双文件；没有连接真实外网 DAV。鱼糕本地源是明确标记的内存 CAS 夹具，不使用或猜测任何鱼糕站点存储键。检查点则真实加密写入 IndexedDB。

## 尚未完成

真实鱼糕存储审计、正式油猴脚本、真实 DAV 的 CORS/条件写互操作、产品页面的实时三方同步接线和自动/后台同步均未完成。当前产品页面保持 06A 手工文件导入、06B 本机保险箱。主站 CSP 仍限制连接到本站；未来接入实际客户端必须单独评估精确域名与执行环境，不能泛化放开。

本阶段不部署、不创建远程资源、不改真实 secrets、不注册 Cron、不更新鱼类数据或模板内容。发布恢复演练与完整安全验收仍待后续阶段；HUB-032/034 的真实站点全链路不能仅凭此夹具标记完成。

复用：继续使用项目内协调器、DAV 协议、保险箱和 API；参考 Web Locks 标准接口及 [Cloudflare 测试文档](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)，未复制外部源码、未引入新第三方依赖。
