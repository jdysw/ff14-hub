/**
 * 通用小工具（无业务语义）。
 */

/** 当前 UTC 毫秒时间戳。集中在一处便于测试与将来替换时钟。 */
export function nowUtcMs(): number {
  return Date.now();
}

/** 生成新的行 ID。使用 UUID v4；D1 中 ID 一律为 TEXT（规划 5.1）。 */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * 常量时间字符串比较，用于比较凭证摘要。
 * 长度不同立刻返回 false——比较对象必须是固定长度的十六进制摘要。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
