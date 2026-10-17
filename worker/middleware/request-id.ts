/**
 * 请求 ID 中间件。
 *
 * 安全前提：
 * - 只接受形状受限的传入 `X-Request-Id`（防止把任意内容注入日志与响应头）。
 * - 传入值不被信任为唯一：不合法就重新生成，而不是原样回显。
 */
import type { AppMiddleware } from '../types';

/** 允许的请求 ID 形状：短、可见 ASCII、无控制字符。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestId(): AppMiddleware {
  return async (c, next) => {
    const incoming = c.req.header('X-Request-Id');
    c.set('requestId', normalizeRequestId(incoming));
    await next();
  };
}

export function normalizeRequestId(raw: string | undefined): string {
  if (raw !== undefined && REQUEST_ID_PATTERN.test(raw)) {
    return raw;
  }
  return crypto.randomUUID();
}
