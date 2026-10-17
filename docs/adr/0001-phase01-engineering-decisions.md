# ADR-0001：阶段 01 工程基线与依赖锁定策略

- 状态：已采纳
- 日期：2026-10-18
- 关联任务：HUB-001 / HUB-002 / HUB-003 / HUB-004 / HUB-005

## 背景

阶段 01 需要一次性建立可长期演进的工程基线：pnpm workspace、strict TypeScript、React/Vite、
Hono/Zod Worker、D1 迁移与 Drizzle、Workers 运行时测试、ESLint、GitHub Actions。
规划 4.1 要求「依赖版本以安装时锁文件和官方当前兼容性为准，不在规划中硬编码未经验证的最新版号」，
但没有说明版本冲突时如何取舍、以及若干工程选择的理由。本 ADR 记录这些决定。

## 决策

### 1. 依赖版本集中锁定在 `pnpm-workspace.yaml` 的 catalog，并使用确切版本

各 `package.json` 通过 `"catalog:"` 引用，不使用 `^`/`~` 浮动范围；`.npmrc` 设置 `save-exact=true`。

**理由**：版本只有一个事实来源，避免四个 workspace 包之间漂移；`--frozen-lockfile` 的 CI 与本地
结果一致。

### 2. TypeScript 锁定 5.9.3，而不是最新的 7.0.2

`typescript-eslint@8.71.2`（当前 latest）的 peer 为 `typescript >=4.8.4 <6.1.0`。
最新 TS 7.x 落在范围之外，类型感知 ESLint 规则无法工作。

**被否决的方案**：升级到 TS 7 并放弃类型感知 lint。理由：类型感知规则能发现未处理 Promise、
`any` 泄漏等真实问题，阶段 01 的价值高于跟随最新版本。

### 3. vitest 锁定 4.1.12，而不是最新的 5.x

`@cloudflare/vitest-pool-workers@0.23.0` 的 peer 为 `vitest ^4.1.0`。

### 4. D1/Workers 测试必须在 workerd + Miniflare D1 中执行

不使用 better-sqlite3 / sql.js 等外置 SQLite 做「等价」测试。
规划 5.1 明确要求实测 D1，且本项目依赖 D1 的外键默认开启、`d1_migrations` 记账表等
平台特有行为——外置 SQLite 覆盖不到这些。

### 5. `compatibility_date` 取 `2026-08-01`，低于当前日期

`@cloudflare/vitest-pool-workers@0.23.0` 内置 `miniflare 5.20260815.0-alpha`（workerd 1.20260815.1），
它拒绝未来兼容日期并抛 `ERR_FUTURE_COMPATIBILITY_DATE`，Workers 测试会整体无法启动。

**代价**：暂时放弃 2026-08 之后引入的运行时行为变更。
**解除条件**：升级 `@cloudflare/vitest-pool-workers` 后同步上调，并重新跑测试。

### 6. 静态资源经 Worker 回退（`run_worker_first: true`）而不是直接由 CDN 提供

只有让所有请求先进入 Worker，安全响应头（尤其 CSP）才能覆盖同域 HTML。

**代价**：每个静态请求多一跳 Worker 调用。对个人项目可接受。
**同时**：`/api/*` 的未知路径被显式处理为 JSON 404，绝不回退成 SPA 的 index.html——
否则客户端会拿到 200 HTML，既破坏契约也掩盖路径拼写错误。

### 7. 不引入 `@hono/zod-validator`

写请求体已在 `write-guard` 中按体积上限读取并解析（流只能消费一次），
`zValidator('json', ...)` 无法复用该结果。项目改为用 Zod 直接校验 `c.get('jsonBody')`，
并由 `validateJsonBody` / `validateQuery` 两个小中间件统一产出同一套错误结构。

**理由**：少一个依赖、少一层适配，且错误契约只有一个出口（避免 zod-validator 的默认
problem-details 响应混入本项目契约）。

### 8. `pnpm.onlyBuiltDependencies` → `pnpm-workspace.yaml` 的 `allowBuilds`

pnpm 11 不再读取 `package.json` 的 `pnpm` 字段（安装时会打印警告），安装脚本白名单只能放在
`pnpm-workspace.yaml`。当前只放行 `esbuild` 与 `workerd`。

### 9. 本地 D1 使用占位 `database_id`

`wrangler.jsonc` 中的 `00000000-...` 是**占位值**，本地（`--local`）操作不会访问 Cloudflare API。
真实远程 ID 只能由人工授权执行 `wrangler d1 create` 后填入。`env.preview` / `env.production`
同样只声明「分离」的事实与各自的占位 ID，不写入任何真实资源 ID 或凭证。

### 10. `packages/shared` 以源码形式被消费（不产出 dist）

`exports` 直接指向 `./src/index.ts`，相对导入省略扩展名，与 `moduleResolution: "bundler"` 一致。
消费方是 Vite 与 esbuild（Worker 打包），两者都能处理。

**代价**：该包不能被 Node 原生 ESM 直接加载。若将来需要（例如独立 CLI），必须改为产出 `dist/`。

## 影响

- 升级依赖时必须同时检查上述 peer 约束与 `compatibility_date` 上限，不能只看「有新版」。
- 阶段 02 起新增模块（`packages/fish-engine` 等）应沿用 catalog 与确切版本策略。
