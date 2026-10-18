/**
 * Workers 运行时测试配置（HUB-005）。
 *
 * 重要立场：**SQLite 单元测试不等同于 D1 运行时测试**。
 * 因此这里不使用 better-sqlite3 / sql.js 之类的外置 SQLite，而是通过
 * @cloudflare/vitest-pool-workers 在真实 workerd + Miniflare D1 里执行测试，
 * 从而覆盖 D1 自身的外键、约束与迁移语义。
 *
 * API 说明：本仓库锁定的 0.23.0 已改为 **Vitest 插件**形态——
 * 从包根导入 `cloudflareTest`，不再存在 `@cloudflare/vitest-pool-workers/config` 子路径。
 */
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// 相对当前工作目录（即 worker 包目录）解析；刻意不使用 node:url，
// 避免 Workers 全局 URL 类型与 Node URL 类型互相冲突。
const MIGRATIONS_DIR = '../migrations';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(MIGRATIONS_DIR);

  return {
    plugins: [
      cloudflareTest({
        // 测试专用配置：与根 wrangler.jsonc 保持一致的 D1 / compat 设置，
        // 但静态资源指向已提交的 apps/web/public（dist 是构建产物，测试期可能不存在）。
        wrangler: { configPath: './test/wrangler.test.jsonc' },
        miniflare: {
          bindings: {
            // 把迁移语句作为绑定注入，让 setup 在测试运行时内真实执行迁移。
            TEST_MIGRATIONS: migrations,
            // 自检路由仅在测试中开启。
            ENABLE_TEST_ROUTES: '1',
            // 测试专用的初始化密钥：明显是一次性测试值，绝不是生产秘密，
            // 也不得被复制到任何部署环境（生产秘密只能通过部署环境的 Secret 注入）。
            BOOTSTRAP_SECRET: 'test-only-bootstrap-secret-value-0123456789',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.spec.ts'],
      // 不允许「没有测试也算通过」。
      passWithNoTests: false,
      setupFiles: ['./test/setup.ts'],
      // 超时（阶段 04 起）：这些用例跑在真实 workerd + Miniflare D1 里，且大量用例会
      // 真实迁移、真实 HTTP 往返、并发抢锁。默认 5 秒在 2 核 CI runner 上会因为机器忙而假红，
      // 掩盖真正的回归；放宽到 30 秒不跳过任何断言、不放宽任何检查。
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
