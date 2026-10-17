/**
 * 阶段 02 真实浏览器验收链的 Playwright 配置。
 *
 * 放在 `tests/e2e/` 内而不是仓库根：这样它和用例属于同一个 tsconfig 项目，
 * 既能被 `pnpm run typecheck:e2e` 检查，也不会成为「不属于任何项目」的游离文件。
 * 运行时由 `pnpm run e2e:phase02` 显式指定 `--config tests/e2e/playwright.config.ts`。
 *
 * 两个项目（桌面 / 窄屏）跑同一批用例，但用例内部会按项目名做取舍：
 * 完整链路（匿名 → 凭证 → 启用 → 实例 → 隔离 → 降级 → 卸载）只在桌面跑一次；
 * 窄屏项目专门验证「窄屏 + 键盘 + 无横向溢出」。
 *
 * 服务由 `scripts/e2e-phase02.mjs` 启动（本地 wrangler dev + 本地 D1），
 * 因此这里刻意**不**配置 `webServer`：启动顺序（清库 → 迁移 → 灌初始化密钥 → 等就绪）
 * 必须由脚本保证，而不是靠 Playwright 的隐式约定。
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:8787';

/** 允许在本地复用系统已安装的浏览器通道（CI 用 Playwright 自带的 chromium）。 */
const browserChannel = process.env['E2E_BROWSER_CHANNEL'];

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // 串行执行：两个项目共用同一个本地服务与同一份 D1，避免互相干扰。
  fullyParallel: false,
  workers: 1,
  // 本地调试时允许 test.only；CI 里必须失败。
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    // 显式设置动作超时：缺失/不可见元素必须**快速失败并给出准确位置**，
    // 而不是把整个用例的预算耗在一个永远等不到的元素上（默认是 0 = 不限制，会吃满 test timeout）。
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(browserChannel === undefined ? {} : { channel: browserChannel }),
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        ...(browserChannel === undefined ? {} : { channel: browserChannel }),
      },
    },
  ],
});
