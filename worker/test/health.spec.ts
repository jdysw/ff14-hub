/**
 * 健康检查与请求 ID 集成测试（在真实 workerd + D1 中执行）。
 */
import { healthResponseSchema } from '@ff14-hub/shared';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TEST_BASE_URL } from './helpers';

const HEALTH_URL = `${TEST_BASE_URL}/api/v1/health`;

describe('GET /api/v1/health', () => {
  it('返回 200，并通过共享契约 Schema 校验', async () => {
    const response = await SELF.fetch(HEALTH_URL);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');

    const body: unknown = await response.json();
    const parsed = healthResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it('真实探测 D1：database=ok 证明绑定与迁移后的库可用', async () => {
    const response = await SELF.fetch(HEALTH_URL);
    const body = await response.json<{ database: string; status: string }>();
    expect(body.database).toBe('ok');
    expect(body.status).toBe('ok');
  });

  it('响应字段集合固定，不泄露绑定名、数据库名或任何密钥', async () => {
    const response = await SELF.fetch(HEALTH_URL);
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual([
      'database',
      'environment',
      'nowUtcMs',
      'service',
      'status',
      'version',
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('recovery');
    expect(serialized).not.toContain('BOOTSTRAP');
  });

  it('回显合法的 X-Request-Id，便于跨日志追踪', async () => {
    const requestId = 'test-request-id-0001';
    const response = await SELF.fetch(HEALTH_URL, { headers: { 'X-Request-Id': requestId } });
    expect(response.headers.get('X-Request-Id')).toBe(requestId);
  });

  it('未提供 X-Request-Id 时由服务端生成 UUID 并回写响应头', async () => {
    const response = await SELF.fetch(HEALTH_URL);
    const returned = response.headers.get('X-Request-Id');
    expect(returned).not.toBeNull();
    expect(returned).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('非 GET 方法返回结构化 405 并声明 Allow', async () => {
    const response = await SELF.fetch(HEALTH_URL, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    const body = await response.json<{ code: string; requestId: string }>();
    expect(body.code).toBe('method_not_allowed');
    expect(typeof body.requestId).toBe('string');
  });
});
