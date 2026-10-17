/**
 * 身份凭证契约（规划 6.3）——阶段 01 的**契约层**。
 *
 * 本轮（HUB-001～HUB-005）只落地契约与认证中间件；Bootstrap / 配对 / 恢复等完整身份流程
 * 由下一轮 HUB-006 在同一任务中实现。这里定义的东西就是 HUB-006 必须遵守的形状，
 * 任何一侧改动都要同步本文件，否则视为契约破坏。
 *
 * 安全前提（不可协商）：
 * - 设备 Token 与恢复密钥都是**至少 256-bit 的高熵随机值**，服务端只保存摘要（SHA-256）。
 *   高熵随机值可以直接用 SHA-256；低熵口令（例如用户自己设的密码）**不得**套用同样方案，
 *   必须使用专门的密码哈希（Argon2id/scrypt/PBKDF2），二者不可混用。
 * - Token 绝不出现在 URL query、日志、分析系统或错误信息里；只走 Authorization 头。
 * - 本地/预览/生产使用完全独立的凭证，不得把生产恢复密钥预置进测试。
 */

/** 设备 Bearer Token 前缀。前缀用于快速拒绝明显不合法/别处的凭证，不构成安全性。 */
export const DEVICE_TOKEN_PREFIX = 'ffh_dev_';
/** 恢复密钥前缀。 */
export const RECOVERY_KEY_PREFIX = 'ffh_rec_';
/** 一次性配对凭证前缀。 */
export const PAIRING_CODE_PREFIX = 'ffh_pair_';

/** 随机字节数：32 字节 = 256 bit。 */
export const TOKEN_RANDOM_BYTES = 32;
/** base64url 无填充编码 32 字节后的字符数。 */
export const TOKEN_BODY_LENGTH = 43;
/** SHA-256 十六进制摘要长度。 */
export const TOKEN_HASH_HEX_LENGTH = 64;
/** 服务端凭证摘要算法标识。 */
export const TOKEN_HASH_ALGORITHM = 'SHA-256';

/** 两类凭证的严格形状校验。用于中间件在查库前先做廉价形状过滤。 */
export const DEVICE_TOKEN_PATTERN = /^ffh_dev_[A-Za-z0-9_-]{43}$/;
export const RECOVERY_KEY_PATTERN = /^ffh_rec_[A-Za-z0-9_-]{43}$/;
export const PAIRING_CODE_PATTERN = /^ffh_pair_[A-Za-z0-9_-]{43}$/;

export const AUTH_HEADER_NAME = 'Authorization';
export const AUTH_SCHEME = 'Bearer';

export type BearerParseResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' };

/**
 * 解析 Authorization 头。
 * 只接受 `Bearer <token>` 且 token 必须匹配设备 Token 形状；
 * 不接受 query 参数、Cookie、自定义 X- 头等替代通道。
 */
export function parseBearerToken(headerValue: string | null | undefined): BearerParseResult {
  if (headerValue === null || headerValue === undefined) {
    return { ok: false, reason: 'missing' };
  }
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'missing' };
  }
  const separatorIndex = trimmed.indexOf(' ');
  if (separatorIndex <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const scheme = trimmed.slice(0, separatorIndex);
  const token = trimmed.slice(separatorIndex + 1).trim();
  // scheme 大小写不敏感是 RFC 7235 的要求；token 本身区分大小写。
  if (scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase()) {
    return { ok: false, reason: 'malformed' };
  }
  if (!DEVICE_TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, token };
}

/**
 * 关于「常量时间比较」：本包**不提供**该原语。
 *
 * 原因：这里是前后端共用的纯函数层，只能写出普通 JS 循环，而 JIT 优化使它不具备
 * 可声称的时序安全保证。Worker 侧的凭证比较使用平台的
 * `crypto.subtle.timingSafeEqual`，见 `worker/lib/util.ts` 与
 * `worker/modules/identity/credentials.ts` 的 `credentialsEqual()`。
 */

/** 受支持的区服（规划 1.4）。 */
export const REGIONS = ['cn', 'global'] as const;
export type Region = (typeof REGIONS)[number];

/** 通用导航数据可以同时适用于两个区服。 */
export const CATALOG_REGIONS = ['cn', 'global', 'both'] as const;
export type CatalogRegion = (typeof CATALOG_REGIONS)[number];

/** 身份操作审计事件类型（identity_audit.event_type 的枚举约束来源）。 */
export const IDENTITY_AUDIT_EVENTS = [
  'workspace_bootstrapped',
  'device_paired',
  'device_pairing_created',
  'device_recovered',
  'device_revoked',
  'device_auth_failed',
] as const;
export type IdentityAuditEvent = (typeof IDENTITY_AUDIT_EVENTS)[number];
