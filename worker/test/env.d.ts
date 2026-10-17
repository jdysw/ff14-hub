/**
 * 测试运行时补充的绑定类型。
 *
 * `env.DB`、`env.ASSETS`、`env.ENVIRONMENT` 等来自 `wrangler types` 生成的
 * `worker-configuration.d.ts`（它声明全局 `Cloudflare.Env` 与 `Env`）。
 * 这里只补上**测试池**通过 miniflare bindings 注入的那一项。
 */
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}
