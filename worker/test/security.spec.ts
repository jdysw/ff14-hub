import './setup-d1';
/**
 * 安全头 / CSP / 请求体积 / Content-Type / Origin 边界测试。
 *
 * 这些断言对应规划 9.2 与 HUB-004 的「明确边界」要求：
 * 边界必须是**可执行、可断言**的，而不是文档里的口号。
 */
import { MAX_JSON_BODY_BYTES } from '@ff14-hub/shared';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TEST_BASE_URL } from './helpers';

describe('安全响应头与 CSP', () => {
  it('API 响应带完整安全头，且 CSP 严格', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/health`);
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    const policy = csp ?? '';
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // 不得出现任何 script 的 eval/inline 放行。
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain('unsafe-eval');

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
  });






});

describe('写请求边界：Content-Type', () => {
  it('非 JSON 的 Content-Type 被拒为 415（阻断表单/simple-request CSRF）', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ label: 'ok', count: 1 }),
    });
    expect(response.status).toBe(415);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe('unsupported_media_type');
  });




});

describe('写请求边界：体积上限', () => {
  it(`超过 ${MAX_JSON_BODY_BYTES} 字节的请求体被拒为 413`, async () => {
    const oversized = JSON.stringify({ label: 'ok', count: 1, padding: 'x'.repeat(MAX_JSON_BODY_BYTES + 1024) });
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(response.status).toBe(413);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe('payload_too_large');
  });




});

describe('写请求边界：Origin', () => {
  it('跨源 Origin 被拒为 403', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ label: 'ok', count: 1 }),
    });
    expect(response.status).toBe(403);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe('forbidden');
  });

  it('同源 Origin 被允许', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: TEST_BASE_URL },
      body: JSON.stringify({ label: 'ok', count: 1 }),
    });
    expect(response.status).toBe(200);
  });




});
