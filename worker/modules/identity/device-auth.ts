/**
 * 设备认证（认证中间件的核心查询）。
 *
 * 安全前提：
 * 1) 只按**摘要**查询：`devices.token_hash` 是 SHA-256(token) 的十六进制。
 *    明文 Token 不落库、不落日志（本函数只接收明文用于计算摘要，不记录它）。
 * 2) 查询命中后再做一次固定时序比较，符合规划 6.3「SHA-256 + 固定时序比较」的要求，
 *    不依赖存储层索引比较的实现细节。
 * 3) 撤销与不存在都返回失败，且对外表现完全一致——不给攻击者任何枚举信号。
 * 4) 数据作用域来自认证结果本身：调用方只能使用返回的 workspaceId，
 *    绝不允许由客户端提交的 workspace id 决定作用域。
 */
import { constantTimeEqualStrings } from '../../lib/util';
import { hashCredential } from './credentials';

/** 认证成功后得到的身份。 */
export interface AuthenticatedDevice {
  readonly deviceId: string;
  readonly workspaceId: string;
}

export type DeviceAuthOutcome =
  | { readonly ok: true; readonly device: AuthenticatedDevice }
  | { readonly ok: false; readonly reason: 'invalid' | 'revoked' };

interface DeviceRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly token_hash: string;
  readonly revoked_at: number | null;
  readonly last_seen_at: number | null;
}

/** last_seen_at 的写入节流窗口：避免每个已认证请求都产生一次写放大。 */
export const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export async function authenticateDevice(db: D1Database, token: string): Promise<DeviceAuthOutcome> {
  const tokenHash = await hashCredential(token);

  const row = await db
    .prepare('SELECT id, workspace_id, token_hash, revoked_at, last_seen_at FROM devices WHERE token_hash = ? LIMIT 1')
    .bind(tokenHash)
    .first<DeviceRow>();

  if (row === null) {
    return { ok: false, reason: 'invalid' };
  }
  // 摘要长度固定（64 位十六进制），再做一次**平台提供的**常量时间比较：
  // 不依赖存储层索引比较的实现细节，也不使用手写循环。
  if (!constantTimeEqualStrings(row.token_hash, tokenHash)) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.revoked_at !== null) {
    return { ok: false, reason: 'revoked' };
  }

  await touchLastSeen(db, row.id, row.last_seen_at);
  return { ok: true, device: { deviceId: row.id, workspaceId: row.workspace_id } };
}

/**
 * 节流更新 last_seen_at。
 * 条件 UPDATE 自带并发保护：只有当前值仍早于节流窗口时才写入，重复写是幂等的。
 */
async function touchLastSeen(db: D1Database, deviceId: string, currentLastSeen: number | null): Promise<void> {
  const now = Date.now();
  if (currentLastSeen !== null && now - currentLastSeen < LAST_SEEN_THROTTLE_MS) {
    return;
  }
  await db
    .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
    .bind(now, deviceId, now - LAST_SEEN_THROTTLE_MS)
    .run();
}

/**
 * 关于审计：写入逻辑已移到 `./audit.ts`，它返回 **statement** 以便与业务写入放进同一个
 * `db.batch()` 事务提交，避免审计与事实不一致。
 *
 * 关于「认证失败审计」：`identity_audit.workspace_id` 为 NOT NULL，
 * 无法承载「未知 Token 认证失败」这类没有工作空间归属的事件，因此这类失败只写脱敏日志。
 * 若要落库，需要新增一张无归属审计表（属于后续工作，已在 docs/security-boundaries.md 记录）。
 */
