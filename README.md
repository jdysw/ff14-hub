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
├── apps/web/            React + Vite 前端（App Shell + 模块管理/组件验收视图 + Widget Host）
│   ├── src/app/shell/   常驻系统入口、视图切换、会话凭证入口
│   ├── src/app/modules/ 模块 API 绑定、模块状态、模块管理界面、变更→实例联动
│   ├── src/app/widgets/ Widget Host、静态组件映射、实例存储、演示组件
│   └── src/lib/         API 客户端、渲染错误边界
├── worker/              Cloudflare Workers API（Hono + Zod + D1）
│   ├── api/v1/          health / modules(公开目录) / identity / me(含模块状态与生命周期) / __test__
│   ├── middleware/      requestId、环境校验、写请求守卫、错误处理、认证、安全头、输入校验
│   ├── modules/identity/  身份契约的代码落点（凭证原语、配对、设备、恢复、审计）
│   ├── modules/registry/  模块静态注册表、内置演示模块、服务端 handler 表
│   ├── modules/lifecycle/ 生命周期服务、workspace_modules 读写、调度与实例清理端口实现
│   ├── modules/ports.ts   生命周期端口与受限上下文定义
│   ├── db/              Drizzle schema 与客户端
│   └── test/            Workers 运行时测试（真实 workerd + Miniflare D1）
├── packages/shared/     前后端共用纯契约（错误、身份、Module/Widget Schema、模块 API、内置演示模块定义）
├── migrations/          D1 SQL 迁移（事实来源）
├── scripts/             冒烟脚本 + 阶段 02 浏览器验收链编排（e2e-phase02.mjs）
├── tests/e2e/           Playwright 用例（阶段 02 起启用）
└── docs/                规划、安全边界、Module/Widget 边界、ADR
```

## 6. API（阶段 02 实际可用范围）

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

统一错误结构：`{ "code": "...", "message": "...", "requestId": ... }`。
`/api/*` 下的未知路径返回 JSON 404，不会回退成 SPA 的 HTML。
所有身份与私有端点响应均为 `Cache-Control: no-store`。

生命周期语义（规划规则 7，**不得混淆**）：

| 操作 | 页面/实例 | 后台任务 | 个人数据与设置 |
|---|---|---|---|
| `hide` / `remove`（实例级） | 仅影响该实例（**纯客户端**） | 不受影响 | 保留 |
| `disable` | 组件停用 + Host 降级显示 | 取消已排队任务 | 保留 |
| `uninstall` | 移除该模块全部实例并停用 | 停止并取消任务 | **默认保留**，可 `restore` |
| `purge` | —— | —— | 本阶段**拒绝**（501） |

安全细节（配对原子性、撤销审计去重、速率限制、常量时间比较等）见
[`docs/security-boundaries.md`](docs/security-boundaries.md)；
模块与 Widget 的边界见 [`docs/module-widget-boundaries.md`](docs/module-widget-boundaries.md)。

## 7. 测试策略

| 层 | 位置 | 运行时 |
|---|---|---|
| 纯契约 | `packages/shared/test/` | Node |
| 前端客户端逻辑 + 注册表/实例存储 | `apps/web/test/*.spec.ts` | Node |
| React 组件渲染与交互（Host、错误隔离、模块管理） | `apps/web/test/*.spec.tsx` | jsdom + React Testing Library |
| API / 认证 / 安全 / 迁移约束 / 模块生命周期 | `worker/test/` | **workerd + Miniflare D1**（`@cloudflare/vitest-pool-workers`） |
| 真实浏览器验收链（模块切换 → 实例表现，含窄屏与键盘） | `tests/e2e/phase02-modules.spec.ts` | Playwright（本地 `wrangler dev`） |

**SQLite 单元测试不等同于 D1 运行时测试**，因此迁移与约束断言全部在 Workers 运行时执行。
浏览器验收链的编排见 [`tests/e2e/README.md`](tests/e2e/README.md)；
身份链路的端到端验证由 `scripts/e2e-identity.mjs` 覆盖。

## 8. CI

`.github/workflows/ci.yml` 在 push 到 `main` 与所有 PR 上执行两个 job：

1. `verify`：冻结安装 → 绑定类型与 wrangler 配置一致性 → lint → typecheck → test → build →
   本地 D1 迁移（全新 + 重复应用）+ 迁移清单。
2. `e2e`：冻结安装 → 安装 Playwright chromium（含系统依赖）→ `pnpm run e2e:phase02`
   （本地 wrangler dev + 本地 D1，随机一次性初始化密钥，不写 `.dev.vars`）。

- 不使用 `continue-on-error`，不使用 `|| true`，不使用「无测试即通过」开关。
- 全部 Cloudflare 操作都带 `--local`：CI **不部署、不创建远程资源、不读取仓库 Secrets**。

## 9. 部署状态

**未部署。** 没有远程 D1、没有 Worker 部署、没有预览环境、没有绑定任何域名、没有启用 Cron。
`wrangler.jsonc` 中的 `env.preview` / `env.production` 只声明环境分离与各自的占位 ID。
是否需要部署到预览环境、以及生产发布，都需要单独授权。

## 10. 已知限制

- **Widget 实例不持久**：`widget_instances` 表属于阶段 03，因此实例只存在于浏览器内存，
  刷新即丢失；服务端卸载只能通过 `ModuleInstanceStore` 端口**请求**清理
  （默认实现自报 `persistent: false`）。语义已被测试钉住，替换实现即可。
- **调度只有端口替身**：`ScheduledTaskStore` 是内存实现（`persistent: false`）。
  没有 Cron、没有 Web Push、没有真实通知派发；`wrangler.jsonc` 的 `triggers.crons` 保持为空。
- **清数据未实现**：只提供显式拒绝（501）。将来必须做成「先备份 + 显式二次确认」的独立流程。
- **认证失败事件未落库**：`identity_audit.workspace_id` 为 NOT NULL，无法承载无归属事件，
  这类失败只写脱敏日志。详见 `docs/security-boundaries.md` 第 9 节。
- **恢复密钥不轮换**：为避免让用户已离线备份的密钥失效（及响应丢失导致永久失去恢复能力）。
- **前端身份界面不完整**：只有阶段 02 补的「会话内存凭证」最小入口；
  初始化向导、配对、设备管理 UI 仍未实现。
- **界面组件全是演示组件**：`demo.*` 演示组件没有任何游戏业务数据，
  真实鱼类/活动/导航属于阶段 04–05。
- `compatibility_date` 暂为 `2026-08-01`，受锁定的 Workers 测试运行时支持上限约束
  （见 ADR-0001 第 5 条）。
- CSP 尚未启用 `require-trusted-types-for 'script'`（Trusted Types 与后续第三方组件的兼容性需单独评估）。
