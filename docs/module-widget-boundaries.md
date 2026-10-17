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
| 持久状态与迁移 | `migrations/0003_modules.sql`、`worker/db/schema.ts` | `workspace_modules`：(workspace_id, module_id) 主键、状态 CHECK、settings/版本、`revision` 乐观并发 |
| 生命周期服务 | `worker/modules/lifecycle/module-lifecycle.ts` | 状态迁移矩阵、幂等 no-op、handler→平台副作用→条件写库 |
| 生命周期端口 | `worker/modules/ports.ts`、`worker/modules/lifecycle/scheduler.ts` | `ModuleInstanceStore` 与 `ScheduledTaskStore`，阶段 02 的替身自报 `persistent: false` |
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
4. Widget 的 `moduleId` 必须等于所属模块 `id`；同一模块内 Widget 类型 ID 唯一，
   **跨模块也唯一**（组件实例可以重复，类型 ID 不可以）。
5. handler 必须**幂等**：生命周期失败或并发抢输后的重试会再次执行它。

### 4.2 Widget Host 的职责边界

| 职责 | 归属 | 不归属 |
|---|---|---|
| 配置 Schema 版本校验与显式迁移 | Widget Host + 静态组件映射 | 各 Widget 自行猜测 |
| 加载态 / 空态 / 错误隔离卡片 / 重试 | Widget Host | 组件 |
| 渲染期错误隔离 | 错误边界（每实例一个） | —— |
| 异步失败上报 | 组件 `reportAsyncError` → Host 渲染错误卡片 | 错误边界（它捕获不到异步错误） |
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

### 4.4 系统级入口不可移除

组件库、设置、工作台切换、导入/恢复、设备管理位于 App Shell，**不属于**任何页面配置。
用户可以清空所有业务组件，但必须仍然能够进入这些入口并恢复默认
（对应不变量 INV-02 与 CUSTOM-02 / CUSTOM-06）。

## 5. 数据模型

| 表 | 状态 |
|---|---|
| `workspace_modules` | **已迁移**（`0003_modules.sql`）：状态、设置与版本、`revision` 乐观并发、安装/启停/卸载时间戳 |
| `workspace_pages`、`widget_instances`、`widget_layouts` | 未迁移（阶段 03） |
| `nav_catalog_links` / `workspace_nav_links` 等 | 未迁移（阶段 04） |
| `notification_jobs` 等 | 未迁移（阶段 05）；当前调度端口是内存替身，**没有 Cron** |

迁移时必须遵守既定不变量：私有表带 `workspace_id` 或可通过受约束 FK 回溯、
布局按页面+断点独立修订、删除使用可同步墓碑、不允许启动时隐式修改生产 Schema。
`module_id` 刻意**没有**外键——模块是代码里的静态注册项，其合法性由注册表校验。

## 6. 相关决定

阶段 02 的具体取舍（命名、执行顺序、端口替身、为什么 purge 用 501 等）
记录在 `docs/adr/0002-phase02-module-runtime.md`。
