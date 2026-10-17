# ADR-0002：阶段 02 模块运行时的关键决定

- 状态：accepted（阶段 02 / HUB-043 · HUB-044 · HUB-050 实施期记录）
- 关联：`docs/module-widget-boundaries.md`、`docs/FF14_Hub_AI_Development_Plan.md` 第 4.3 / 5.2 / 5.3 节

本 ADR 只记录**本阶段真正做出、且会影响后续阶段的选择**，以及被刻意推迟的东西。
每条都给出「为什么」和「将来在哪一步替换」，避免后续 Agent 重新争论一遍。

## D1. 表名用 `settings_version` 而不是规划里的 `config_version`

规划 5.2 把 `workspace_modules` 的设置版本列写作 `config_version`。
实际迁移（`migrations/0003_modules.sql`）使用 `settings_version`。

**原因**：已经提交并被测试锁定的契约 `ModuleManifest.settingsSchemaVersion` 用的是「settings」，
而规划正文里同时存在 Widget 的 `configSchemaVersion`。若照抄 `config_version`，
同一个概念会出现三种叫法（settingsSchemaVersion / config_version / configVersion），
后续必然出现「改了 A 忘了 B」。因此统一按「模块设置 = settings」命名，
Widget 的配置（实例级）继续叫 config。

**影响**：与规划正文的措辞有一处已知差异，已在本 ADR 与迁移注释中说明；不改动规划正文。

## D2. 状态里区分「持久状态」与「有效状态」

`workspace_modules.status` 只允许 `enabled` / `disabled` / `uninstalled`（有 CHECK 约束）。
对外的有效状态多一个 `not_installed`，它**只由行缺失派生**，永远不写进数据库。

**原因**：如果允许把 `not_installed` 写进行里，就再也分不清「从来没装过」和
「装过又手工改成未安装」；而卸载语义（保留数据、可恢复）恰恰依赖这个区别。

## D3. 乐观并发只用 `revision`，不用「比较整个状态」

所有变更都以 `UPDATE ... WHERE workspace_id = ? AND module_id = ? AND revision = ?` 提交，
受影响行数为 0 即 409。

**原因**：需要防的是**静默覆盖**（两个客户端基于同一份快照各写一次，后写者无声胜出）。
单调整数修订号是最小且可被真实并发测试验证的方案，不需要引入版本向量或 CRDT。
`expectedRevision` 必填，客户端不能「省略即覆盖」。首次变更的有效 revision 为 0。

## D4. 生命周期执行协议：**先原子准入提交状态，再执行副作用，最后收尾**

> 本条替换了本 ADR 的早期版本（两次）。第一次是「校验 → handler → 平台副作用 → 条件写库」，
> 缺陷是 CAS 输家也会执行副作用。
> 第二次是「准入 → 副作用 → 收尾」，但**没有限制并发续做**：多个重试可以同时读到 pending 并各自执行副作用，
> 且「收尾影响 0 行」被当成成功，于是旧执行者能在 restore 之后继续清理新一代的实例与任务。
> 现在改为下面的四段式，赢家与执行权都由数据库独占（不使用 isolate 内互斥——Workers 的多个 isolate 不共享内存）。

**阶段 1 · 原子准入（唯一的「可变写入」，一个 D1 batch / 一个事务）**

```
UPDATE workspace_modules
   SET status = <目标>, settings_json = ?, settings_version = ?, revision = revision + 1, ...
 WHERE workspace_id = ? AND module_id = ? AND revision = <expectedRevision>     -- 条件 CAS
   AND NOT EXISTS (SELECT 1 FROM workspace_module_operations g WHERE ...)      -- 待完成操作互斥
INSERT INTO workspace_module_operations (..., revision = <新 revision>)
  SELECT ... WHERE changes() = 1                                               -- 与 CAS 同一事务
INSERT INTO workspace_module_operation_claims (..., token = <本次执行 token>)
  SELECT ... WHERE changes() = 1                                               -- 与 CAS 同一事务
```

- `changes() = 0` 即**抢输**：立刻以 409 返回，**此时以及此后都没有任何可变副作用**。
- 待完成标记的互斥写在**条件里**（`NOT EXISTS`），不是「先插再 `DO NOTHING`」：
  否则状态 CAS 提交了、标记却被静默吞掉，就等于凭空造出「enabled 且无 pending」。
- 首次安装（行不存在）用 `INSERT ... SELECT ... WHERE NOT EXISTS ... ON CONFLICT DO NOTHING`。

**阶段 2 · 独占执行认领（`workspace_module_operation_claims`）**

续做路径必须先抢到执行 token：

```
INSERT INTO workspace_module_operation_claims (...) SELECT ... WHERE EXISTS(operations ...) ON CONFLICT DO NOTHING
   -- 0 行 → 已有执行者：若租约未过期，直接 409 operation_in_progress（零副作用）
   -- 0 行且租约已过期 → UPDATE ... SET token = <新的> WHERE expires_at <= now（原子抢占）
UPDATE workspace_module_operations SET attempts = attempts + 1, last_error = NULL WHERE changes() = 1
```

- 同一模块同一时刻只有一个 token 持有者 —— 这是「两个重试不会同时清理」的唯一依据。
- 抢占成功会让旧 token **立即失效**；旧执行者的收尾/失败记录都以 token 为条件，影响 0 行即退出。

**阶段 3 · 副作用（受 token 与 revision 双重约束）**

顺序固定：模块 handler → 移除实例 → 取消已排队任务；**每一步前后都校验执行权**。
- handler 只拿到受限上下文（见 D6）；平台清理是安全不变量，**不因 handler 失败而跳过**。
- **执行归属传到模块调度视图**：交给 handler 的 `ModuleScopedScheduler` 绑定本次执行的
  `token` + 准入 revision，并在**每一次可变调用**（`schedule` / `cancel`）前校验执行权。
  handler 可能在 `await` 中跨过租约被别的重试取代——「等 handler 返回后再查 token」无法撤销
  它内部已经造成的副作用，所以归属检查必须发生在调用点上：
  - `schedule` 以 `expectedRevision = 准入 revision` 传入管理端口：代际不匹配 → `execution_superseded`；
    新任务以该 revision 作为 `createdRevision`，**旧执行者不会把任务标成新代**；
    写入后**再校验一次**，若期间发生接管/restore，则按旧代撤销自己的插入
    （`deleteByKey({ upToRevision: 旧代 })`，绝不会删到同 key 的新代任务）。
  - `cancel` 同样带 `upToRevision = 准入 revision` 的 fence 并先校验执行权，
    因此旧 handler 删不掉 restore 之后同名的任务。
- 端口清理带 **revision fence**：`removeInstancesForModule({ maxRevision })`、
  `cancelAllForModule({ upToRevision })`、`cancel({ upToRevision })`。
  这是「租约到期 ≠ 旧执行者已停止」的应对方式——不假设 TTL 到期它就停了。
- 任一步失败：把原因写进 `last_error`（`attempts` 已在认领时递增），状态**不回滚**。
  失败后立即释放认领，客户端可以马上重试。

**阶段 4 · 收尾（必须归属同一执行者）**

```
DELETE FROM workspace_module_operations
 WHERE workspace_id = ? AND module_id = ? AND revision = <准入 revision>
   AND EXISTS (SELECT 1 FROM ...claims c WHERE c.token = <我的 token>)
```

影响 0 行**不是**成功，而是 `operation_superseded`（409）——执行权已被取代或已被别人收尾。
收尾**不**再 bump revision（见 D13）。注意 D1 的 `meta.changes` 会把级联删除的认领行也算进去，
因此该判定写的是 `>= 1`。

**失败如何对客户端表达（不允许伪装）**

副作用失败时返回 **200** + 已提交的新状态 + `effect.pending = true` + `effect.failure = 原因` +
`module.pendingOperation`。选 200 而不是 5xx 的理由很直接：状态确实已经变了，
用 5xx 会让客户端以为「什么都没发生」，而那正是本次复核要求消除的伪装。
只有**准入事务本身失败**（什么都没提交）才返回 500，此时可以安全重试。

**重试（唯一的恢复路径）与活性**

存在待完成标记时，用**同一 action + 同一 expectedRevision** 重发即可**续做**（不是重做）；
其他动作或夹带设置一律 409（`pending_conflict`），避免交错。
租约（`EXECUTION_LEASE_MS = 15s`）只解决「执行者崩溃后没人收尾」的活性问题：
到期后允许原子抢占，绝不被解读为「旧执行者已经安全停止」——安全性来自 token 与 revision fence。
模块 handler 因此必须幂等。本阶段**没有**后台自动重试、没有通用分布式任务框架、没有 Cron。

**门禁安全（为什么要 `transitioning`）**

`moduleGateStatus(status, pending)` = 有待完成操作时 `transitioning`，否则为有效状态。
它同时用于 Host（不执行组件）与调度端口（不排入后台任务），实现只有一处。
这样「执行中 / 失败待重试」绝不被当成可运行。
唯一的例外见 D15 的「初始化豁免」。

## D5. 平台级副作用不由模块代码承担

「取消已排队任务」「移除当前 Host 实例」由平台在聚合层执行，模块 handler 只做自己的事。

**原因**：如果清理依赖模块自己实现，一个写错的模块就能让停用失效（后台任务继续跑）。
平台不变量不能建立在模块代码的正确性上。演示模块的 handler 因此只做只读观察 + 结构化日志。

## D6. 模块代码只拿到受限上下文

`ModuleLifecycleContext` 只含 `workspaceId` / `moduleId` / `now` / **受限服务端口**。
**没有** D1 绑定、没有 `env`、没有请求对象、没有设备标识。

**原因**：INV 要求「声明能力不等于绕过服务端授权」。只要 handler 拿不到库句柄，
就不可能出现「模块自己绕过注册表读别人工作空间数据」的实现，而不必依赖代码评审去发现。

服务端口也不是「把平台端口直接交出去」：见 D15。

## D7. 能力采用「白名单 ∩ 授予集合」，两层都要过

Manifest 声明的能力必须同时满足：① 落在 `MODULE_CAPABILITIES` 白名单内；
② 是注册表为本模块声明授予的能力的子集。任一层不满足即**注册失败**（不是警告）。

**原因**：只校验白名单等于「模块自己说要用什么就能用什么」。多一层服务端授予集合之后，
「降低某个模块的权限」只需要改注册表，不需要改 Manifest。

## D8. 实例清理与调度都定义为**端口**，阶段 02 提供明确标注的替身实现

- `ModuleInstanceStore`：阶段 02 没有持久页面/实例表，服务端默认实现是 no-op 替身
  并自报 `persistent: false`；浏览器侧的实例表（`apps/web/.../instance-store.ts`）才是真实生效的一侧。
- `ScheduledTaskStore`：阶段 02 只有内存实现（`persistent: false`），
  阶段 05 换成 `notification_jobs` 表。

**原因**：这两件事本阶段都还不能真做，但语义必须现在就被钉住并被测试
（卸载要请求清理、停用要取消已排队任务）。端口让「语义已定、实现待换」变成可验证的事实，
而不是文档里的承诺。**本阶段不注册任何 Cron**，`wrangler.jsonc` 的 `triggers.crons` 保持为空。

注意：内存任务存储随 isolate 回收而丢失。这是**已知限制**，因此调度端口只作为语义锚点，
不能被当成真实调度系统；真实执行属于阶段 05。

## D9. purge（清数据）显式返回 501，而不是「暂时没实现所以 404」

`POST /api/v1/me/modules/:id/purge` 与 `PATCH` 里的 `action: "purge"` 都返回
`501 not_implemented` + 可读原因，并明确说明「本次请求没有删除任何数据」。

**原因**：清数据与卸载是两种语义（规划规则 7）。用一个看起来像「路径写错」的 404
会让人以为是拼写问题，而 501 + 明确文案能让「我们刻意不做」这件事被看见、被测试。

## D10. `hide` / `remove` 完全停留在客户端

隐藏与移除实例不经过任何模块 API，也不触碰 `workspace_modules`。
只有「实例存储」这一层状态变化。

**原因**：这两个操作一旦拥有服务端副作用，就会和「停用/卸载」的语义混在一起，
正是规划规则 7 禁止的混淆。相应地，界面上也把两组操作明确分开
（实例卡片内是隐藏/移除；模块卡片内是停用/卸载/恢复/清数据）。

## D11. 前端仍不引入路由

阶段 02 的验收视图切换用 Shell 内的一个 `ShellView` 状态实现，不引入 react-router。

**原因**：INV-01/INV-02 把「自由导航」和「多页面工作台」放在阶段 03–04；
现在引入路由会提前决定 URL 形状与多页面模型，而这两件事都还没被需求固定。

## D12. 组件映射与配置迁移都是静态的，未知类型一律降级

`widgetId → React 组件` 是写死的 `Record` 查找；配置迁移是每个组件显式注册的
`版本 N → N+1` 函数表。未知 widgetId / 缺少某级迁移 / 版本高于当前，全部降级为
配置错误卡片并**不执行**组件。

**原因**：禁止按不可信字符串动态加载或执行远程 JS（INV-12）。
「宁可显示配置错误，也不要拿错形状的配置去渲染」是这条禁令在客户端的具体表现。

## D13. 每次生命周期操作只 bump 一次 revision

`revision` 表示**已提交的状态/设置修订号**：准入时 +1，收尾（清除待完成标记）不再 +1。
「是否存在待完成操作」由 `pendingOperation` 字段本身表达，不占用 revision。

**原因**：若收尾也 bump，一次操作会推进两个 revision（`enable` 后直接是 2），
既让测试与客户端难以推理，也让「重试次数」间接影响 revision。
乐观并发的语义只需要保证「每次操作唯一对应一个 revision」，这一点已由准入 CAS 满足。

## D14. 待完成操作必须持久化，且「失败」是可见的一等状态

新增 `migrations/0004_module_operations.sql` 的 `workspace_module_operations`：
`(workspace_id, module_id)` 主键（同一模块同时最多一个待完成操作）、复合外键指向
`workspace_modules` 并 `ON DELETE CASCADE`、`action` / `target_status` 枚举 CHECK、
`revision`、`started_at`、`attempts`、`last_error`。

**为什么是新表而不是给 `workspace_modules` 加列**：SQLite 没有 `ADD COLUMN IF NOT EXISTS`，
加列会破坏「迁移可重复应用」这一不变量（与 0002 的处理方式一致）。

**为什么必须持久化**：Workers 的请求可能在任何时刻被打断，内存里的「正在清理」没有意义。
只有落库才能保证「失败待重试」是一个**可查询、可重试、不会丢**的事实。

## D15. 模块服务端口：**闭包绑定作用域** + **执行期能力门禁** + 受核对的初始化豁免

早期实现把带任意作用域的 `ModuleSchedulerPort` 直接交给 handler，这有两个漏洞：
handler 可以操作**别的工作空间/模块**的任务；未获得 `scheduled:own` 也能排程
（`registry.hasCapability()` 当时并未用于该端口）。

现在交给模块的是 `ModuleScopedScheduler`：

- 入参只有 `taskKey` / `runAt`（`cancel` 只有 `taskKey`），**没有** workspace/module 字段；
  实现用闭包构造委派入参，调用者多传的作用域字段被丢弃。伪造在类型上与运行时都无效。
- `schedule` 先查**注册表授予结果** `hasCapability(moduleId, 'scheduled:own')`，
  未授予直接返回 `capability_not_granted`（`declared` 不参与判定）。
- 平台清理用的是**内部管理端口**，它带任意作用域，但**绝不交给模块代码**。

**唯一的门禁豁免（初始化豁免）**：模块在自己的 enable/restore 初始化里需要登记自己的后台任务，
而此时待完成标记让它处于 `transitioning`。因此作用域视图在**同时满足**以下三条时才放行：
① 有 `scheduled:own`；② 正在执行自己的 enable/restore；③ 数据库里的待完成操作与该动作、
该 revision 完全一致。豁免通过管理端口的 `selfInit` 内部标志传递，模块拿不到管理端口，
也无法伪造数据库事实。停用/卸载的 handler **不**享有该豁免（停止过程不得再排程）。

**执行归属也绑定在这个视图上**（不只是作用域）：`schedule` / `cancel` 每次调用前都校验
「我仍是当前 token 持有者」，并把自己这一代的 revision 作为 fence 传给管理端口（见 D4 阶段 3）。
因此 handler 在 `await` 中被接管之后，它内部的任务操作一律 `execution_superseded`，
不会删掉或冒充 restore 之后的新一代任务。

## D16. 前端会话隔离：代际绑定 + 卸载即失效

凭证切换/清除后不能继续展示或修改旧工作空间的私有内容。实现：

- `SessionCredentialStore` 对外只暴露 `{ generation, authenticated }` 快照，**不含明文凭证**；
  明文只经 `get()` 交给 API 客户端内部。这样凭证不会出现在 React 的 props / state / deps
  （否则会进入 React DevTools 与组件序列化）。
- `generation` 在凭证身份**真正变化**时 +1（重复保存同一凭证不推进）。
- 会话作用域容器 `SessionWorkbench` **在整个会话期间保持挂载**，只以 `generation` 为 key：
  切换视图（概览 / 模块管理 / 组件验收 / 会话凭证）只是换展示区域，实例存储与模块状态快照都保留；
  只有凭证切换/清除才让整棵子树**同步重挂**，旧会话的私有状态、Host 实例与提示立刻消失。
- `useModuleState` 用 `mountedRef` 判定「会话是否还是我」：卸载后迟到的 GET **不写状态**，
  迟到的写返回 `{ ok: false, stale: true }`，调用方据此**跳过 Host 联动**。

## D17. Widget Host：注册表是归属权威，配置解析异常一律降级到实例

三个真实缺陷的修正：

1. **归属校验**：Host 用 `instance.moduleId` 取访问判定却用 `widgetId` 选组件条目，
   两者不一致时会出现「借启用中的 A 模块执行已停用 B 模块的组件」。
   现在最先校验 `entry.moduleId === instance.moduleId`，不一致即 `blocked:ownership`，不执行组件。
2. **解析异常**：`resolveWidgetConfig` 会调用组件注册的迁移函数（任意代码），
   而每实例的错误边界只包住 `<Component/>`。因此把「迁移/校验抛错」在 `useMemo` 内部
   catch 成本实例的配置错误，避免打穿兄弟实例与区域。
3. **attempt 隔离**：所有 `report*` 回调绑定创建时的 `retryToken`，
   旧 attempt 的迟到回调（未清理的定时器 / Promise）一律被忽略，不会改写新 attempt 的状态。

## D18. 状态读取必须是**单一 SQL 快照**

`readStatus` / `listStatuses` / 变更后的读取，以及调度门禁，全部走同一条
`workspace_modules LEFT JOIN workspace_module_operations` 查询。

**原因**：把「状态」和「是否有待完成操作」分成两次查询（即使包在 `Promise.all` 里）
会在两次读之间被一次准入切开——准入是在**同一事务**里写 status 与 pending 的，
于是组合出的快照可能是「enabled + 无 pending」，让 Host 绕过 `transitioning` 门禁。
因此本文件不再导出「单独读模块行 / 单独读操作行」的函数，避免再次拼出不一致的两次读。

同时，准入的**状态 CAS 与待完成标记互斥写在同一个条件里**（`NOT EXISTS`），
而不是「先插标记再 `ON CONFLICT DO NOTHING`」：后者会让 CAS 提交而标记被静默吞掉。

## D19. 会话容器的生命周期 = 会话代际，而不是当前视图

早期实现只在「模块管理 / 组件验收」两个视图挂载 `SessionWorkbench`，
于是切到概览或会话凭证（即使不换凭证）就会卸载它、丢掉本会话全部 Widget 实例。

现在容器**始终挂载**，只有 `generation` 变化才重挂：

- 视图切换只改变「渲染哪个面板」，实例存储、模块状态快照与提示都留在容器里；
- 凭证切换/清除推进 generation → 容器重挂 → 旧数据同步消失（见 D16）。

配置编辑器的草稿是**面板内**状态，因此面板切换会重置草稿——但已应用的实例配置在实例存储里，
不受影响（这一点有 AppShell 级交互测试覆盖）。

## D20. 前端只接受「不小于已知 revision」的写响应

`useModuleState.mutate` 在写入前比较响应的 `module.revision` 与本地已知 revision：
更小的视为过期响应，返回 `{ ok: false, stale: true }` 并**跳过 Host 联动**。

**原因**：生命周期收尾可以被重试、执行权可以被取代，旧执行者的响应可能晚到。
如果拿它去 `removeInstancesForModule`，就会删掉 restore 之后新建的实例——这正是
服务端 revision fence 在浏览器侧的对应保护。与 D18 同理：宁可丢弃一个过期响应，
也不要用过期事实修改本地状态。
