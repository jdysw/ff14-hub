/**
 * 设备列表与撤销（HUB-006 / 规划 6.1）。
 *
 * 安全前提：
 * - 所有查询都带 `workspace_id = ?` 且 workspace_id **只能**来自认证中间件，
 *   因此拿 A 工作空间的凭证去操作 B 工作空间的设备只会得到 404，不会泄露 B 的设备是否存在。
 * - 列表**绝不返回** `token_hash`；只返回 `deviceSummarySchema` 里的字段。
 * - 撤销立即生效：认证中间件每次请求都查库（无进程内令牌缓存），
 *   所以撤销后同一个 Token 的下一次请求就会得到 401，无需等待任何缓存失效。
 * - 撤销设备时连带删除该设备创建的、尚未消费的配对，使其配对码立即失效。
 */
import type { DeviceSummary, WorkspaceProfile } from '@ff14-hub/shared';
import { newId } from '../../lib/util';
import { toDeviceSummary } from './pairing';

interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
  readonly last_seen_at: number | null;
  readonly revoked_at: number | null;
}

interface WorkspaceRow {
  readonly id: string;
  readonly region: 'cn' | 'global';
  readonly timezone: string;
  readonly locale: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** 当前工作空间的非敏感配置（绝不包含 recovery_hash）。 */
export async function getWorkspaceProfile(db: D1Database, workspaceId: string): Promise<WorkspaceProfile | null> {
  const row = await db
    .prepare('SELECT id, region, timezone, locale, created_at, updated_at FROM workspaces WHERE id = ?')
    .bind(workspaceId)
    .first<WorkspaceRow>();
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    region: row.region,
    timezone: row.timezone,
    locale: row.locale,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 列出本工作空间设备：未撤销在前，其余按创建时间。 */
export async function listDevices(
  db: D1Database,
  workspaceId: string,
  currentDeviceId: string,
): Promise<DeviceSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, name, created_at, last_seen_at, revoked_at
         FROM devices
        WHERE workspace_id = ?
        ORDER BY (revoked_at IS NOT NULL) ASC, created_at ASC`,
    )
    .bind(workspaceId)
    .all<DeviceRow>();
  return result.results.map((row) => toDeviceSummary(row, currentDeviceId));
}

export type RevokeOutcome = { readonly ok: true; readonly alreadyRevoked: boolean } | { readonly ok: false; readonly reason: 'not_found' };

/**
 * 撤销设备。幂等：对已撤销的设备再次调用返回成功（alreadyRevoked=true）。
 * 撤销自己是被允许的——后续请求会立即 401（因为认证不依赖任何进程内缓存）。
 */
export async function revokeDevice(
  db: D1Database,
  input: { readonly workspaceId: string; readonly deviceId: string; readonly actingDeviceId: string },
): Promise<RevokeOutcome> {
  const now = Date.now();

  const results = await db.batch([
    // 1) 条件撤销：只有仍处于未撤销状态时才生效，用受影响行数判定胜负。
    db
      .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL')
      .bind(now, input.deviceId, input.workspaceId),

    // 2) 审计条件取**数据库实际受影响行数**：`changes()` 反映上一条 UPDATE 影响的行数。
    //    刻意不用「revoked_at 是否等于本次时间戳」——两次撤销落在同一毫秒时那种判定会误判为真，
    //    从而重复写审计。`INSERT OR IGNORE` 配合部分唯一索引
    //    `idx_identity_audit_device_revoked_once` 再提供一层数据库级去重保证。
    db
      .prepare(
        `INSERT OR IGNORE INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json)
         SELECT ?, ?, 'device_revoked', ?, ?, ? WHERE changes() = 1`,
      )
      .bind(newId(), input.workspaceId, input.deviceId, now, JSON.stringify({
        // 记录「是否撤销了自己」这一事实，便于解释紧随其后的 401。
        selfRevocation: input.deviceId === input.actingDeviceId,
      })),

    // 3) 让该设备创建的、尚未消费的配对立即失效。
    //    条件写成「该设备现已处于撤销状态」而不是「等于本次时间戳」，因此天然幂等，
    //    也覆盖「对已撤销设备再次调用」这种清理场景。
    db
      .prepare(
        `DELETE FROM device_pairings
          WHERE created_by_device = ? AND used_at IS NULL
            AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND workspace_id = ? AND revoked_at IS NOT NULL)`,
      )
      .bind(input.deviceId, input.deviceId, input.workspaceId),
  ]);

  const updated = results[0];
  if ((updated?.meta.changes ?? 0) === 1) {
    return { ok: true, alreadyRevoked: false };
  }

  // 没有行被更新：区分「已撤销（幂等成功）」与「不存在 / 不属于本工作空间」。
  const existing = await db
    .prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?')
    .bind(input.deviceId, input.workspaceId)
    .first<{ id: string }>();
  if (existing === null) {
    return { ok: false, reason: 'not_found' };
  }
  return { ok: true, alreadyRevoked: true };
}
