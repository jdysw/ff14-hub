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
import { timingSafeEqualHex } from '@ff14-hub/shared';
import { newId, timingSafeEqual } from '../../lib/util';
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
  // 双保险：摘要长度固定，可以做真正的固定时序比较。
  if (!timingSafeEqual(row.token_hash, tokenHash) || !timingSafeEqualHex(row.token_hash, tokenHash)) {
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
 * 写入身份审计记录（不含任何凭证或摘要）。
 * HUB-006 的 Bootstrap / 配对 / 撤销流程调用它。
 *
 * 已知限制（留给 HUB-006 决定）：`identity_audit.workspace_id` 为 NOT NULL，
 * 因此**无法**记录「未知 Token 的认证失败」这类没有工作空间归属的事件；
 * 本轮的做法是只写脱敏日志。HUB-006 需要选择：把该列放宽为可空，或另建一张无归属审计表。
 */
export async function recordIdentityAudit(
  db: D1Database,
  input: {
    readonly workspaceId: string;
    readonly eventType: string;
    readonly deviceId: string | null;
    readonly detail?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      newId(),
      input.workspaceId,
      input.eventType,
      input.deviceId,
      Date.now(),
      // detail 只允许放非敏感事实（例如 "pairing_id"、"reason"），禁止放凭证或其摘要。
      JSON.stringify(input.detail ?? {}),
    )
    .run();
}
