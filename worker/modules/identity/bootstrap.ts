/**
 * 一次性工作空间初始化（HUB-006 / 规划 6.1、6.3）。
 *
 * 不变量：
 * - `bootstrap` **不是**公开注册 API：调用方必须提供部署环境中的高熵初始化密钥
 *   （由中间件在比较前拒绝未配置的情况）。
 * - 全流程**只能成功一次**。这一点由 `workspace_bootstrap_guard.singleton_key` 的主键唯一约束
 *   在数据库层保证，而不是「先查有没有工作空间再插入」这种有竞态的写法。
 * - **并发与重放安全**：所有写入放在同一个 `db.batch()`（D1 中是 SQL 事务）里。
 *   并发的第二个请求会在第一条语句上冲突，整批回滚，因此不会遗留
 *   「有 workspace 没有 device」或「有 guard 没有 workspace」的半初始化状态。
 * - 明文恢复密钥与设备 Token 只在返回值中出现一次，落库的只有 SHA-256 摘要。
 */
import { ApiError, DEFAULT_ERROR_MESSAGE, RECOVERY_KEY_PREFIX, type Region } from '@ff14-hub/shared';
import { isUniqueConstraintError, newId } from '../../lib/util';
import { identityAuditStatement } from './audit';
import { generateCredential, generateDeviceToken, hashCredential } from './credentials';

export interface BootstrapInput {
  readonly region: Region;
  readonly timezone: string;
  readonly locale: string;
  readonly deviceName: string;
}

export interface BootstrapSuccess {
  readonly ok: true;
  readonly workspaceId: string;
  readonly deviceId: string;
  /** 明文恢复密钥，仅此一次返回。 */
  readonly recoveryKey: string;
  /** 首台设备的明文 Token，仅此一次返回。 */
  readonly deviceToken: string;
  readonly createdAt: number;
}

export type BootstrapOutcome = BootstrapSuccess | { readonly ok: false; readonly reason: 'already_initialized' };

/** 初始化守卫表的固定主键值。 */
export const BOOTSTRAP_GUARD_KEY = 'primary';

export async function bootstrapWorkspace(db: D1Database, input: BootstrapInput): Promise<BootstrapOutcome> {
  const workspaceId = newId();
  const deviceId = newId();
  const now = Date.now();
  const recoveryKey = generateCredential(RECOVERY_KEY_PREFIX);
  const deviceToken = generateDeviceToken();

  // 先算摘要：明文不会进入任何 SQL 参数之外的路径。
  const recoveryHash = await hashCredential(recoveryKey);
  const tokenHash = await hashCredential(deviceToken);

  try {
    await db.batch([
      // 1) 抢占初始化通道。并发下只有一个事务能成功插入这一行。
      db
        .prepare('INSERT INTO workspace_bootstrap_guard (singleton_key, workspace_id, claimed_at) VALUES (?, ?, ?)')
        .bind(BOOTSTRAP_GUARD_KEY, workspaceId, now),
      // 2) 建立工作空间。
      db
        .prepare(
          'INSERT INTO workspaces (id, region, timezone, locale, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(workspaceId, input.region, input.timezone, input.locale, recoveryHash, now, now),
      // 3) 首台设备（只存摘要）。
      db
        .prepare(
          'INSERT INTO devices (id, workspace_id, token_hash, name, revoked_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
        )
        .bind(deviceId, workspaceId, tokenHash, input.deviceName, now),
      // 4) 首次初始化设备是站点 owner，同时获得公开活动编辑权限。
      // 后续配对设备只获得普通工作空间权限，绝不自动继承管理员角色。
      db.prepare(
        'INSERT INTO calendar_admin_devices (device_id, workspace_id, granted_at) VALUES (?, ?, ?)',
      ).bind(deviceId, workspaceId, now),
      // 5) 审计：与业务写入同一事务。
      identityAuditStatement(db, {
        workspaceId,
        eventType: 'workspace_bootstrapped',
        deviceId,
        at: now,
        detail: { region: input.region, timezone: input.timezone, locale: input.locale },
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // 已被初始化（或并发中被别人抢先）：整批已回滚，无残留。
      return { ok: false, reason: 'already_initialized' };
    }
    throw new ApiError('internal_error', DEFAULT_ERROR_MESSAGE.internal_error, `bootstrap_failed:${String(error)}`);
  }

  return { ok: true, workspaceId, deviceId, recoveryKey, deviceToken, createdAt: now };
}
