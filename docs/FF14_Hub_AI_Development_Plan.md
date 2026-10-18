---
document_id: FF14-HUB-PLAN
schema_version: "1.0"
title: "FF14 Hub — AI 开发主规划"
status: approved_for_phase_01
last_updated: "2026-10-18"
language: zh-CN
audience: [Codex, DSH, coding-agents, maintainers]
project:
  name: FF14 Hub
  repository: jdysw/ff14-hub
  repository_visibility: private
  default_branch: main
  target_region: cn
  planned_region_extension: global
  usage: personal_first
  hosting: cloudflare_first
  traditional_user_accounts: false
  customization: full_user_control
current_execution:
  phase: "03"
  task_ids: [HUB-045, HUB-046, HUB-049, HUB-054]
  dispatch: "Codex -> codex-dsh-collab -> DSH Desktop（可用时）"
  repository_created: verified
  tasks_dispatched: true
  implementation_status: in_progress
  # 以下状态由执行 Agent 按真实证据维护；证据不足即不得上调。
  phase_01_task_status:
    HUB-001: merged
    HUB-002: merged
    HUB-003: merged
    HUB-004: merged
    HUB-005: merged
    HUB-006: merged
  phase_02_task_status:
    HUB-043: merged
    HUB-044: merged
    HUB-050: merged
  phase_03_task_status:
    HUB-045: implemented_pending_review
    HUB-046: implemented_pending_review
    HUB-049: implemented_pending_review
    HUB-054: implemented_pending_review
  last_status_update: "2026-10-18"
  status_evidence: |
    阶段 01：以 PR #1 squash 合并入 main（commit c65e29e），main CI run 39063324867 success；
      阶段 01 完成定义中的「PR 合并」已满足。
    阶段 02：PR #5 在 head eec978a5d4acd7cbb33568f1cf26ef44b6ce1bdb 上通过
      CI run 39071393657（lint/typecheck/test/build 与真实浏览器链两项 success）、
      工作树干净、mergeable CLEAN 后标 ready 并 squash 合并，
      merge commit b9acfb2bc9c96c200ffdd6a7559f278bcf0dc897；
      合并后 main CI run 39071908808 的两项 job 均 success；
      已删除已合并远程分支 codex/phase02-modules。
      Issues #2 / #3 / #4 由 PR 关联关闭。
    阶段 03：分支 codex/phase03-workbench，Issues #6（HUB-045）/ #7（HUB-046）/
      #8（HUB-049）/ #9（HUB-054）。四个任务均为「已实现、待人工评审」。
    本地已实际通过：pnpm install --frozen-lockfile、pnpm lint、pnpm typecheck、
      pnpm test、pnpm build、绑定类型一致性 check、D1 本地迁移（全新 + 重复应用）安全。
    测试规模（全部实跑）：packages/shared 58 项、worker（真实 workerd + Miniflare D1）19 文件 345 项、
      apps/web（jsdom + React Testing Library）9 文件 111 项；
      真实浏览器验收链 phase03：3 passed / 3 skipped（桌面完整链路含真实拖动+缩放、双客户端并发 409、
      窄屏键盘，7.0s），phase02 回归链：2 passed / 2 skipped。
    另有独立黑盒冒烟：在本机真实 wrangler dev + 真实 D1 上直连工作台路由，
      覆盖鉴权作用域、模块门禁、幂等重放、断点独立、非法布局、备份导出/预览/导入/撤销、
      模板三种模式、页面删除/恢复，共 35 项断言全部通过。
    本地 D1：0006_workbench.sql 在真实 workerd + D1 中实测（外键 / 部分唯一索引 / CHECK 生效）。
    已知真实缺陷与取舍：RGL 2.3.0 的拖动入口依赖 DraggableCore 以 cloneElement 注入
      onMouseDown，组件边界漏透传会让拖动**静默**失效；已修复并记录在 ADR-0003 D13.1。
    集中复核后的一轮加固（ADR-0003 D17）：并发新增/复制的空位与「规划时看到的布局修订」绑定；
      导出改为单 batch 一致快照并自校验；撤销点的未消费校验/标记消费与替换同事务且要求
      expectedRevision；导入确认新增 previewToken（绑定 document+mode+revision+模块门禁）；
      幂等键新增请求指纹（同 ID 换意图 409 且零写入）；实例清理用本次标记限定影响范围，
      0 新增墓碑时零 revision 变更。迁移因此只用 CREATE ... IF NOT EXISTS（不改既有表结构）。
    Cloudflare 部署状态：未部署（未创建远程资源、未绑定域名、未注册 Cron）。
    HUB-045 / 046 / 049 / 054 均为「已实现、待人工评审」，**不是** done。
---

# FF14 Hub — AI 开发主规划

> **本文件是项目的单一开发规划依据（Single Source of Truth）。** 面向 Codex、DSH Desktop、其他编码 Agent 和开发维护者。它是规划，不代表仓库、代码、部署或测试已经完成。任务实际状态必须以 GitHub 提交、PR、CI 和部署记录为准。
>
> **阅读顺序：** 第 0 节执行指令 → 第 1–4 节硬约束与架构 → 第 5–9 节数据、接口、关键业务 → 第 10–12 节任务与验收。遇到歧义时优先遵守“不变量”，将必要选择记录为 ADR，不静默变更产品边界。

## 实施状态快照（由执行 Agent 维护，非规划原文）

> 本节是为了让「规划」与「当前事实」不被混淆而增加的。规划正文（第 0 节起）保持原样；任务条目仍然只是需求定义。

| 任务 | 状态 | 证据 |
|---|---|---|
| HUB-001 工程初始化 | merged | `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `apps/web` / `worker` / `packages/shared`；随 PR #1 合并（squash commit `c65e29e`），`main` 上 CI run `39063324867` success |
| HUB-002 Workers 运行环境 | merged | `wrangler.jsonc`（D1 + 同域 assets）、`worker/index.ts`、`worker/env.ts`、`.dev.vars.example`；同上合并与 CI 证据 |
| HUB-003 D1 数据模型与迁移 | merged | `migrations/0001_core.sql`、`worker/db/schema.ts`；FK/唯一/枚举约束在 workerd+D1 中实测；同上合并与 CI 证据 |
| HUB-004 API 基础与校验 | merged | `worker/api/`、`worker/middleware/`、`packages/shared/src/errors.ts`；401/404/405/409/413/415/422/500 路径均有测试 |
| HUB-005 CI 与测试基础 | merged | `.github/workflows/ci.yml`、ESLint 扁平配置、Vitest Workers 池；同上合并与 CI 证据 |
| HUB-006 单工作空间身份与设备管理 | merged | `worker/modules/identity/`、`worker/api/v1/identity.ts`、`migrations/0002_identity.sql`、`worker/lib/rate-limit.ts`；PR #1 合并（gpt 独立复核 51 项身份测试通过），`main` CI run `39063324867` success |
| HUB-043 Module Registry | merged | `worker/modules/registry/`（注册表 + 内置演示模块）、`packages/shared/src/builtin-modules.ts`；`worker/test/module-registry.spec.ts` 在真实 workerd 中通过；随 PR #5 合并（squash commit `b9acfb2`），`main` CI run `39071908808` 两项 job success |
| HUB-044 Widget Host | merged | `apps/web/src/app/widgets/`（Host、静态组件映射、实例存储、演示组件）、`apps/web/src/lib/RenderErrorBoundary.tsx`；Playwright 验收链覆盖桌面与窄屏；同上合并与 CI 证据 |
| HUB-050 模块生命周期与数据策略 | merged | `migrations/0003_modules.sql` + `0004_module_operations.sql` + `0005_module_operation_claims.sql`、`worker/modules/lifecycle/`、`worker/api/v1/{modules,me-modules}.ts`、`apps/web/src/app/modules/`；`module-lifecycle.spec.ts`（含确定性交错/独占认领/租约抢占/revision fence 传播/快照一致性）+ `module-schema.spec.ts` 在真实 D1 中通过；同上合并与 CI 证据 |
| HUB-045 布局编辑器 | implemented_pending_review | `packages/shared/src/workbench-api.ts`（唯一布局校验实现）、`worker/modules/workbench/`（`tx.ts` 原子幂等事务、`service.ts`）、`migrations/0006_workbench.sql`、`apps/web/src/app/workbench/`；依赖锁定 `react-grid-layout@2.3.0`（见 ADR-0003 D13） |
| HUB-046 多页面与独立断点 | implemented_pending_review | `workspace_pages` / `widget_instances` / `widget_layouts` / `page_layout_revisions`、`worker/api/v1/me-workbench.ts`、`docs/adr/0003-phase03-workbench.md` |
| HUB-049 模板、空白页与重置 | implemented_pending_review | `BUILTIN_WORKBENCH_TEMPLATES`（四种模板 + `honestyNote` 诚实说明）、`apply-template` 三种模式、Shell 内 `empty-recovery` 恢复入口 |
| HUB-054 工作台配置备份恢复 | implemented_pending_review | `worker/modules/workbench/backup.ts`（导出/预览/导入/恢复）、`workbench_backups` 表、导出与导入共用 `WORKBENCH_BACKUP_MAX_BYTES` |

**明确未完成 / 未做（不要读成已完成）：**

- 阶段 03 的工作位于分支 `codex/phase03-workbench`，以**草稿 PR** 提交集中复核，**尚未合并**。
- 未创建任何 Cloudflare 远程资源（无 D1 远程库、无 Worker 部署、无预览环境、无域名绑定、无 Cron）。
- 阶段 04 的导航业务、阶段 05 的鱼类/通知引擎、阶段 06 的 WebDAV 同步均未实现。
- 阶段 03 的**调度端口仍是内存实现**（`persistent: false`）：没有 Cron、没有 Web Push、
  没有真实通知派发；`wrangler.jsonc` 的 `triggers.crons` 保持为空。
  （实例清理端口已在阶段 03 换成真实 D1 实现，`persistent: true`。）
- **跨设备增量同步（HUB-051）未实现**：墓碑已按规划 5.3 保留，但没有同步水位、没有 GC、
  没有 `GET /me/sync/changes`。
- 清数据（purge）**未实现**，只提供显式拒绝（501）；将来必须做成「先备份 + 二次确认」的独立流程。
- 前端的完整身份界面（初始化向导、配对、设备管理 UI）未实现；阶段 02 只补了「会话内存凭证」这一最小入口。
- 认证失败事件仍未落库（`identity_audit.workspace_id` 为 NOT NULL，无法承载无归属事件），只写脱敏日志。
- 界面上的组件全部是 `demo.*` 演示组件，**没有任何游戏业务数据**；
  四种初始模板只放置已注册的演示组件，并在界面上原样展示「真实模块见阶段 04–05」的诚实说明。
- 备份上限为 48 KiB：极端规模（30 页 × 40 组件且配置接近上限）的工作台**无法导出**，
  会收到明确失败而不是损坏文件（见 ADR-0003 D11）。

## 0. 给 AI Agent 的执行指令

### 0.1 本轮任务与权限边界

- 目标仓库：`jdysw/ff14-hub`，独立**私有**仓库，默认分支 `main`。创建前先确认不存在；存在则先查看状态，不覆盖已有内容。**不得修改其他仓库**，尤其是 `jdysw/ff14-glamour-zh`。
- 当前只实施 **阶段 01 / HUB-001 ～ HUB-006**：Core 基础、D1、统一 API、CI、单工作空间身份系统。
- 阶段 01 **必须为后续的 Module Registry、Widget Host、可自定义导航、拖拽工作台预留边界**，但不提前实现导航 UI、鱼王逻辑或完整模块管理器。
- 不能假设本地 DSH 可被任意 ChatGPT 网页会话调用。使用 `codex-dsh-collab` 派发前需先发现实际可用的工具/技能及工作区；没有接口则报告阻碍，不得宣称任务已派发。
- 优先使用与主仓库隔离的功能分支/PR；与任务关联的零散提交可以整理为 squash merge。未经授权不部署到生产、不提交密钥、不修改其他现有项目。

### 0.2 Agent 必须遵守的规则

1. **先检查环境**：仓库状态、运行环境、插件可用性、Cloudflare 绑定权限；不得凭经验宣称已连接。
2. **先读文档再编码**：任务依赖、架构约束、接口和迁移规范均以本规划为基准。
3. **一次处理一个明确的任务集合**：先建立目录与契约，再实施，最后测试、审核、提交。
4. **执行真实测试**：不得通过修改测试预期、跳过断言、伪造日志或虚报测试结果获得通过。
5. **采用最小必要权限**：不存储 WebDAV 明文凭证；身份 Token/恢复密钥不进入日志或 Git；所有私有 API 校验设备身份与工作空间作用域。
6. **保持中文注释**：关键业务规则、安全前提、同步冲突处理均使用中文注释；公共 API、函数和变量命名可使用英文。
7. **不要把“隐藏 Widget”“移除 Widget”“停用 Module”“清除数据”混为一谈**。
8. **不要擅自引入传统账户注册、OAuth、多人 SaaS 或外部大模型能力**。
9. **每个 PR 提供证据**：修改范围、测试命令及实际结果、影响的数据库迁移、安全影响和未解决风险。
10. **无法确定外部数据正确性时应显式标记为未验证**，特别是鱼王/鱼皇复杂规则和官方活动。

### 0.3 交付报告固定格式

```markdown
## 任务结果
- 完成的任务 ID：
- GitHub 仓库 / 分支 / PR：
- 新建或修改的文件：
- 实际执行的命令：
- 测试结果（通过、失败、未运行）：
- Cloudflare 部署状态（未部署/预览/生产）：
- 安全与迁移注意事项：
- 未完成事项 / 阻碍：
- 下一批可启动任务：
```

## 1. 产品目标与不可变要求

### 1.1 项目定义

**FF14 Hub = FF14 工具与网站导航 + 个人游戏信息中心 + 完全可自定义的模块化工作台。**

默认面向国服玩家和个人自用，预留国际服扩展。核心差异化不是拥有最多链接，而是让用户**完全控制网站条目、分类、工作台页面、组件布局、模块启停、个人游戏状态和提醒策略**。

### 1.2 产品不变量（Invariant）

| ID | 不变量 | 违反即视为架构缺陷 |
|---|---|---|
| INV-01 | 个人导航网站、分类、分组可自由新增、编辑、删除、排序、导入导出 | 官方默认库更新不能重新插回用户已删除的链接 |
| INV-02 | 页面由可组合 Widget 实例组成；支持添加、复制、隐藏、移除、移动、缩放、配置 | 用户可清空所有业务组件，但保留系统恢复入口 |
| INV-03 | 完整业务功能是 Module；一个 Module 可提供多个 Widget 和路由 | 移除 Widget 不等于停用 Module，更不等于删除个人数据 |
| INV-04 | 模块支持启用、停用、逻辑卸载、恢复与清除数据的不同语义 | 停用相关后台任务；默认保留用户数据 |
| INV-05 | 无传统用户注册/登录系统；采用私有工作空间、多设备独立凭证、离线恢复密钥 | 私有数据不能通过公共 API 读取 |
| INV-06 | WebDAV 用户名、密码只由授权客户端持有，不传给服务器 | 客户端负责 WebDAV 读写，服务端只保存必要状态 |
| INV-07 | 提醒调度在 Cloudflare 后端执行，与浏览器标签页存活无关 | 后台可继续尝试推送，但不承诺终端一定显示 |
| INV-08 | 国服和国际服游戏数据明确分区，不能混用规则 | UTC 存绝对时间，ET 用纯函数换算，区服在数据/规则层显式化 |
| INV-09 | 鱼糕数据至少兼容 `completed`、`pinned`、`alarmFish`，以及未来未知字段 | 同步必须支持反向修改与删除，不能永远取并集 |
| INV-10 | 业务模块不能直接依赖外站 DOM/数据库内部结构 | 外部资料通过可替换 Adapter；内部统一契约 |
| INV-11 | 生产基础设施遵循最小化原则：Cloudflare Workers + D1 + Cron 优先 | 不为个人项目提前采用微服务、消息队列集群或多租户账户体系 |
| INV-12 | 新增功能可以通过 Module Manifest 和 Widget Registry 接入 | 不应该要求硬编码修改首页业务组件清单 |

### 1.3 明确不做（Non-goals）

- 阶段 01 不建设完整的导航业务、不开发鱼类预测、不开发活动爬虫、Web Push 或 WebDAV 同步。
- MVP 不支持任意第三方 JavaScript 直接注入主站；未来插件必须隔离、审核并声明权限。
- 不以自动抓取替代对 FF14 复杂游戏规则的核验。
- 不强制维护社区账号、角色绑定或多人社交互动。
- 不在首期使用 KV 存储要求强一致、带冲突修订的个人数据。

### 1.4 术语

- **Workspace（工作空间）**：一个个人数据及授权设备的逻辑容器，不等于网页中的一个工作台页面。
- **Page（工作台页面）**：可自定义组件布局的页面，如“日常”“钓鱼”“高难”。
- **Module（功能模块）**：有业务能力、接口、存储、权限、后台任务、可选路由及 Widget 的功能单元。
- **Widget（界面组件）**：一个 Module 对外提供的可独立配置视图。
- **Widget Instance（组件实例）**：用户在页面上添加的某一 Widget 副本，拥有独立配置和布局。
- **Catalog（推荐资源库）**：系统维护的 FF14 网站目录；导入用户空间后成为可独立修改的数据副本。
- **Region（区服）**：`cn` / `global`；通用导航数据可以使用 `both`。
- **ET**：艾欧泽亚时间；与浏览器地区时区不是同一个概念。
- **Revision**：用户状态或页面布局的修订号，供乐观并发和增量同步使用。

## 2. 最终用户能力（PRD）

### 2.1 导航中心 NAV

- NAV-01：管理任意网站 URL、名称、描述、图标、分类、标签、打开方式、排序、状态。
- NAV-02：新增、改名、删除、重排任意个人分类与分组，允许多重分组。
- NAV-03：系统维护一个只读 FF14 官方推荐目录；支持选择导入，不与用户副本强绑定。
- NAV-04：用户对导入资源有完整编辑/删除权；**删除墓碑必须跨设备同步**，资源库升级不得强行恢复。
- NAV-05：搜索导航标题、别名、描述和标签；可按区服和分类筛选。
- NAV-06：导入浏览器书签 HTML 和结构化 JSON；可导出个人导航配置。
- NAV-07：网站健康检查应区分 `ok`、`maybe_blocked`、`unreachable`、`unknown`，禁止将 403 一律认定为永久失效。
- NAV-08：同一导航资源可用于完整导航页面与“常用网站”Widget。

### 2.2 自定义工作台 CUSTOM

- CUSTOM-01：用户可新建、重命名、排序、删除多个 Page，并选一个默认页。
- CUSTOM-02：空白页面是合法状态；**系统级设置/组件库/恢复入口永久保留在应用 Shell 中**。
- CUSTOM-03：Widget 支持添加、复制、移动、缩放、隐藏、移除；移除不删除业务数据。
- CUSTOM-04：相同类型 Widget 可重复添加，每个实例有独立筛选和显示配置。
- CUSTOM-05：桌面、平板、手机断点保存独立网格布局；支持键盘替代操作。
- CUSTOM-06：布局编辑支持保存/撤销、重置单组件、重置页面、模板导入导出。
- CUSTOM-07：跨设备布局修改需有 Revision 与冲突处理，禁止静默覆盖。
- CUSTOM-08：初始模板：日常导航、钓鱼、高难、空白；模板只是起点，不限制用户编辑。

### 2.3 模块能力 MODULE

- MODULE-01：每个内置模块有稳定 ID、版本、Manifest、能力声明、组件清单、设置 Schema 与生命周期。
- MODULE-02：允许用户启用、停用、逻辑卸载与恢复模块。
- MODULE-03：停用模块应终止/暂停其主动后台行为（如新通知任务），保留用户数据。
- MODULE-04：模块之间通过明确的公共事件/服务接口通信，不绕过权限读取私有数据库。
- MODULE-05：Widget Host 负责加载、配置校验、权限、错误边界、加载态和空态。
- MODULE-06：版本升级时由迁移处理组件配置 Schema 与数据结构。
- MODULE-07：首期仅运行内置可信模块；第三方插件运行环境是后续独立议题。

### 2.4 活动、钓鱼与个人提醒

- EVENT-01：活动列表/日历，支持人工添加与官方来源链接；分区服记录起止时间与验证状态。
- EVENT-02：活动到期前提醒、活动变更后任务重算；外部源失败有人工维护/缓存兜底。
- FISH-01：完整普通鱼、鱼王、鱼皇基础数据和个人进度模型，不只存鱼王。
- FISH-02：独立 ET/天气计算器、区域天气、前置天气、窗口推算与规则验证标记。
- FISH-03：支持未钓鱼过滤、收藏、独立提醒订阅、未来窗口和稀有窗口优先级。
- REM-01：用户自由设置通知提前量、免打扰、摘要、设备接收渠道。
- REM-02：Cron 调度到期任务；多次执行幂等、并发安全、发送前重验状态。
- REM-03：Web Push 发送与浏览器关闭标签页解耦；保存投递尝试历史，区分“Push 服务接受”和“终端显示”。
- SYNC-01：使用鱼糕 WebDAV 进度及本地油猴脚本；服务端不得持有 WebDAV 凭证。
- SYNC-02：客户端同步三份数据：鱼糕本地、WebDAV、FF14 Hub 服务端；冲突可审计、可恢复。

## 3. 架构决策（ADR）

| ADR | 决策 | 理由 | 替代方案与不采用原因 |
|---|---|---|---|
| ADR-001 | Cloudflare Workers + 静态资源同域部署 | 减少 API CORS、运维成本 | 首期不分别建设多个服务 |
| ADR-002 | 模块化单体，TypeScript Monorepo | 公共类型、测试便利、后续可扩展 | 首期不微服务化 |
| ADR-003 | React + Vite + Hono + Zod | 组件生态与轻量 API 路由 | 避免无必要的复杂 SSR |
| ADR-004 | D1（SQLite）存持久和私有状态 | 支持 SQL 关系、事务、修订号 | KV 最终一致性，不适合状态冲突处理 |
| ADR-005 | PWA + Service Worker + Web Push | 关闭标签页后仍可由后端调度 | 不依赖页面 `setInterval` 作为提醒核心 |
| ADR-006 | 单工作空间、多设备随机凭证 | 满足无注册与个人使用 | 不做公共匿名注册 API |
| ADR-007 | 前后端公用纯函数 Fish Engine | 可验证、可复用 | 不直接把第三方网页倒计时作为唯一依据 |
| ADR-008 | 推荐目录与用户数据副本分离 | 用户彻底控制导航 | 不向用户导航强制推送默认条目 |
| ADR-009 | Module Manifest + Widget Host | 模块与展示解耦 | 不在页面直接硬编码业务功能 |
| ADR-010 | Desktop/Mobile 布局分开修订 | 跨设备表现可控 | 不用一套绝对坐标覆盖全部终端 |
| ADR-011 | WebDAV 客户端直接访问 | 明文密钥不进后端 | 不做服务端 WebDAV 代理 |

架构主链路：

```text
Browser/PWA + Tampermonkey (authorized client)
      | HTTPS (same-origin)
      v
Cloudflare Workers/Hono (Auth Middleware + API + Scheduled)
      |                       \
      v                        \--> Web Push Provider (push endpoints)
Cloudflare D1
      ^
      |
Adapters: FF14 game data / official event sources / fish rules

Browser/Userscript -- HTTPS --> user's WebDAV  (no server credential access)
```

## 4. 技术栈、目录及工程规范

### 4.1 技术栈

| 层级 | 推荐 | 边界 |
|---|---|---|
| 包管理 | pnpm workspace | 锁定 lockfile，声明 Node 版本 |
| Web UI | React、TypeScript（strict）、Vite | Tailwind CSS、shadcn/ui 按后续 UI 阶段引入 |
| API | Cloudflare Workers、Hono、Zod | 所有输入需验证 |
| 数据 | Cloudflare D1、Drizzle ORM、SQL Migration | 不允许启动时隐式改生产 Schema |
| 本地离线 | IndexedDB、PWA | 设备凭证不使用 URL query 参数 |
| 布局 | React-Grid-Layout（阶段 03 验证版本） | 具有响应式断点、拖动、缩放 |
| 通知 | Workers Cron、Web Push + VAPID | 从发送结果和设备收件分别监控 |
| 测试 | Vitest、Workers 测试环境、Playwright | 单元、集成、端到端 |
| CI/CD | GitHub Actions、Wrangler | PR CI、预览环境、生产发布分离 |

依赖版本以安装时锁文件和官方当前兼容性为准，不在规划中硬编码未经验证的最新版号。

### 4.2 目标目录树

```text
ff14-hub/
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/            # App Shell / 路由 / 公共布局
│       │   ├── features/       # navigation, events, fishing, reminders
│       │   ├── widgets/        # 通用展示容器（后续）
│       │   └── lib/
│       └── public/
├── worker/
│   ├── index.ts
│   ├── api/
│   ├── middleware/            # 认证/校验/错误处理
│   ├── modules/               # 业务模块
│   ├── adapters/              # 第三方数据源
│   └── scheduled/             # Cron 任务
├── packages/
│   ├── shared/                 # 类型、Zod Schema、错误契约
│   ├── fish-engine/            # 纯函数 ET/天气计算（阶段 05）
│   └── sync-core/              # 字段级版本同步（阶段 06）
├── userscripts/
│   └── ffmomola-sync/         # 鱼糕油猴脚本（阶段 06）
├── migrations/                # D1 SQL migrations
├── data/                      # 推荐导航与游戏静态数据
├── tests/
├── docs/
│   └── adr/
├── .github/workflows/
├── wrangler.jsonc
└── README.md
```

目录可以调整，但需保留清晰的 `UI / API / domain / adapter / persistence` 分层；变化写入 ADR。

### 4.3 跨模块契约（阶段 02 实现）

```ts
interface ModuleManifest {
  id: string;                  // 例：ff14.fishing，稳定唯一
  version: string;             // 语义版本
  displayName: string;
  capabilities: string[];      // 需在注册中心白名单验证
  widgets: WidgetDefinition[];
  routes?: { path: string; viewId: string }[];
  settingsSchemaVersion: number;
  lifecycle: {
    onEnable?: string;
    onDisable?: string;
    onUninstall?: string;
  };
}

interface WidgetDefinition {
  id: string;                  // 例：fish-next-windows
  moduleId: string;
  allowMultiple: boolean;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  maxSize?: { w: number; h: number };
  configSchemaVersion: number;
}
```

这只是需求契约示意，不直接作为可执行插件运行时。具体组件通过静态注册表映射，**不得根据不可信字符串动态执行远程 JS**。

模块操作语义：

| 操作 | 页面 | 后台运行 | 个人业务数据 |
|---|---|---|---|
| `hideWidget` | 仅隐藏该实例 | 不受影响 | 保留 |
| `removeWidget` | 删除当前页面该实例 | 不受影响 | 保留 |
| `disableModule` | 隐藏或禁用其组件/入口 | 暂停或取消其任务 | 保留 |
| `uninstallModule` | 移除模块所有 Widget 实例并停用 | 停止模块任务 | 默认保留，可再次启用 |
| `purgeModuleData` | 需明确二次确认 | 依操作 | 仅清除选择范围，先提供备份 |

**系统级设置、工作台切换、组件库入口、导入恢复和个人设备管理位于 App Shell，不能由用户删光。**

## 5. 数据模型及迁移策略

### 5.1 通用约定

- ID：除游戏物品等稳定数字 ID 之外，使用 `TEXT` UUID/ULID；不得使用名称当主键。
- 时间：UTC Unix 毫秒，D1 `INTEGER`；显示时本地化，国服默认 `Asia/Shanghai`。
- 所有私有表必须含 `workspace_id`，或能通过受约束的 FK 唯一回溯到它；任何私有请求都以认证作用域查询。
- 外部数据有来源、版本、校验状态与最后成功更新时间；危险/旧数据不得装成实时可信信息。
- 删除采用墓碑/事件日志支持跨设备传播；垃圾回收必须尊重同步水位。
- 事务行为和并发更新必须实测 D1；不要假设传统独立 SQLite 的所有行为完全相同。

### 5.2 分阶段表清单

**阶段 01 必需：**

| 表 | 核心字段/约束 | 目的 |
|---|---|---|
| `workspaces` | `id PK, region, timezone, locale, recovery_hash UNIQUE, created_at, updated_at` | 单个私有工作空间 |
| `devices` | `id PK, workspace_id FK, token_hash UNIQUE, name, revoked_at, last_seen_at, created_at` | 独立设备身份与撤销 |
| `device_pairings` | `id PK, workspace_id FK, pairing_hash UNIQUE, expires_at, used_at, created_by_device` | 一次性有限期配对 |
| `identity_audit` | `id PK, workspace_id FK, event_type, device_id, created_at, detail_json` | 身份操作审计（不含密钥） |

**阶段 02–04（可定制工作台/导航）：**

| 表 | 核心字段/约束 | 目的 |
|---|---|---|
| `workspace_modules` | `(workspace_id, module_id) PK, status, settings_json, config_version, updated_at` | Module 启停/逻辑卸载 |
| `workspace_pages` | `id PK, workspace_id FK, slug, name, is_default, sort_order, layout_revision` | 多页面工作台 |
| `widget_instances` | `id PK, page_id FK, module_id, widget_type, config_json, config_version, is_hidden` | 独立 Widget 实例 |
| `widget_layouts` | `(widget_id, breakpoint) PK, x, y, w, h` | 桌面/平板/手机布局 |
| `nav_catalog_links` | `id PK, url, title, category, tags, source_version` | 系统推荐资源库 |
| `workspace_nav_links` | `id PK, workspace_id FK, source_catalog_id NULL, url, title, icon, revision, deleted_at` | 个人全权控制网站 |
| `workspace_nav_groups` | `id PK, workspace_id FK, name, sort_order, deleted_at` | 自定义分类/分组 |
| `workspace_nav_memberships` | `(link_id, group_id) PK, sort_order` | 网站多分组 |

**阶段 05–06（游戏、通知、同步）：**

| 表 | 核心字段/约束 | 目的 |
|---|---|---|
| `data_sources` | `id, region, source_version, last_success_at, status` | 数据源健康度 |
| `events` | `id, region, title, starts_at, ends_at, source_url, verification_status` | 游戏活动 |
| `fish` | `id INTEGER PK, name_zh, name_en, fish_type, icon_id` | 全鱼类基本资料 |
| `fish_rules` | `id, fish_id FK, region, rule_json, source_version, validation_status` | 计算规则版本 |
| `fish_state_fields` | `(workspace_id, fish_id, field_name) PK, value, revision, updated_at, updated_by_device` | `caught/pinned/alarm` 分字段状态 |
| `reminder_rules` | `id, workspace_id, target_type, target_id, offset_minutes, channel, enabled` | 用户提醒规则 |
| `notification_jobs` | `id, workspace_id, rule_id, occurrence_key, dedup_key UNIQUE, scheduled_at, status, attempts, leased_until` | 调度与去重 |
| `push_subscriptions` | `id, device_id FK, endpoint UNIQUE, p256dh, auth_secret, enabled` | Web Push 目标 |
| `notification_deliveries` | `(job_id, subscription_id) UNIQUE, status, attempts, response_code` | 逐设备发送记录 |
| `sync_operations` | `id PK, workspace_id, device_id, entity_type, entity_id, field, base_revision, result_revision, status` | 幂等与冲突审计 |
| `sync_runs` | `id, workspace_id, client_id, source, revision, started_at, finished_at, status` | 同步水位/结果 |

实际 SQL 必须提供 FK、必需索引、唯一约束、非法枚举校验；允许为性能引入新表，但不得更改已有不变量。阶段 01 只迁移其必需表。

### 5.3 乐观并发与删除策略

- 个人状态更新携带 `baseRevision` 与幂等 `operationId`；服务端通过有条件的数据库更新提交新 Revision。
- 不同字段可以独立合并；同一字段并发发生矛盾时返回结构化冲突，允许显式选择“本地/服务端”。
- 首次导入历史已钓数据可提出并集合并候选，但后续**取消已钓、取消收藏、取消提醒**不能被旧状态自动复活。
- `workspace_nav_links.deleted_at`、Widget 删除及布局删除使用可同步墓碑；保留到全部相关设备确认或超过明确保留策略。
- 跨设备布局按页面 + 断点独立修订，避免手机编辑误覆盖桌面坐标。

## 6. API 设计（契约草案）

统一前缀 `/api/v1`。API 读取公开数据可以匿名；任何 `/me/*` 必须通过设备身份验证。统一错误对象：`{ "code": "...", "message": "...", "requestId": "..." }`。

### 6.1 阶段 01 必需端点

| Method | Path | Auth | 成功条件 |
|---|---|---|---|
| GET | `/api/v1/health` | Public | 返回服务状态；不得泄露环境密钥 |
| POST | `/api/v1/identity/bootstrap` | Deployment bootstrap secret, once only | 原子初始化单个 Workspace，发放恢复密钥/首设备凭证 |
| POST | `/api/v1/identity/pairing` | Owner device | 生成短期一次性配对凭证 |
| POST | `/api/v1/identity/pairing/claim` | Pairing proof | 领取新设备独立 Token；一次性消费 |
| POST | `/api/v1/identity/recover` | High-entropy recovery proof | 恢复/新建设备凭证；速率限制、审计 |
| GET | `/api/v1/me/profile` | Device bearer | 仅返回当前工作空间的非敏感配置 |
| GET | `/api/v1/me/devices` | Device bearer | 列出当前设备及可撤销设备 |
| DELETE | `/api/v1/me/devices/:id` | Device bearer | 撤销设备立即阻断后续私有访问 |

阶段 01 **不需要**首页业务仪表盘 API、鱼类计算和通知；最多用非真实业务数据的占位 Shell 验证调用链。

### 6.2 后续接口（阶段 02–06）

- 工作台：`GET/POST /me/pages`, `PATCH/DELETE /me/pages/:id`, `PUT /me/pages/:id/layout`（带 `layoutRevision`）。
- 模块：`GET /modules/catalog`, `GET/PATCH /me/modules/:id`，根据状态进行工作空间级启停。
- Widget：`POST /me/pages/:id/widgets`, `PATCH/DELETE /me/widgets/:id`。
- 导航：`GET /navigation/catalog`, `GET/POST /me/navigation/links`, `PATCH/DELETE /me/navigation/links/:id`, `GET/POST /me/navigation/groups`。
- 活动：`GET /events`, `POST/PATCH /me/events`（个人活动），活动来源应有校验状态。
- 鱼类：`GET /fish`, `GET /fish/windows?region=cn&hours=72`, `GET /me/fish-progress`。
- 同步：`POST /me/sync/operations`, `GET /me/sync/changes`，幂等并返回字段级冲突。
- 提醒：`GET/POST/PATCH/DELETE /me/reminders`, `POST /me/push-subscriptions`, `POST /me/notifications/test`。
- 恢复：`GET /me/export`、明确确认的导入操作；原始备份含版本字段。

### 6.3 身份安全协议（重点）

- `bootstrap` **绝不可是公开无限次注册 API**：用环境中的一次性高熵初始化密钥保护；D1 事务或唯一约束确保单工作空间只创建一次，初始化后禁用通道/废弃密钥。
- 每台设备生成独立至少 256-bit 随机高熵 Bearer Token；服务端只存安全摘要（高熵 Token 可使用 SHA-256 + 固定时序比较方案，不能将低熵口令按此方式存储）。
- 恢复密钥同样使用强随机；首发时明确指导线下备份，日志与数据库只保留摘要。若有低熵用户设置口令则需专门密码哈希算法，不应混用。
- 配对码需限时、单次消费、绑定发起设备/工作空间，短码要有速率限制、尝试次数上限与防枚举策略；也可以使用高熵一次性配对令牌。
- 所有私有查询须使用已认证 `workspace_id`，不能接受任意客户端提交的 workspace ID 决定数据作用域。
- SPA Token 存储考虑 IndexedDB 与 CSP 威胁模型；不通过 URL 参数、日志、分析系统传输 Token；各类写操作校验 Origin/Content-Type。
- 本地开发、预览、生产必须分离 D1 和凭证；不能将生产恢复密钥预置在测试中。

## 7. 核心游戏与通知引擎设计

### 7.1 钓鱼规则与时间

独立包 `packages/fish-engine` 提供纯函数：UTC↔ET、天气周期、前置天气、开放条件、候选窗口、有效窗口、排序。输入包含区服、规则版本、区域/鱼类 ID、时间范围；输出包含稳定的 `occurrenceKey`、UTC 开始/结束、校验状态、天气条件和可能的不完整条件标记。

- 不是所有鱼都能只凭 ET/天气推导最终可钓时机；鱼识、前置鱼及复杂机制要显式建模和验证。
- 可以生成未来 72 小时常规窗口；长达 30–60 天的稀有窗口应按需计算、限制成本。
- 采用历史已知窗口和天气测试向量交叉验证；未知规则标记为 `unverified`/`incomplete`。
- 后续基于鱼类 ID、区服及规则版本生成稳定事件键，不能只用显示文案去重。

### 7.2 统一提醒系统

`事件/窗口变化 -> 通知计划生成 -> notification_jobs -> Cron 扫描到期任务 -> 租约/重新验证 -> 逐设备 Web Push -> delivery 结果`。

- Cron 正常目标可按每分钟扫描；这是服务端处理目标而非手机显示时间承诺。
- 通知任务用 `dedup_key` 保证唯一性；抢占采用原子条件更新/租约；异常任务允许重试与过期租约回收。
- 发送前检查当前订阅是否生效、鱼是否已钓到、活动是否结束、免打扰是否限制发送。
- Web Push 成功只说明推送服务接受请求；终端收到/显示并非可靠可观测事件。
- 设备失效订阅应注销；临时错误指数退避，永久错误不无限重试。
- 可选的摘要/低优先级合并作为独立扩展，不影响 P0 独立通知。

### 7.3 活动数据

官方活动采用适配器拉取（只有在验证合法访问与可持续性后实现），保留 `source_url`、`last_verified_at`、`verification_status`；手工维护作为兜底。国服与国际服不可混合。非可靠来源不生成“准确截止提醒”。

## 8. 鱼糕/WebDAV 同步协议

### 8.1 已知兼容格式

历史鱼糕导出至少包含：

```json
{ "completed": [4776, 4925], "pinned": [], "alarmFish": [] }
```

- `completed`：已钓到 ID。
- `pinned`：收藏 ID。
- `alarmFish`：鱼类提醒偏好 ID。
- 三个集合互相独立，不能只同步 `completed`。
- 不认识的字段和未知鱼类 ID 必须保留，避免破坏鱼糕未来版本数据。

### 8.2 数据流与安全边界

```text
鱼糕本地状态 <-> Tampermonkey 适配器 <-> 用户 WebDAV
                         |
                         +---- HTTPS + Device Token ----> FF14 Hub API -> D1

FF14 Hub 服务端：只保存最小化必要鱼类状态、版本及订阅；不接收 WebDAV 用户名/密码。
```

- WebDAV 凭证仅存用户浏览器/脚本配置，建议使用 WebCrypto AES-GCM 与非导出密钥；正式版本强制 HTTPS 和 `@connect` 最小白名单；本地加密不能保证抵御设备被控或同执行环境恶意脚本。
- 双文件方案：`fish.json` 保持鱼糕兼容；`fish.sync.json` 存版本、数据修订、操作日志/同步水位。WebDAV 多文件写入通常不原子，必须容忍部分完成并通过下次同步修复。
- 支持 WebDAV 的 ETag/If-Match 条件写入；冲突时重新读取、重新比较；无条件写入前必须充分验证服务端支持情况或停止危险覆盖。
- 首次导入先展示合并预览及备份；后续基于字段级 Revision 与操作 ID 处理变更和取消状态。拒绝简单 `union(completed)` 作为通用冲突算法。
- 若本地客户端全部关闭，服务端只可使用最后同步的 D1 快照继续提醒，无法得知 WebDAV 后续变化；界面需要显示同步新鲜度。
- 现有旧脚本 `ff14-fish-engine-v1.4.0.user.js` 仅作为迁移参考，必须审查旧代码中 `localhost:8787`、`@connect *`、HTTP 地址允许、冲突取并集与只写 `completed` 的行为。

## 9. UI/UX、隐私与安全

### 9.1 界面行为

- 首屏支持选择预置工作台或从空白开始；默认预置不是永久绑定关系。
- 编辑模式可拖动、缩放、增删、复制、隐藏、设置 Widget；退出编辑模式持久化。
- 桌面建议 12 栏、平板 6–8 栏、手机 2–4 栏；各断点独立保存位置与尺寸，并提供非拖拽排序。
- Widget 配置必须先通过对应版本 Schema 校验，加载失败显示隔离的错误卡片而不导致全站崩溃。
- 未启用模块提供启用入口；用户删除全部页面组件后仍可进入组件库/设置及恢复默认。
- 提供深浅色主题与可访问性基础支持，但阶段 01 仅需结构化的基本 Shell。

### 9.2 安全准则

- 禁止在任何环境存放或输出真实 WebDAV 密钥、GitHub Token、VAPID 私钥或设备 Token。
- 禁止将第三方网站内容不经清理插入 `innerHTML`；导航 URL 只允许 `https:`（必要时允许有理由的 `http:`），显式拒绝 `javascript:`/`data:` 等危险协议。
- SSRF：Web Push 和任何服务器端 URL 访问要验证目的地、协议、域名与重定向链，禁止任意内网地址探测。
- 严格 CSP、安全响应头、API 限流、JSON 大小限制、日志脱敏；不要把 CORS 当做身份认证。
- 第三方 iframe Widget 要使用沙箱和独立权限；首期不允许加载任意 JS 插件。
- 所有外部抓取需遵守可用性、服务条款、数据许可；失败需降级，不能假数据冒充真实游戏信息。

## 10. 阶段路线图与依赖

> **总原则：先 Core，再 Module/Widget 基础，再布局和导航，最后接入业务与同步。** “功能可删除、可自定义”必须先于固定页面业务实现，避免后期重构。

| 阶段 | 目标 | 任务范围 | 前置依赖 | 结束门槛 |
|---|---|---|---|---|
| 01 | Core 工程与身份系统 | HUB-001～006 | 无 | 私有仓库、可运行、D1 迁移、设备鉴权、CI |
| 02 | Module Registry / Widget Host | HUB-043、044、050 | 01 | 模块注册、启停、生命周期、容器错误隔离 |
| 03 | 自定义工作台 | HUB-045、046、049、054 | 02 | 多页、布局、实例管理、备份恢复 |
| 04 | 自由导航与首页 | HUB-007～012、047、048、051 | 03 | 个人链接完全 CRUD，不受推荐目录强制覆盖 |
| 05 | 鱼类/活动/提醒 | HUB-013～027、035 | 01、02、03 | 时间规则有验证、后台提醒可运行 |
| 06 | 鱼糕/WebDAV 与发布 | HUB-028～042（适用项）、052、053 | 04、05 | 稳定同步、安全审查、部署及恢复演练 |

后续阶段的 P1（如 HUB-027、042、052、053）不阻塞核心 MVP，除非其被某个 P0 功能引用。阶段 04 与阶段 05 部分后端任务可以并行，但 **Widget 集成必须依赖 02/03 的契约**。

## 11. 任务目录（机器可检索稳定 ID）

**状态定义：** `todo` / `in_progress` / `blocked` / `review` / `done`。本文件中的任务都是 `todo`，除非后续由真实仓库证据更新。优先级 `P0` 必做、`P1` 后续。

> 阅读提示：下表任务条目是**需求定义**，不代表实现状态。阶段 01 的真实状态见文首「实施状态快照」。

### 11.1 阶段 01：当前必须执行

#### HUB-001 — 工程初始化
- **priority:** P0
- **depends_on:** []
- **scope:** 创建/检查 `jdysw/ff14-hub` 私有仓库；pnpm workspace、React + Vite、Workers + TypeScript 基础；声明 Node/pnpm 版本；README、.gitignore、env 示例。
- **deliverables:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `apps/web/`, `worker/`, `packages/shared/`, `README.md`。
- **acceptance:** `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build` 成功；本地 UI 可访问；不依赖实际生产密钥。
- **tests:** 安装、构建、基本启动冒烟测试。

#### HUB-002 — Cloudflare Workers 运行环境
- **priority:** P0
- **depends_on:** [HUB-001]
- **scope:** Hono Worker 入口、环境变量 Schema、Wrangler 配置、开发/预览/生产分离；预留 D1 Binding。
- **deliverables:** `worker/index.ts`, `wrangler.jsonc`, `worker/env.ts`, `.dev.vars.example`（仅占位）、相关文档。
- **acceptance:** Worker 可本地运行；静态前端与 `/api/v1/health` 可访问；机密配置未出现在前端 bundle 或仓库。
- **tests:** API 冒烟、错误环境配置处理。

#### HUB-003 — D1 数据模型与迁移
- **priority:** P0
- **depends_on:** [HUB-001, HUB-002]
- **scope:** `workspaces`、`devices`、`device_pairings`、`identity_audit` SQL/Drizzle schema；迁移工具和初始化方式。
- **deliverables:** `migrations/0001_core.sql`、ORM schema、迁移说明、测试种子（无真实凭证）。
- **acceptance:** 全新本地 D1 可应用迁移；重复迁移安全；FK、唯一约束、认证相关索引有效；预览与生产库分离。
- **tests:** Schema 约束和迁移重放测试。

#### HUB-004 — API 基础与校验
- **priority:** P0
- **depends_on:** [HUB-002, HUB-003]
- **scope:** Hono Router、Zod 验证、request ID、统一错误结构、私有 API 鉴权中间件、日志脱敏。
- **deliverables:** `worker/api/`, `worker/middleware/`, `packages/shared/` 内 API 类型契约。
- **acceptance:** 未认证请求对私有 API 返回 401；错误不暴露敏感内部信息；所有写 API 有输入校验。
- **tests:** 400/401/404/422/429/500 等关键错误路径（相关状态按实现范围适用）。

#### HUB-005 — CI 与测试基础
- **priority:** P0
- **depends_on:** [HUB-001, HUB-002]
- **scope:** ESLint、strict typecheck、Vitest、GitHub Actions、构建、依赖审查；预留 Playwright 用例目录。
- **deliverables:** `.github/workflows/ci.yml`、测试配置、规范文档。
- **acceptance:** PR CI 能运行 lint/typecheck/test/build；失败会让 CI 显示失败；不能用 `|| true` 隐藏失败。
- **tests:** 有至少一个真实 API 单元测试和失败路径测试。

#### HUB-006 — 单工作空间身份与设备管理
- **priority:** P0
- **depends_on:** [HUB-003, HUB-004, HUB-005]
- **scope:** 一次性 Bootstrap、强随机恢复密钥、设备 Token 发放与摘要、设备列表/撤销、有限时单次配对、恢复访问、审计与速率限制。
- **deliverables:** `worker/modules/identity/`, 认证 API、迁移补丁（如需）、安全测试与文档。
- **acceptance:** Bootstrap 无法重复建立工作空间；设备 Token 不明文落库；撤销后立即拒绝；旧/过期配对码不可重复领取；不同设备有独立凭证；恢复密钥不进日志。
- **tests:** 初始创建、重复 Bootstrap、无效/撤销 Token、过期配对、并发领取、恢复路径、恶意请求及越权用例。

**阶段 01 完成定义：** 以上六项全部 `done` + PR 合并 + CI 通过 + 本地 D1 迁移与授权 E2E 可复现。是否部署到 Cloudflare **预览环境**以当时可用凭证为准；生产部署单独授权。

### 11.2 其他任务索引

以下任务均需建立 GitHub Issue，具体字段、测试在开始前根据同一 PRD 补足；不能以表格一行代替真正实现。

| ID | 优先级 | 内容 | 最小验收依据 | 前置 |
|---|---|---|---|---|
| HUB-007 | P0 | 导航种子数据与分类 | 可重入的目录导入 | 047 |
| HUB-008 | P0 | 导航搜索与筛选 | 分类、关键字、区服过滤通过 | 007,048 |
| HUB-009 | P0 | 收藏和个人排序 | 持久化、多设备同步 | 048,051 |
| HUB-010 | P0 | 首页工作台 | Widget 显示、空态恢复 | 045,046 |
| HUB-011 | P0 | 活动手工维护与列表 | 起止时间、来源、过期逻辑 | 004,044 |
| HUB-012 | P0 | 响应式 PWA | 可安装、手机无溢出 | 001,045 |
| HUB-013 | P0 | 游戏数据 Adapter | 记录数据版本与校验状态 | 004 |
| HUB-014 | P0 | ET/天气计算核心 | 固定历史向量通过 | 013 |
| HUB-015 | P0 | 鱼类规则 Schema | 复杂条件可扩展、版本化 | 013,014 |
| HUB-016 | P0 | 未来鱼类窗口 API | 已验证鱼正确输出窗口 | 014,015 |
| HUB-017 | P0 | 钓鱼 Widget / 页面 | 按窗口及条件过滤 | 016,044 |
| HUB-018 | P0 | 三字段鱼类进度 | 已钓/收藏/提醒独立持久化 | 003,013 |
| HUB-019 | P0 | 钓鱼历史案例校验 | 复杂天气链回归准确 | 016 |
| HUB-020 | P0 | 提醒规则管理 | CRUD、提前量、启停 | 018,011 |
| HUB-021 | P0 | 通知任务生成与去重 | `dedup_key` 唯一、窗口变更重算 | 020 |
| HUB-022 | P0 | Cron 与租约调度 | 并发执行不重复领取任务 | 021 |
| HUB-023 | P0 | Web Push 服务 | 设备订阅、测试通知有效 | 006,022 |
| HUB-024 | P0 | 重试与投递明细 | 区分临时/永久失败 | 023 |
| HUB-025 | P0 | 已完成/已取消自动抑制 | 不再生成或发送无效任务 | 018,020,022 |
| HUB-026 | P0 | 提醒管理 Widget | 规则、历史及设备状态可管理 | 023,044 |
| HUB-027 | P1 | 摘要及免打扰 | 合并低优先级通知 | 024 |
| HUB-028 | P0 | 鱼糕 JSON 适配 | 三数组和未知字段不丢失 | 018 |
| HUB-029 | P0 | 客户端 WebDAV 适配 | HTTPS，凭证不进后端 | 028 |
| HUB-030 | P0 | 修订号/幂等同步 | 相反修改冲突不静默覆盖 | 018,028 |
| HUB-031 | P0 | ETag 与中断恢复 | 并发与部分写入可恢复 | 029,030 |
| HUB-032 | P0 | 鱼糕油猴脚本更新 | 正式 API、受限域、同步正常 | 028–031 |
| HUB-033 | P0 | 个人数据导入导出 | 可预览、回滚、恢复 | 030,054 |
| HUB-034 | P0 | 多设备同步 E2E | 增删改/取消已钓跨端一致 | 030–033 |
| HUB-035 | P0 | 区服隔离验证 | CN/Global 规则不混用 | 013,015 |
| HUB-036 | P0 | 全链路 E2E | 关键路径自动化通过 | MVP 所有 P0 |
| HUB-037 | P0 | 安全审计 | 无未处理高危问题 | MVP 所有 P0 |
| HUB-038 | P0 | 预览/生产隔离 | 独立 D1/Secrets | 002 |
| HUB-039 | P0 | 观测与告警 | Cron、数据源、通知、同步错误可检测 | 022,031 |
| HUB-040 | P0 | 部署与回滚演练 | 预览/生产发布及备份恢复有记录 | 036–039 |
| HUB-041 | P0 | 用户与维护文档 | 能独立部署、备份、恢复 | 040 |
| HUB-042 | P1 | 官方资讯 Adapter | 来源与时间可验证 | 011 |
| HUB-043 | P0 | Module Registry | Manifest 验证、模块发现 | 001,004 |
| HUB-044 | P0 | Widget Host | 多实例、配置 Schema、错误隔离 | 043 |
| HUB-045 | P0 | 布局编辑器 | 拖拽、缩放、隐藏、删除、撤销 | 044 |
| HUB-046 | P0 | 多页面与独立断点 | 新建、切换、不同端独立布局 | 045 |
| HUB-047 | P0 | 推荐导航 vs 个人导航分离 | 删除后升级不强制恢复 | 003 |
| HUB-048 | P0 | 用户网站/分类/分组 CRUD | 自定义内容完整增删改 | 047 |
| HUB-049 | P0 | 模板、空白页与重置 | 全删后仍可恢复 | 046 |
| HUB-050 | P0 | 模块生命周期/数据策略 | 停用≠删除，后台任务正确暂停 | 043 |
| HUB-051 | P0 | 布局/导航跨设备同步 | Revision、墓碑、冲突处理 | 046,048,006 |
| HUB-052 | P1 | 通用自定义数据 Widget | Schema 验证且访问受控 | 044 |
| HUB-053 | P1 | 第三方扩展隔离设计 | 不可信组件不接触主站密钥 | 043 |
| HUB-054 | P0 | 工作台配置备份恢复 | 带版本 JSON 导入导出成功 | 046,050 |

## 12. 发布、验收和质量门槛

### 12.1 自动化验证矩阵

| 类别 | 必需测试 | 适用阶段 |
|---|---|---|
| 工程 | frozen install、typecheck、lint、build、smoke test | 01 |
| 身份 | Bootstrap 并发/重放、设备撤销、配对过期、恢复、越权 | 01 |
| Module | 多实例、生命周期、无效 Manifest、错误边界 | 02 |
| 工作台 | 空布局恢复、桌面/手机布局、冲突/撤销/导出 | 03 |
| 导航 | CRUD、删除墓碑、官方目录升级不恢复个人删除项 | 04 |
| 游戏 | ET 与天气边界、复杂规则及已知窗口对照 | 05 |
| 通知 | 幂等、租约、失败重试、停用抑制、设备失效 | 05 |
| 同步 | 首次导入、冲突、撤销标记、ETag、断网恢复、未知字段 | 06 |
| 安全 | 私有 API、URL 校验、SSRF、XSS、秘密泄漏检查 | 全阶段 |

指标目标（不是无条件保证）：缓存后的本地导航筛选 <200ms；正常网络下首页 LCP 目标 <2.5s；Cron 到期服务端处理监控目标 ≤2 分钟；核心 ET/天气测试向量 100% 通过；相同订阅事件的逻辑任务不重复建立；私有 API 越权测试全部通过。

### 12.2 Definition of Done

一个任务只有同时满足以下条件才标记 `done`：

- 功能完成并符合本文件的前置条件/不变量。
- 有可运行自动化测试，适用情况下覆盖错误与边界输入。
- Lint、TypeScript、Build、相关测试都**实际通过**；未运行要标记未运行。
- 数据库变更提供 Migration 和回滚/兼容性说明。
- 涉及秘密、身份、通知、同步和远程数据时附安全审查说明。
- 新能力有 README/文档与必要使用说明。
- GitHub PR/提交可追溯；合并后清理无用分支，不频繁发正式 Release。

### 12.3 发行节奏

- `v0.1.0`：可定制导航 + 工作台基本能力 + 核心个人提醒（以实际 P0 验收为准）。
- `v0.2.0`：鱼糕/WebDAV 全量双向同步、复杂鱼类窗口完善、多设备稳定性。
- `v0.3.0`：自动活动聚合、个人进度与消息摘要优化。
- `v1.0.0`：完整功能、安全审计、恢复演练、长期监控。

**版本号仅为规划，实际发布依赖验收而非日历。**

## 13. 风险与应对

| 风险 | 严重度 | 措施 |
|---|---|---|
| WebDAV 合并覆盖用户删除/取消操作 | 高 | 字段级 Revision、墓碑、冲突预览、条件写入 |
| 本地插件未在当前调用环境可见 | 高（执行阻断） | 先发现实际插件工具；不可见即报告，不声称已派发 |
| 无账号的恢复密钥遗失 | 高 | 首次强制提示备份、设备独立授权与撤销 |
| 高稀有鱼规则不准确 | 高 | 历史测试、规则版本、未验证标记 |
| 浏览器推送受系统条件限制 | 高 | 记录服务端投递结果；提供提醒历史/多设备 |
| 外站/鱼糕结构变更 | 中 | Adapter、数据版本与兼容测试 |
| 预置目录更新覆盖个人导航 | 高 | 系统推荐库与用户副本分离、删除墓碑 |
| 用户删除全部 Widget 导致无法管理 | 高 | App Shell 系统级管理/恢复入口不可移除 |
| 模块停用后仍持续发通知 | 高 | 生命周期中断调度，投递前检查模块状态 |
| Cloudflare 免费额度限制和定时成本 | 中 | 缓存与增量任务、监控配额、按需升级 |

## 14. 待定事项及默认决策

未由用户进一步指定时，**以此默认值直接推进，不要阻塞阶段 01**：

| 事项 | 默认值 | 后续允许调整 |
|---|---|---|
| 仓库可见性 | private | 是 |
| 默认地区 | cn | 是 |
| 默认显示语言 | zh-CN | 是 |
| 默认时区 | Asia/Shanghai | 是 |
| 登录方式 | 无注册，恢复密钥 + 设备独立 Token | 不得无授权变成传统账号系统 |
| 布局保存 | 网格/断点独立存储，乐观并发 | 是 |
| 预置导航 | 导入成为私人副本，而非仅动态覆盖 | 是，但不可破坏个人删除语义 |
| WebDAV 凭证 | 客户端保管，服务器不存 | 不得改变 |
| 插件机制 | 内置模块优先；不执行第三方 JS | 后续可加隔离运行时 |
| 正式部署域名 | 暂不绑定；候选 `ff14.zhixia.uk` | 是，部署前确认 |
| 部署方式 | 先本地/预览，生产需授权 | 是 |

## 15. AI 快速接手摘要（Context Pack）

```yaml
project: FF14 Hub
repo: jdysw/ff14-hub
repo_visibility: private
current_phase: "01"
current_tasks: [HUB-001, HUB-002, HUB-003, HUB-004, HUB-005, HUB-006]
product_identity: customizable_ff14_dashboard
must_have:
  - free_edit_personal_navigation
  - independent_module_widget_lifecycle
  - multi_page_responsive_drag_resize_layout
  - accountless_secure_single_workspace
  - server_side_reminders
  - cn_first_global_ready
  - client_only_webdav_credentials
  - ffmomola_completed_pinned_alarmFish_roundtrip
current_deliverables:
  - pnpm_typescript_react_vite_worker_hono
  - d1_migrations
  - device_identity_and_recovery
  - api_validation_and_auth
  - tests_ci
forbidden:
  - edit_other_repositories
  - fake_test_results
  - server_side_webdav_credentials
  - silent_sync_overwrite
  - hardcode_future_widgets_into_homepage
  - publicly_register_unbounded_users
before_reporting_done:
  - actual_tests_passed
  - code_committed_and_reviewable
  - migration_verified
  - auth_security_verified
```

**维护要求：** 每次阶段验收后由负责 Agent 更新 `current_execution` 状态、已完成任务及变更记录；不要把“计划已确定”误标为“功能已开发”。

## 16. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-10-18 | 本文件首次进入仓库 | 保存用户批准的完整规划；同时更新 `current_execution` 以反映真实执行状态（阶段 01 HUB-001～005 已实现待评审、HUB-006 未开始、未部署）。规划正文未做删改。 |
| 2026-10-18 | 更新 HUB-006 状态 | HUB-006 后端身份系统（Bootstrap / 配对 / 恢复 / 设备管理 / 速率限制 / 审计）已实现并带真实 Workers+D1 测试；状态改为 `implemented_pending_review`。前端身份界面仍未实现。规划正文未做删改。 |
| 2026-10-18 | 阶段 01 合并 + 阶段 02 实施 | 阶段 01 经 GPT 独立复核后以 PR #1 squash 合并入 `main`（merge commit `c65e29e`，`main` CI run `39063324867` success），HUB-001～006 状态改为 `merged`。阶段 02（HUB-043 / HUB-044 / HUB-050）在分支 `codex/phase02-modules` 实施：模块静态注册表与诊断、Widget Host 与静态组件映射、`workspace_modules` 迁移与生命周期契约、公开目录与设备鉴权端点、模块管理与组件验收视图、React 与 Playwright 验收测试。状态为 `implemented_pending_review`（草稿 PR，未合并）。规划正文未做删改；阶段 02 的具体取舍记录在 `docs/adr/0002-phase02-module-runtime.md`。 |
| 2026-10-18 | 阶段 02 复核修复 | 按集中复核意见修正五个真实缺陷：① 生命周期改为「先原子准入提交状态 → 副作用 → 收尾」，CAS 输家在任何可变副作用前退出，副作用失败以 200 + `pending/failure` 如实暴露并持久化待完成操作（新增 `0004_module_operations.sql`），可用同动作 + 同 revision 幂等重试；② 模块服务端口改为闭包绑定作用域 + `scheduled:own` 执行期门禁，平台管理端口不交给模块，初始化豁免需数据库核对；③ 前端按不含明文凭证的会话代际隔离私有快照/Host 实例/在途响应；④ Widget Host 以注册表为归属权威，配置迁移抛错降级到本实例，report 回调按 attempt 隔离；⑤ Registry 补同 Manifest 内 route 重复检测，handler/组件表改用 `Object.hasOwn`。取舍记录在 ADR-0002（D4 重写、新增 D13–D17）。规划正文未做删改。 |
| 2026-10-18 | 阶段 02 二次复核修复 | 按第二轮集中复核修正三处：① 生命周期增加**独占执行认领**（`workspace_module_operation_claims`，token + 租约），`attempts` 在认领事务内递增，收尾/失败写入以 token 为条件，端口清理加 revision fence（`maxRevision`/`upToRevision`）——被取代的旧执行者在副作用前退出，且删不掉 restore 之后的新实例/新任务（新增迁移 `0005`）；② 状态读取改为**单一 LEFT JOIN 快照**（`readStatus`/`listStatuses`/门禁/变更后读取同源），并把「该模块没有待完成操作」写进准入 CAS 的条件，避免「enabled 且无 pending」的假快照与标记被静默吞掉；③ 会话作用域容器改为**整个会话期间保持挂载**（只按 generation 重挂），切换视图不再丢实例，仅切换/清除凭证才清空，并新增前端「只接受不小于已知 revision 的写响应」fence。ADR-0002 的 D4 再次重写并新增 D18–D20。规划正文未做删改。 |
| 2026-10-18 | 阶段 02 三次复核修复（fence 传播） | 把执行归属传入模块调度视图：`ModuleScopedScheduler` 绑定本次执行的 `token` + 准入 revision，`schedule`/`cancel` **每次可变调用前**都校验执行权并把该 revision 作为上界；`schedule` 校验 `expectedRevision` 且以它作为新任务的 `createdRevision`（拒绝过期执行者、不把旧代提升为新代），`insert` 在途发生接管/restore 时按旧代撤销自己的插入（`deleteByKey({ upToRevision: 旧代 })`）；单 key 取消也加 revision fence（不再只保护 `cancelAllForModule`）。新增真实 D1 + deferred handler/store 回归：handler 跨租约被取代后其内部 cancel/schedule 均为 `execution_superseded` 且新代任务不被删除/冒充；insert 在途（写入前/写入后）两种交错的迟到清理。ADR-0002 D4 阶段 3 与 D15 同步更新。规划正文未做删改。 |
| 2026-10-18 | 阶段 02 合并 + 阶段 03 实施 | 阶段 02 在 head `eec978a5`、CI run `39071393657` 两项 success、工作树干净且 mergeable CLEAN 的条件下标 ready 并 squash 合并（merge commit `b9acfb2`，`main` CI run `39071908808` 两项 job success），已删除已合并远程分支 `codex/phase02-modules`，Issues #2/#3/#4 由 PR 关联关闭，HUB-043/044/050 状态改为 `merged`。阶段 03（HUB-045 / 046 / 049 / 054）在分支 `codex/phase03-workbench` 实施，Issues #6–#9，以**草稿 PR #10** 提交复核（未合并、未部署）：新增迁移 `0006_workbench.sql`（`workspace_pages` / `widget_instances` / `widget_layouts` / `page_layout_revisions` / `workspace_workbench_state` / `workbench_operations` / `workbench_backups`）、`worker/modules/workbench/`（原子幂等事务、页面/实例/布局/模板服务、备份恢复、真实 D1 实例清理端口）、`worker/api/v1/me-workbench.ts`、`packages/shared/src/workbench-api.ts`（唯一布局校验实现 + 模板 + 备份契约）与前端工作台视图；依赖锁定 `react-grid-layout@2.3.0`。复核期修掉 7 个真实缺陷（幂等短路时机、merge 默认页唯一性、导入 slug 冲突、首次 bump 偏移、模板/导入模块门禁时间窗、`:id` 路由 404 语义不一致、前端拖动因漏透传 `onMouseDown` 而静默失效）。取舍与边界记录在 `docs/adr/0003-phase03-workbench.md`（含 D13.1）。规划正文未做删改。 |
| 2026-10-18 | 阶段 03 集中复核加固 | 按集中复核修复六处语义缺口与两处安全静态分析问题，记录在 ADR-0003 D17：① 并发新增/复制的空位与「规划时看到的三个断点布局修订号 + 实例数」一起进认领条件，杜绝两个不同 operationId 各自选中同一空位都提交；② 导出改为**单 batch 四条 SELECT**的一致快照并反校验文档；③ 撤销点的「未消费校验 + 标记消费」与页面替换同事务，恢复要求 `expectedRevision`，重复消费返回 409；④ 导入确认新增 `previewToken`（绑定 document + mode + 工作台 revision + 相关模块门禁），任何变化 409 要求重新预览，不再以「执行时跳过实例」事后改变用户确认；⑤ 幂等键新增请求指纹（同 ID 换目标/正文/预期 revision → 409 且零写入），入口短路与事务冲突路径同判据；⑥ 实例清理用本次随机标记限定影响范围，0 个新增墓碑时零 revision 变更。新增迁移 `0007_workbench_hardening.sql` 只用 `CREATE ... IF NOT EXISTS`（两张配套表），因 SQLite 不支持 `ADD COLUMN IF NOT EXISTS` 而「迁移语句可逐条重放」是既定验收点。安全侧：移除 `Math.random` 兜底、把超线性回溯正则换成线性扫描；同时拆分三处认知复杂度超标函数（不改行为）。规划正文未做删改。 |
