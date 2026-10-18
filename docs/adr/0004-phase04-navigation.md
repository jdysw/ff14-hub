# ADR-0004：阶段 04 —— 自由导航、内置导航/活动模块、PWA 与跨设备同步

- **状态**：接受（阶段 04 实施中）
- **范围**：HUB-007 / 008 / 009 / 010 / 011 / 012 / 047 / 048 / 051
- **前置**：ADR-0001（工程）、ADR-0002（模块运行时）、ADR-0003（工作台与备份）；阶段 03 已合并（`main` `c2d5ce8`）

本 ADR 记录阶段 04 的**不可变决策**。表中 DDL 是 `migrations/0008_navigation.sql` /
`migrations/0009_events.sql` 的事实来源；`worker/db/schema.ts` 只是它的类型化镜像（不参与建表）。

---

## D1 推荐目录与个人副本彻底分离（HUB-047）

- `nav_catalog_links` 是**只读系统目录**：只有种子/维护代码写入（`worker/modules/nav/catalog.ts`），
  没有任何用户 API 能修改它。它带 `source_version`、`source_url`、`verified_at`、`verification_status`。
- `workspace_nav_links.source_catalog_id` 是**弱关联**：刻意不加外键，因为「个人副本」必须能在
  目录条目被下线/改名后继续存在。导入即**完全独立**，用户可删、可改、可重排。
- 「每个目录条目在每个工作空间至多一条活跃副本」是数据库级约束
  （部分唯一索引 `WHERE source_catalog_id IS NOT NULL AND deleted_at IS NULL`）；
  墓碑行不受约束，因此「删除后再次显式导入」可以复用同一行（复活墓碑），而不是复制一份。
- **目录升级**（`source_version` 变大）只更新 `nav_catalog_links`，绝不写个人表。
  目录升级不是再导入：服务端在 `nav/catalog.ts` 提供 `catalogUpgradePlan()` 纯函数报告
  「每条目录条目相对个人副本的状态」：`new` / `unchanged` / `user_modified` / `tombstoned`。
  只有用户对同一条目录条目**显式再次导入**（`importCatalogEntry(explicit: true)`）时才更新个人行，
  且 `user_modified = true` 的行需要显式 `overwriteUserEdits: true` 才覆盖。
- 删除墓碑 `deleted_at` 跨设备传播（D7）；**没有任何路径**会因为目录升级而清除墓碑。

## D2 个人链接 / 分类 / 多分组（HUB-048）

- 个人链接字段：名称、URL、描述、标签、图标（空则安全默认图标）、打开方式、区服、收藏、状态、
  手动顺序、别名（供搜索）、来源目录条目与导入版本、`revision`、墓碑。
- 分类与分组是同一张表 `workspace_nav_groups`（用户产出物），一个链接可属于多个分组
  （`workspace_nav_memberships`，含组内顺序与墓碑）。
- **主键一律稳定 ID**（`crypto.randomUUID()`），名称只作为可编辑字段，绝不作为标识。
- 时间一律 UTC 毫秒（`nowUtcMs()`）。
- **作用域**：所有私有查询/写入只取认证得到的 `workspaceId`；关联 ID（`source_catalog_id`、
  `link_id`、`group_id`）也必须在同一 workpace 内校验——
  「外键」不能替代作用域检查（`workspace_nav_memberships.workspace_id` 与两个端点行的
  `workspace_id` 必须在同一事务内相等，有测试覆盖）。
- 越权（用 A 的凭证访问 B 的行）返回 404，不泄露存在性。

## D3 URL 与图标安全策略（HUB-048 / 008）

- 服务端**只接受 `https:`**，且要求有 host、不含用户名/密码、长度 ≤ 2048。
- 显式拒绝 `javascript:` / `data:` / `file:` / `blob:` / `vbscript:` 及一切非 https 协议。
- 本阶段**不授予任何 http 例外**；将来若确有理由放行 http，必须在 ADR 中逐条记录原因，
  不允许在代码里偷偷放宽（`validateNavUrl` 是唯一实现，前后端共用）。
- 图标是**纯文本**（emoji 或内置标识），不是 HTML/URL 注入点：前端只以文本渲染，
  不使用 `dangerouslySetInnerHTML`；空值回落到 `NAV_DEFAULT_ICON`。
- 导航 URL 绝不进入任何服务端 fetch：本阶段**没有**主动探测，
  健康状态一律 `unknown`（见 D4），因此不存在把导航 URL 变成 SSRF 入口的路径。

## D4 健康状态与「不伪造」（HUB-008）

- 状态枚举固定为 `ok` / `maybe_blocked` / `unreachable` / `unknown`，由**人工或后续探测**填写。
- 阶段 04 不实现服务器端探测：默认 `unknown`，界面明确显示「未探测」。
- 403 不得被判定为永久失效（枚举里没有 `blocked`；将来探测只能产出 `maybe_blocked`）。
- 本阶段**不伪造在线状态**：没有探测结果就不显示「可用」。

## D5 搜索 / 筛选 / 排序复用同一份纯函数（HUB-008 / 009）

- `packages/shared/src/nav-api.ts` 里的 `normalizeNavText` / `filterNavLinks` / `sortNavLinks`
  是**唯一实现**：Worker 的查询端点与前端 Widget 都调用它。
  服务端先用 SQL 取「本工作空间 + 未删除」的行（作用域与墓碑在 SQL 层），
  再用同一纯函数做关键字/分组/区服/标签筛选与排序，因此两处不可能漂移。
- 规范化：NFKC + 小写 + 折叠空白，标题/别名/描述/标签全部参与匹配。
- `sort_order` 是用户手动顺序，跨设备一致（`revision` 参与同步）。

## D6 导入 / 导出（HUB-007 / 008）

- 书签 HTML 与结构化 JSON 必须先**预览**：解析是纯函数（`parseBookmarkHtml` /
  `parseNavImportJson`），只把 `<A HREF="...">标题</A>` 与文件夹层级当**数据**读，
  其余标签一律忽略；**不执行**外来 HTML，也不把外来 HTML 直接插进页面。
- 解析结果逐项给出 `accepted` / `skipped`（附原因：非 https、重复、超限、非法 URL…）。
- 服务端在 apply 时**重新校验**（绝不相信客户端传来的「已校验」结果），并按 `operationId` 幂等。
- 导出文档带 `schemaVersion`，且能被 `parseNavExportDocument` 读回（roundtrip 测试）。
- 导出/导入**不含**任何凭证（与工作台备份同一原则）。

## D7 跨设备同步：水位 + 墓碑（HUB-051）

- 复用阶段 03 的「页面 + 断点独立 revision」与请求指纹/CAS，**不新建第二套布局机制**；
  手机端保存只 bump `mobile` 修订，不会把桌面坐标覆盖。
- 导航写入带 `baseRevision`（或 `expectedRevision`）与 `operationId`；同一字段并发冲突返回
  结构化 `409`（`details.conflict` 带 `entityType/entityId/field/baseRevision/currentRevision`），
  不盲目覆盖。
- `GET /me/sync/changes?since=<cursor>&limit=N` 是**认证**的变更/水位端点，覆盖：
  `page` / `widget` / `layout` / `nav_link` / `nav_group` / `nav_membership` / `module` /
  `workspace_event`（个人活动；追加在清单末尾，因为清单顺序也是契约）。
- **变更流是数据库里的单调序号表，不是时间戳扫描**（复核修正：原「按 `updated_at` 扫描 +
  `nextCursor = lastTs + 1`」被判定为 P1 真实缺陷）。`migrations/0011_change_journal.sql`
  建立 `workspace_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id, entity_type,
  entity_id, op, revision, changed_at)`，并由**触发器**在**同一事务**里为每一行变更落一条记录。
  为什么必须是序号：同一毫秒内完全可能「删除 → 显式恢复」，`updated_at` 无法表达先后；
  多 Worker 的时钟还可能回退。任何「按时间重叠窗口」的补丁都解决不了这两点。
  为什么用触发器而不是在写路径里手记日志：写路径不止常规 CRUD（模块卸载清理、模板重置、
  备份导入、墓碑化，将来还会有新代码），漏记一处就是**永久**丢变更，且客户端无法补救。
  触发器由数据库保证「行变了 ⟹ 同一个事务里有记录」，覆盖现在与将来的所有路径。
- **游标 = `v2:<seq>`**（`SYNC_CURSOR_PREFIX`）。`v1:<毫秒>` 是旧版时间戳游标，
  服务端**明确拒绝**（422 + `details.reason='cursor_version_unsupported'`），
  由客户端丢弃本地游标做一次全量重建——绝不把毫秒值当 seq 解释（那会静默漏变更或重放）。
  其余损坏输入返回 `cursor_malformed`。迁移会**回填**既有行的一条初始变更记录，因此
  「游标为空」的首次同步也能拿到全部现存数据。
- **分页有真实工作量上限**：每页恰好 ≤ `limit` 条变更（`seq` 严格递增，不存在
  「同一时间戳行太多而无限扩张」的情形）；`nextSyncCursor` 是唯一实现。
- **payload 与水位来自同一一致快照**：一次请求用**一个 D1 batch** 读「变更页 + 各实体 payload
  （按本页 entity_id 子查询限定）+ `meta`」，因此不会出现「旧行 + 新 revision」的混合视图。
- **权威工作空间修订号随响应返回**（`meta.navRevision` / `meta.workbenchRevision` / `meta.watermark`）。
  客户端更新**全局 CAS 基数**只能用它；行 CAS 只用各行 `revision`。
  复核修正：原客户端用 `Math.max(snapshot.revision, change.revision)` 推导全局修订，
  而行修订（membership 恒 0）不能推导全局修订 → 远端每次新增/编辑后客户端全局修订落后，
  下一次重排/导入必然 409。这条规则有双浏览器回归（B 自动同步后**无需人工刷新**即可重排/导入）。
- `syncChange.seq` 是排序/去重/墓碑先后的**唯一**依据；`updatedAt` 仅作展示与诊断。
  客户端墓碑表按 seq 记忆，因此「同毫秒删除→恢复」会正确落地为恢复，而更旧的 upsert
  不会复活已删行。
- 删除以墓碑形式返回（`op: 'delete'`）；客户端只按墓碑删除，**不会**因为某行没出现在
  增量里就复活它。墓碑保留策略：**不自动 GC**（阶段 04 不删除任何墓碑），
  因此不存在「早于某设备水位被删掉」的情况。
- 组合实体 ID 的契约上限是 **96**（`SYNC_ENTITY_ID_MAX_LENGTH`）：`nav_membership` 的
  `linkId:groupId` 是两个 36 字符 UUID + 分隔符 = 73 字符。复核发现原上限 64 会让
  「只要有成员关系，整份响应就过不了 `syncChangesResponseSchema`」。修法是**放宽契约**，
  而不是在服务端截断 ID——截断会让极端情况下两个不同关系映射到同一键，客户端按 ID
  去重就会互相覆盖（服务端仍保留长度截断作为最后一道防线，并有测试盯着）。
- **页面墓碑的子行归属**：`deletePage` 只 bump 页面行自身，因此增量里客户端只收到
  `page` 的 `delete`。契约规定：客户端收到 `page` 的 `delete` 时，**本地一并移除该页面的
  widget 与 layout**（它们已经不可能再被服务端返回）；收到 `page` 的 upsert 时重新读取
  该页的实例与布局。这条规则有服务端测试记录（增量只有 page、全量里 layout 为 delete）。
- **变更流的 payload 是「当前实体内容」，不是「事件发生时的内容」**——因此**禁止从零回放历史**
  （第三轮复核修正）。反例：`导入 → 删除 → 显式恢复` 之后，历史里的 `delete` 仍然存在
  （payload=null），把它重放到一个已经是「已恢复」的本地副本上，会**误删**这条活跃链接
  （成员关系一起丢），直到更靠后的 restore 页才补回；而历史行的 `revision` 与当前
  payload 的 `revision` 也不一致。
  协议（安全快照 + 稳定水位初始化）：
  1. `since` **缺省**时服务端**不返回历史变更**，只返回 `resetRequired: true`、
     `changes: []`、`nextCursor = v2:<当前水位>`、`meta.watermark`；
  2. 客户端先 `GET` 一次权威快照（导航/工作台）并**替换**本地状态；
  3. 快照落地后才把游标设为第 1 步的 `nextCursor`，之后只用 `since` 取**真实增量**；
  4. 因此被投递的每一条都发生在「本地快照」之后，按 seq 顺序应用是自洽的
     （后来的事件覆盖先前事件），中间态是**真实历史**而不是错误状态。
- **`hasMore === true` 期间不得采用 `meta` 的全局修订号**（同一修正）：那对应服务端**当前**
  状态，而客户端集合还不完整；用它做全局 CAS 会「按未来修订号批准基于部分旧集合的写入」。
  客户端排空（`hasMore === false`）后才写入本地全局 revision，且排空过程中不允许重排/导入，
  界面明确提示「正在同步」。客户端在发现 `hasMore` 时应**立即续取下一页**，不等下一个轮询间隔。
- 编辑中的本地草稿遇到远程变化时**保留草稿并提示冲突**，后台刷新不得静默覆盖。

## D8 内置真实模块（HUB-010 / 011）

- 新增两个**真实**内置模块（不再是 `demo.*` 名义）：
  - `ff14.navigation`：Widget `nav-quick-links`（常用/收藏网站）、`nav-search`（搜索与分类）。
  - `ff14.events`：Widget `events-upcoming`（即将开始/进行中）、`events-manage`（手工维护个人活动）。
- 二者都经 Module Registry 注册（Manifest + 静态 handler 表 + Settings Schema + 授予能力），
  业务组件由 `component-registry.ts` 的**静态映射**接入，Shell 里没有不可移除的硬编码业务组件。
- 能力授予：`ff14.navigation` → `['storage:own','navigation:read-catalog']`；
  `ff14.events` → `['storage:own']`。前端按公开目录的 `capabilities` 比对（声明 ⊆ 授予）。
- **模块数据端口**（新增 Host 契约）：Widget 拿不到设备 Token、拿不到 D1、也拿不到任意 URL；
  它只能调用 `ModuleDataPort.call(operation, input)`，`operation` 必须是该模块在静态端口表里
  声明过的名字。端口实现持有会话凭证与 API 客户端，并在每次调用前复查模块门禁状态
  （`transitioning`/停用/卸载时不执行），因此**不回退生命周期 pending/执行 token/createdRevision fence**。
- 未知组件（不在注册表）一律降级卡片，**不执行**。
- 默认模板只初始化一次：模板/目录升级都不会把用户删掉的默认项塞回页面。

## D9 手工活动模块（HUB-011）

- **边界变更（短 ADR）**：规划 5.2 把 `events` 归到阶段 05–06 的「游戏、通知、同步」表清单。
  阶段 04 提前实现的是**人工维护的活动列表**（真实用户输入、日期起止、来源链接、区服、
  过期逻辑、验证状态），**不实现**抓取器、鱼类计算与提醒调度——后者仍留阶段 05。
  这是产品边界的显式记录，不是静默变更。
- 公共来源活动（`events`，只读）与个人活动（`workspace_events`，工作空间私有）分表；
  公共接口只返回公共行，个人行永不通过公共 API 泄露。
- **不捆绑任何未经核实的活动数据**：`events` 本阶段为空表（种子为零），
  界面诚实显示「没有可验证的公共来源活动」，不编造。
- 外部来源未验证时 `verification_status = 'unverified'` 且界面标注；不声称准确提醒。
- 过期逻辑是纯函数（`eventPhase(event, nowMs)`），有表驱动测试；区服在数据层显式化（INV-08）。

## D10 PWA 与离线边界（HUB-012）

- `manifest.webmanifest` + 图标（同域静态资源）提供可安装基础；Service Worker 只缓存
  **公开静态资源**与**允许的非敏感目录**（`/api/v1/modules/catalog`、`/api/v1/navigation/catalog`、
  `/api/v1/events`）。
- **绝不缓存**：任何带 `Authorization` 的请求与响应、`/api/v1/me/*`、设备凭证、备份、
  个人活动、个人导航。
- 缓存放行判断是**纯函数**（`shouldCacheRequest`/`shouldCacheResponse`，可单测），
  默认拒绝而非默认允许。
- 退出/切换凭证时立即清除私有相关缓存并隔离旧工作空间；SW 更新不重载正在编辑的页面，
  提示用户后再激活，避免无提示丢草稿。
- 离线体验有明确状态与降级文案，**不假装**私有修改已服务端持久化。

## D11 幂等与事务：复用同一套机制（HUB-048 / 051）

- 阶段 03 的幂等/守卫算法（认领 + token 守卫 + 请求指纹 + 原子 batch）提取为
  `worker/modules/idempotency/ledger.ts`，**只保留一份实现**；
  `worker/modules/workbench/tx.ts` 变成绑定 `workbench_operations` 的薄封装（导出名不变），
  导航绑定 `nav_operations` / `nav_operation_intents`。
- 指纹覆盖「目标 ID + 动作 + 正文 + 期望 revision」；同一 `operationId` 换意图 → `409` 且零写入。
- 失败回滚：所有多表写入在同一个 D1 batch 内，任何约束冲突整体回滚。

## D12 明确不做（阶段 04 边界）

- 不做服务端 URL 探测、不做抓取器、不做鱼类计算、不做提醒调度、不注册 Cron。
- 不做墓碑 GC；不做 WebDAV 同步（阶段 06）。
- 不部署、不创建远程 Cloudflare 资源、不绑定域名。

## D13 首页视图 = 可定制工作台（但初始落地视图仍是「概览」）

HUB-010 要求「首页必须使用阶段 03 的可定制工作台」：业务组件由 Registry/静态映射接入，
**不往 Shell 硬编码不可移除业务**。阶段 04 的落地方式是：

- 用户的「首页」就是 `WorkbenchView`（可定制工作台）：页面、实例、布局、组件库全在它里面，
  导航与活动 Widget 都通过注册表进入它，Shell 里没有任何不可移除的业务组件；
- 「概览」只是系统面板（健康探针 + 阶段说明），不含任何业务 Widget，因此不与可定制首页竞争；
- 初始视图保持 `overview`：**实测**把它改成 `workbench` 会让每个渲染 Shell 的测试都挂载完整编辑器，
  前端测试套件耗时从 ~19s 涨到 ~58s（2 核 CI 上更糟），且未登录时首页会是「无数据的编辑器」。
  这是一个可解释的取舍，记录在此而不是静默偏离。

## D14 复核修正（阶段 04 实现后由独立验收链发现，已修）

阶段 04 的真实浏览器验收链（`tests/e2e/phase04-navigation.spec.ts`）在实现完成后发现了四个
**真实产品缺陷**。它们都不是测试问题，因此都在产品代码里修掉，并补了回归用例：

| # | 缺陷（用户可见后果） | 根因 | 修法 | 回归用例 |
|---|---|---|---|---|
| 1 | **链接编辑保存 100% 409**（连「基于最新修订保存」也无效） | 前端把**工作空间修订**当作行 CAS 基数提交，而服务端 `PATCH` 比较的是**行修订**；两者差值恒 ≥ 1 且单调不减 | 编辑草稿记录 `link.revision`；远端变化检测也改为比较**该行**修订（顺带消除了「别人改别的链接→我的草稿被标冲突」的噪音） | `apps/web/test/nav-view.spec.tsx`（改为断言行修订） |
| 2 | 被删除的目录条目在界面上显示成「尚未导入」且默认勾选（点了却什么都不会发生） | 快照 `links` 只含活跃行，而前端正是用它推算目录状态，看不到墓碑 | 服务端新增 `catalogPlan` 投影（用共享 `catalogUpgradePlan` 计算，**含墓碑行**）随快照返回；前端优先使用它 | `worker/test/nav-import.spec.ts`（#3 用例：删除后 `state === 'tombstoned'`） |
| 3 | 目录导入新建的分类分组是**空分组**（成员关系静默插 0 行） | 成员关系 INSERT 带 `JOIN workspace_nav_groups` 条件，却排在「新建分组」INSERT **之前** | 成员关系语句单独收集，排在分组 INSERT 之后入批 | `worker/test/nav-import.spec.ts`（#4 用例：断言成员关系存在且未墓碑） |
| 4 | 全部跳过的导入仍然推进工作空间水位（其它设备收到无意义信号、可能误标草稿冲突） | `bumpNavStateStatements` 无条件入批 | 只有真的写入（新增/复活链接或新建分组）时才推进，响应 `revision` 也不再假装 +1 | `worker/test/nav-import.spec.ts`（#6 用例：水位与响应 revision 都不变） |

另外修掉一处**离线能力缺口**（同一条链的实现观察 #5）：`install` 时 SW 只能预缓存非指纹资源，
`/assets/*` 带内容哈希 → 「首访后立刻离线」会白屏（外壳在、JS 不在）。
现在页面在**受控之后**把当前真实加载过的同源资源清单发给 SW（`FF14_HUB_CACHE_URLS`），
SW 逐条按**同一份**缓存策略过滤后补缓存（页面侧的过滤只是减少消息体积，SW 侧才是安全边界）。
回归用例：`apps/web/test/pwa-asset-cache.spec.ts`（含「页面报了私有 URL 也必须拒绝」）。

**测试基础设施修正**：前端与 Worker 的 vitest 单测超时从默认 5 秒放宽到 20/30 秒。
理由写进了两个配置文件：这些用例是「真实 workerd + Miniflare D1」与「整壳渲染 + 真实交互」，
在 2 核 CI runner 上会因为机器忙而**假红**，掩盖真正的回归。这不跳过断言、不放宽任何检查。

**诚实记录的未覆盖项**（浏览器链无法覆盖，由单测覆盖）：
真实目录 `source_version` 升级需要直接改库，因此浏览器链用「同一条目再次非显式导入」触发
同一份服务端决策；真实版本升级由 `worker/test/nav-catalog.spec.ts` / `nav-import.spec.ts` 覆盖。
F2 的「同断点陈旧写」用真实 HTTP 断言 409（界面路径难以稳定构造），已在 `tests/e2e/README.md` 标注。

## D15 第二轮集中复核修正（P1，已修）

独立复核在三处发现「实现能跑但语义不对」的问题，均已按根因修掉（不是测试问题）：

### D15.1 同步水位 = 数据库单调序号（替换时间戳游标）
见 D7 的重写。要点：`workspace_changes` + 触发器覆盖**所有**写路径；游标 `v2:<seq>`；
旧 `v1:<毫秒>` 游标**明确拒绝**并要求重建；每页 ≤ limit（真实工作量上限）；
payload/水位/meta 来自**同一个 D1 batch 快照**；`meta` 给出权威的工作空间级修订号。

### D15.2 导航修订号：全局与行级严格分离
- 服务端：同步响应带 `meta.navRevision`（`workspace_nav_state.revision`，与变更页同一个 batch 读出）。
- 客户端：**全局 CAS 只用 `meta.navRevision`**；行 CAS 只用各行 `revision`。
  明确禁止 `Math.max(snapshot.revision, change.revision)` 之类的推导——`change.revision` 是行修订
  （`nav_membership` 恒 0），用它推导全局修订会让本地全局修订落后，下一次重排/导入必 409。
- 回归：双浏览器 A 改动 → B 自动同步后**无需人工刷新**即可重排/导入；真并发仍 409 且草稿保留。

### D15.3 导航读路径的一致快照 + 导出引用完整性
- `readSnapshot` / `exportDocument` / `importItems` 规划 / `importCatalogEntries` 规划的
  links+groups+memberships+revision+目录(+关联墓碑行) 全部放进**一个 D1 batch** 读取，
  写入的 CAS 绑定**该快照**观察到的 revision（不再二次读取）。
- 导出：`buildNavExportDocument` 只导出**两端都活跃**的成员关系；
  `validateNavExportIntegrity` 校验「ID 唯一、membership 两端存在、URL 仍合规、数量上限」，
  导出与恢复共用同一判定。导入侧遇到不完整文档**明确拒绝**，不"跳过几条"。
- 回归：在两次读取之间插入真实 CRUD/删除（委托层），断言不会覆盖用户修改、
  不会按旧墓碑规划复活、导出的成员关系全部有两端。

### D15.4 完整导航配置 round-trip（`restore` 模式）
- 导入分两种**显式**模式：`links`（普通链接/浏览器书签）与 `restore`（本应用版本化导出文档）。
  `parseNavImportDocument` 是唯一判定入口：带 `schemaVersion` → `restore`，
  数组/`{links}` → `links`，未来版本/损坏/引用不完整 → `error`（**不降级**成 links 数组）。
- `restore` 保留全部功能字段（含 `isFavorite`/`status`/`sortOrder`/`icon`/`aliases`/`region`/
  `openMode`）与 groups、多对多 memberships、组内顺序；link/group ID **重映射**到当前工作空间
  （绝不按外部 ID 引用其他 workspace 的数据）；URL 重复的链接连同其关系逐条跳过并说明原因。
- 幂等（`operationId`）+ 工作空间 revision CAS（`expectedRevision`）。
- 回归（真实 HTTP）：A 导出 → **空 workspace B** 预览 → 确认导入 → 逐字段/逐关系相等、
  B 的设备凭证与模块个人数据未被触碰；未来版本与危险 URL 明确拒绝。
