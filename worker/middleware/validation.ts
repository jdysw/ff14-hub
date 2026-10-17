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
 */
import { ApiError, DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import type { ZodType } from 'zod';
import type { AppMiddleware } from '../types';

/** 每个请求最多列出的问题条目数，避免超长消息。 */
const MAX_REPORTED_ISSUES = 5;

/** zod issue code → 简短中文说明。刻意不含任何「收到值」的信息。 */
const ISSUE_TEXT: Readonly<Record<string, string>> = {
  invalid_type: '类型不正确',
  too_small: '长度或数值过小',
  too_big: '长度或数值过大',
  invalid_format: '格式不正确',
  invalid_value: '取值不在允许范围内',
  invalid_union: '不匹配任何允许的形式',
  unrecognized_keys: '包含未允许的字段',
  invalid_key: '字段名不合法',
  not_multiple_of: '不是允许的倍数',
  custom: '不满足额外约束',
};

interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/** 把 zod 问题列表转成安全的可读文本：只有路径与类别，没有值。 */
export function describeIssues(issues: readonly ZodIssueLike[]): string {
  const parts = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '<root>';
    return `${path}: ${ISSUE_TEXT[issue.code] ?? '不合法'}`;
  });
  if (issues.length > MAX_REPORTED_ISSUES) {
    parts.push(`…等共 ${issues.length} 项`);
  }
  return parts.join('；');
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
