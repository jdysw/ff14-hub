# Module / Widget 边界说明

本文件固定 Module 与 Widget 的接入边界，并记录**每个阶段实际落地了什么**。
「阶段 01 只落地契约」是当时的计划，现在（阶段 02）注册表、Widget Host 与生命周期已经实现，
因此下面按事实更新，而不是保留旧描述。

## 1. 阶段 01 已经落地了什么（回顾）

| 已落地 | 位置 | 说明 |
|---|---|---|
| Manifest / Widget Schema 与校验 | `packages/shared/src/module-manifest.ts` | Zod 契约 + `validateModuleManifest()`，能力白名单默认拒绝 |
| 生命周期操作语义表 | 同上 `MODULE_OPERATION_SEMANTICS` | 五种操作对「页面 / 后台 / 数据」的影响被写成常量并被测试断言 |
| 断点与列数基线 | 同上 `LAYOUT_BREAKPOINTS` / `BREAKPOINT_COLUMNS` | 桌面 12 / 平板 8 / 手机 4，各断点独立 |
| 系统级入口常驻 | `apps/web/src/app/shell/SystemBar.tsx` | 工作台切换、组件库、模块管理、设置、导入恢复、设备管理永久保留 |
| 单工作空间设备身份 | `worker/modules/identity/`、`migrations/0001..0002` | 原子配对、每设备独立凭证、立即撤销、恢复 |

## 2. 阶段 02 已经落地了什么（HUB-043 / HUB-044 / HUB-050）

| 已落地 | 位置 | 说明 |
|---|---|---|
| Module Registry（静态注册与发现） | `worker/modules/registry/module-registry.ts` | Zod 校验、唯一 module/widget/route、能力白名单 ∩ 授予集合、handler 必须存在于静态表；失败给诊断码，启动期即失败 |
| 内置演示模块定义 | `packages/shared/src/builtin-modules.ts` | `demo.basics` / `demo.solo`，**明确标注无游戏业务语义** |
| 服务端静态 handler 表与模块 Settings Schema | `worker/modules/registry/builtin-modules.ts` | handler 只拿到受限上下文，拿不到 D1 与设备 Token |
| 公开模块目录 | `GET /api/v1/modules/catalog`（`worker/api/v1/modules.ts`） | 匿名可读，只含非敏感元数据；**不含** handler 名与个人状态 |
| 模块状态与生命周期契约 | `GET/PATCH /api/v1/me/modules`、`POST /api/v1/me/modules/:id/purge`（`worker/api/v1/me-modules.ts`） | 设备鉴权；`expectedRevision` 必填；purge **显式拒绝**（501） |
| 持久状态与迁移 | `migrations/0003_modules.sql`、`migrations/0004_module_operations.sql`、`worker/db/schema.ts` | `workspace_modules`（状态 CHECK、settings/版本、`revision` 乐观并发）+ `workspace_module_operations`（待完成操作的持久事实） |
| 生命周期服务 | `worker/modules/lifecycle/module-lifecycle.ts` | **先原子准入提交状态** → 副作用 → 收尾；待完成操作可重试（见 4.3） |
| 生命周期端口 | `worker/modules/ports.ts`、`worker/modules/lifecycle/scheduler.ts` | 交给模块的是**闭包绑定作用域 + 能力门禁**的 `ModuleScopedScheduler`；管理端口只留在平台 |
| 门禁状态 | `packages/shared` 的 `moduleGateStatus()` | 存在待完成操作 → `transitioning`；Host 与调度共用同一实现 |
| Widget Host | `apps/web/src/app/widgets/WidgetHost.tsx` | 独立实例状态机、错误边界、加载/空/错误/重试、降级卡片 |
| 静态组件映射与配置迁移 | `apps/web/src/app/widgets/component-registry.ts` | 写死的 `widgetId → 组件`，显式版本迁移；未知类型降级 |
| 浏览器实例表 | `apps/web/src/app/widgets/instance-store.ts` | `allowMultiple` 策略、隐藏/移除只影响实例、按模块整批清理 |
| 验收界面 | `apps/web/src/app/modules/ModuleManagerPanel.tsx`、`apps/web/src/app/widgets/WidgetAcceptancePanel.tsx`、`apps/web/src/app/shell/SessionCredentialPanel.tsx` | 真实目录/状态/变更；会话内存凭证入口 |

## 3. 阶段 02 刻意没有做什么

- 没有工作台数据模型（`workspace_pages`、`widget_instances`、`widget_layouts` 仍**未**迁移）。
  因此实例只存在于浏览器内存，服务端卸载只能通过 `ModuleInstanceStore` 端口**请求**清理。
  阶段 03 接入持久实例表后，端口实现替换即可，语义不变。
- 没有前端路由，也没有多页面 / 拖拽 / 缩放 / 布局编辑。
- 没有第三方插件运行时：将来也不允许按不可信字符串动态执行远程 JS。
- 没有清数据（purge）实现，只有显式拒绝；将来必须做成「备份 + 显式二次确认」的独立流程。
- 没有真实调度与通知：`ScheduledTaskStore` 是内存替身，`wrangler.jsonc` 的 `triggers.crons` 仍为空。
- 没有游戏业务界面：界面上的组件全部是 `demo.*` 演示组件。

## 4. 接入约定（继续有效）

### 4.1 Module 声明

1. 每个内置模块有稳定 ID（形如 `ff14.fishing`）与语义版本，由 `MODULE_ID_PATTERN`/`SEMVER_PATTERN` 校验。
2. `capabilities` 必须落在 `MODULE_CAPABILITIES` 白名单内，且必须是注册表授予集合的子集；
   不满足即**注册失败**（默认拒绝，不静默忽略）。
3. `lifecycle` 里的 `onEnable`/`onDisable`/`onUninstall` 只能引用**静态注册表**中的处理器名，
   禁止内联代码或远程地址；引用不存在的名字即注册失败。
   查找使用 `Object.hasOwn`，因此 `constructor` 之类的原型成员**不会**被当成已注册 handler。
4. Widget 的 `moduleId` 必须等于所属模块 `id`；Widget 类型 ID 在同一 Manifest 内与**跨模块**都唯一
   （组件实例可以重复，类型 ID 不可以）。路由 `path` / `viewId` 同样在两种范围内唯一。
5. handler 必须**幂等**：失败或并发抢输后的重试会再次执行它。

### 4.1.1 能力是**执行期**门禁，不只是声明

- `scheduled:own`：交给模块的调度视图在 `schedule` 前查 `registry.hasCapability()`，
  未授予直接 `capability_not_granted`；Manifest 里写了也不影响判定。
- 调度视图的作用域由闭包绑定，入参里没有 workspace/module 字段；
  多传的作用域字段会被丢弃，**伪造无效**。
- **执行归属同样绑定在视图上**：`schedule` / `cancel` 每次调用前都校验「本次执行的 token 仍是当前」，
  并把自己这一代的 revision 作为 fence 传给管理端口。因此 handler 在 `await` 中被接管之后，
  它内部的任务操作一律 `execution_superseded`——既删不掉 restore 之后同名的任务，
  也不能把旧代任务标成当前代；`insert` 若在途发生接管/restore，会按旧代撤销自己的插入。
- 平台清理用的管理端口（可跨作用域）**绝不交给模块代码**。

### 4.2 Widget Host 的职责边界

| 职责 | 归属 | 不归属 |
|---|---|---|
| **实例归属校验**（`entry.moduleId === instance.moduleId`） | Widget Host（注册表是权威） | 实例自述 |
| 配置 Schema 版本校验与显式迁移 | Widget Host + 静态组件映射 | 各 Widget 自行猜测 |
| **配置解析/迁移抛错** | Widget Host（降级为本实例配置错误） | 错误边界（它只包住组件） |
| 加载态 / 空态 / 错误隔离卡片 / 重试 | Widget Host | 组件 |
| 渲染期错误隔离 | 错误边界（每实例一个） | —— |
| 异步失败上报 | 组件 `reportAsyncError` → Host 渲染错误卡片 | 错误边界（它捕获不到异步错误） |
| **attempt 隔离** | Host（回调绑定 `retryToken`，旧 attempt 的迟到回调被忽略） | 组件自行取消 |
| 权限与本工作空间数据作用域 | Widget Host + 认证中间件 | Widget（不得自行读库） |
| 业务计算与数据获取 | 模块 / Adapter | Widget Host |
| 跨模块通信 | 显式公共事件/服务接口 | 直接读别的模块的表 |

### 4.3 操作语义（不可混淆，规划规则 7）

| 操作 | 页面表现 | 后台任务 | 个人业务数据 |
|---|---|---|---|
| `hideWidget` | 仅隐藏该实例（**纯客户端**） | 不受影响 | 保留 |
| `removeWidget` | 删除当前页面的该实例（**纯客户端**） | 不受影响 | 保留 |
| `disableModule` | 隐藏/禁用其组件与入口（Host 降级） | **取消已排队任务** | 保留 |
| `uninstallModule` | 移除该模块全部 Widget 实例并停用 | 停止并取消任务 | **默认保留**，可 `restore` 再次使用 |
| `purgeModuleData` | 不受影响 | 依操作 | 本阶段**显式拒绝（501）**；将来需二次确认且先提供备份 |

`MODULE_OPERATION_SEMANTICS` 是这张表的代码表示，
`packages/shared/test/module-manifest.spec.ts` 与 `worker/test/module-lifecycle.spec.ts`
共同保证它们不会退化成同一件事。

### 4.3.1 执行协议与「待完成操作」

生命周期变更采用四段式（详见 `docs/adr/0002-phase02-module-runtime.md` D4）：

1. **原子准入**：一次 D1 事务里做条件 CAS（`WHERE revision = ?` **且该模块没有待完成操作**）、
   写入待完成标记、写入本次**执行 token**。抢输的一方以 409 退出，**在任何可变副作用之前**。
2. **独占认领**：续做必须先抢到 `workspace_module_operation_claims` 的唯一 token
   （或原子抢占**已过期**的租约）。抢不到 → 409 `operation_in_progress`，同样零副作用。
3. **副作用**：模块 handler → 移除当前 Host 实例 → 取消已排队任务；每步前后校验执行权。
   端口清理带 **revision fence**（`maxRevision` / `upToRevision`），
   因此即便旧执行者越过了检查，也删不掉 restore 之后的新实例与新任务。
4. **收尾**：条件删除待完成标记（必须仍持有 token）。影响 0 行不是成功，
   而是 409 `operation_superseded`（执行权已被取代或已被别人收尾）。

由此得到的可见语义：

| 情况 | API 返回 | 门禁状态 | 个人数据 |
|---|---|---|---|
| 成功 | 200，`effect.pending = false` | 目标状态（如 `uninstalled`） | 保留 |
| 副作用失败 | **200**，`effect.pending = true` + `effect.failure` + `module.pendingOperation` | `transitioning`（不执行、不排程） | 保留 |
| 准入事务失败 | 500（什么都没提交） | 不变 | 不变 |
| 抢输 / revision 过期 | 409 | 不变 | 不变 |
| 别人正在执行 / 我的执行权已被取代 | 409（`operation_in_progress` / `operation_superseded` / `operation_already_completed`） | 不变 | 不变 |

重试：**同 action + 同 expectedRevision** 会**续做**未完成的清理；其他动作或夹带设置返回 409
（`pending_conflict`）。租约（15s）只解决崩溃后的活性，**不**假设到期旧执行者已停止——
安全性来自 token 与 revision fence。前端会把 `pending` / 失败原因如实展示，并提供「重试完成收尾」。

### 4.4 系统级入口不可移除

组件库、设置、工作台切换、导入/恢复、设备管理位于 App Shell，**不属于**任何页面配置。
用户可以清空所有业务组件，但必须仍然能够进入这些入口并恢复默认
（对应不变量 INV-02 与 CUSTOM-02 / CUSTOM-06）。

## 5. 数据模型

| 表 | 状态 |
|---|---|
| `workspace_modules` | **已迁移**（`0003_modules.sql`）：状态、设置与版本、`revision` 乐观并发、安装/启停/卸载时间戳 |
| `workspace_module_operations` | **已迁移**（`0004_module_operations.sql`）：待完成操作（`action`/`target_status`/`revision`/`attempts`/`last_error`），复合外键指向 `workspace_modules` 并级联删除 |
| `workspace_module_operation_claims` | **已迁移**（`0005_module_operation_claims.sql`）：**独占执行认领**（`token`、`claimed_at`、`expires_at`），主键保证同一模块同时只有一个执行者；随 operations 行级联删除 |
| `workspace_pages`、`widget_instances`、`widget_layouts` | **已迁移**（`0006_workbench.sql`，阶段 03）：多页面 + 墓碑 + 页面级 revision；实例带 `created_revision`（模块代际 fence）与墓碑；布局按「实例 × 断点」 |
| `page_layout_revisions` | **已迁移**（`0006_workbench.sql`）：「页面 × 断点」**独立**修订号（ADR-010） |
| `workspace_workbench_state` | **已迁移**（`0006_workbench.sql`）：工作台级修订号，用于导入预览的新鲜度令牌 |
| `workbench_operations` | **已迁移**（`0006_workbench.sql`）：幂等 `operationId` 的结果留痕与「本次尝试 token」守卫 |
| `workbench_backups` | **已迁移**（`0006_workbench.sql`）：替换导入前的可恢复备份（只含工作台配置） |
| `nav_catalog_links` / `workspace_nav_links` 等 | 未迁移（阶段 04） |
| `notification_jobs` 等 | 未迁移（阶段 05）；当前调度端口是内存替身，**没有 Cron** |

迁移时必须遵守既定不变量：私有表带 `workspace_id` 或可通过受约束 FK 回溯、
布局按页面+断点独立修订、删除使用可同步墓碑、不允许启动时隐式修改生产 Schema。
`module_id` 刻意**没有**外键——模块是代码里的静态注册项，其合法性由注册表校验。

## 6. 相关决定

阶段 02 的具体取舍（命名、执行顺序、端口替身、为什么 purge 用 501 等）
记录在 `docs/adr/0002-phase02-module-runtime.md`；
阶段 03 的具体取舍（断点级修订、token 幂等守卫、页面墓碑与恢复、导入 ID 重映射、
备份容量上限、`react-grid-layout` 版本选择、实例清理端口的三条件原子 fence 等）
记录在 `docs/adr/0003-phase03-workbench.md`。

## 7. 阶段 03 落地了什么（HUB-045 / HUB-046 / HUB-049 / HUB-054）

Widget 实例从**浏览器内存**变成**服务端持久数据**，因此原先只在前端成立的几条规则现在由服务端强制。

### 7.1 实例的归属与合法性由服务端权威判定

- 组件类型必须存在于**静态注册表**（`registry.findWidget`）。服务端据此得出所属模块、
  `allowMultiple`、`defaultSize`/`minSize`/`maxSize` 与配置 Schema；**不接受**客户端提交这些元数据。
- 新建实例（含复制 / 模板 / 导入）在**认领语句的同一原子条件**里要求：
  页面属于本工作空间且未删除、所属模块 `status = 'enabled'` 且 `revision` 与本次读取一致、
  该模块没有待完成操作。因此不存在「读到 enabled 再被停用」的时间窗。
- 编辑（改配置 / 隐藏 / 移除）只要求「没有待完成操作」：停用模块后其既有实例是被保留的
  （停用 ≠ 删数据），此时编辑不产生任何执行，不该被禁止。
- `allowMultiple = false` 的作用域是**整个工作空间**（跨活跃页面），并发添加也只会成功一次。

### 7.2 卸载模块会真的清理持久实例，且带代际 fence

阶段 02 的 `ModuleInstanceStore` 是 `persistent: false` 的 no-op 替身（服务端只能「请求清理」）。
阶段 03 换成真实 D1 实现（`worker/modules/workbench/instance-store.ts`，`persistent: true`）：

- 把 `workspace_id` + `module_id` + `created_revision <= 上界` 作为**同一条 UPDATE 的原子条件**；
- 实例标记为墓碑（`deleted_at`），其布局行被删除，受影响页面的三个断点修订号 +1；
- `workspace_modules` 一行都不动，因此模块设置与个人数据保留；
- 旧执行者传入的是它自己的准入 revision，因此**删不掉 restore 之后创建的新实例**。

### 7.3 系统级入口与「清空」语义

- 用户可以删光所有页面的所有组件，也可以删掉所有页面。此时 Shell 的
  `empty-recovery` 面板提供「新建页面 / 应用模板」；页面切换、组件库、设置、
  导入恢复与设备入口始终可达。
- 页面删除是**墓碑**，其下的实例与布局保持原样，因此
  `POST /me/pages/:id/restore` 能把页面连同内容整体带回来。
- 「隐藏实例」「移除实例」「停用模块」「卸载模块」「清空页面」「重置工作台」是六种不同动作，
  各自的影响范围在 ADR-0003 与本文件中逐条写清，不得互相代替。
