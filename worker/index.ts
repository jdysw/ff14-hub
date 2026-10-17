/**
 * Worker 入口（HUB-002）。
 *
 * 职责边界：
 * - 唯一在**所有**响应上施加安全响应头的位置（含 500 / 404 / 静态资源）。
 * - 顶层兜底异常处理：即使 Hono 的错误处理本身出问题，也不会把未处理的异常直接抛给运行时
 *   （那会产出没有安全头的裸 500）。
 * - 不在这里做认证、校验或业务判断——那些在 app.ts 的中间件链里。
 */
import { DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import { createApp } from './app';
import { resolveEnvironmentName, type Env } from './env';
import { errorResponse } from './middleware/error-handler';
import { normalizeRequestId } from './middleware/request-id';
import { withSecurityHeaders } from './middleware/security-headers';
import { logLine } from './lib/redact';
import { handleScheduled } from './scheduled';

const app = createApp();

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    let response: Response;
    try {
      response = await app.fetch(request, env, ctx);
    } catch (error) {
      // 理论上 onError 已经兜住；这里是最后一道防线，保证响应结构与安全头都成立。
      const requestId = normalizeRequestId(request.headers.get('X-Request-Id') ?? undefined);
      console.error(
        logLine('error', 'top_level_fetch_failure', {
          requestId,
          path: url.pathname,
          message: error,
        }),
      );
      response = errorResponse('internal_error', DEFAULT_ERROR_MESSAGE.internal_error, requestId);
    }

    return withSecurityHeaders(response, {
      environment: resolveEnvironmentName(env),
      isApi: isApiPath(url.pathname),
      // 仅在请求已由 HTTPS 提供时声明 HSTS，避免本地 http 调试被误导。
      enableHsts: url.protocol === 'https:',
    });
  },

  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
