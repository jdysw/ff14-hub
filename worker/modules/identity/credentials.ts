/**
 * 高熵凭证的独立摘要和比较原语，供现行 owner 与通知设备使用。
 *
 * 安全前提（规划 6.3，不可协商）：
 * - 临时随机凭证的熵不得低于 256 bit（32 字节）。
 * - 服务端只保存 SHA-256 摘要；明文只在发放的那一刻返回给客户端一次，绝不落库、绝不落日志。
 * - SHA-256 适用于**高熵随机值**。若将来引入用户自设口令，必须改用专门的密码哈希
 *   （Argon2id/scrypt/PBKDF2）并加盐，不得复用这里的哈希。
 */
const TOKEN_RANDOM_BYTES = 32;
import { constantTimeEqualStrings } from '../../lib/util';

/** 把高熵字节数组编码为 base64url（无填充）。 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
  const padding = encoded.indexOf('=');
  return padding < 0 ? encoded : encoded.slice(0, padding);
}

/** 计算凭证摘要（SHA-256 十六进制，小写）。 */
export async function hashCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * 生成一个新的高熵凭证；用途由调用者提供的固定前缀标识。
 */
export function generateCredential(prefix: string): string {
  const bytes = new Uint8Array(TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return `${prefix}${toBase64Url(bytes)}`;
}

/**
 * 以平台的常量时间比较判断两个凭证是否相等。
 *
 * 实现要点：先对两侧各自取 SHA-256，使参与比较的字节串长度恒等（32 字节），
 * 再交给 `crypto.subtle.timingSafeEqual`。这样既避免长度差异泄露信息，
 * 也不依赖任何手写循环的时序特性。
 */
export async function credentialsEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([hashCredential(a), hashCredential(b)]);
  return constantTimeEqualStrings(hashA, hashB);
}
