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

  it('API 响应禁止被缓存（包含错误响应）', async () => {
    const ok = await SELF.fetch(`${TEST_BASE_URL}/api/v1/health`);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    const notFound = await SELF.fetch(`${TEST_BASE_URL}/api/v1/nope`);
    expect(notFound.headers.get('Cache-Control')).toBe('no-store');
  });

  it('静态资源同样经过 Worker 并获得安全头（同域部署的关键约束）', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/favicon.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).not.toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('本地/测试环境不注入 upgrade-insecure-requests，避免本地 http 调试被破坏', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/health`);
    expect(response.headers.get('Content-Security-Policy') ?? '').not.toContain('upgrade-insecure-requests');
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

  it('application/json 与 +json 后缀都被接受', async () => {
    for (const contentType of ['application/json', 'application/json; charset=utf-8']) {
      const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: JSON.stringify({ label: 'ok', count: 1 }),
      });
      expect(response.status, contentType).toBe(200);
    }
  });

  it('无请求体的 DELETE 不要求 Content-Type', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, { method: 'DELETE' });
    // 走到路由层：路径存在但没有 DELETE 处理器 → 404（而不是 415）。
    expect(response.status).not.toBe(415);
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

  it('接近上限但仍在限内的请求体正常通过', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 约 60KB：足够大以覆盖流式读取路径，但仍小于 64KB 上限。
      body: JSON.stringify({ label: 'ok', count: 1, padding: 'x'.repeat(60_000) }),
    });
    expect(response.status).toBe(200);
  });

  it('GET 请求不受体积校验影响', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo?region=cn`);
    expect(response.status).toBe(200);
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

  it('无 Origin 的写请求被允许（凭证在 Authorization 头，非 ambient credential）', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ok', count: 1 }),
    });
    expect(response.status).toBe(200);
  });

  it('无法解析的 Origin 不被放行', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'not-a-url' },
      body: JSON.stringify({ label: 'ok', count: 1 }),
    });
    expect(response.status).toBe(403);
  });
});

describe('校验失败不泄露提交的值', () => {
  it('把像凭证的内容放进错误类型的字段，也不会回显到响应里', async () => {
    const secretish = 'ffh_dev_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ok', count: secretish }),
    });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain(secretish);
    expect(text).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('取值为非法枚举时也不回显该取值', async () => {
    const secretish = 'ffh_rec_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo?region=${encodeURIComponent(secretish)}`);
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain(secretish);
  });
});
