/**
 * 速率限制测试（HUB-006）。
 *
 * 重点不是「限流函数能返回 429」，而是：
 * - 阈值与策略常量一致（不允许实现与声明漂移）；
 * - **并发不能绕过**（依赖 D1 条件更新的原子性，而不是读-判断-写）；
 * - 被限流的请求**不产生任何身份副作用**；
 * - 限流表不保存明文客户端标识。
 */
import { apiErrorBodySchema, TOKEN_BODY_LENGTH } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../lib/rate-limit';
import {
  URLS,
  bootstrapHeaders,
  countRows,
  jsonPost,
  resetIdentityState,
  TEST_BOOTSTRAP_SECRET,
} from './helpers';

/** 明显错误但长度合法的初始化密钥，用于制造 401 而不触发单例冲突。 */
const WRONG_BOOTSTRAP_SECRET = 'wrong-secret-value-that-is-long-enough-0000';

beforeEach(async () => {
  await resetIdentityState();
});

describe('速率限制', () => {
  it('Bootstrap：恰好允许 limit 次，之后返回 429 并带 Retry-After', async () => {
    const limit = RATE_LIMITS.bootstrapPerClient.limit;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < limit + 1; attempt += 1) {
      const response = await SELF.fetch(
        URLS.bootstrap,
        jsonPost({ deviceName: 'x' }, bootstrapHeaders(WRONG_BOOTSTRAP_SECRET)),
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('Retry-After')).toMatch(/^\d+$/);
        const body = await response.json<Record<string, unknown>>();
        expect(apiErrorBodySchema.safeParse(body).success).toBe(true);
        expect(body['code']).toBe('rate_limited');
        expect(body['message']).not.toContain(TEST_BOOTSTRAP_SECRET);
      }
    }

    expect(statuses.filter((status) => status === 401)).toHaveLength(limit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    // 被拒的请求没有任何副作用。
    expect(await countRows('workspaces')).toBe(0);
  });

  it('达到限流后，即使提供正确初始化密钥也被拒绝，且不创建任何工作空间', async () => {
    const limit = RATE_LIMITS.bootstrapPerClient.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'x' }, bootstrapHeaders(WRONG_BOOTSTRAP_SECRET)));
    }

    const response = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName: 'x' }, bootstrapHeaders()));
    expect(response.status).toBe(429);
    expect(await countRows('workspaces')).toBe(0);
    expect(await countRows('workspace_bootstrap_guard')).toBe(0);
  });

  it('Recover：超过限额后返回 429，且不新增设备', async () => {
    const limit = RATE_LIMITS.recoverPerClient.limit;
    const wrongKey = `ffh_rec_${'A'.repeat(TOKEN_BODY_LENGTH)}`;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      const response = await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: wrongKey, deviceName: 'x' }));
      expect(response.status, `第 ${attempt + 1} 次`).toBe(401);
    }

    const denied = await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: wrongKey, deviceName: 'x' }));
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(await countRows('devices')).toBe(0);
  });

  it('并发请求不能绕过限流：恰好 limit 个被允许', async () => {
    const limit = RATE_LIMITS.pairingClaimPerClient.limit;
    const unknownCode = `ffh_pair_${'Q'.repeat(TOKEN_BODY_LENGTH)}`;
    const attempts = limit + 5;

    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: unknownCode, deviceName: 'x' })),
      ),
    );

    const allowed = responses.filter((response) => response.status === 401).length;
    const denied = responses.filter((response) => response.status === 429).length;
    // 原子条件更新保证「允许数」不会因为并发而超过阈值。
    expect(allowed).toBe(limit);
    expect(denied).toBe(attempts - limit);
  });

  it('限流表只保存标识摘要，不出现明文 IP 或端点之外的原始输入', async () => {
    await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: `ffh_rec_${'B'.repeat(TOKEN_BODY_LENGTH)}`, deviceName: 'x' }));

    const rows = await env.DB.prepare('SELECT scope_key FROM auth_rate_limits').all<{ scope_key: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      expect(row.scope_key).toMatch(/^[a-z-]+:(c:[0-9a-f]{32}|g)$/);
    }
  });

  it('不同端点使用独立配额，互不影响', async () => {
    // 先耗尽 recover 的配额。
    const limit = RATE_LIMITS.recoverPerClient.limit;
    const wrongKey = `ffh_rec_${'C'.repeat(TOKEN_BODY_LENGTH)}`;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: wrongKey, deviceName: 'x' }));
    }
    expect((await SELF.fetch(URLS.recover, jsonPost({ recoveryKey: wrongKey, deviceName: 'x' }))).status).toBe(429);

    // pairing/claim 的配额仍然可用（返回 401 而不是 429）。
    const claim = await SELF.fetch(
      URLS.pairingClaim,
      jsonPost({ pairingCode: `ffh_pair_${'D'.repeat(TOKEN_BODY_LENGTH)}`, deviceName: 'x' }),
    );
    expect(claim.status).toBe(401);
  });
});
