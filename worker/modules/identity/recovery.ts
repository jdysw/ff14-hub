/**
 * 恢复访问（HUB-006 / 规划 6.1、6.3）。
 *
 * 不变量：
 * - 恢复密钥是高熵随机值，服务端只存摘要；查询按 `recovery_hash` 的唯一索引命中。
 * - 失败与成功在**响应上不可区分**：密钥不存在统一按未授权处理，不透露「这个密钥格式对但不存在」。
 * - 速率限制由路由层在调用本函数**之前**施加（见 api/v1/identity.ts），
 *   因此暴力猜测在到达这里之前就会被 429 挡住。
 * - 创建新设备与审计在同一 `db.batch()` 事务中提交。
 *
 * 有意不做的一件事：**不轮换恢复密钥**。
 * 用户在首次初始化时被要求离线备份该密钥；若在这里轮换，用户旧备份立即失效，
 * 而一旦客户端没有成功收到新密钥（网络中断、响应丢失），就永久失去恢复能力。
 * 轮换应作为独立的、带二次确认与备份引导的显式操作，不属于本轮范围。
 */
import { newId } from '../../lib/util';
import { identityAuditStatement } from './audit';
import { generateDeviceToken, hashCredential } from './credentials';

export type RecoverOutcome =
  | {
      readonly ok: true;
      readonly workspaceId: string;
      readonly deviceId: string;
      readonly deviceToken: string;
      readonly createdAt: number;
    }
  | { readonly ok: false; readonly reason: 'invalid' };

export async function recoverDeviceAccess(
  db: D1Database,
  input: { readonly recoveryKey: string; readonly deviceName: string },
): Promise<RecoverOutcome> {
  const recoveryHash = await hashCredential(input.recoveryKey);

  const workspace = await db
    .prepare('SELECT id FROM workspaces WHERE recovery_hash = ? LIMIT 1')
    .bind(recoveryHash)
    .first<{ id: string }>();

  if (workspace === null) {
    return { ok: false, reason: 'invalid' };
  }

  const deviceId = newId();
  const deviceToken = generateDeviceToken();
  const tokenHash = await hashCredential(deviceToken);
  const now = Date.now();

  await db.batch([
    db
      .prepare(
        'INSERT INTO devices (id, workspace_id, token_hash, name, revoked_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
      )
      .bind(deviceId, workspace.id, tokenHash, input.deviceName, now),
    identityAuditStatement(db, {
      workspaceId: workspace.id,
      eventType: 'device_recovered',
      deviceId,
      at: now,
      detail: { method: 'recovery_key' },
    }),
  ]);

  return { ok: true, workspaceId: workspace.id, deviceId, deviceToken, createdAt: now };
}
