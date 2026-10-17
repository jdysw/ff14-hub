/**
 * 测试数据辅助。
 *
 * 安全前提：这里种下的是**测试专用**的假凭证（随机生成、仅存在于测试运行时内存与临时 D1 中），
 * 绝不使用任何真实 Token / 恢复密钥，也不把它们写入仓库。
 */
import { env } from 'cloudflare:test';
import { generateCredential, generateDeviceToken, hashCredential } from '../modules/identity/credentials';
import { RECOVERY_KEY_PREFIX } from '@ff14-hub/shared';

/** 测试用同源基准。固定 host 便于验证 Origin 同源判定。 */
export const TEST_BASE_URL = 'https://ff14-hub.test';

export interface SeededWorkspace {
  readonly workspaceId: string;
  readonly recoveryKey: string;
}

export interface SeededDevice {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly tokenHash: string;
  /** 可直接用于 fetch 的 Authorization 头值。 */
  readonly authorization: string;
}

export async function seedWorkspace(region: 'cn' | 'global' = 'cn'): Promise<SeededWorkspace> {
  const workspaceId = crypto.randomUUID();
  const recoveryKey = generateCredential(RECOVERY_KEY_PREFIX);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO workspaces (id, region, timezone, locale, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(workspaceId, region, 'Asia/Shanghai', 'zh-CN', await hashCredential(recoveryKey), now, now)
    .run();
  return { workspaceId, recoveryKey };
}

export async function seedDevice(
  workspaceId: string,
  options: { readonly revoked?: boolean; readonly name?: string } = {},
): Promise<SeededDevice> {
  const deviceId = crypto.randomUUID();
  const token = generateDeviceToken();
  const tokenHash = await hashCredential(token);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO devices (id, workspace_id, token_hash, name, revoked_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      deviceId,
      workspaceId,
      tokenHash,
      options.name ?? '测试设备',
      options.revoked === true ? now : null,
      null,
      now,
    )
    .run();
  return { workspaceId, deviceId, token, tokenHash, authorization: `Bearer ${token}` };
}

export async function seedWorkspaceWithDevice(
  options: { readonly revoked?: boolean } = {},
): Promise<{ workspace: SeededWorkspace; device: SeededDevice }> {
  const workspace = await seedWorkspace();
  const device = await seedDevice(workspace.workspaceId, { revoked: options.revoked ?? false });
  return { workspace, device };
}

/** 读取设备的 token_hash（用于断言响应体从未泄露它）。 */
export async function readTokenHash(deviceId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT token_hash FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<{ token_hash: string }>();
  return row?.token_hash ?? null;
}

/** 读取设备的 last_seen_at。 */
export async function readLastSeenAt(deviceId: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT last_seen_at FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<{ last_seen_at: number | null }>();
  return row?.last_seen_at ?? null;
}
