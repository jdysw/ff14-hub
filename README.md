# FF14 Hub

FF14 个人导航与模块化工作台。默认面向国服玩家与个人自用，预留国际服扩展。

**当前状态：阶段 01（Core 工程与身份基础）已合并入 `main`；阶段 02（模块系统 HUB-043 / 044 / 050）
已实现，位于分支 `codex/phase02-modules` 的草稿 PR，尚未合并。未部署。**
已能跑通的是「工程基线 + 统一 API + D1 迁移 + 单工作空间身份系统 + 模块注册表 + Widget Host
+ 模块生命周期契约 + CI/浏览器验收」，
**不是**一个可用的 FF14 工具站：导航、鱼类、多页面工作台编辑器、提醒与同步均未实现。
界面上出现的组件全部是**明确标注的演示组件**（`demo.*`），没有任何游戏业务数据。

- 完整开发规划（单一事实来源）：[`docs/FF14_Hub_AI_Development_Plan.md`](docs/FF14_Hub_AI_Development_Plan.md)
- 安全边界（已生效的边界与已知限制）：[`docs/security-boundaries.md`](docs/security-boundaries.md)
- Module / Widget 边界（含阶段 01/02 实际落地与刻意未做）：[`docs/module-widget-boundaries.md`](docs/module-widget-boundaries.md)
- 工程决策记录：[`docs/adr/0001-phase01-engineering-decisions.md`](docs/adr/0001-phase01-engineering-decisions.md)、
  [`docs/adr/0002-phase02-module-runtime.md`](docs/adr/0002-phase02-module-runtime.md)

## 1. 环境要求

| 项目 | 版本 | 说明 |
|---|---|---|
| Node.js | `>=22.12.0`（本地验证于 24.19.0） | 见 `package.json` 的 `engines` 与 `.nvmrc` |
| pnpm | `>=10`（本地验证于 11.22.0） | `packageManager` 字段固定为 `pnpm@11.22.0` |

依赖版本集中锁定在 `pnpm-workspace.yaml` 的 `catalog:` 中，均为安装前核对官方 peer/engines
兼容性后选定的**确切版本**。`.npmrc` 刻意不覆盖 registry：本地沿用你的 registry 配置，
CI 使用 runner 默认 registry，`pnpm-lock.yaml` 只记录 integrity、不绑定 registry 主机。

## 2. 快速开始

```bash
pnpm install --frozen-lockfile   # 冻结安装（CI 与验收使用同一命令）
pnpm run lint                    # ESLint（含类型感知规则）
pnpm run typecheck               # strict TypeScript（含 tests/e2e 的 Playwright 用例）
pnpm run test                    # Node 单测 + React 组件测试 + 真实 workerd/Miniflare D1 测试
pnpm run build                   # 前端产物 + Worker 打包干跑（不部署）
pnpm run verify                  # 上面四步串联
pnpm run e2e:phase02             # 真实浏览器验收链（本地 wrangler dev + 本地 D1）
```

本地同域开发与冒烟：

```bash
pnpm run db:migrate:local        # 应用 D1 迁移到本地 SQLite（不访问 Cloudflare）
pnpm run build:web               # 先生成 dist，Worker 的静态资源绑定指向它
pnpm run dev:api                 # wrangler dev，默认 http://127.0.0.1:8787
pnpm run smoke:local             # 另开终端：同域静态页 + /api/v1/health 冒烟
```

身份系统端到端冒烟（需要本地 `.dev.vars` 中配置了初始化密钥）：

```powershell
# 先生成一个本地随机初始化密钥写入 .dev.vars（该文件不入库）
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
"BOOTSTRAP_SECRET=`"$secret`"" | Set-Content .dev.vars
pnpm run db:migrate:local
pnpm run dev:api
# 另开终端
$env:FF14_E2E_BOOTSTRAP_SECRET = $secret
pnpm run smoke:identity
```

该脚本覆盖 Bootstrap → 配对 → 领取 → 撤销即时失效 → 恢复 的完整链路，
并且只输出判定结果，**不打印任何凭证**。

`pnpm run dev` 只启动 Vite 开发服务器（前端热更新，不同域）；要做同域联调请用 `dev:api`。

## 3. 环境变量与本地凭证

- 示例文件：`.dev.vars.example`（**只有占位符**）。复制为 `.dev.vars` 后自行填入本地随机值；
  `.dev.vars` 已被 `.gitignore` 忽略，绝不入库。
- `BOOTSTRAP_SECRET` 由 `POST /api/v1/identity/bootstrap` 使用；未配置或长度不足 32 时该端点
  返回 503（fail-closed），因此它在运行时是**可选**的。
- `pnpm run e2e:phase02` **不写、不读、不覆盖** `.dev.vars`：它用 `wrangler dev --var` 注入
  本次运行随机生成的一次性初始化密钥。
- 任何真实 Token、恢复密钥、VAPID 私钥都不得出现在仓库、日志或错误响应中。
- 本地 / 预览 / 生产必须使用各自独立的 D1 与密钥，不得共用。

`wrangler.jsonc` 中的 `database_id` 是本地占位值；真实远程 ID 只能由人工授权执行
`wrangler d1 create` 后填入。

## 4. D1 迁移

迁移文件位于 `migrations/`，由 `wrangler d1 migrations apply` 管理；**事实来源是 SQL**，
`worker/db/schema.ts` 的 Drizzle 定义只是它的类型化镜像（不参与建表）。

```bash
pnpm run db:migrate:local          # 应用未执行的迁移（全新库）
pnpm run db:migrate:local          # 再跑一次：应为 "No migrations to apply!"
pnpm run db:migrations:list:local  # 查看已应用清单
```

已落地：
- `migrations/0001_core.sql` —— `workspaces` / `devices` / `device_pairings` / `identity_audit`，含外键、唯一索引、枚举 CHECK。
- `migrations/0002_identity.sql` —— `workspace_bootstrap_guard`（单例初始化守卫）、`auth_rate_limits`（限流计数）、
  `pairing_claims`（配对独占占位，经 FK 链回溯到工作空间）、以及撤销审计的部分唯一索引。
- `migrations/0003_modules.sql` —— `workspace_modules`：`(workspace_id, module_id)` 主键、状态 CHECK
  （只允许 `enabled` / `disabled` / `uninstalled`）、设置与设置版本、`revision` 乐观并发列、
  安装/启停/卸载时间戳。**停用与卸载都不删除本行**，因此个人设置会保留（卸载 ≠ 清数据）。
- `migrations/0004_module_operations.sql` —— `workspace_module_operations`：待完成生命周期操作的
  持久事实（`action` / `target_status` / `revision` / `attempts` / `last_error`），复合外键指向
  `workspace_modules` 并级联删除。存在即表示「状态已提交、收尾未完成或失败待重试」，
  此时门禁为 `transitioning`（不执行组件、不排程）。
- `migrations/0005_module_operation_claims.sql` —— `workspace_module_operation_claims`：
  **独占执行认领**（`token` / `claimed_at` / `expires_at`），主键保证同一模块同时只有一个执行者；
  所有收尾/失败写入以 token 为条件，端口清理以模块 revision 为 fence。

约定与注意点：

- 通篇使用 `IF NOT EXISTS`，**重复应用安全**（`worker/test/migrations.spec.ts` 与
  `worker/test/module-schema.spec.ts` 会把拆分出的每条语句再跑一遍来验证，而不是只依赖记账表的短路）。
- D1 **默认开启外键约束**，因此迁移里不写 `PRAGMA foreign_keys`；不要假设它在某些环境下关闭。
- 事务与并发行为必须实测 D1，不能假设与独立 SQLite 完全一致。
- 生产 Schema 不在启动时隐式修改，只能通过新迁移文件演进。

阶段 03 才会新增 `workspace_pages` / `widget_instances` / `widget_layouts` 等表（见规划 5.2），本轮**未**迁移。

## 5. 目录结构

```text
ff14-hub/
├── apps/web/            React + Vite 前端（App Shell + 导航视图 + 模块管理/组件验收 + Widget Host + PWA）
│   ├── src/app/shell/   常驻系统入口、视图切换、会话凭证入口
│   ├── src/app/modules/ 模块 API 绑定、模块状态、模块管理界面、变更→实例联动
│   ├── src/app/widgets/ Widget Host、静态组件映射、实例存储、演示组件、**模块数据端口注册表**
│   ├── src/app/workbench/ 工作台页面/实例/布局编辑器、模板与备份恢复面板
│   ├── src/app/nav/     导航视图、目录/书签导入预览、导航 Widget、导航数据端口
│   ├── src/app/events/  活动 Widget（人工维护）与活动数据端口
│   ├── src/app/pwa/     Service Worker 注册、缓存策略（纯函数）、离线/安装状态
│   ├── public/          manifest.webmanifest、sw.js、图标（静态资源，同域提供）
│   └── src/lib/         API 客户端、渲染错误边界
├── worker/              Cloudflare Workers API（Hono + Zod + D1）
│   ├── api/v1/          health / modules / navigation(公开目录) / events(公开活动) / identity /
│   │                    me(模块、工作台、导航、活动、同步水位) / __test__
│   ├── middleware/      requestId、环境校验、写请求守卫、错误处理、认证、安全头、输入校验
│   ├── modules/identity/  身份契约的代码落点（凭证原语、配对、设备、恢复、审计）
│   ├── modules/registry/  模块静态注册表、内置模块（演示 + ff14.navigation/ff14.events）、服务端 handler 表
│   ├── modules/lifecycle/ 生命周期服务、workspace_modules 读写、调度与实例清理端口实现
│   ├── modules/idempotency/ 幂等账本**唯一实现**（认领 + 守卫 + 指纹 + 原子 batch）
│   ├── modules/workbench/ 工作台服务、实例存储、备份恢复、事务骨架绑定
│   ├── modules/nav/      推荐目录种子与版本化 upsert、导航服务、幂等账本绑定
│   ├── modules/events/   个人活动服务（人工维护；无抓取/无提醒）
│   ├── modules/sync/     跨设备变更/水位扫描（只读）
│   ├── modules/ports.ts   生命周期端口与受限上下文定义
│   ├── db/              Drizzle schema 与客户端
│   └── test/            Workers 运行时测试（真实 workerd + Miniflare D1）
├── packages/shared/     前后端共用纯契约（错误、身份、Module/Widget Schema、工作台、导航、活动、同步）
├── migrations/          D1 SQL 迁移（事实来源，0001–0010）
├── scripts/             冒烟脚本 + 阶段 02/03/04 浏览器验收链编排（e2e-phase0N.mjs）
├── tests/e2e/           Playwright 用例（阶段 02 起启用，阶段 04 见 phase04-navigation.spec.ts）
└── docs/                规划、安全边界、Module/Widget 边界、ADR
```

## 6. API（阶段 04 实际可用范围）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 就绪探针：会真实探测 D1 |
| POST | `/api/v1/identity/bootstrap` | 一次性初始化唯一工作空间；需要 `X-Bootstrap-Secret`，成功后通道关闭（再调 409） |
| POST | `/api/v1/identity/pairing` | 已认证设备生成一次性、有限期配对凭证（TTL 60–3600 秒） |
| POST | `/api/v1/identity/pairing/claim` | 凭配对凭证领取新设备凭证；一次性消费，发起设备被撤销后立即失效 |
| POST | `/api/v1/identity/recover` | 用离线备份的恢复密钥换发新设备凭证 |
| GET | `/api/v1/me/profile` | 当前工作空间的非敏感配置 |
| GET | `/api/v1/me/devices` | 本工作空间设备列表（不含 `token_hash`） |
| DELETE | `/api/v1/me/devices/:id` | 撤销设备；**立即生效**（认证每个请求都查库，无进程内缓存） |
| GET | `/api/v1/modules/catalog` | **公开**模块目录：只含 ID/版本/展示名/能力/Widget 定义/路由/设置版本；不含 handler 名与个人状态 |
| GET | `/api/v1/me/modules` | 本工作空间模块有效状态（`not_installed` 为行缺失派生值） |
| GET | `/api/v1/me/modules/:id` | 单个模块状态；未注册模块返回 404 |
| PATCH | `/api/v1/me/modules/:id` | 生命周期变更 / 设置写入；**必须带 `expectedRevision`**，不匹配返回 409 |
| POST | `/api/v1/me/modules/:id/purge` | 清数据入口：本阶段**显式拒绝**（501），并明确说明没有删除任何数据 |
| GET | `/api/v1/me/workbench` | 工作台快照：页面列表 + 默认页 + 工作台 revision + 容量上限 |
| GET/POST | `/api/v1/me/pages` | 列出 / 新建页面（`POST` 可带 `templateId`；空白页合法） |
| PATCH/DELETE | `/api/v1/me/pages/:id` | 改名 / 排序 / 设为默认页 / 删除（墓碑；必须带 `expectedRevision`） |
| POST | `/api/v1/me/pages/:id/restore` | 从墓碑恢复页面（连同其组件实例与布局） |
| GET/PUT | `/api/v1/me/pages/:id/layout` | 读取三断点布局 / 保存**单个**断点的整页布局（`baseRevision` 必填，陈旧写 409） |
| GET/POST | `/api/v1/me/pages/:id/widgets` | 列出 / 添加组件实例（服务端校验模块门禁、单例约束与尺寸） |
| PATCH/DELETE | `/api/v1/me/widgets/:id` | 改配置 / 隐藏 / 移除（隐藏 ≠ 移除，都不影响模块与个人数据） |
| POST | `/api/v1/me/widgets/:id/duplicate` | 复制实例（独立配置与初始位置） |
| GET | `/api/v1/me/workbench/templates` | 四种初始模板（含 `honestyNote` 诚实说明） |
| POST | `/api/v1/me/workbench/apply-template` | 应用模板：`new_page` / `replace_page` / `reset_workspace` |
| GET | `/api/v1/me/workbench/backup` | 导出工作台配置（`schemaVersion` 版本化 JSON，**不含任何凭证**） |
| GET | `/api/v1/me/workbench/backups` | 可恢复备份列表（替换导入时自动生成的那份也在内） |
| POST | `/api/v1/me/workbench/import/preview` | 预览导入：新增/替换/跳过计数、影响范围、未知模块、问题列表（**不写入**）；返回 `previewToken`（绑定 document + mode + 工作台 revision + 相关模块门禁） |
| POST | `/api/v1/me/workbench/import/apply` | 显式确认（`confirm: true` + `previewRevision` + `previewToken`）后按 workspace 事务应用；令牌不匹配 → 409 要求重新预览 |
| POST | `/api/v1/me/workbench/backup/:id/restore` | 用可恢复备份撤销一次替换导入（`expectedRevision` 必填；撤销点的消费与替换**同事务**，一份只能用一次） |
| GET | `/api/v1/navigation/catalog` | **公开**推荐目录（只读系统目录；条目带 `sourceUrl`/`verifiedAt`/`region`/`verificationStatus`，**不含**任何个人数据） |
| GET | `/api/v1/me/navigation` | 导航快照：链接 + 分组 + 多分组归属 + 导航 revision + 目录版本 + 容量上限 |
| GET | `/api/v1/me/navigation/links` | 服务端筛选/排序视图（`text`/`groupId`/`region`/`status`/`favoritesOnly`/`tag`/`sort`），与前端**共用同一份纯函数** |
| POST | `/api/v1/me/navigation/links` | 新建个人链接（`operationId` 幂等；`groupIds` 直接建立多分组归属） |
| PATCH/DELETE | `/api/v1/me/navigation/links/:id` | 改名/改 URL/描述/标签/别名/图标/打开方式/区服/收藏/状态/顺序；删除是**墓碑**（`expectedRevision` 必填，冲突返回结构化 409） |
| POST | `/api/v1/me/navigation/links/reorder` | 整体替换个人排序（给出的 ID 集合必须与当前活跃集合一致，否则拒绝且零改动） |
| PUT | `/api/v1/me/navigation/links/:id/groups` | 整体替换该链接的分组归属（多分组） |
| GET/POST | `/api/v1/me/navigation/groups` | 列出 / 新建个人分组（分类） |
| PATCH/DELETE | `/api/v1/me/navigation/groups/:id` | 改名 / 重排 / 删除（墓碑；链接本身保留） |
| POST | `/api/v1/me/navigation/groups/reorder` | 整体替换分组顺序 |
| POST | `/api/v1/me/navigation/catalog/import` | 从推荐目录导入：`new` 新建、`user_modified` **不覆盖**、`tombstoned` **不复活**（除非 `explicitReimport`） |
| POST | `/api/v1/me/navigation/import/preview` | 书签/JSON 导入预览：逐项 `accepted`/`skipped`（原因：非 https、重复、缺标题、超限…），**不写入** |
| POST | `/api/v1/me/navigation/import/apply` | 确认后按 `operationId` 幂等写入；`expectedRevision` 保证预览不过期才应用 |
| GET | `/api/v1/me/navigation/export` | 导出个人导航（版本化 JSON，可 roundtrip，**不含任何凭证**） |
| GET | `/api/v1/events` | **公开**活动列表（只含公共来源表；本阶段该表为空，诚实返回空数组；`region`/`phase`/`text`/`sort` 可选） |
| GET/POST | `/api/v1/me/events` | 个人活动列表 / 新建（标题、区服 cn\|global、UTC 起止、描述、来源链接；`operationId` 幂等） |
| PATCH/DELETE | `/api/v1/me/events/:id` | 修改 / 删除（墓碑；`expectedRevision` 必填，冲突返回结构化 409） |
| GET | `/api/v1/me/sync/changes` | **只读**跨设备变更/水位（`since` 游标 + `limit`）：覆盖页面/实例/布局/导航链接/分组/成员关系/模块/个人活动；墓碑以 `op:"delete"` 传播 |

统一错误结构：`{ "code": "...", "message": "...", "requestId": ... }`；
并发冲突在此之上带 `details.conflict`（结构化冲突：`reason`/`entityType`/`entityId`/`field`/
`baseRevision`/`currentRevision`/`resolutionOptions`，形状与 `syncConflictSchema` 一致），
因此客户端可以程序化处理，而不必解析文案；导航与活动端点使用**同一个**形状。
省略 `details` 时该键不存在（阶段 01–03 的响应形状不变）。
集合级冲突（整表重排的集合不符、导入预览过期）没有「哪一行」可言，因此**不编造** entityId，
只给 409 + 精确文案。
`/api/*` 下的未知路径返回 JSON 404，不会回退成 SPA 的 HTML。
所有身份与私有端点响应均为 `Cache-Control: no-store`。

生命周期语义（规划规则 7，**不得混淆**）：

| 操作 | 页面/实例 | 后台任务 | 个人数据与设置 |
|---|---|---|---|
| `hide`（实例级） | 该实例不再渲染 | 不受影响 | 保留 |
| `remove`（实例级） | 该实例墓碑化，布局行删除 | 不受影响 | 保留 |
| `disable`（模块级） | 组件停用 + Host 降级显示 | 取消已排队任务 | 保留 |
| `uninstall`（模块级） | **该工作空间所有页面上**的该模块实例被墓碑化（带代际 fence） | 停止并取消任务 | **默认保留**，可 `restore` |
| 删除页面 | 页面墓碑化；其下的实例与布局**保留**，可连同内容恢复 | 不受影响 | 保留 |
| 重置工作台（模板） | 全部页面墓碑化 + 按模板重建；实例与布局保留，可逐页恢复 | 不受影响 | 保留 |
| 导入替换 | 全部页面墓碑化 + 按备份重建；**同一事务**内先写可恢复备份 | 不受影响 | 不受影响（绝不隐式启停模块） |
| `purge` | —— | —— | 本阶段**拒绝**（501） |

实例清理真正发生在服务端：`workspace_id` + `module_id` + `created_revision <= 上界`
是**同一条 UPDATE 的原子条件**，因此被取代的旧执行者删不掉 `restore` 之后创建的新实例。

生命周期采用「**原子准入（含待完成标记与执行认领）→ 独占执行副作用（revision fence）→ 收尾**」协议：
抢输的一方（409）在任何可变副作用之前退出；副作用失败时返回 200 +
`effect.pending = true` + 失败原因，并把待完成操作持久化（`workspace_module_operations`），
可用**同动作 + 同 revision** 幂等重试续做。独占执行由 `workspace_module_operation_claims`
保证；租约（15s）只用于崩溃后抢占，安全性来自 token 与 revision fence。详见 ADR-0002 D4。

安全细节（配对原子性、撤销审计去重、速率限制、常量时间比较等）见
[`docs/security-boundaries.md`](docs/security-boundaries.md)；
模块与 Widget 的边界见 [`docs/module-widget-boundaries.md`](docs/module-widget-boundaries.md)；
**阶段 04 的操作手册**（导航导入/个人副本/多分组/书签预览、导航与活动 Widget、
多设备同步与草稿冲突、PWA 安装与离线边界）见
[`docs/phase04-user-guide.md`](docs/phase04-user-guide.md)。

## 7. 测试策略

| 层 | 位置 | 运行时 |
|---|---|---|
| 纯契约 | `packages/shared/test/` | Node |
| 前端客户端逻辑 + 注册表/实例存储 | `apps/web/test/*.spec.ts` | Node |
| React 组件渲染与交互（Host、错误隔离、模块管理） | `apps/web/test/*.spec.tsx` | jsdom + React Testing Library |
| API / 认证 / 安全 / 迁移约束 / 模块生命周期 / 工作台与备份 | `worker/test/` | **workerd + Miniflare D1**（`@cloudflare/vitest-pool-workers`） |
| 导航（目录/个人副本/多分组/导入/作用域/危险 URL） / 活动 / 同步水位 | `worker/test/nav-*.spec.ts`、`events-*.spec.ts`、`sync-changes.spec.ts` | 同上（真实 D1 约束 + 真实 HTTP） |
| 导航视图与 Widget、活动 Widget、模块数据端口、PWA 缓存策略 | `apps/web/test/nav-*.spec.*`、`events-widgets.spec.tsx`、`pwa.spec.ts` | jsdom + React Testing Library |
| 真实浏览器验收链（模块切换 → 实例表现，含窄屏与键盘） | `tests/e2e/phase02-modules.spec.ts` | Playwright（本地 `wrangler dev`） |
| 真实浏览器验收链（工作台拖动/缩放、键盘替代、断点独立、导出导入 round-trip、双客户端并发冲突） | `tests/e2e/phase03-workbench.spec.ts` | Playwright（本地 `wrangler dev`） |
| 真实浏览器验收链（目录导入→改私人副本→删除→目录升级仍删除、书签预览与往返、导航/活动 Widget 放入/移除/模块停用、PWA 元数据与缓存隐私、窄屏与键盘、双上下文的导航与布局冲突/草稿保留） | `tests/e2e/phase04-navigation.spec.ts` | Playwright（本地 `wrangler dev`） |

**SQLite 单元测试不等同于 D1 运行时测试**，因此迁移与约束断言全部在 Workers 运行时执行。
浏览器验收链的编排见 [`tests/e2e/README.md`](tests/e2e/README.md)；
身份链路的端到端验证由 `scripts/e2e-identity.mjs` 覆盖。

## 8. CI

`.github/workflows/ci.yml` 在 push 到 `main` 与所有 PR 上执行四个 job：

1. `verify`：冻结安装 → 绑定类型与 wrangler 配置一致性 → lint → typecheck → test → build →
   本地 D1 迁移（全新 + 重复应用）+ 迁移清单。
2. `e2e`：冻结安装 → 安装 Playwright chromium（含系统依赖）→ `pnpm run e2e:phase02`
   （本地 wrangler dev + 本地 D1，随机一次性初始化密钥，不写 `.dev.vars`）。
3. `e2e-phase03`：同上，跑 `pnpm run e2e:phase03`（工作台布局编辑器与备份恢复链）。
4. `e2e-phase04`：同上，跑 `pnpm run e2e:phase04`（自由导航、活动、PWA 与跨设备同步链）。

- 不使用 `continue-on-error`，不使用 `|| true`，不使用「无测试即通过」开关。
- 全部 Cloudflare 操作都带 `--local`：CI **不部署、不创建远程资源、不读取仓库 Secrets**。

## 9. 部署状态

**未部署。** 没有远程 D1、没有 Worker 部署、没有预览环境、没有绑定任何域名、没有启用 Cron。
`wrangler.jsonc` 中的 `env.preview` / `env.production` 只声明环境分离与各自的占位 ID。
是否需要部署到预览环境、以及生产发布，都需要单独授权。

## 10. 已知限制

- **没有后台自动恢复待完成操作**：副作用失败的收尾只能由客户端显式重试（同动作 + 同 revision），
  没有后台自动重试或定时对账；租约过期后的抢占同样需要新请求触发。
- **执行租约不保证旧执行者已停止**：`EXECUTION_LEASE_MS = 15s` 只提供崩溃后的活性，
  安全性依赖 token 条件写入与 revision fence（旧执行者删不掉新一代的实例与任务）。
- **Widget 实例已持久化**：`widget_instances` / `widget_layouts` / `workspace_pages` 于阶段 03 迁移。
  实例清理端口已是真实 D1 实现（`persistent: true`），因此服务端卸载会真正墓碑化实例并删除其布局行。
- **跨设备同步是「通知通道 + 快照权威」**（HUB-051）：已实现 `GET /me/sync/changes`
  水位端点与墓碑传播，客户端在挂载/focus/显式刷新时以快照对齐。
  **不做墓碑 GC**，因此不存在的「提前删掉仍要同步的墓碑」风险；代价是存储会持续增长。
  诚实记录一个 1 毫秒窗口：与某页最后一行同一毫秒、但在快照之后写入的行要等下一次
  快照对齐才会被看到（不会永久丢失，也不会复活删除）。
- **导航健康状态不做主动探测**：本阶段**没有**任何服务端 URL 探测，因此
  `health` 一律 `unknown`，界面如实显示「未探测」。403 永远不会被当成永久失效
  （枚举里没有 `blocked`，只有 `maybe_blocked`）。也正因如此，导航 URL 不可能成为
  SSRF 入口（没有任何代码把导航 URL 交给服务端 fetch）。
- **公共活动表为空**：阶段 04 **不捆绑任何未经核实**的活动数据，`GET /api/v1/events`
  诚实返回空数组，界面显示「没有可验证的公共来源活动」。抓取器、鱼类计算与提醒调度属于阶段 05。
- **备份上限 48 KiB**：导出与导入共用同一上限（且严格小于全局请求体上限 64 KiB）。
  极端规模工作台（30 页 × 40 组件且配置接近上限）会**导出失败**并给出原因，而不是产出损坏文件。
- **草稿只在前端内存**：服务端只接受整页保存，没有服务端草稿；刷新页面会丢失未保存的布局草稿。
  跨设备同步的客户端规则是「有草稿时保留草稿并提示冲突」，不会静默覆盖。
- **离线不假装已保存**：Service Worker 只缓存公开静态资源与公开目录，
  `/api/v1/me/*`、带 `Authorization` 的请求/响应、备份与个人数据一律**不进缓存**；
  离线时界面明确提示「私有修改不会在离线时持久化到服务端」。
- **SW 更新需用户确认**：`sw.js` 自己**不**调用 `skipWaiting`，必须由页面在有草稿保护的前提下
  发消息激活，避免无提示重载丢掉正在编辑的内容。
- **调度只有端口替身**：`ScheduledTaskStore` 是内存实现（`persistent: false`）。
  没有 Cron、没有 Web Push、没有真实通知派发；`wrangler.jsonc` 的 `triggers.crons` 保持为空。
- **清数据未实现**：只提供显式拒绝（501）。将来必须做成「先备份 + 显式二次确认」的独立流程。
- **认证失败事件未落库**：`identity_audit.workspace_id` 为 NOT NULL，无法承载无归属事件，
  这类失败只写脱敏日志。详见 `docs/security-boundaries.md` 第 9 节。
- **恢复密钥不轮换**：为避免让用户已离线备份的密钥失效（及响应丢失导致永久失去恢复能力）。
- **前端身份界面不完整**：只有阶段 02 补的「会话内存凭证」最小入口；
  初始化向导、配对、设备管理 UI 仍未实现。
- **`demo.*` 演示组件仍在**：真实业务模块（`ff14.navigation` / `ff14.events`）已接入，
  但演示组件刻意保留作为「配置迁移、错误隔离、单例约束」的可复现验证夹具；
  鱼类/钓鱼数据仍属于阶段 05。
- **导航种子规模很小**：目录只收录少量**已核对来源**的中文/国服优先条目，
  每条都有 `sourceUrl` 与 `verifiedAt`；不编造网站，也不声称网站在线。
- `compatibility_date` 暂为 `2026-08-01`，受锁定的 Workers 测试运行时支持上限约束
  （见 ADR-0001 第 5 条）。
- CSP 尚未启用 `require-trusted-types-for 'script'`（Trusted Types 与后续第三方组件的兼容性需单独评估）。
- `compatibility_date` 暂为 `2026-08-01`，受锁定的 Workers 测试运行时支持上限约束
  （见 ADR-0001 第 5 条）。
- CSP 尚未启用 `require-trusted-types-for 'script'`（Trusted Types 与后续第三方组件的兼容性需单独评估）。
