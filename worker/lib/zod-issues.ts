/**
 * Zod 问题的**安全**文本化（HUB-004，抽到 lib 以便模块注册表复用）。
 *
 * 安全前提（重要）：
 * - 只由**字段路径 + 问题类别**构成，绝不回显提交的值。
 *   Zod 的若干默认文案会把「收到的值」拼进 message，直接透传会把凭证写进响应体与日志；
 *   模块设置将来可能包含 WebDAV 口令之类的敏感值，因此这条约束对模块设置同样成立。
 */

/** 每个请求最多列出的问题条目数，避免超长消息。 */
export const MAX_REPORTED_ISSUES = 5;

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

export interface ZodIssueLike {
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
