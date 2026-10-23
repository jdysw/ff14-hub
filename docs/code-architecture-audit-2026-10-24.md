# FF14 Hub 代码质量与架构审查（2026-10-24）

> 范围：`main` @ `080cdc170d311d42662cbd0b073810115d53a301`。审查方式为 GitHub 仓库目录、实现、配置、测试文件与已有运维文档的静态审阅；**未在本轮本地安装依赖、执行测试或部署**。因此“测试存在”不等于“本轮测试通过”，“疑似风险”不等于已经复现的线上故障。

## 结论

**建议保留现有 TypeScript + React/Vite + Hono/Cloudflare Worker + D1 + pnpm Monorepo 的模块化单体方案。** 已有分层、安全边界、数据契约、数据库迁移和大量回归测试，重新选型的收益小于风险。主要技术债是：老工作空间服务与本地优先前端之间的架构分叉、部分服务/契约巨型文件、钓鱼看板高频整表派生、推送计数语义及文档漂移。

用户私有数据的现行路径是 `apps/web` 的 IndexedDB → 用户 WebDAV/S3；本站 Worker 只处理公共数据、公共管理员、独立通知订阅等。旧 `/api/v1/me/*`、工作空间、Widget 与生命周期仍注册并有测试，**未确认客户端使用情况前不能以“前端未引用”为由删除**。

## 1. 模块边界

| 层 | 当前落点 | 判断 |
| --- | --- | --- |
| Web UI | `apps/web/src/app/local`、`fish`、`events`、`admin`、`pwa` | 功能目录已形成，但 `LocalApp.tsx` 同时承担路由、搜索、窗口管理、状态同步和首页组合 |
| 本地持久化及同步 | `local/store.ts`、`secure-storage.ts`、`remote-sync.ts` | IndexedDB 事务、设备密钥隔离、ETag 条件写是合理基础；继续保留格式兼容 |
| HTTP / 中间件 | `worker/api/v1`、`worker/middleware` | Hono 路由、输入校验、认证/写保护、结构化错误分工明确 |
| 业务服务 | `worker/modules/*` | 部分服务规模过大且合并 SQL、状态转换和业务流程 |
| 共享契约 | `packages/shared` | Zod 贯穿前后端，但 `nav-api.ts` 的解析/导入/目录/Widget 职责需要细分 |
| 游戏计算与同步 | `packages/fish-engine`、`packages/fish-sync` | 独立包适合复用和单测 |
| Android | `apps/android` | 原生小组件单独工程，构建/测试不在默认根目录 verify 中 |
| 数据库和运维 | `migrations`、`scripts`、`wrangler.jsonc` | SQL 迁移为事实来源，预览/生产分离；发布需要显式验收 |

## 2. 已确认事项与风险优先级

### P1 / 通知重试可能耗尽每日额度（可靠性）

位置：`worker/modules/reminders/local-push.ts` 的 `runLocalNotifications()`。

当前代码领取任务后，以 `UPDATE local_push_devices SET sent_count=...` 预先占用一次每日额度，然后调用外部渠道 `send(...)`。当渠道返回 0、429 或 5xx 时，任务又会改回 `queued` 重试，但已消耗的 `sent_count` 没有相应释放。连续失败可能使当日尚未成功投递的提醒遇到限额。

这不宜只将计数挪到发送后——并发 worker 下会破坏限额。应先明确计量的是“投递尝试次数”还是“成功/已接受次数”，然后为并发保留额度、供应商失败、重试次数和跨日恢复编写 D1 集成测试，再实现原子结算或拆分 `attempt_count`/`accepted_count`。不要直接更改测试期待值掩盖行为。

### P1 / 钓鱼看板全量高频计算及重复 Worker（性能）

位置：`apps/web/src/app/fish/FishingBoard.tsx`。

`now` 每秒更新；`visible` 的 `useMemo` 依赖 `now`，每次都对完整鱼类列表 `filter`、`windowState`、`sort`。Worker 每分钟重新通过结构化克隆接收整份 `catalog.fish` 并预测；`LocalApp.tsx` 的首页看板与详情 Overlay 可以同时挂载各自的 `FishingBoard`，因此可能存在两组计时器、计算和 Worker。

建议拆分“静态搜索匹配”“窗口状态快照”“秒级剩余时间”；在鱼窗状态边界或分钟级更新候选/排序，只让可见倒计时秒级刷新。评估相同区服的 Worker 复用、仅将必要数据传入 Worker，配合 React Profiler、低端移动端和 24h/168h 样本测试验证实际收益。

### P1 / 核心服务体积过大（维护性）

按本次静态读取（以实际文件行数为准）：
- `worker/modules/nav/service.ts`：约 **3,141 行**；`createNavService` 将目录、链接、分组、导入/恢复、快照等大量方法集中在一个工厂；
- `worker/modules/workbench/service.ts`：约 **1,530 行**；`backup.ts`：约 **1,361 行**；`internal.ts`：约 **980 行**；
- `worker/modules/lifecycle/module-lifecycle.ts`：约 **1,125 行**；
- `packages/shared/src/nav-api.ts`：约 **1,663 行**，把 Schema、校验、书签 HTML 解析、目录导入/导出和 Widget Manifest 放在一起；
- `apps/web/src/app/local/modern-ui.css`：约 **1,023 行**，建议按页面/组件核查选择器归属。

优先在保持对外签名不变的前提下拆分内部文件。例如 `nav/service.ts` 改为 `queries / commands / catalog-import / snapshots / transactions`；`nav-api.ts` 改为 `contracts / url / import-export / catalog-plan`，原入口 re-export 过渡。以跨文件依赖方向、循环依赖检测和现有 nav/workbench D1 回归测试为合并门禁。**不需要为消灭长文件强行增加微服务。**

### P2 / 当前前端与兼容服务的架构分叉

主入口 `main → App → LocalApp` 采用浏览器本地个人资料；但 Worker 仍保留完整的 `/identity`、`/me`、`workbench`、`lifecycle`、`sync` API，相关历史迁移与测试也存在。这不是“可直接删的死代码”，而是需要明确生命周期的兼容接口。

建议先建立 API/数据兼容矩阵：公开入口、实际外部消费者、历史版本、D1 表数据量、归档/恢复要求和移除条件；没有外部客户端证据和迁移方案，不能删除接口、D1 表或历史迁移。可先把文档标为“当前 UI / 历史兼容 API”，降低架构认知成本。

### P2 / 鱼类目录静态资源成本

`apps/web/public/fishing/catalog-cn.json` ~2.74 MB、`catalog-global.json` ~1.51 MB，合计约 **4.25 MB 原始文件**，并由客户端 Zod 进行完整校验；PWA 缓存白名单包含两个文件。未测实际压缩传输和客户端耗时，不能据此认定当前页面卡顿。

建议先量化浏览器解压/校验耗时、堆内存和首屏性能，后续将概览必要字段与扩展资料分级读取，或建立按地区分块及版本化缓存；保持既有数据格式导入兼容。

### P2 / 文档与当前实现漂移

- `docs/calendar-admin-guide.md` 原先仍说明在网页“首次开通管理员”，但 `worker/api/v1/admin.ts` 不再提供注册端点；真正入口在设置页隐藏点击，见 `docs/site-admin-operations.md`。
- 旧管理员指南描述 PBKDF2-SHA256 **310,000** 轮；`worker/modules/events/calendar-admin-auth.ts` 目前明确为 **100,000** 轮 + HMAC pepper。
- `docs/security-boundaries.md` 中 CSP 示例写 `connect-src 'self'`，实际 `worker/middleware/security-headers.ts` 为 `connect-src 'self' https:`，允许用户配置的 HTTPS WebDAV/S3；`img-src` 同样允许 `https:`。
- `worker/app.ts` 顶部注释称 `/me` “认证后仍未实现”，与现在注册并保留的兼容 API 不一致。
- `package.json` 描述仍着重早期阶段 04 旧 Widget 工作台；当前产品应以 README 的本机优先说明为准。

本 PR 修订可确定的失效说明；更广泛的历史 ADR 保持原样、标明历史属性，不篡改历史设计决策。

### P2 / 发布门禁不完全覆盖产品边界

根脚本 `pnpm run verify` 已覆盖源码检查、类型、包测试、运维测试和构建干跑。它**没有默认包含** Android 的 `check:android-pvp` / Gradle `testDebugUnitTest` / `lintDebug` / `assembleDebug`，也不包含 `validate:config`、`audit:prod`。仓库当前无 `.github/workflows`，是已声明的人工关闭 GitHub Actions 策略，不应擅自恢复付费 CI。

建议创建不依赖付费 CI 的本地/手动发布验收清单，明确 web/worker、数据库与 Android 的独立门禁。Android 测试依赖 JDK17/SDK35，不能无环境时假称验证通过。

## 3. 已有优势（应保留）

1. 同源 Worker + 安全头统一施加、请求 ID、结构化错误、输入校验、管理员密码/TOTP/会话隔离。
2. 本地 IndexedDB 原子修改、加密设备配置和 revision CAS；个人数据 WebDAV/S3 直连，强 ETag 条件写和显式同步冲突预览。
3. Zod 契约复用、分模块包测试、workerd/D1 集成测试、PWA 缓存白名单和离线行为回归。
4. SQL 历史迁移与实际 D1 表保留；预览和生产环境单独配置。
5. Android 小组件独立工程，当前并未混入网页构建链。

## 4. 推荐按 PR 推进（不改变当前线上行为）

| 次序 | 建议独立 PR | 验收条件 |
| --- | --- | --- |
| 0 | 审计报告 + 更正文档注释（本 PR） | 无业务代码、DB、部署变更；文件说明与代码一致 |
| 1 | 修正通知额度/重试账本 | 注入 429/5xx/超时、跨日、并发测试，额度不被意外耗尽且不突破日限 |
| 2 | 钓鱼看板性能 | React Profiler 实测；高频只更新倒计时；鱼窗范围、筛选、已钓获、详情等测试不回退 |
| 3 | 拆分导航契约与 `createNavService` | 对外 API/数据库/JSON 格式不变；严格 TS/lint + 全量导航 D1 测试通过 |
| 4 | 整理 UI 容器和 CSS | 首页/详情/设置状态保持、键盘/触屏/移动端布局与 PWA 离线验收 |
| 5 | 历史兼容 API 生命周期整理 | 客户端/数据审计报告完成后再决定是否迁移、弃用；禁止直接删表或迁移 |
| 6 | 发布脚本与文档一致性门禁 | 手动验证入口完善；Web/Worker/Android 分别留存运行结果，不默认开启付费 CI |

建议本轮不改版本号、不创建正式 Release、不清理历史 SQL。执行重构时提交到对应主题 PR，并在验收后压缩合并。

## 5. 本次审查未做的事

- 未对远端生产环境做渗透测试、读取生产 Secrets 或访问真实用户数据。
- 未执行 `pnpm install`、`pnpm verify`、Android Gradle 构建、D1 迁移或线上部署。
- 未对所有 493 个跟踪文件逐行审查；本结论来自完整文件清单、主要实现、配置与选取的代表性代码。
- 未断言线上已发生性能故障、通知丢失或安全漏洞；所述行为需要在独立测试 PR 中验证。

## 6. PR #78 实施进度（本次更新）

此节是以上静态审计的实施记录；第 4 节为最初建议的工作顺序，现按用户要求将已落实修改集中提交到原有 [PR #78](https://github.com/jdysw/ff14-hub/pull/78) 草稿，不另建 PR。

| 范围 | 已提交代码 | 剩余验证或后续工作 |
| --- | --- | --- |
| 通知配额与失败重试 | `worker/modules/reminders/local-push.ts` 原子完成任务 + 根据同一租约条件返还未被渠道接受的配额；`worker/test/local-notifications.spec.ts` 新增失败、并发、租约过期案例 | 必须实际运行 workerd/D1 测试；注意“2xx 被接受”不等于终端已展示，超时仍有不可避免的不确定性 |
| 钓鱼看板性能 | 新增 `fish/forecast-session.ts` 共享 Worker 订阅，`FishingBoard.tsx` 将秒级展示与分钟/鱼窗边界列表计算分离；新增单元测试 | 必须执行 Web 单测、实际浏览器可见性恢复和 React Profiler；尚未测性能百分比 |
| 导航持久化边界 | `worker/modules/nav/persistence.ts` 从原服务**等价移动**约 725 行 D1 行投影、事务内快照读取与 SQL 语句工厂；`service.ts` 维持既有公开类型和原业务调用 | 已做源码片段字节级还原比对（除 export 标记相同）；仍须全量导航 D1 集成测试，特别是快照、导入、墓碑、幂等及并发 |
| UI 容器与样式 | 提取 `use-navigation-catalog.ts`；将 `modern-ui.css` 按原级联顺序拆为基础、页面内容、模块和 PVP 样式（四段拼接与原文本完全一致），并新增 CSS 顺序测试 | 原有首页目录回归、移动端视觉与可访问性测试仍须执行；不得只按静态文本等价声明视觉验收通过 |
| 兼容清单 | 新增 `docs/api-compatibility-inventory.md`，明确 IndexedDB/通知/D1 旧工作空间数据所有权 | **没有**经授权的生产 D1 只读数据与客户端日志访问；不得据静态扫描删 API、表或历史迁移 |
| 验证与文档 | 新增 `docs/manual-release-verification.md`，`verify` 纳入 Android PVP 规则生成一致性检查，`verify:release` 增加 Wrangler 配置干跑，修正 README、pnpm catalog 陈旧注释和管理员/CSP 文档 | 默认不启用 GitHub Actions；Android Gradle、联网依赖审计、浏览器 E2E 仍是独立手动门禁 |

**本轮续做**：`packages/shared/src/nav-api.ts` 已将文本规范化、导航投影、目录升级判定及书签 HTML 安全扫描器分别提取至 `nav-normalize.ts`、`nav-projection.ts`、`nav-catalog-decisions.ts`、`nav-bookmark-parser.ts`。原入口保留所有公开 API，解析器的 URL 校验与上限由原契约显式注入，内部模块只通过 `import type` 引用旧类型，避免运行时循环。新增 facade 同一性及解析输出一致性测试。静态复核确认前三个抽取源码片段与原文件完全一致；书签扫描器除导出、函数签名和显式依赖注入外，函数正文与原实现一致。共享契约入口从 1,663 行缩减至约 1,054 行。`forecast-session.ts` 也增加鱼类预测规则比较及相同元数据冲突后的存活任务复用逻辑，防止结果串用和冗余 Worker。\n\n**尚未实施**：结构化 JSON 导入/导出解析的剩余模块化、大型工作台/生命周期服务、鱼类目录按需分片与主动删除历史兼容 API；它们仍需完整类型检查、D1 测试或真实数据迁移评估，不能因静态审计就直接移除。

**运行验证状态**：尝试恢复原 DevSpace 工作空间 `E:\\deepseek\\workplace1` 及其工作空间 ID，连接仍返回内部错误；容器也无法解析私有 GitHub 源码域名。已使用独立 SQLite 进行 `UPDATE ... WHERE changes()>0` 基本语义验证，并完成 GitHub 源码片段与 CSS 完整内容的静态一致性复核，但**未运行 pnpm verify、workerd、Gradle 或真实浏览器测试**。PR 应保持 Draft，不应自动合并/部署。
