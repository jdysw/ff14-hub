/**
 * 日志脱敏（HUB-004，规划 9.2）。
 *
 * 安全前提：
 * - 任何写入日志的字符串都必须先经过 `redactSecrets`，因为错误可能携带请求内容、
 *   数据库摘要或第三方返回片段。
 * - 脱敏是**兜底**而不是许可：代码本身就不应该把凭证放进错误信息或日志。
 * - 这里只做模式匹配（高熵凭证形状、常见密钥字段名、Authorization 头），
 *   不试图理解语义；因此它不能替代「不记录敏感数据」的设计。
 */

/** 匹配本项目的三类高熵凭证：ffh_dev_ / ffh_rec_ / ffh_pair_ 前缀 + base64url 主体。 */
const CREDENTIAL_PATTERN = /\bffh_(?:dev|rec|pair)_[A-Za-z0-9_-]{8,}/g;

/** Authorization 头：连方案（Bearer/Basic/…）带凭证一起吞掉，只保留字段名。 */
const AUTHORIZATION_PATTERN =
  /\b(authorization\s*:\s*)(?:[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+)?[^\s,;"']+/gi;

/** 十六进制形态的长摘要（例如 token_hash / recovery_hash 的 SHA-256 十六进制输出）。 */
const HEX_DIGEST_PATTERN = /\b[0-9a-fA-F]{64}\b/g;

/**
 * 常见敏感字段的键值对（JSON、查询串、shell 风格均覆盖）。
 * 字符类刻意排除 `&`：否则会把查询串里后续的非敏感参数一起吃掉，破坏日志可读性。
 */
const SENSITIVE_FIELD_PATTERN =
  /("?(?:password|passwd|pwd|secret|token|token_hash|recovery_hash|recovery_key|pairing_hash|pairing_code|api[_-]?key|private[_-]?key|p256dh|auth|auth_secret|username|webdav[_-]?password)"?\s*[:=]\s*"?)([^"',;&\s}]+)/gi;

/** Web Push 端点里可能内嵌的一次性密钥（查询串形式）。 */
const URL_SECRET_QUERY_PATTERN = /([?&](?:token|key|secret|sig|signature)=)[^&\s]+/gi;

export const REDACTED = '[REDACTED]';

/**
 * 对文本做脱敏。非字符串输入返回 `[UNPRINTABLE]`，避免把对象意外序列化进日志。
 */
export function redactSecrets(input: unknown): string {
  if (input === null || input === undefined) {
    return '';
  }
  if (typeof input !== 'string') {
    if (input instanceof Error) {
      return redactSecrets(input.message);
    }
    return '[UNPRINTABLE]';
  }
  return input
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
    .replace(CREDENTIAL_PATTERN, REDACTED)
    .replace(HEX_DIGEST_PATTERN, '[REDACTED_HEX]')
    .replace(SENSITIVE_FIELD_PATTERN, `$1${REDACTED}`)
    .replace(URL_SECRET_QUERY_PATTERN, `$1${REDACTED}`);
}

/**
 * 构造结构化日志行。使用 JSON 便于检索，且所有字段先经脱敏。
 * 注意：调用方不得把整个 request 对象传进来；只传明确挑选过的字段。
 */
export function logLine(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): string {
  const safeFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    // 键名本身也可能是敏感的，因此对键与值都做脱敏。
    safeFields[redactSecrets(key)] = redactSecrets(value);
  }
  return JSON.stringify({ level, event, ...safeFields });
}
