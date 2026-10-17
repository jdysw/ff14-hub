/**
 * 让测试环境里的 `env` 带上本项目的绑定类型。
 *
 * 说明：`cloudflare:test` 把 `env` 声明为全局命名空间 `Cloudflare.Env`，
 * 因此这里用声明合并把本项目的 Env 与测试专用绑定补进去。
 * TEST_MIGRATIONS 由 vitest.config.ts 通过 miniflare bindings 注入。
 */
import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      readonly TEST_MIGRATIONS: D1Migration[];
    }
  }
}
