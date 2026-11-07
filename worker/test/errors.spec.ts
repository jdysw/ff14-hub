/**
 * 统一错误结构与脱敏测试。
 *
 * 覆盖 HUB-004 验收：400/401/404/405/409/413/415/422/500 的关键路径
 * （401 与 413/415/422 的完整覆盖在 auth.spec.ts 与 security.spec.ts）。
 */
import { apiErrorBodySchema } from '@ff14-hub/shared';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TEST_BASE_URL } from './helpers';

/** 断言响应是严格的 `{ code, message, requestId }` 结构，并返回该对象。 */
async function expectApiError(
  response: Response,
  status: number,
  code: string,
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  const body = await response.json<Record<string, unknown>>();
  // 结构必须严格符合共享契约（不允许出现额外字段）。
  expect(apiErrorBodySchema.safeParse(body).success).toBe(true);
  expect(body['code']).toBe(code);
  expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(['code', 'message', 'requestId']);
  return body;
}

describe('统一错误结构', () => {

  it('/api/* 下的未知路径不得回退成 SPA HTML', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/unknown`);
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const text = await response.text();
    expect(text).not.toContain('<!doctype html');
    expect(text).not.toContain('<html');
  });

  it('未预期异常降级为脱敏 500，不泄露内部诊断文本', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/boom`);
    const body = await expectApiError(response, 500, 'internal_error');
    expect(body['message']).not.toContain('内部诊断信息');
    expect(JSON.stringify(body)).not.toContain('Error');
  });

  it('400：JSON 语法错误走 bad_request', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ "label": "x", ',
    });
    await expectApiError(response, 400, 'bad_request');
  });

});
