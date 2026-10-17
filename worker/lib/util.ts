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
 * 常量时间字符串比较（Worker 侧）。
 *
 * 使用**运行时提供的** `crypto.subtle.timingSafeEqual`——Cloudflare Workers 提供的扩展，
 * 由平台实现常量时间比较。刻意不使用手写 JS 循环：V8 的 JIT 可以对普通循环做优化与分支预测，
 * 手写循环不应被描述为具备时序安全保证。
 *
 * 长度不同直接返回 false：本函数的比较对象长度固定（SHA-256 十六进制摘要、定长凭证），
 * 长度本身不构成秘密；平台实现也要求两侧等长。
 */
export function constantTimeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * 判断 D1 错误是否为唯一约束冲突。
 *
 * 用途：把「并发下第二个请求撞上唯一约束」这种**预期内的竞争失败**与真正的故障区分开。
 * D1 的约束错误消息形如
 *   `D1_ERROR: UNIQUE constraint failed: workspace_bootstrap_guard.singleton_key: SQLITE_CONSTRAINT`
 * 因此同时匹配原因与 SQLite 错误码，避免把其它错误误判为冲突。
 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (isForeignKeyConstraintError(error)) {
    return false;
  }
  return /UNIQUE constraint failed/i.test(error.message) || /SQLITE_CONSTRAINT_UNIQUE/i.test(error.message);
}

/** 判断是否为外键约束失败（与唯一约束区分，便于给出不同处理）。 */
export function isForeignKeyConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /FOREIGN KEY constraint failed/i.test(error.message) || /SQLITE_CONSTRAINT_FOREIGNKEY/i.test(error.message);
}

/**
 * 稳定的 JSON 序列化：对象键排序后输出。
 *
 * 用途：比较「设置是否真的变化了」。直接比较 `JSON.stringify` 会因键顺序不同而误判为变化，
 * 从而把幂等的重复 PATCH 错误地当成修改（并多 bump 一次 revision）。
 * 只支持 JSON 可表示的值；遇到循环引用会退化为 `undefined`（调用方按「无法比较」处理）。
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (seen.has(input)) {
      return undefined;
    }
    seen.add(input);
    if (Array.isArray(input)) {
      return input.map((item) => normalize(item));
    }
    const source = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = normalize(source[key]);
    }
    return result;
  };
  return JSON.stringify(normalize(value)) ?? 'null';
}

