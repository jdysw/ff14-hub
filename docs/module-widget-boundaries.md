# Module / Widget 边界说明

本文件固定**阶段 02 及之后** Module 与 Widget 的接入边界。阶段 01 只落地契约，不实现运行时。
目的是让「用户可自由增删改模块与组件」这件事从结构上成立，而不是事后改造固定首页。

## 1. 阶段 01 已经落地了什么

| 已落地 | 位置 | 说明 |
|---|---|---|
| Manifest / Widget Schema 与校验 | `packages/shared/src/module-manifest.ts` | Zod 契约 + `validateModuleManifest()`，能力白名单默认拒绝 |
| 生命周期操作语义表 | 同上 `MODULE_OPERATION_SEMANTICS` | 五种操作对「页面 / 后台 / 数据」的影响被写成常量并被测试断言 |
| 断点与列数基线 | 同上 `LAYOUT_BREAKPOINTS` / `BREAKPOINT_COLUMNS` | 桌面 12 / 平板 8 / 手机 4，各断点独立 |
| 系统级入口常驻 | `apps/web/src/app/shell/SystemBar.tsx` | 工作台切换、组件库、模块管理、设置、导入恢复、设备管理永久保留 |
| 工作台容器占位 | `apps/web/src/app/shell/AppShell.tsx` | 只放占位说明，**不**硬编码任何业务组件 |

## 2. 阶段 01 刻意没有做什么

- 没有 Module Registry 运行时（模块发现、注册、权限授予）。
- 没有 Widget Host（加载、配置校验、错误边界、加载态/空态）。
- 没有工作台数据模型（`workspace_pages`、`widget_instances`、`widget_layouts` 等表尚未迁移）。
- 没有前端路由，也没有任何导航或鱼类业务界面。
- 没有第三方插件运行时，将来也不允许按不可信字符串动态执行远程 JS。

## 3. 阶段 02 的接入约定

### 3.1 Module 声明

1. 每个内置模块有稳定 ID（形如 `ff14.fishing`）与语义版本，由 `MODULE_ID_PATTERN`/`SEMVER_PATTERN` 校验。
2. `capabilities` 必须落在 `MODULE_CAPABILITIES` 白名单内；未知能力**直接拒绝**，不静默忽略。
3. `lifecycle` 里的 `onEnable`/`onDisable`/`onUninstall` 只能引用**静态注册表**中的处理器名，禁止内联代码或远程地址。
4. Widget 的 `moduleId` 必须等于所属模块 `id`；同一模块内 Widget 类型 ID 唯一。
   （组件**实例**可以重复，类型 ID 不可以——这两件事不要混。）

### 3.2 Widget Host 的职责边界

| 职责 | 归属 | 不归属 |
|---|---|---|
| 配置 Schema 版本校验 | Widget Host | 各 Widget 自行校验 |
| 加载态 / 空态 / 错误隔离卡片 | Widget Host | 模块 |
| 权限与本工作空间数据作用域 | Widget Host + 认证中间件 | Widget（不得自行读库） |
| 业务计算与数据获取 | 模块 / Adapter | Widget Host |
| 跨模块通信 | 显式公共事件/服务接口 | 直接读别的模块的表 |

### 3.3 操作语义（不可混淆，规划规则 7）

| 操作 | 页面表现 | 后台任务 | 个人业务数据 |
|---|---|---|---|
| `hideWidget` | 仅隐藏该实例 | 不受影响 | 保留 |
| `removeWidget` | 删除当前页面的该实例 | 不受影响 | 保留 |
| `disableModule` | 隐藏/禁用其组件与入口 | 暂停或取消 | 保留 |
| `uninstallModule` | 移除该模块全部 Widget 实例并停用 | 停止 | 默认保留，可再次启用 |
| `purgeModuleData` | 不受影响 | 依操作 | 仅清除选择范围，需二次确认且先提供备份 |

`MODULE_OPERATION_SEMANTICS` 是这张表的代码表示，`packages/shared/test/module-manifest.spec.ts`
中有断言保证它们不会退化成同一件事。

### 3.4 系统级入口不可移除

组件库、设置、工作台切换、导入/恢复、设备管理位于 App Shell，**不属于**任何页面配置。
用户可以清空所有业务组件，但必须仍然能够进入这些入口并恢复默认
（对应不变量 INV-02 与 CUSTOM-02 / CUSTOM-06）。

## 4. 数据模型预留

阶段 02–04 将新增（见规划 5.2，本轮**未**迁移）：

- `workspace_modules`：模块启停与逻辑卸载状态。
- `workspace_pages`、`widget_instances`、`widget_layouts`：多页面与按断点独立的布局。
- `nav_catalog_links` / `workspace_nav_links` 等：推荐目录与用户副本分离。

迁移时必须遵守既定不变量：私有表带 `workspace_id` 或可通过受约束 FK 回溯、
布局按页面+断点独立修订、删除使用可同步墓碑、不允许启动时隐式修改生产 Schema。
