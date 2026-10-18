# ADR-0003：阶段 03 自定义工作台的关键决定

- 状态：accepted（阶段 03 / HUB-045 · HUB-046 · HUB-049 · HUB-054 实施期记录）
- 关联：`docs/FF14_Hub_AI_Development_Plan.md` 第 2.2 / 5.2 / 5.3 / 9.1 节、`docs/module-widget-boundaries.md`、`docs/adr/0002-phase02-module-runtime.md`

本 ADR 只记录**本阶段真正做出、且会影响后续阶段的选择**，以及被刻意推迟的东西。
每条都给出「为什么」与「将来在哪一步替换」，避免后续 Agent 重新争论一遍。

## D1. 布局修订放在「页面 × 断点」，不放在 `workspace_pages.layout_revision`

规划 5.2 把 `layout_revision` 写在 `workspace_pages` 上。实际实现新增了独立表
`page_layout_revisions (page_id, breakpoint, revision)`，`workspace_pages` 只保留**页面级** revision。

**原因**：规划 ADR-010 要求「桌面/平板/手机各自独立修订」，而单列 `layout_revision` 无法表达这一点：
手机端保存布局会把同一列 +1，于是桌面端在途的保存会莫名其妙 409——正是 ADR-010 想避免的跨端误覆盖。
拆表后，保存手机布局只 bump `mobile` 行，桌面端的 `baseRevision` 仍然有效。

**顺带说明**：另有一张 `workspace_workbench_state(workspace_id, revision)`，
它是**工作台整体**的修订号，只服务两个具体用途：导入预览的新鲜度令牌、前端「工作台有没有变」的便宜信号。
它与断点级并发是两件事，因此没有合并。

## D2. 幂等用「本次尝试随机 token」守卫，不用 `changes() = 1` 链

所有写入都是「认领（`INSERT INTO workbench_operations ... ON CONFLICT DO NOTHING`）→ 变更 → 收尾」
同一个 D1 batch。每条变更语句都带守卫：

```sql
EXISTS (SELECT 1 FROM workbench_operations g
         WHERE g.workspace_id = ? AND g.operation_id = ? AND g.attempt_token = ?)
```

**为什么不用 `changes() = 1` 链**（阶段 02 的写法）：`changes()` 只反映**紧邻的上一条语句**，
而工作台里有大量「可能影响 0 行」的语句（清掉旧默认页、删除不存在的布局行）。
一旦中间某条影响 0 行，后续语句就会被误跳过——这类 bug 只在特定布局下出现，极难发现。
token 守卫与语句影响行数**无关**，因此不存在这个失效模式。

**语义收口**：
- **幂等短路必须发生在任何前置读取之前**。各写入方法会先读状态并做新鲜度判断
  （布局的 `baseRevision`、页面的 `expectedRevision`、实例的 `revision`）；
  首次提交成功后这些前置条件**必然已经变化**。如果先做前置检查，那么
  「响应丢失后客户端原样重试」——幂等最该生效的那个场景——会被早退成 409/404，
  客户端永远拿不到首次结果。因此每个写入方法的**第一条语句**就是
  `readWorkbenchReplay()`：命中了就直接返回首次结果，一个字节都不写。
  （这是阶段 03 复核阶段发现并修掉的真实缺陷，有 `page.delete` 与 `saveLayout` 的回归用例。）
- 重放（同一 `operationId` 重试）在认领语句处也会生成**新的**随机 token，
  永远不等于已存行的 token（收尾时已置空），因此即便短路未命中，重放也不会再次施加副作用。
- 并发抢输的一方因 `ON CONFLICT DO NOTHING` 未插入自己的 token，其全部语句同样不生效；
  它随后读到已存在的行，按「重放」返回同一结果。
- 同一 `operationId` 用于**不同类别**（`kind`）返回 409，不静默当重放放行——那是客户端 bug 或探测行为。
  类别字符串集中定义在 `WORKBENCH_OP_KINDS`，避免「入口检查」与「认领写入」两处字面量漂移
  （漂移的后果正是把重放误判成类别冲突）。
- batch 是原子的，因此「已认领但未收尾」在事务外不可观测，不需要额外的崩溃恢复流程。

## D3. 页面删除只墓碑页面本身，实例与布局保留

`workspace_pages.deleted_at` 非空即墓碑。删除页面时**不**动 `widget_instances` 与 `widget_layouts`。

**原因**：需求要求「删除/恢复」有明确行为且可撤销。如果删除页面时把实例也墓碑化，
恢复页面就只能恢复一个空壳；而「清空所有业务组件」与「删除页面」是两种不同的用户意图。
保留实例后，`POST /me/pages/:id/restore` 能把页面**连同内容**整体带回来。

**边界**：活跃实例的判定一律要 JOIN 到活跃页面（`p.deleted_at IS NULL`），
因此墓碑页面上的实例永远不占配额、不参与单例判定、也不出现在任何响应里。

## D4. 「有活跃页面时唯一默认页」由数据库 + 事务共同保证

- **数据库**：部分唯一索引 `idx_workspace_pages_single_default`
  （`WHERE is_default = 1 AND deleted_at IS NULL`）保证活跃页面中默认页**至多一个**。
  任何绕过服务层的写入（导入、手工 SQL）都撞得上。
- **事务**：SQLite 无法声明式表达「集合非空时**恰好**一个」，因此任何改变活跃页面集合的写入
  （新建 / 删除 / 恢复 / 应用模板）都在**同一个 batch** 内重新推导默认页：
  `rederiveDefaultPageStatement` **仅在当前没有默认页时**把 sort_order 最小的活跃页面设为默认。

**为什么「仅在缺失时」**：否则每次删除页面都会把默认页重设成「sort_order 最小者」，
等于悄悄改掉用户选的默认页。

**明确拒绝**：`PATCH {isDefault:false}` 作用于当前默认页返回 422，而不是留下「一个默认页都没有」的状态。

## D5. 新建实例必须同时满足三条原子条件；编辑只受 `transitioning` 限制

新建实例（含复制、模板、导入）在认领语句里同时要求：

1. 页面属于本工作空间且未删除；
2. 该模块 `status = 'enabled'` **且** `revision` 等于本次读取到的值；
3. 该模块**没有**待完成操作（`transitioning` 门禁）。

**为什么连 revision 一起比**：新实例要记录 `created_revision` 作为生命周期清理的 fence。
只有把「登记的代际」与「准入时的代际」绑成同一个原子条件，
「记录的代际」才不可能是一个被并发改写过的值。不一致时返回 409，客户端重新读取即可。

**为什么编辑（改配置 / 隐藏 / 移除）只要求「没有待完成操作」**：
停用或卸载模块后，其既有实例是被**保留**的（模块语义：停用 ≠ 删数据）。
此时编辑配置不产生任何执行，因此不该被禁止；但正在 `transitioning` 时不写，
避免与「即将清理这批实例」的操作互相踩。新增实例则必须 enabled：界面会引导先启用模块。

## D6. 单例约束（`allowMultiple = false`）的作用域是「整个工作空间」

不是「单个页面」。`demo-solo` 之类的单例组件在一个工作空间内最多一个活跃实例，
判定发生在认领语句里（跨活跃页面的 `NOT EXISTS`），因此并发添加也只会成功一次。

## D7. 整页保存：矩形集合必须**恰好**覆盖该页面的全部活跃实例

`PUT /me/pages/:id/layout` 只保存**一个断点**，但该断点的矩形必须覆盖该页面全部活跃实例。

**原因**：允许部分提交就会产生「有实例、但某个断点下没有位置」的半状态，
那正是「静默丢布局」的来源。缺少某个实例的矩形时返回 422 而不是补一个默认位置——
服务端**只拒绝非法输入，不替用户悄悄改布局**。

## D8. 布局合法性只有一个判定实现

`packages/shared/src/workbench-api.ts` 的 `validateLayoutRects()` 是**唯一**实现，
服务端保存路径与导入路径都调用它；规则是：实例归属正确、坐标非负、
`x + w <= 列数`、尺寸落在静态注册表的 `minSize`/`maxSize` 内、任意两项不重叠。

**为什么放共享包**：前端键盘替代操作要在按钮禁用状态上做出与后端一致的判断
（否则会出现「按钮可点但保存被拒」）。同一份纯函数让两侧不可能漂移。
服务端的尺寸约束一律取自 `registry.findWidget()`，**不接受**客户端提交的约束。

## D9. 导入时**总是**重新分配 ID 与 slug

备份里的页面 ID、实例 ID 与页面 slug 都只用于文档内部一致性检查
（同一份备份内重复页面/实例 ID 属于致命问题）。落地时一律重新分配。

**为什么 ID 重映射**：这是杜绝「借备份 ID 引用别人的数据」的最简形式——
结构上不存在「按备份里的 ID 去匹配现有行」的路径，因此也就不存在跨工作空间引用的可能。

**为什么 slug 也必须重映射**：`idx_workspace_pages_slug` 是覆盖**全部行（含墓碑）**的唯一索引
（这样「恢复已删除页面」永远不会与新页面撞 slug）。因此备份里的 slug 在同一个工作空间里
几乎总是已被占用——把导出导回原地时**必然**如此。原样写入会撞唯一索引并让整个导入事务回滚，
表现为 500 而不是可解释结果。`pickUniqueSlug` 由新建页面、模板重置与导入共同使用，
避免两套 slug 逻辑漂移。

代价：同一工作空间的 round-trip 在 ID 与 slug 上不等价（结构、名称、配置、各断点矩形等价）。
这一点在幂等键、导入预览与文档里都写明了，避免被误读为「原样还原」。

## D10. 模块未启用 / 未知模块：**跳过并如实上报**，绝不隐式启用

模板与导入都遵守同一条规则：

- 组件类型未注册（静态注册表里没有）→ 导入视为**致命问题**（`unknown_widget_type`），整份文档不可导入；
  模板里则由契约保证不会出现（有测试）。
- 组件类型已注册但所属模块不是 `enabled`（含 `transitioning`）→ **跳过该实例**，
  在预览的 `unknownModules` 与 `instancesSkipped`、以及应用结果的 `skipped` 里逐条列出原因。
- 导入路径**不触碰** `workspace_modules`：不启用、不停用、不卸载、不删个人数据（有测试直接断言字节不变）。
- 组件归属以**静态注册表**为权威：备份里声明的 `moduleId` 与注册表不一致时以注册表为准并给出警告，
  因此「借启用 A 去渲染停用 B」在结构上不可能。

## D11. 备份容量上限由导出与导入**共用**一个常量

`WORKBENCH_BACKUP_MAX_BYTES = 48 KiB`，严格小于全局 `MAX_JSON_BODY_BYTES = 64 KiB`。

- 导出在序列化后超过该上限时**显式失败**（`export_too_large` + 可读原因），
  绝不产出一个永远导不回来的文件。
- 导入超过同一上限时同样显式拒绝。

因此「导出大于导入上限」这种自相矛盾的设计在结构上不成立，并有测试断言这一关系。

**真实边界（不隐瞒）**：上限是 48 KiB，因此一个塞满 30 页 × 40 个组件、且每个组件配置接近 4 KiB 的
工作台**无法导出**。届时用户会收到明确失败信息，而不是一个损坏的文件。
把上限提高需要同时提高全局请求体上限并重新评估 D1 参数上限，属于后续工作。

## D12. 重新分配 ID + 事务内先写备份：`replace` 导入是可撤销的

`replace` 模式在**同一个事务**里：写一份 `kind='pre_import'` 的当前快照 → 墓碑化当前活跃页面 →
按备份内容重建页面与实例。

- 因此不存在「备份写成功但替换失败」或反过来的中间状态。
- 事后可 `POST /me/workbench/backup/:id/restore` 回到导入前；恢复后把该备份标记为 `consumed_at`，
  防止同一个撤销点被重复套用。
- 每个工作空间保留最近 5 份备份（服务层裁剪，同一事务内）。

## D13. 布局编辑器依赖锁定 `react-grid-layout@2.3.0`

| 检查项 | 实际结果 |
|---|---|
| 官方当前版本 | `2.3.0`（npm `time.modified` 2026-10-05） |
| peer 依赖 | `react >= 16.3.0`、`react-dom >= 16.3.0` → 与仓库锁定的 React **19.3.1** 兼容 |
| 类型 | 2.x 自带 `dist/index.d.ts` / `.d.mts`，**不装** `@types/react-grid-layout`（该包只到 2.1.0，形状对应旧 API） |
| 模块格式 | ESM（`dist/index.mjs`）+ exports 映射（含 `./css/styles.css`）→ 与 Vite 8 的 ESM 解析一致 |
| React 19 的 `findDOMNode` 移除 | 2.x 通过 `nodeRef` / `useContainerWidth` 驱动，实际解析到 `react-draggable@4.7.2`、`react-resizable@3.2.0`（均声明 React 19 可用）；真实浏览器拖动/缩放由 Playwright 链验证 |
| 样式 | 只需 `import 'react-grid-layout/css/styles.css'`：它已包含 resize handle 的全部样式，**不需要** `react-resizable/css/styles.css`（3.2.0 不再提供该文件） |

**为什么不在 1.x**：1.x 依赖 `ReactDOM.findDOMNode`，该 API 在 React 19 已移除；
2.x 是围绕 React 19 重写的一代（提供 `useContainerWidth` / `useGridLayout` 钩子替代 `WidthProvider` HOC）。

**边界**：只是**布局容器**。组件仍然只来自 `apps/web/src/app/widgets/component-registry.ts`
的静态映射，绝不按不可信字符串动态加载，也不执行任何第三方 JS。

## D14. 生命周期实例清理端口改为真实 D1 实现

阶段 02 的 `createNoopInstanceStore()`（`persistent: false`，`removed: 0`）被
`worker/modules/workbench/instance-store.ts` 的 `createD1InstanceStore()` 取代
（`persistent: true`），并在 `worker/modules/runtime.ts` 装配。

- **三条件同一原子条件**：`UPDATE widget_instances ... WHERE workspace_id = ? AND module_id = ?
  AND deleted_at IS NULL AND created_revision <= ?`。
  因此不存在「先按模块查出来、再按 revision 过滤」的时间窗。
- **实例墓碑，布局硬删除**：实例墓碑是权威记录（卸载 ≠ 删数据，也让后续同步能观察到变化）；
  已墓碑的实例不该再占网格位置，因此其 `widget_layouts` 行被删除，
  同时把受影响页面的三个断点修订号 +1，客户端据此知道布局变了。
- **旧代 fence**：`created_revision` 由写入路径记录。被取代的旧执行者传入它自己的准入 revision，
  因此删不掉 `restore` 之后（代际更大）创建的实例。有真实 D1 测试覆盖该交错。
- 清理在同一 `db.batch()` 事务内完成，并把工作台级修订号 +1（卸载确实改变了工作台）。

## D15. `reset_workspace` 只墓碑页面（与 D3 一致），彻底清空走导入替换

模板的 `reset_workspace` 模式墓碑化当前全部活跃页面，然后按模板重建页面。
它**不**删除实例与布局，因此逐页 `restore` 仍能把内容带回来。

**理由**：与 D3 保持同一套语义（删除页面 ≠ 删数据），也让「重置」不需要额外的备份机制就已是可逆的。
需要「彻底清空、不保留任何旧组件」的用户应走 `replace` 导入（那条路径会先自动写可撤销备份）。
界面上重置与替换导入都必须显式确认，并提示可先导出备份。

## D17. 复核修复（集中复核后的一轮加固）

集中复核在阶段 03 的实现里发现六处语义缺口。以下逐条记录**修了什么、为什么这样修**，
避免后续 Agent 把它们当成「可选优化」再改回去。

### D17.1 并发新增/复制的空位必须与「规划时看到的矩形集合」绑定

**缺陷**：`addWidget` / `duplicateWidget` 先用 `existingRects` 规划空位，再提交；认领语句只校验
「页面活跃 + 模块门禁 + 实例数上限 + 单例」。两个**不同** `operationId` 的并发请求可以各自读到同一份
矩形、各自选中同一个空位、都提交成功——形成服务端本应拒绝的重叠。

**修复**：规划依据改为**单一一致快照**——`readPlanningSnapshot` 把
「页面 + 活跃实例集合 + 矩形 + 三个断点修订号」四条 SELECT 放进**同一个 `db.batch`**（同一事务），
因此不可能出现「按旧矩形规划、却拿到新 revision」的组合。规划时读到的三个 revision
再与 `COUNT(活跃实例)=观察值` 一起进入**同一条认领语句**，任何并发新增/移除/整页保存都会让其中一个条件不成立 → 409。
`explain` 会进一步区分「布局修订号变了」(`layout_revision_conflict`) 与一般冲突。
模板的 `replace_page` 也一起检查：它原本用「预读 revision + 1」写绝对值，预读过期会让客户端的
revision 倒退，已改为 SQL 侧的 `+1`（`bumpLayoutRevisionStatements`），不再依赖任何预读。

**为什么不是「在事务内重新规划」**：D1 的 batch 只能执行 SQL，不能运行规划逻辑；
用「同一快照 + 观察值等值」把规划的前提条件带进事务是同一语义的最小实现。
独立断点的 `saveLayout` 语义不变（它本来就以 `baseRevision` 做等值校验）。

**回归**：`worker/test/workbench-interleaving.spec.ts` 用一个真实 D1 委托层，
在第一次 batch（规划快照）之前插入 `saveLayout`（把实例从 x0 挪到 x4 并升 revision），
断言「注入确实发生」+「规划读取**没有**被逐条直接执行（是单 batch）」+「结果两两不重叠」；
旧实现会在该交错下提交出重叠。

### D17.2 导出必须来自一致快照

**缺陷**：`buildDocument` 分多次 SELECT 读页面/实例/布局，可能导出「页面已删但布局还在」
这类不可恢复的混合态。

**修复**：四条 SELECT（页面、实例、布局、工作台 revision）放进**同一个 `db.batch`**——D1 的 batch
是单个事务，因此必然同一时刻。导出结果还会用 `workbenchBackupDocumentSchema` 反校验一次；
不合格就返回 `export_inconsistent` 而**不**产出文件。

### D17.3 撤销点的消费与替换必须同事务

**缺陷**：`restoreBackup` 先提交替换、再单独 `UPDATE consumed_at`。两个不同 `operationId`
可以在标记前连续套用同一份撤销点；中途失败还会留下「已恢复但未消费」。

**修复**：把「未消费校验」放进认领前置条件、把「标记消费」作为**同批语句**，与页面替换一起提交。
对外语义：
- 同一 `operationId` 重试 → 返回首次结果（`replayed: true`），不再写库；
- 另一 `operationId` 用已消费的备份 → 409 `backup_consumed`；
- 恢复必须带 `expectedRevision`（用户在界面上看到的工作台 revision），
  与工作台 revision 不等 → 409 `backup_revision_conflict`，且**不会**消费该备份。

### D17.4 导入确认必须绑定「预览时算出的计划」

**缺陷**：`previewRevision` 只覆盖 `workspace_workbench_state`，而模块的 enable/disable/uninstall
未必改变它；`apply` 时重新 `analyze`/`planImport` 还可能改变「哪些实例被跳过」。
于是用户确认的预览与实际替换可以不同。

**修复**：预览返回 `previewToken`（SHA-256），绑定
`document + mode + 工作台 revision + 每个相关模块的门禁状态与 revision`。
应用时必须原样回显并**先重算再比对**，任何一项变化 → 409 `import_preview_stale` 且零写入；
同时认领语句里用 `moduleGateSnapshotConditions` 把**所有相关模块**的观察值原样钉成原子前置条件：
`not_installed` → 该行必须仍缺失；`enabled`/`disabled`/`uninstalled` → 状态与 revision 必须一致且无待完成操作；
`transitioning` → revision 一致且仍有待完成操作。

**为什么必须覆盖「被跳过的模块」**：只绑定「会被写入的模块」时，
一个在预览里被跳过（disabled / not_installed）的模块若在 token 校验之后、认领之前被启用，
事务就拦不住——那会绕过「所有相关门禁变化都要重新预览」的承诺。现在它同样 409。
这些条件**只读**模块状态，不会启用/停用任何模块；恢复备份不使用该令牌
（内容是服务端自己写下的快照），由 `expectedRevision` + 未消费语义承担。

**回归**：`worker/test/workbench-interleaving.spec.ts` 在「token 已校验、认领批次尚未执行」的窗口里
启用被跳过的模块，断言 409 + 零写入（页面/实例/幂等记录都不变），随后重新预览即可正常导入。

### D17.5 幂等键必须绑定请求意图

**缺陷**：幂等只按 `(workspace, operationId, kind)` 判定。于是 `page.update` 对不同页、
`layout.save` 对不同页的同一断点、以及「同一个 operationId 换一份 body」都会被当成重放返回旧结果。

**修复**：新增 `request_fingerprint`（SHA-256，覆盖目标 ID / 动作 / 正文 / 预期 revision / 断点），
入口短路与事务冲突路径使用**同一条**判据：
完全相同的请求 → 返回首次结果；指纹不同 → 409 `operation_payload_mismatch` 且零写入。

**存储位置**：单独一张 `workbench_operation_intents` 表，而不是给 `workbench_operations` 加列。
原因见 D17.7。两份记录在同一个 batch 写入，因此不存在「有结果没指纹」的持久半状态；
早期版本写入的行没有指纹，按「无法判定」保守处理（要求换新 operationId，不返回旧结果）。

### D17.6 清理必须幂等：只推进「本次真正移除」的页面

**缺陷**：`removeInstancesForModule` 的「删除布局行 / 补断点修订行 / bump 页面 revision /
bump 工作台 revision」按**所有历史墓碑**过滤。于是「0 个新增墓碑」的重试也会再推一轮 revision，
让 restore 之后的新布局草稿无端 409，清理本身也不幂等。

**修复**：每次调用生成随机 `cleanupToken`，先把「本次将要墓碑化的实例」（与墓碑 UPDATE
**完全相同的条件**、同一事务）写进 `widget_cleanup_marks`，后续所有语句都以该 token 过滤。
0 个新增 → 后续语句全部 0 行 → **零 revision 变更**。刻意不用时间戳猜「本次」：
同毫秒内的两次调用无法区分。标记表在事务末尾按 token 清理，不会无限增长。

### D17.7 迁移只用 `CREATE ... IF NOT EXISTS`（不用 `ADD COLUMN`）

上面两处都需要「给既有表加字段」，但 SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，
而本仓库的验收点（HUB-003）与测试都要求**迁移语句可逐条重放**。
因此改用两张**只增不改**的配套表（`workbench_operation_intents`、`widget_cleanup_marks`）：
语义等价、天然幂等，也不改动既有表结构。

### D17.8 安全静态分析（SonarCloud）的实际问题与结果

**修复前**：质量门失败，失败条件为 `C Security Rating on New Code (required ≥ A)`，
另有 `D Reliability` 与「Duplication on New Code 3.7% > 3%」。

**逐条修复**：

1. `Math.random` 曾被用作 `operationId` 的前端兜底生成器（弱随机，S2245）。
   已彻底移除：只用 `crypto.randomUUID()` / `crypto.getRandomValues()`，
   两者都不可用时**抛错**而不是降级到弱随机。
2. `pickUniqueSlug` 里的 `/^-+|-+$/g` 属于「两侧锚点 + 量词 + 全局」写法，会对每个起始位置重试
   （超线性回溯，S5852）。已替换为一次线性扫描的 `stripEdgeDashes`，行为等价且 O(n)。
3. 测试里存在把变量拼进 `env.DB.prepare(...)` 文本的写法（S3649 SQL 注入面）：
   `SELECT COUNT(*) FROM ${table}`、`CREATE/DROP TRIGGER ... ${name}`。
   已改为**编译期常量表**（`COUNT_ROWS_SQL` 的键就是 `CountableTable` 联合类型）与**字面量 SQL**，
   拼接面彻底消失。
4. CI 的 `uses:` 由 tag 改为**完整 commit SHA**（第三方 Action 必须可固定到不可变对象）。
5. 脚本里 `spawn('taskkill', …)` 改为绝对路径调用，不再通过 PATH 解析可执行文件。
6. `[...moduleIds].sort()` 改为显式 `localeCompare` 比较器（默认排序按 UTF-16 码元，
   对「字母序」不可靠；这里还需要跨请求可复现的顺序来生成预览令牌）。
7. 重复代码（>3% 门限）：把 `opId` / `seedAuth` / `errorBodyOf` 从 7 个 worker spec 抽到
   `worker/test/helpers.ts`；把 `DESCRIPTORS` / `page()` / `instance()` 从两个前端 spec 抽到
   `apps/web/test/workbench-fixtures.ts`；顺带拆分了 `validateLayoutRects`、`analyze`、
   `applyDocument` 三个认知复杂度超标的函数（只做结构拆分，不改行为）。

**修复后（最终 head）**：SonarCloud 质量门 **pass**——`0 Security Hotspots`、
`2.9% Duplication on New Code`（≤3%）、Security/Reliability 均达到 A。
剩余 29 条为**非阻断**的维护性告警；其中 `applyTemplate` 的认知复杂度 21 仍未拆，
它是 maintainability 而不是质量门条件，已如实记录，不为压指标大改。


## D16. 明确推迟的东西（不要读成已实现）

- **不实现跨设备增量同步**（HUB-051）：墓碑已按规划 5.3 保留，但没有同步水位、没有 GC、
  没有 `GET /me/sync/changes`。墓碑保留策略与垃圾回收属于阶段 04/06。
- **不实现清数据（purge）**：仍然是显式 501。
- **不做 WebDAV、通知、Cron、远程部署**：`triggers.crons` 仍为空，未创建任何远程资源。
- **不做布局草稿的服务端存储**：草稿只存在于前端内存；服务端只接受整页保存。
- **不提供「导出全量个人业务数据」**：HUB-054 只覆盖工作台配置，不冒充阶段 06 的能力。

## D13.1 拖动把手：`threshold` 锁定 0，且子元素必须转发注入的事件处理器

阶段 03 的前端工作台在真实浏览器（Edge + 真实 `wrangler dev`）里出现过一次**静默失效**：
按住拖动把手移动 180×60 像素，卡片完全没有反应——类名里始终没有 `react-draggable-dragging`，
`transform` 停在原值，`data-dirty` 一直是 `false`，浏览器**没有**任何 console error 或 pageerror。
同一张卡片的**缩放手柄**（右下角 `.react-resizable-handle-se`）却工作正常。

排查后确认是**两个独立原因叠加**，两条都必须记住：

### (1) 根因：组件型子元素没有转发 `onMouseDown`（这条是决定性的）

`react-grid-layout@2.3.0` 的 `GridItem` 用 `DraggableCore` 包住 `children`，而
`DraggableCore` 的拖动入口是一个 **React 属性**：
`React.cloneElement(child, { onMouseDown, onMouseUp, onTouchEnd })`。
`handle` / `nodeRef` / `disabled` 都传得没错，但只有这三个属性真的落在 **DOM 节点**上，
`react-draggable` 的 `handleDragStart` 才会被调用，`handle` 选择器才会被匹配。

工作台的卡片是**组件**（`WidgetCard`，`forwardRef` 到 `<article>`）。它最初只把
`className` / `style` / `ref` / `children` 透传下去，**漏了 `onMouseDown`**，
于是 RGL 注入的拖动入口被组件丢掉了：mousedown 到了 DOM，但没有任何拖动处理器接收。

证据（在真实浏览器里给 `Element.prototype.matches` 插桩，`react-draggable` 正是用它做把手匹配）：

| 观察点 | 修复前 | 修复后 |
|---|---|---|
| mousedown 目标 | 把手内部的 `<span>`（命中正确） | 同左 |
| `Element.matches` 调用次数 | **0**（`handleDragStart` 根本没进） | 正常出现并返回 `true` |
| `react-draggable-dragging` | 不出现 | 出现 |
| `transform` | 不变 | `translate(...)` 随拖动变化 |
| `data-dirty` | `false` | `true`（草稿链路打通） |

**结论**：RGL 的「子元素」如果是组件，必须把 `onMouseDown` / `onMouseUp` / `onTouchEnd`
原样转发到它的根 DOM 节点（见 `apps/web/src/app/workbench/WidgetCard.tsx` 里
`onMouseDown` 的注释）。缩放不受影响，因为那个手柄是 `react-resizable` 自己创建并直接
绑定 ref 的 `<span>`，中间没有组件边界——这也是为什么「只有拖动坏、缩放好」很有迷惑性。

### (2) 同时锁定 `dragConfig.threshold = 0`

`GridItemInner` 在 `dragThreshold > 0` 时**不在 mousedown 阶段调用 `onDragStart`**，
而是先挂起（`dragPendingRef` / `thresholdExceededRef`），等第一次 `onDrag` 的位移越过阈值
再补发开始。这条分支在 `noCompactor` 组合下额外引入风险，也让「按下即生效」的语义变复杂。
真实浏览器对照：`threshold: 0` 时拖动把手、从卡片正文拖动（对照，验证 `handle` 仍然生效）、
缩放三条路径全部正常；`threshold: 3` 时（在 (1) 修复之前）拖动完全不动。

因此工作台**显式使用 `threshold: 0`**（`apps/web/src/app/workbench/LayoutGrid.tsx`）。
注意因果：**真正让拖动失效的是 (1)**；(2) 是消除一条不必要分支的防御性选择。
若将来升级 `react-grid-layout`，必须重新验证本节两条并更新此处。

### 顺带记录：受控布局的引用稳定性

`layouts` 是受控 prop。若每次渲染都新建对象字面量（或复制数组），RGL 每轮都会做一次
「props 布局 ↔ 内部布局」同步；与 `autoSize` 的高度测量叠加后，会表现为网格高度与
下方面板位置持续微动（元素「永远不稳定」）。工作台因此在 `WorkbenchView` / `LayoutGrid`
里保证 `layouts` 与 `instances` 的**引用稳定**，只在真正变化时替换。

### 顺带记录：进入编辑模式时把网格带进视野

工作台视图上方还有页面管理与工具栏，在 720px 高的窗口里网格可能落在折叠线以下，
而「进入编辑模式」的意图就是改布局。因此进入编辑模式时会 `scrollIntoView` 到网格
（`WorkbenchView` 的 effect）。这不是测试便利，而是可达性处理：否则用户（以及任何基于
真实鼠标坐标的自动化）会按在空白处而以为「拖不动」。
