/**
 * 响应构造helper。
 *
 * 为什么不用 `c.json(...)`：本项目需要精确控制状态码（避免依赖 Hono 的状态码字面量类型）
 * 与头部（requestId、no-store），集中在这里可以保证所有含凭证的响应形态一致。
 *
 * 安全前提：**任何包含或响应于凭证的响应都必须 `Cache-Control: no-store`**，
 * 避免被浏览器、代理或中间缓存留存。
 */
import { REQUEST_ID_HEADER } from '@ff14-hub/shared';
import type { RateLimitDecision } from './rate-limit';
import { errorResponse, requestIdOf } from '../middleware/error-handler';
import type { AppContext } from '../types';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** JSON 响应：附带 requestId，禁止缓存。 */
export function noStoreJson(c: AppContext, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': JSON_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      [REQUEST_ID_HEADER]: requestIdOf(c),
    },
  });
}

/** 无响应体的成功响应（例如 DELETE）。 */
export function noContent(c: AppContext): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      [REQUEST_ID_HEADER]: requestIdOf(c),
    },
  });
}

/** 429 响应：带 Retry-After，便于客户端正确退避。 */
export function rateLimited(c: AppContext, decision: RateLimitDecision): Response {
  const response = errorResponse('rate_limited', '请求过于频繁，请稍后重试。', requestIdOf(c));
  response.headers.set('Retry-After', String(decision.retryAfterSeconds));
  return response;
}
