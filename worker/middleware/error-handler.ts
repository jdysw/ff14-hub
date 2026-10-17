/**
 * 统一错误处理与统一 404（HUB-004）。
 *
 * 安全前提：
 * - 对外响应严格遵循 `{ code, message, requestId }`，绝不包含堆栈、SQL 语句、表名、
 *   绑定名、文件路径或任何凭证。
 * - 未知异常一律降级为内部错误；真实原因只写服务端日志，且先经 `redactSecrets` 脱敏。
 * - 校验失败也走同一结构；字段级细节只保留**路径与问题类别**，不回显提交的值
 *   （zod 的若干默认文案会把「收到的值」写进 message，直接转发会泄露凭证）。
 */
import {
  ApiError,
  DEFAULT_ERROR_MESSAGE,
  HTTP_STATUS_BY_ERROR_CODE,
  REQUEST_ID_HEADER,
  type ApiErrorBody,
  type ApiErrorCode,
} from '@ff14-hub/shared';
import type { Hono } from 'hono';
import { logLine } from '../lib/redact';
import type { AppBindings, AppContext } from '../types';

/** 构造对外错误响应体。这是唯一允许的响应形状。 */
export function errorBody(code: ApiErrorCode, message: string, requestId: string): ApiErrorBody {
  return { code, message, requestId };
}

/**
 * 构造错误响应。刻意手工构造 Response，以便：
 * 1) 精确控制状态码，不依赖 Hono 的状态码字面量类型；
 * 2) 统一附加 requestId 头与 401 的 WWW-Authenticate。
 */
export function errorResponse(code: ApiErrorCode, message: string, requestId: string): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    [REQUEST_ID_HEADER]: requestId,
  });
  if (code === 'unauthorized') {
    // 声明认证方案，但不透露任何关于凭证是否存在的信号。
    headers.set('WWW-Authenticate', 'Bearer realm="ff14-hub"');
  }
  return new Response(JSON.stringify(errorBody(code, message, requestId)), {
    status: HTTP_STATUS_BY_ERROR_CODE[code],
    headers,
  });
}

/** 读取上下文中的请求 ID；即使中间件未执行也给出稳定回退值。 */
export function requestIdOf(c: AppContext): string {
  const value: string | undefined = c.get('requestId');
  return value === undefined || value.length === 0 ? 'req-unknown' : value;
}

/** 统一的 404 构造器（供未知 API 路径与自定义 notFound 使用）。 */
export function apiNotFound(c: AppContext): Response {
  return errorResponse('not_found', DEFAULT_ERROR_MESSAGE.not_found, requestIdOf(c));
}

/** 统一的 405 构造器：声明允许的方法，不泄露其他信息。 */
export function methodNotAllowed(allowed: readonly string[]): (c: AppContext) => Response {
  return (c: AppContext) => {
    const response = errorResponse(
      'method_not_allowed',
      DEFAULT_ERROR_MESSAGE.method_not_allowed,
      requestIdOf(c),
    );
    response.headers.set('Allow', allowed.join(', '));
    return response;
  };
}

/**
 * 注册全局错误处理器。
 * 注意：安全响应头由顶层 fetch 统一施加，这里只负责错误结构与脱敏。
 */
export function registerErrorHandlers(app: Hono<AppBindings>): void {
  app.onError((error, c) => {
    const requestId = requestIdOf(c);

    if (error instanceof ApiError) {
      // 预期内的业务错误：4xx 属正常控制流，5xx 才需要记录。
      if (error.status >= 500) {
        console.error(
          logLine('error', 'api_error', {
            requestId,
            code: error.code,
            detail: error.logDetail ?? '',
          }),
        );
      }
      return errorResponse(error.code, error.message, requestId);
    }

    // 未预期异常：只记录脱敏后的名称与消息，绝不记录请求体或凭证。
    console.error(
      logLine('error', 'unhandled_error', {
        requestId,
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return errorResponse('internal_error', DEFAULT_ERROR_MESSAGE.internal_error, requestId);
  });

  app.notFound((c) => apiNotFound(c));
}
