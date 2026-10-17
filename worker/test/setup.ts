/**
 * 测试前置：把 migrations/*.sql 真正应用到测试用的 D1 实例。
 *
 * 说明：
 * - 使用官方 `applyD1Migrations`，它会在 D1 内维护 `d1_migrations` 记账表，
 *   因此重复调用是安全的（与 `wrangler d1 migrations apply` 的语义一致）。
 * - 池默认启用 isolated storage：每个测试文件拿到干净的存储，并在这里重新应用迁移。
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
