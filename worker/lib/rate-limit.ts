import {forEachSequential} from "../../packages/shared/src/sequential-tasks.mjs";
/**
 * 速率限制（HUB-006）：D1 上的固定窗口计数，原子且并发安全。
 *
 * 安全前提：
 * - **不存明文客户端标识**：scope_key 由调用方传入「端点 + 标识摘要」，见 `identityScopeKey()`。
 * - **原子性**：不使用「读 → 判断 → 写」这种有竞态的流程，而是依赖
 *   `UPDATE ... WHERE attempt_count < limit` 的条件更新与 `ON CONFLICT DO NOTHING` 的插入结果
 *   来判定本次请求是否被允许。并发下不会出现「限流被绕过」。
 * - 限流是**纵深防御**，不是身份认证：即使被绕过，凭证本身仍是高熵随机值。
 */

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** 被拒时建议的等待秒数（用于 Retry-After）。 */
  readonly retryAfterSeconds: number;
}

/** 各身份端点的限流策略。参数取保守值，避免被暴力枚举又不影响正常使用。 */
export const RATE_LIMITS = {
  /** Authenticated manual delivery can perform external IO; rotating devices must not bypass workspace quota. */
  reminderReconcilePerWorkspace: { limit: 5, windowMs: 60 * 1000 },
  pushRegistrationPerWorkspace: { limit: 20, windowMs: 10 * 60 * 1000 },
  pushRegistrationPerDevice: { limit: 10, windowMs: 10 * 60 * 1000 },
  /** Bootstrap：初始化密钥可能被暴力猜测，窗口内次数要少。 */
  bootstrapPerClient: { limit: 10, windowMs: 5 * 60 * 1000 },
  bootstrapGlobal: { limit: 30, windowMs: 5 * 60 * 1000 },
  /** 配对领取：配对码同样是可猜测凭证。 */
  pairingClaimPerClient: { limit: 20, windowMs: 5 * 60 * 1000 },
  pairingClaimGlobal: { limit: 60, windowMs: 5 * 60 * 1000 },
  /** 配对创建：需要已认证设备，但仍限流以防被用作放大点。 */
  pairingCreatePerDevice: { limit: 30, windowMs: 10 * 60 * 1000 },
  /** 恢复：恢复密钥是最高价值凭证，窗口更长。 */
  recoverPerClient: { limit: 10, windowMs: 15 * 60 * 1000 },
  recoverGlobal: { limit: 30, windowMs: 15 * 60 * 1000 },
} as const satisfies Readonly<Record<string, RateLimitPolicy>>;

/** 读取 D1 的受影响行数。 */
function changedRows(result: D1Result<unknown>): number {
  return result.meta.changes ?? 0;
}

/** 判断一次拒绝。 */
function deny(retryAfterSeconds: number): RateLimitDecision {
  return { allowed: false, retryAfterSeconds };
}

function allow(): RateLimitDecision {
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * 消费一次配额并返回是否允许。
 *
 * 流程（每一步都是原子的，任意一步的判定都不依赖先前的读取结果）：
 * 1. 尝试插入新窗口行：`ON CONFLICT DO NOTHING` —— 插入成功即为本窗口第 1 次，放行。
 * 2. 行已存在且窗口未过期：条件自增（`attempt_count < limit`）—— 自增成功即放行。
 * 3. 走到这里说明「已超限」或「窗口已过期」。读一行只为区分这两种情况，
 *    随后用**带 window_start 条件**的更新重置窗口；若更新失败说明有并发者先重置了，
 *    本次保守拒绝（而不是放行），避免把限流放宽。
 */
export async function consumeRateLimit(
  db: D1Database,
  scopeKey: string,
  policy: RateLimitPolicy,
): Promise<RateLimitDecision> {
  const now = Date.now();
  const windowFloor = now - policy.windowMs;

  const inserted = await db
    .prepare(
      'INSERT INTO auth_rate_limits (scope_key, window_start, attempt_count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (scope_key) DO NOTHING',
    )
    .bind(scopeKey, now, now)
    .run();
  if (changedRows(inserted) === 1) {
    return allow();
  }

  const bumped = await db
    .prepare(
      'UPDATE auth_rate_limits SET attempt_count = attempt_count + 1, updated_at = ? WHERE scope_key = ? AND window_start > ? AND attempt_count < ?',
    )
    .bind(now, scopeKey, windowFloor, policy.limit)
    .run();
  if (changedRows(bumped) === 1) {
    return allow();
  }

  const row = await db
    .prepare('SELECT window_start, attempt_count FROM auth_rate_limits WHERE scope_key = ?')
    .bind(scopeKey)
    .first<{ window_start: number; attempt_count: number }>();

  if (row === null) {
    // 极端情况：行在两次语句之间被清理。保守拒绝，等待下一个窗口。
    return deny(1);
  }

  if (row.window_start <= windowFloor) {
    // 窗口已过期：条件重置（只有 window_start 仍是我们读到的值时才重置）。
    const reset = await db
      .prepare(
        'UPDATE auth_rate_limits SET window_start = ?, attempt_count = 1, updated_at = ? WHERE scope_key = ? AND window_start = ?',
      )
      .bind(now, now, scopeKey, row.window_start)
      .run();
    if (changedRows(reset) === 1) {
      return allow();
    }
    return deny(1);
  }

  const remainingMs = row.window_start + policy.windowMs - now;
  return deny(Math.max(1, Math.ceil(remainingMs / 1000)));
}

/**
 * 依次消费多条配额，任一被拒即整体拒绝。
 *
 * 注意：先被消费的配额不会因为后续被拒而回退。这是刻意的保守取舍——
 * 宁可多记一次尝试，也不引入「回滚计数」这种新竞态。
 */
export async function enforceRateLimits(
  db: D1Database,
  entries: readonly (readonly [scopeKey: string, policy: RateLimitPolicy])[],
): Promise<RateLimitDecision> {
  let worst: RateLimitDecision = allow();
  await forEachSequential(entries,async ([scopeKey, policy])=>{
    const decision = await consumeRateLimit(db, scopeKey, policy);
    if (!decision.allowed) {
      worst = {
        allowed: false,
        retryAfterSeconds: Math.max(worst.retryAfterSeconds, decision.retryAfterSeconds),
      };
    }
  });
  return worst;
}
