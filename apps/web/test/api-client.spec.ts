/**
 * API 客户端契约测试。
 *
 * 重点断言安全属性而不是实现细节：
 * - Token 只出现在 Authorization 头，绝不出现在 URL。
 * - 非契约形状的错误体不会把原始文本回显给 UI。
 * - 网络失败与 HTTP 失败被区分对待。
 */
import { API_V1_PREFIX, REQUEST_ID_HEADER } from '@ff14-hub/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  NETWORK_FAILURE_STATUS,
  buildApiUrl,
  createApiClient,
  normalizeApiError,
} from '../src/lib/api-client';

const FAKE_TOKEN = `ffh_dev_${'A'.repeat(43)}`;

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * 构造一个可观测的 fetch 替身。
 * 显式声明入参类型，避免 vi.fn 推断出空元组而让 mock.calls 无法索引。
 */
function makeFetchSpy(handler: FetchHandler) {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init ?? {});
  });
  return {
    spy,
    fetchImpl: spy as unknown as typeof fetch,
    /** 取第 n 次调用的 (url, init)。url 统一为字符串，避免对象被判为不安全的字符串化。 */
    callAt(index: number): { url: string; init: RequestInit } {
      const call = spy.mock.calls[index];
      if (call === undefined) {
        throw new Error(`fetch 未被调用到第 ${index} 次`);
      }
      const input = call[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return { url, init: call[1] ?? {} };
    },
  };
}

describe('buildApiUrl', () => {
  it('默认返回同源相对路径', () => {
    expect(buildApiUrl(`${API_V1_PREFIX}/health`)).toBe('/api/v1/health');
  });

  it('接受显式 http(s) 基地址并去掉重复斜杠', () => {
    expect(buildApiUrl('/api/v1/health', 'https://ff14-hub.test/')).toBe('https://ff14-hub.test/api/v1/health');
  });

  it('拒绝非绝对路径，避免把相对路径拼到不可预期位置', () => {
    expect(() => buildApiUrl('api/v1/health')).toThrow();
  });

  it('拒绝非 http(s) 的基地址', () => {
    expect(() => buildApiUrl('/api/v1/health', 'ftp://example.com')).toThrow();
    expect(() => buildApiUrl('/api/v1/health', 'javascript:alert(1)')).toThrow();
  });
});

describe('normalizeApiError', () => {
  it('接受符合契约的错误体', () => {
    expect(normalizeApiError({ code: 'unauthorized', message: '需要有效的设备凭证。', requestId: 'r-1' })).toEqual({
      code: 'unauthorized',
      message: '需要有效的设备凭证。',
      requestId: 'r-1',
    });
  });

  it('拒绝契约外的错误码', () => {
    const normalized = normalizeApiError({ code: 'evil_code', message: 'x', requestId: 'r-1' });
    expect(normalized.code).toBe('internal_error');
    expect(normalized.requestId).toBe('client-malformed');
  });

  it('对 HTML 错误页等非契约响应降级为固定文案，不回显原文', () => {
    const normalized = normalizeApiError('<html><script>alert(1)</script></html>');
    expect(normalized.message).not.toContain('script');
    expect(normalized.code).toBe('internal_error');
    expect(normalizeApiError(undefined).requestId).toBe('client-malformed');
  });

  it('保留结构化的 details（阶段 04 的并发冲突必须能到达界面）', () => {
    const conflict = {
      reason: 'revision_conflict',
      entityType: 'nav_link',
      entityId: 'l-1',
      field: null,
      baseRevision: 3,
      currentRevision: 4,
      resolutionOptions: ['local', 'server'],
    };
    const normalized = normalizeApiError({
      code: 'conflict',
      message: '资源状态冲突。',
      requestId: 'r-2',
      details: { conflict },
    });
    expect(normalized.code).toBe('conflict');
    expect(normalized.details).toEqual({ conflict });
  });

  it('details 不是对象时一律丢弃，不把任意响应体当结构化数据', () => {
    expect(
      normalizeApiError({ code: 'conflict', message: 'x', requestId: 'r-3', details: 'not-an-object' }).details,
    ).toBeUndefined();
    expect(
      normalizeApiError({ code: 'conflict', message: 'x', requestId: 'r-4', details: null }).details,
    ).toBeUndefined();
    // 没有 details 时该键不存在（阶段 01–03 的响应形状不变）。
    expect('details' in normalizeApiError({ code: 'conflict', message: 'x', requestId: 'r-5' })).toBe(false);
  });
});

describe('createApiClient', () => {
  it('把 Token 放进 Authorization 头，且绝不放进 URL', async () => {
    const fetchSpy = makeFetchSpy(() => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    const client = createApiClient({ getToken: () => FAKE_TOKEN, fetchImpl: fetchSpy.fetchImpl });

    await client.request('/api/v1/me/profile');

    const { url, init } = fetchSpy.callAt(0);
    expect(url).toBe('/api/v1/me/profile');
    expect(url).not.toContain(FAKE_TOKEN);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('默认不附加 Authorization 头（阶段 01 不持有凭证）', async () => {
    const fetchSpy = makeFetchSpy(() => new Response('{}', { status: 200 }));
    const client = createApiClient({ fetchImpl: fetchSpy.fetchImpl });
    await client.request('/api/v1/health');
    expect(new Headers(fetchSpy.callAt(0).init.headers).has('Authorization')).toBe(false);
  });

  it('GET 不设置 Content-Type，带 body 的写请求自动设置 JSON', async () => {
    const fetchSpy = makeFetchSpy(() => new Response('{}', { status: 200 }));
    const client = createApiClient({ fetchImpl: fetchSpy.fetchImpl });

    await client.request('/api/v1/health');
    expect(new Headers(fetchSpy.callAt(0).init.headers).has('Content-Type')).toBe(false);

    await client.request('/api/v1/__test__/echo', { method: 'POST', body: '{"a":1}' });
    expect(new Headers(fetchSpy.callAt(1).init.headers).get('Content-Type')).toBe('application/json');
  });

  it('HTTP 失败时返回结构化错误，并优先采用响应头中的请求 ID', async () => {
    const fetchSpy = makeFetchSpy(
      () =>
        new Response(JSON.stringify({ code: 'unauthorized', message: '需要有效的设备凭证。', requestId: 'body-id' }), {
          status: 401,
          headers: { [REQUEST_ID_HEADER]: 'header-id' },
        }),
    );
    const client = createApiClient({ fetchImpl: fetchSpy.fetchImpl });

    const result = await client.request('/api/v1/me/profile');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.requestId).toBe('header-id');
    }
  });

  it('网络异常与 HTTP 失败区分：前者状态码 0', async () => {
    const fetchSpy = makeFetchSpy(() => {
      throw new TypeError('failed to fetch');
    });
    const client = createApiClient({ fetchImpl: fetchSpy.fetchImpl });

    const result = await client.request('/api/v1/health');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(NETWORK_FAILURE_STATUS);
      expect(result.error.requestId).toBe('client-network');
    }
  });

  it('health() 命中 /api/v1/health 并在成功时返回数据', async () => {
    const payload = {
      status: 'ok',
      service: 'ff14-hub',
      version: '0.0.0',
      environment: 'test',
      database: 'ok',
      nowUtcMs: 1,
    };
    const fetchSpy = makeFetchSpy(() => new Response(JSON.stringify(payload), { status: 200 }));
    const client = createApiClient({ fetchImpl: fetchSpy.fetchImpl });

    const result = await client.health();
    expect(fetchSpy.callAt(0).url).toBe(`${API_V1_PREFIX}/health`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.database).toBe('ok');
    }
  });
});
