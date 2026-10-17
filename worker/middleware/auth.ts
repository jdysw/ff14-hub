/**
 * 设备认证中间件（HUB-006 契约，本轮已完整实现）。
 *
 * 保护范围：所有 `/api/v1/me/*`（以及将来任何私有端点）都必须挂载它。
 *
 * 安全前提：
 * - 401 是唯一失败出口：缺少凭证、形状非法、未知 Token、已撤销 Token 全部返回同一个
 *   401 与同一条文案，不提供任何可用于枚举的差异。
 * - 失败原因只写脱敏日志（不含 Token），便于运维排查而不制造泄露面。
 * - 成功时把 workspaceId / deviceId 写入 context；下游只能使用它们，
 *   不得接受客户端提交的 workspace id。
 */
import { AUTH_HEADER_NAME, ApiError, DEFAULT_ERROR_MESSAGE, parseBearerToken } from '@ff14-hub/shared';
import { logLine } from '../lib/redact';
import { authenticateDevice } from '../modules/identity/device-auth';
import type { AppMiddleware, AppContext } from '../types';

function logAuthFailure(c: AppContext, reason: string): void {
  console.warn(
    logLine('warn', 'device_auth_failed', {
      requestId: c.get('requestId'),
      reason,
      path: new URL(c.req.url).pathname,
    }),
  );
}

export function deviceAuth(): AppMiddleware {
  return async (c, next) => {
    const parsed = parseBearerToken(c.req.header(AUTH_HEADER_NAME));
    if (!parsed.ok) {
      logAuthFailure(c, parsed.reason);
      throw new ApiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized);
    }

    const outcome = await authenticateDevice(c.env.DB, parsed.token);
    if (!outcome.ok) {
      logAuthFailure(c, outcome.reason);
      throw new ApiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized);
    }

    c.set('deviceId', outcome.device.deviceId);
    c.set('workspaceId', outcome.device.workspaceId);
    await next();
  };
}
