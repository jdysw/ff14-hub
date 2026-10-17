/**
 * 测试数据辅助。
 *
 * 安全前提：这里种下的是**测试专用**的假凭证（随机生成、仅存在于测试运行时内存与临时 D1 中），
 * 绝不使用任何真实 Token / 恢复密钥，也不把它们写入仓库。
 */
import { env, SELF } from 'cloudflare:test';
import { RECOVERY_KEY_PREFIX } from '@ff14-hub/shared';
import { BOOTSTRAP_SECRET_HEADER } from '../api/v1/identity';
import type { RuntimeEnv } from '../env';
import { generateCredential, generateDeviceToken, hashCredential } from '../modules/identity/credentials';

/**
 * 构造用于边界测试的 env。
 *
 * 为什么需要断言：`wrangler types` 生成的绑定类型把 wrangler.jsonc 里声明的绑定标为必需
 * （例如 `ASSETS`），而这里要测试的恰恰是「绑定缺失/不合法时服务如何失败」。
 * 断言集中在这一处，避免散落到各个测试文件里。
 */
export function partialEnv(values: Partial<RuntimeEnv>): RuntimeEnv {
  return values as RuntimeEnv;
}

/** 测试用同源基准。固定 host 便于验证 Origin 同源判定。 */
export const TEST_BASE_URL = 'https://ff14-hub.test';

/** 与 vitest.config.ts 注入的绑定保持一致；明显是测试值，不是生产秘密。 */
export const TEST_BOOTSTRAP_SECRET = 'test-only-bootstrap-secret-value-0123456789';

export const URLS = {
  bootstrap: `${TEST_BASE_URL}/api/v1/identity/bootstrap`,
  pairing: `${TEST_BASE_URL}/api/v1/identity/pairing`,
  pairingClaim: `${TEST_BASE_URL}/api/v1/identity/pairing/claim`,
  recover: `${TEST_BASE_URL}/api/v1/identity/recover`,
  profile: `${TEST_BASE_URL}/api/v1/me/profile`,
  devices: `${TEST_BASE_URL}/api/v1/me/devices`,
  moduleCatalog: `${TEST_BASE_URL}/api/v1/modules/catalog`,
  meModules: `${TEST_BASE_URL}/api/v1/me/modules`,
} as const;

/** 单个模块状态端点。 */
export function moduleUrl(moduleId: string): string {
  return `${URLS.meModules}/${moduleId}`;
}

/** 清数据端点（本阶段恒 501）。 */
export function modulePurgeUrl(moduleId: string): string {
  return `${URLS.meModules}/${moduleId}/purge`;
}

/** 构造 JSON POST 请求。 */
export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** 构造 JSON PATCH 请求（模块生命周期变更用）。 */
export function jsonPatch(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** 构造带 JSON 体的 DELETE 请求（用于验证方法/校验边界）。 */
export function jsonDelete(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** 带初始化密钥的请求头。 */
export function bootstrapHeaders(secret: string = TEST_BOOTSTRAP_SECRET): Record<string, string> {
  return { [BOOTSTRAP_SECRET_HEADER]: secret };
}

export interface BootstrapResult {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly recoveryKey: string;
  readonly deviceToken: string;
  readonly authorization: string;
}

/** 通过真实 HTTP 端点完成一次初始化。 */
export async function bootstrapViaApi(deviceName = '测试设备一'): Promise<BootstrapResult> {
  const response = await SELF.fetch(URLS.bootstrap, jsonPost({ deviceName }, bootstrapHeaders()));
  if (response.status !== 201) {
    throw new Error(`bootstrap 未成功：status=${response.status} body=${await response.text()}`);
  }
  const body = await response.json<{
    workspaceId: string;
    recoveryKey: string;
    deviceToken: string;
    device: { id: string };
  }>();
  return {
    workspaceId: body.workspaceId,
    deviceId: body.device.id,
    recoveryKey: body.recoveryKey,
    deviceToken: body.deviceToken,
    authorization: `Bearer ${body.deviceToken}`,
  };
}

/** 创建一次性配对凭证。 */
export async function createPairingViaApi(
  authorization: string,
  ttlSeconds?: number,
): Promise<{ pairingCode: string; expiresAt: number }> {
  const body = ttlSeconds === undefined ? {} : { ttlSeconds };
  const response = await SELF.fetch(URLS.pairing, jsonPost(body, { Authorization: authorization }));
  if (response.status !== 201) {
    throw new Error(`创建配对未成功：status=${response.status} body=${await response.text()}`);
  }
  return await response.json<{ pairingCode: string; expiresAt: number }>();
}

/** 清空全部身份与模块相关表（顺序满足外键约束）。 */
export async function resetIdentityState(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM identity_audit'),
    env.DB.prepare('DELETE FROM pairing_claims'),
    env.DB.prepare('DELETE FROM device_pairings'),
    env.DB.prepare('DELETE FROM workspace_module_operations'),
    env.DB.prepare('DELETE FROM workspace_modules'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM workspace_bootstrap_guard'),
    env.DB.prepare('DELETE FROM workspaces'),
    env.DB.prepare('DELETE FROM auth_rate_limits'),
  ]);
}

const COUNTABLE_TABLES = [
  'workspaces',
  'devices',
  'device_pairings',
  'identity_audit',
  'workspace_bootstrap_guard',
  'auth_rate_limits',
  'pairing_claims',
  'workspace_modules',
  'workspace_module_operations',
] as const;

export type CountableTable = (typeof COUNTABLE_TABLES)[number];

/** 统计行数。表名来自白名单，不接受任意输入（避免拼接不可信字符串）。 */
export async function countRows(table: CountableTable): Promise<number> {
  if (!COUNTABLE_TABLES.includes(table)) {
    throw new Error(`不允许统计的表：${table}`);
  }
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

export interface AuditRow {
  readonly event_type: string;
  readonly device_id: string | null;
  readonly detail_json: string;
}

export async function readAuditEvents(): Promise<AuditRow[]> {
  const result = await env.DB.prepare(
    'SELECT event_type, device_id, detail_json FROM identity_audit ORDER BY created_at ASC',
  ).all<AuditRow>();
  return result.results;
}

/** 直接改写配对有效期，用于构造「已过期」场景（不等待真实时间流逝）。 */
export async function forcePairingExpiry(pairingCode: string, expiresAt: number): Promise<void> {
  await env.DB.prepare('UPDATE device_pairings SET expires_at = ? WHERE pairing_hash = ?')
    .bind(expiresAt, await hashCredential(pairingCode))
    .run();
}

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

/**
 * 直接读取 `workspace_modules` 的一行，用于断言「卸载/停用没有删数据」这类
 * **数据库事实**，而不是只看响应体自述。
 */
export interface ModuleRowSnapshot {
  readonly status: string;
  readonly settings_json: string;
  readonly settings_version: number;
  readonly revision: number;
  readonly installed_at: number;
  readonly enabled_at: number | null;
  readonly disabled_at: number | null;
  readonly uninstalled_at: number | null;
}

export async function readModuleRow(workspaceId: string, moduleId: string): Promise<ModuleRowSnapshot | null> {
  return await env.DB.prepare(
    `SELECT status, settings_json, settings_version, revision, installed_at, enabled_at, disabled_at, uninstalled_at
       FROM workspace_modules WHERE workspace_id = ? AND module_id = ?`,
  )
    .bind(workspaceId, moduleId)
    .first<ModuleRowSnapshot>();
}

/** 发起一次模块生命周期 PATCH（避免每个测试重复拼请求）。 */
export async function patchModule(
  authorization: string,
  moduleId: string,
  body: unknown,
): Promise<Response> {
  return await SELF.fetch(moduleUrl(moduleId), jsonPatch(body, { Authorization: authorization }));
}

/** 读取 `workspace_modules` 中某个模块的设置对象。 */
export async function readModuleSettings(
  workspaceId: string,
  moduleId: string,
): Promise<Record<string, unknown> | null> {
  const row = await readModuleRow(workspaceId, moduleId);
  if (row === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(row.settings_json);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/** `workspace_module_operations` 的一行（待完成操作的持久事实）。 */
export interface ModuleOperationRowSnapshot {
  readonly action: string;
  readonly target_status: string;
  readonly revision: number;
  readonly started_at: number;
  readonly attempts: number;
  readonly last_error: string | null;
}

/** 直接读取待完成操作行，用于断言「副作用失败留下了持久事实」。 */
export async function readModuleOperationRow(
  workspaceId: string,
  moduleId: string,
): Promise<ModuleOperationRowSnapshot | null> {
  return await env.DB.prepare(
    `SELECT action, target_status, revision, started_at, attempts, last_error
       FROM workspace_module_operations WHERE workspace_id = ? AND module_id = ?`,
  )
    .bind(workspaceId, moduleId)
    .first<ModuleOperationRowSnapshot>();
}
