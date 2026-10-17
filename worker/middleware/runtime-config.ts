/**
 * 运行时配置中间件（HUB-002 的「错误环境配置处理」）。
 *
 * 安全前提：
 * - 绑定/变量校验失败时，对外只返回通用 500，**不**把 zod 字段明细发给调用方；
 *   明细只写入服务端日志，且先经脱敏。
 * - 配置结果里只保留「是否已配置密钥」这类布尔事实。
 */
import { DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import { parseEnv } from '../env';
import { logLine } from '../lib/redact';
import type { AppMiddleware } from '../types';
import { errorResponse, requestIdOf } from './error-handler';

export function runtimeConfig(): AppMiddleware {
  return async (c, next) => {
    const result = parseEnv(c.env);
    if (!result.ok) {
      console.error(
        logLine('error', 'invalid_worker_env', {
          requestId: requestIdOf(c),
          issues: result.issues.join('; '),
        }),
      );
      // 刻意不回显 issues：环境变量名与结构属于内部信息。
      return errorResponse('internal_error', DEFAULT_ERROR_MESSAGE.internal_error, requestIdOf(c));
    }
    c.set('config', result.config);
    return await next();
  };
}
