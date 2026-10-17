/**
 * 输入校验中间件（HUB-004）：所有外部输入必须经 Zod 校验。
 *
 * 为什么不使用现成的 zValidator('json', ...)：
 * 写请求体已在 write-guard 中按体积上限读取并解析完毕（流只能消费一次），
 * 因此这里校验的是 `c.get('jsonBody')`，而不是再次读取请求流。
 *
 * 安全前提（重要）：
 * - 校验失败消息只由**字段路径 + 问题类别**构成，绝不回显提交的值。
 *   Zod 的若干默认文案会把「收到的值」拼进 message，直接透传会把凭证写进响应体与日志。
 * - 细节只写服务端行为的结果：客户端拿到统一的 `validation_failed` + 可读的字段提示。
 * - 安全文本化实现已抽到 `worker/lib/zod-issues.ts`，模块注册表的设置校验复用同一份，
 *   避免两处各写一份而漂移。
 */
import { ApiError, DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import type { ZodType } from 'zod';
import { describeIssues } from '../lib/zod-issues';
import type { AppMiddleware } from '../types';

// 保持既有导入路径可用（注册表与测试都从这里取；实现只有一份）。
export { describeIssues, MAX_REPORTED_ISSUES } from '../lib/zod-issues';

/** 取出已被 `validateJsonBody` 校验过的请求体，并保持静态类型。 */
export function parsedJsonBody<T>(c: { get: (key: 'jsonBody') => unknown }, schema: ZodType<T>): T {
  const result = schema.safeParse(c.get('jsonBody'));
  if (!result.success) {
    // 走到这里说明中间件链被错误改动（validateJsonBody 未挂载）。
    // 这是编程错误而非输入问题，因此按内部错误处理，不把 zod 细节发给调用方。
    throw new ApiError('internal_error', DEFAULT_ERROR_MESSAGE.internal_error, 'validated_body_missing');
  }
  return result.data;
}

/** 校验已解析的 JSON 请求体，并把校验后的值写回 context。 */
export function validateJsonBody<T>(schema: ZodType<T>): AppMiddleware {
  return async (c, next) => {
    const parsed = schema.safeParse(c.get('jsonBody'));
    if (!parsed.success) {
      throw new ApiError(
        'validation_failed',
        `${DEFAULT_ERROR_MESSAGE.validation_failed}（${describeIssues(parsed.error.issues)}）`,
        `json_body_invalid:${describeIssues(parsed.error.issues)}`,
      );
    }
    c.set('jsonBody', parsed.data);
    await next();
  };
}

/** 校验查询参数（不消费请求体，因此可以与 validateJsonBody 并存）。 */
export function validateQuery<T>(schema: ZodType<T>): AppMiddleware {
  return async (c, next) => {
    const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_failed',
        `${DEFAULT_ERROR_MESSAGE.validation_failed}（${describeIssues(parsed.error.issues)}）`,
        `query_invalid:${describeIssues(parsed.error.issues)}`,
      );
    }
    await next();
  };
}
