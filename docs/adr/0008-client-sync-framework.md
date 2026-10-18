# ADR 0008 — 客户端同步框架（06B：本机保险箱、协调器、受限油猴骨架）

承接 ADR 0007（06A 的鱼糕兼容、三方合并与条件式 WebDAV 协议）。06A 已经把**零件**做好并测过，
但「本地 / WebDAV / Hub 三份副本到底由谁按什么顺序推进、崩在半路怎么办」还没有落地。
本文记录 06B 的选择：把这件事收敛成**纯注入端口的协调器 + 浏览器本机保险箱 + 受限油猴骨架**，
并把所有没做到的部分明确写成未完成项。

范围限制（严格执行）：不部署、不创建远程资源、不注册 Cron、不新增 secrets；
本轮不接真实鱼糕站点存储、不做真实 WebDAV 联调、不声称已能自动同步。

## 1. 本机保险箱（`packages/fish-sync/src/vault.ts`）

- **密钥**：`AES-GCM-256`、`extractable:false`。不可导出密钥经 IndexedDB 的**结构化克隆**持久化
  （[WebCrypto 规范](https://www.w3.org/2012/webcrypto/CR-WebCryptoAPI-20141214/)本身不定义密钥存储，
  结构化克隆是可用的路径）。`ensureKey` 只做「有则返回、无则写入」：不得覆盖已有主密钥。
  跨标签页并发首次初始化时，IndexedDB 的 readwrite 事务在同一 object store 上串行化，
  因此只会写入一个候选密钥；`createClientVault` 内部对同一实例再做单飞（single-flight）。
- **AAD 绑定**：`{版本, 档案(工作空间 id / 区服 / Hub 源 / DAV 地址 / 名称), 用途, 创建时间}`。
  换工作空间、换区服、换 Hub 源、换 DAV 地址、换用途，或篡改记录头，都会解密失败**并抛错**
  （绝不静默返回 null——null 只表示「这条记录不存在」）。
- **记录**：`credentials` / `checkpoint` / `archive` 三种用途；键为 `<本机档案 id>:<用途>`，
  同一工作空间的多区服/多账号互不覆盖；列表按「工作空间 + 站点源（+ 区服）」过滤。
- **上限**：单条记录 4MiB 明文（超出直接拒绝，不加密也不写入）；本机最多 30 条记录。
- **不做什么**：不发起任何网络请求；不接触 Hub 设备 Token（协调器与面板都拿不到它）；
  不写日志/控制台；DAV 配置永不发给后端。
- **错误语义**：存储失败（读取/写入/事务回滚）与解密失败必须区分——前者原样抛出，
  后者一律「本机记录无法解密」。

## 2. 协调器（`packages/fish-sync/src/coordinator.ts`）

纯注入端口：`LocalPort`（读 + CAS 写）、`DavPort`（`readPair`/`resume`/`commit`）、
`HubPort`（`snapshot`/`preview`/`apply`）、`CheckpointStore`、`ProfileLockPort`。
凭证与设备 Token 都留在端口实现的闭包里，协调器本身看不到，因此也不可能把它们写进检查点。

不可协商的规则：

1. **三方预览**：按「基线 + 各副本字段修订号」算 `touched`，用 06A 的三方合并产出冲突列表；
   有未解决冲突就**不产生计划**，也不写任何副本。
   基线分别记录 local / WebDAV / Hub 的修订图，不比较不同副本计数器的大小。
   检查点版本为 2；早期草稿版本会被拒绝，不能默默重新开始。
   预览遇到 prepared sidecar 只报冲突，不调用恢复写入；恢复只处理本机检查点所属的事务 ID。
2. **首次同步**：没有基线时，「缺位不算分歧」——本地/DAV 的 fish.json 是完整声明（数组里没有即 false），
   Hub 只对**确实存在行**的字段有意见；两侧都有意见且不同则必须逐键显式选择副本（不是并集）。
3. **顺序固定**：WebDAV → Hub → 本地；**计划先落盘**（`planned` 检查点）再执行任何副作用，
   每个阶段之后更新检查点（`dav-committed` → `hub-applied` → 基线 + `pending:null`）。
4. **最终状态校验**：三个阶段都跑完后重读三方，要求本地文档 == 计划、DAV 是一次 `sidecarFresh`
   的一致提交且内容 == 计划、Hub 计划内字段都已成立；任一不成立都停下并保留检查点。
5. **恢复必须重读重校验**：`recover()` 不使用任何内存里的旧读数；任何一侧出现计划之外的新变化
   （本地 CAS 令牌变了、DAV 内容/ETag 变了、Hub watermark 前进了）就**硬阻塞**并保留待处理意图。
6. **丢失响应不算成功**：Hub 必须用同一 `{token, operationId}` 幂等重放取得操作回执，
   校验完整字段读集（包括未改动字段的值与修订），不能仅凭目标值相同推断提交归属。
   已提交操作可在原预览过期后重放；本地 CAS 端口须原子记录 operationId 回执才能恢复丢失响应。
   DAV 提交使用同一 operationId 作为 sidecar transactionId，并检查两个 ETag；相同内容的新事务也会阻塞。
   每次本地写入前重新校验远端，避免在 hub-applied 恢复阶段复制旧计划。传输类失败**不**标记为硬阻塞，
   因此 `recover()` 可以安全重试；只有「重试也无法自愈」的情况（预览过期、他方新改动、状态校验失败）
   才写入 `blockedReason`。
7. **最小 Hub 意图**：只发 `{fishId, field, value, expectedRevision}`；扩展字段永不出客户端；
   整批超过 200 项直接拒绝（不做部分导入）。
8. **显式处置**：待处理意图只能通过「调用方给出的 operationId 与现场一致」的
   `resolvePending(mode:'archive'|'discard')` 清除；不一致则抛 `operation-mismatch` 且检查点不变。

**已知限制**：`ProfileLockPort` 当前只有**进程内**实现（`createInMemoryProfileLock`）。
跨标签页互斥需要 [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
之类的浏览器级互斥，**尚未接入**；接入之前不得把本协调器描述成「多标签页安全的自动同步」。

## 3. 受限油猴骨架（`packages/fish-sync/src/userscript.ts`）

鱼糕站点的存储键名与读写 API **没有经过审计**，因此本轮不写任何猜测实现：
`USCRIPT_REVIEW` 的域名白名单为空、`storageAdapterAudited:false`，于是**没有任何可发布配置**。

策略（均有单测）：`@match` 只允许精确 HTTPS 主机+路径（禁通配符/http/本地回环/内网）；
`@connect` 只允许精确主机且必须在已审计白名单内（`*` 直接拒绝）；`grant` 只允许 `none`；
禁止源代码出现 `eval` / `new Function` / `document.write` / `GM_xmlhttpRequest` / `fetch` /
`XMLHttpRequest` / `unsafeWindow`；元数据里出现 `Bearer`、`token=`、`password`/`secret` 字面量一律拒绝。
没有「已审计域名 + 已审计存储端口」时，适配器是 **disabled** 的：所有方法抛错，绝不退化成猜测实现，
也不发起网络请求（单测用 stub 证明 `fetch` 未被调用）。

## 4. 受信面板（`apps/web/src/app/fish-sync/ClientVaultPanel.tsx`）

渲染在 `SyncPanel` 下方、`WidgetHost` 与模块数据端口**之外**：它不通过 `ModuleDataPort`，
只调用受信 `GET /api/v1/me/profile` 取得当前工作空间标识与区服，再用本机保险箱存取 DAV 凭证。
本阶段**不发起任何 WebDAV 网络请求**；设备 Token 仍只在会话内存中。
保存成功后立即清空口令输入；列表只展示元数据（名称/区服/DAV 地址）；
「校验可解密」只报「可解密」而**从不显示口令**；删除需要显式勾选确认。
会话隔离依赖 Shell 的 `generation` 重挂 + 面板内的「作用域发布」守卫（旧作用域的在途结果不会写入新状态）。

## 5. 复用决策（license / source / fit）

| 参考 | 来源 | 许可/性质 | 是否采用 |
| --- | --- | --- | --- |
| 不可导出 `CryptoKey` 的持久化方式 | W3C Web Cryptography API 规范 + MDN `CryptoKey`/`SubtleCrypto` 文档 | 规范/文档（仅阅读） | 采用其结论（结构化克隆），**未复制代码** |
| 跨标签页互斥 | [MDN Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) | 文档（仅阅读） | **未采用**（仅记录为后续方案；本轮只有进程内锁） |
| `@connect` / `@match` 元数据语义 | [Tampermonkey 文档](https://www.tampermonkey.net/documentation.php) | 文档（仅阅读） | 采用其语义构造**更严格**的白名单校验 |
| 条件式 WebDAV 客户端 | 见 ADR 0007 | — | 继续复用 06A 自研适配器，不引入第三方 DAV 依赖 |

本轮**没有新增任何第三方依赖**（仅把工作区内的 `@ff14-hub/fish-sync` 直接声明为 `apps/web` 的依赖，
以便前台引用本机保险箱模块）。因此没有新的许可义务。

名称、DAV 地址和作用域标识是 IndexedDB 中可读的档案元数据；账号、口令和检查点正文为密文。
不可导出密钥不阻止同源 JavaScript 调用解密；本机保险箱不提供对恶意同源脚本的隔离。
油猴源码正则检查只辅助人工审计，不是 JavaScript 沙箱，也不能代替真实站点源码审计。

## 6. 明确未完成（不要解读为已完成）

- 真实鱼糕站点存储适配（键名/API 审计）与可发布的油猴脚本。
- 真实 WebDAV 服务端联调（本轮只用内存假服务器 + 06A 的协议单测）。
- `coordinator` 的**活体**接入：网页目前只用保险箱面板与 06A 的显式导入预览；
  协调器已实现并有单测，但尚未与真实三副本串起来，也**没有**任何自动/后台同步。
- 跨标签页互斥（Web Locks）、真实鱼类数据集与模板内容。
