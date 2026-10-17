/**
 * 统一错误结构与脱敏测试。
 *
 * 覆盖 HUB-004 验收：400/401/404/405/409/413/415/422/500 的关键路径
 * （401 与 413/415/422 的完整覆盖在 auth.spec.ts 与 security.spec.ts）。
 */
import { apiErrorBodySchema } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import type { Env } from '../env';
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
  expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId']);
  return body;
}

describe('统一错误结构', () => {
  it('未知 /api/v1 路径返回结构化 404', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/does-not-exist`);
    const body = await expectApiError(response, 404, 'not_found');
    expect(body['requestId']).toBeTypeOf('string');
  });

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

  it('契约内的业务错误保持同一结构，且 logDetail 不进响应', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/conflict`);
    const body = await expectApiError(response, 409, 'conflict');
    expect(body['message']).toBe('资源状态冲突。');
    // ApiError 的第三个参数只供服务端日志。
    expect(JSON.stringify(body)).not.toContain('内部诊断');
  });

  it('400：JSON 语法错误走 bad_request', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ "label": "x", ',
    });
    await expectApiError(response, 400, 'bad_request');
  });

  it('422：字段缺失/类型错误走 validation_failed', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ok' }),
    });
    const body = await expectApiError(response, 422, 'validation_failed');
    // 允许在 message 中给出字段路径与问题类别，但不能回显提交的值。
    expect(body['message']).toContain('count');
  });

  it('422：未允许的额外字段被拒绝（strict 模式）', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'ok', count: 1, unexpected: 'x' }),
    });
    await expectApiError(response, 422, 'validation_failed');
  });

  it('查询参数校验失败同样返回 422', async () => {
    const response = await SELF.fetch(`${TEST_BASE_URL}/api/v1/__test__/echo?region=mars`);
    await expectApiError(response, 422, 'validation_failed');
  });
});

describe('环境配置错误处理（HUB-002 验收）', () => {
  it('缺少 DB 绑定时返回脱敏 500，不回显字段级问题', async () => {
    const app = createApp();
    // 刻意传入不合法 env：这是唯一能触发该分支的方式，且不依赖测试池的绑定可变性。
    // 双重断言是刻意的：这里要构造**不满足 Env**（缺少 DB 绑定）的运行时输入。
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const response = await app.request('/api/v1/health', { method: 'GET' }, {} as unknown as Env);
    expect(response.status).toBe(500);
    const body = await response.json<Record<string, unknown>>();
    expect(apiErrorBodySchema.safeParse(body).success).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('DB');
    expect(serialized).not.toContain('D1');
    expect(body['code']).toBe('internal_error');
  });

  it('自检路由在开关关闭时表现为路径不存在（404，而非 403）', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/v1/__test__/boom',
      { method: 'GET' },
      { DB: env.DB, ENVIRONMENT: 'test' },
    );
    // 不暴露「该路由存在但被禁用」这一信息。
    expect(response.status).toBe(404);
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe('not_found');
  });
});
