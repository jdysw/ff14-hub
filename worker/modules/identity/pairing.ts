/**
 * 一次性有限期设备配对（HUB-006 / 规划 6.3）。
 *
 * 不变量：
 * - 配对凭证是高熵随机值（32 字节），只保存 SHA-256 摘要；明文只在创建响应里返回一次。
 * - **有效期**由 `expires_at` 强制，且上限被夹紧（不能只信请求参数）。
 * - **单次消费 + 新设备 + 审计在同一个 D1 batch（SQL 事务）内完成**：
 *   不存在「配对已烧毁但设备未创建」的中间状态，也没有跨事务补偿逻辑。
 * - 独占判定使用 `pairing_claims` 的主键（`pairing_id`）与本次调用独有的 `device_id`（UUID），
 *   而不是毫秒时间戳——时间戳在同一毫秒会撞，UUID 不会。
 * - 「未消费 / 未过期 / 发起设备未撤销」三项检查与消费写在同一批语句内，
 *   因此不存在「读到有效状态、提交前状态被改变」的 TOCTOU 窗口。
 * - 任何一句失败（例如被故障注入的触发器阻止）都会让整批回滚，
 *   消费标记、新设备与审计一起消失，配对码仍可正常重试。
 */
import { PAIRING_CODE_PREFIX, MAX_PAIRING_TTL_SECONDS, type DeviceSummary } from '@ff14-hub/shared';
import { newId } from '../../lib/util';
import { identityAuditStatement } from './audit';
import { generateCredential, generateDeviceToken, hashCredential } from './credentials';

/** 默认配对有效期：10 分钟。 */
export const DEFAULT_PAIRING_TTL_SECONDS = 600;

export interface PairingCreated {
  readonly pairingCode: string;
  readonly expiresAt: number;
}

/** 把请求给定的 TTL 夹紧到允许区间。 */
export function clampPairingTtlSeconds(ttlSeconds: number | undefined): number {
  const value = ttlSeconds ?? DEFAULT_PAIRING_TTL_SECONDS;
  if (!Number.isFinite(value)) {
    return DEFAULT_PAIRING_TTL_SECONDS;
  }
  return Math.min(Math.max(Math.trunc(value), 60), MAX_PAIRING_TTL_SECONDS);
}

export async function createPairing(
  db: D1Database,
  input: {
    readonly workspaceId: string;
    readonly createdByDevice: string;
    readonly ttlSeconds?: number;
  },
): Promise<PairingCreated> {
  const pairingId = newId();
  const pairingCode = generateCredential(PAIRING_CODE_PREFIX);
  const pairingHash = await hashCredential(pairingCode);
  const now = Date.now();
  const expiresAt = now + clampPairingTtlSeconds(input.ttlSeconds) * 1000;

  await db.batch([
    db
      .prepare(
        'INSERT INTO device_pairings (id, workspace_id, pairing_hash, expires_at, used_at, created_by_device, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      )
      .bind(pairingId, input.workspaceId, pairingHash, expiresAt, input.createdByDevice, now),
    identityAuditStatement(db, {
      workspaceId: input.workspaceId,
      eventType: 'device_pairing_created',
      deviceId: input.createdByDevice,
      at: now,
      // 只记录配对记录 id 与有效期，不记录配对码或摘要。
      detail: { pairingId, expiresAt },
    }),
  ]);

  return { pairingCode, expiresAt };
}

export type PairingClaimOutcome =
  | {
      readonly ok: true;
      readonly workspaceId: string;
      readonly deviceId: string;
      readonly deviceToken: string;
      readonly createdAt: number;
    }
  | { readonly ok: false; readonly reason: 'invalid' | 'consumed' | 'expired' | 'origin_device_revoked' };

interface PairingDiagnosticRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly used_at: number | null;
  readonly expires_at: number;
  readonly origin_revoked_at: number | null;
}

/**
 * 领取配对凭证。
 *
 * 注意开头那次查询**只用于**给出日志原因与廉价提前失败；
 * 授权判定完全由下面 batch 内的 SQL 完成，所以「预读之后状态被改变」不会造成越权。
 */
export async function claimPairing(
  db: D1Database,
  input: { readonly pairingCode: string; readonly deviceName: string },
): Promise<PairingClaimOutcome> {
  const pairingHash = await hashCredential(input.pairingCode);
  const now = Date.now();

  const diagnostic = await db
    .prepare(
      `SELECT p.id, p.workspace_id, p.used_at, p.expires_at, d.revoked_at AS origin_revoked_at
         FROM device_pairings p
         JOIN devices d ON d.id = p.created_by_device
        WHERE p.pairing_hash = ?
        LIMIT 1`,
    )
    .bind(pairingHash)
    .first<PairingDiagnosticRow>();

  if (diagnostic === null) {
    return { ok: false, reason: 'invalid' };
  }
  if (diagnostic.used_at !== null) {
    return { ok: false, reason: 'consumed' };
  }
  if (diagnostic.expires_at <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (diagnostic.origin_revoked_at !== null) {
    return { ok: false, reason: 'origin_device_revoked' };
  }

  const deviceId = newId();
  const deviceToken = generateDeviceToken();
  const tokenHash = await hashCredential(deviceToken);

  const results = await db.batch([
    // 1) 独占消费。三个前置条件与写入在同一条语句内求值：
    //    未消费、未过期、发起设备未撤销。pairing_id 是主键，
    //    并发/重放下只有一个事务能插入成功。
    db
      .prepare(
        `INSERT INTO pairing_claims (pairing_id, device_id, claimed_at)
         SELECT p.id, ?, ?
           FROM device_pairings p
          WHERE p.id = ?
            AND p.used_at IS NULL
            AND p.expires_at > ?
            AND EXISTS (SELECT 1 FROM devices d WHERE d.id = p.created_by_device AND d.revoked_at IS NULL)`,
      )
      .bind(deviceId, now, diagnostic.id, now),

    // 2) 新设备：只有**本次**占位成功（device_id 等于本次生成的 UUID）才插入。
    //    竞争失败者的语句是合法的空操作，不会创建设备。
    db
      .prepare(
        `INSERT INTO devices (id, workspace_id, token_hash, name, revoked_at, last_seen_at, created_at)
         SELECT ?, p.workspace_id, ?, ?, NULL, NULL, ?
           FROM pairing_claims c
           JOIN device_pairings p ON p.id = c.pairing_id
          WHERE c.pairing_id = ? AND c.device_id = ?`,
      )
      .bind(deviceId, tokenHash, input.deviceName, now, diagnostic.id, deviceId),

    // 3) 写入消费标记，保留 used_at 的语义（便于展示与清理）。
    db
      .prepare(
        `UPDATE device_pairings SET used_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM pairing_claims WHERE pairing_id = ? AND device_id = ?)`,
      )
      .bind(now, diagnostic.id, diagnostic.id, deviceId),

    // 4) 审计：与消费、设备写入同一事务。
    db
      .prepare(
        `INSERT INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json)
         SELECT ?, p.workspace_id, 'device_paired', ?, ?, ?
           FROM pairing_claims c
           JOIN device_pairings p ON p.id = c.pairing_id
          WHERE c.pairing_id = ? AND c.device_id = ?`,
      )
      .bind(newId(), deviceId, now, JSON.stringify({ pairingId: diagnostic.id }), diagnostic.id, deviceId),
  ]);

  const claimResult = results[0];
  if ((claimResult?.meta.changes ?? 0) !== 1) {
    // 竞争失败，或恰在此期间过期 / 发起设备被撤销。
    // 后续语句因缺少 claim 行而没有写入任何内容——**不创建补偿，也不创建设备或审计**。
    return { ok: false, reason: 'consumed' };
  }

  return {
    ok: true,
    workspaceId: diagnostic.workspace_id,
    deviceId,
    deviceToken,
    createdAt: now,
  };
}

/** 供设备列表复用的摘要构造（不含任何摘要列）。 */
export function toDeviceSummary(row: {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
  readonly last_seen_at: number | null;
  readonly revoked_at: number | null;
}, currentDeviceId: string): DeviceSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    current: row.id === currentDeviceId,
  };
}
