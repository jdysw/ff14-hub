# FF14 Hub

FF14 个人导航与模块化工作台。默认面向国服玩家与个人自用，预留国际服扩展。

**当前状态：阶段 01（Core 工程与身份基础）实现中，尚未部署、尚未合并。**
本仓库现在能跑通的是「工程基线 + 统一 API 骨架 + D1 迁移 + 认证中间件 + CI」，
**不是**一个可用的 FF14 工具站。导航、鱼类、工作台编辑器、提醒与同步均未实现。

- 完整开发规划（单一事实来源）：[`docs/FF14_Hub_AI_Development_Plan.md`](docs/FF14_Hub_AI_Development_Plan.md)
- 安全边界（已生效的边界与已知限制）：[`docs/security-boundaries.md`](docs/security-boundaries.md)
- Module / Widget 边界（阶段 02 接入约定）：[`docs/module-widget-boundaries.md`](docs/module-widget-boundaries.md)
- 工程决策记录：[`docs/adr/0001-phase01-engineering-decisions.md`](docs/adr/0001-phase01-engineering-decisions.md)

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
pnpm run typecheck               # strict TypeScript，全部 workspace 包
pnpm run test                    # Node 单测 + 真实 workerd/Miniflare D1 测试
pnpm run build                   # 前端产物 + Worker 打包干跑（不部署）
pnpm run verify                  # 上面四步串联
```

本地同域开发与冒烟：

```bash
pnpm run db:migrate:local        # 应用 D1 迁移到本地 SQLite（不访问 Cloudflare）
pnpm run build:web               # 先生成 dist，Worker 的静态资源绑定指向它
pnpm run dev:api                 # wrangler dev，默认 http://127.0.0.1:8787
pnpm run smoke:local             # 另开终端：同域静态页 + /api/v1/health 冒烟
```

`pnpm run dev` 只启动 Vite 开发服务器（前端热更新，不同域）；要做同域联调请用 `dev:api`。

## 3. 环境变量与本地凭证

- 示例文件：`.dev.vars.example`（**只有占位符**）。复制为 `.dev.vars` 后自行填入本地随机值；
  `.dev.vars` 已被 `.gitignore` 忽略，绝不入库。
- 阶段 01 的代码**不读取**其中的身份配置；`BOOTSTRAP_SECRET` 由下一轮 HUB-006 使用。
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

已落地：`migrations/0001_core.sql` —— `workspaces` / `devices` / `device_pairings` / `identity_audit`
四张表，含外键、唯一索引、枚举 CHECK 与索引。

约定与注意点：

- 通篇使用 `IF NOT EXISTS`，**重复应用安全**（`worker/test/migrations.spec.ts` 会把拆分出的每条语句
  再跑一遍来验证，而不是只依赖记账表的短路）。
- D1 **默认开启外键约束**，因此迁移里不写 `PRAGMA foreign_keys`；不要假设它在某些环境下关闭。
- 事务与并发行为必须实测 D1，不能假设与独立 SQLite 完全一致。
- 生产 Schema 不在启动时隐式修改，只能通过新迁移文件演进。

阶段 02 起将新增工作台与导航相关表（见规划 5.2），本轮**未**迁移。

## 5. 目录结构

```text
ff14-hub/
├── apps/web/            React + Vite 前端（阶段 01 仅结构化 App Shell）
├── worker/              Cloudflare Workers API（Hono + Zod + D1）
│   ├── api/v1/          health / me(骨架) / __test__(仅测试可达)
│   ├── middleware/      requestId、环境校验、写请求守卫、错误处理、认证、安全头
│   ├── modules/identity/ 身份契约的代码落点（凭证原语、设备认证）
│   ├── db/              Drizzle schema 与客户端
│   └── test/            Workers 运行时测试（真实 workerd + Miniflare D1）
├── packages/shared/     前后端共用纯契约（错误、身份、Module/Widget Schema）
├── migrations/          D1 SQL 迁移（事实来源）
├── scripts/             冒烟脚本等
├── tests/e2e/           Playwright 用例预留位置（尚未启用）
└── docs/                规划、安全边界、Module/Widget 边界、ADR
```

## 6. API（阶段 01 实际可用范围）

| Method | Path | 状态 |
|---|---|---|
| GET | `/api/v1/health` | 可用（就绪探针：会真实探测 D1） |
| GET | `/api/v1/me/profile` | **骨架**：未授权 401；已认证 501（HUB-006 实现） |
| GET | `/api/v1/me/devices` | 同上 |
| DELETE | `/api/v1/me/devices/:id` | 同上 |

统一错误结构：`{ "code": "...", "message": "...", "requestId": "..." }`。
`/api/*` 下的未知路径返回 JSON 404，不会回退成 SPA 的 HTML。

## 7. 测试策略

| 层 | 位置 | 运行时 |
|---|---|---|
| 纯契约 | `packages/shared/test/` | Node |
| 前端客户端逻辑 | `apps/web/test/` | Node |
| API / 认证 / 安全 / 迁移约束 | `worker/test/` | **workerd + Miniflare D1**（`@cloudflare/vitest-pool-workers`） |

**SQLite 单元测试不等同于 D1 运行时测试**，因此迁移与约束断言全部在 Workers 运行时执行。
`tests/e2e/README.md` 说明了 Playwright 为何推迟到阶段 03 之后启用。

## 8. CI

`.github/workflows/ci.yml` 在 push 到 `main` 与所有 PR 上执行：
冻结安装 → lint → typecheck → test → build → 本地 D1 迁移（全新 + 重复应用）。

- 不使用 `continue-on-error`，不使用 `|| true`，不使用「无测试即通过」开关。
- 全部 Cloudflare 操作都带 `--local`：CI **不部署、不创建远程资源、不读取仓库 Secrets**。

## 9. 部署状态

**未部署。** 没有远程 D1、没有 Worker 部署、没有预览环境、没有绑定任何域名、没有启用 Cron。
`wrangler.jsonc` 中的 `env.preview` / `env.production` 只声明环境分离与各自的占位 ID。
是否需要部署到预览环境、以及生产发布，都需要单独授权。

## 10. 已知限制

- 认证失败事件目前只写脱敏日志，未落库（`identity_audit.workspace_id` 为 NOT NULL，
  无法容纳无归属事件）。处理方案留待 HUB-006，见 `docs/security-boundaries.md` 第 9 节。
- 速率限制（配对 / 恢复 / 认证失败）属 HUB-006，本轮未实现。
- `compatibility_date` 暂为 `2026-08-01`，受锁定的 Workers 测试运行时支持上限约束
  （见 ADR-0001 第 5 条）。
- CSP 尚未启用 `require-trusted-types-for 'script'`（Trusted Types 与后续第三方组件的兼容性需单独评估）。
