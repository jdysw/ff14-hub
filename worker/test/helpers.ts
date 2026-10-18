/**
 * 测试数据辅助。
 *
 * 安全前提：这里种下的是**测试专用**的假凭证（随机生成、仅存在于测试运行时内存与临时 D1 中），
 * 绝不使用任何真实 Token / 恢复密钥，也不把它们写入仓库。
 */
import { env, SELF } from 'cloudflare:test';
import {
  RECOVERY_KEY_PREFIX,
  type BreakpointLayout,
  type GridRect,
  type LayoutBreakpoint,
  type WidgetInstance,
  type WorkbenchSnapshot,
  type WorkspacePage,
} from '@ff14-hub/shared';
import { expect } from 'vitest';
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
  // 阶段 03：自定义工作台（HUB-045 / HUB-046 / HUB-049 / HUB-054）。
  workbench: `${TEST_BASE_URL}/api/v1/me/workbench`,
  pages: `${TEST_BASE_URL}/api/v1/me/pages`,
  widgets: `${TEST_BASE_URL}/api/v1/me/widgets`,
  workbenchTemplates: `${TEST_BASE_URL}/api/v1/me/workbench/templates`,
  workbenchApplyTemplate: `${TEST_BASE_URL}/api/v1/me/workbench/apply-template`,
  workbenchBackup: `${TEST_BASE_URL}/api/v1/me/workbench/backup`,
  workbenchBackups: `${TEST_BASE_URL}/api/v1/me/workbench/backups`,
  workbenchImportPreview: `${TEST_BASE_URL}/api/v1/me/workbench/import/preview`,
  workbenchImportApply: `${TEST_BASE_URL}/api/v1/me/workbench/import/apply`,
  // 阶段 04：自由导航（HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009）。
  navCatalog: `${TEST_BASE_URL}/api/v1/navigation/catalog`,
  meNavigation: `${TEST_BASE_URL}/api/v1/me/navigation`,
  meNavigationLinks: `${TEST_BASE_URL}/api/v1/me/navigation/links`,
  meNavigationLinksReorder: `${TEST_BASE_URL}/api/v1/me/navigation/links/reorder`,
  meNavigationGroups: `${TEST_BASE_URL}/api/v1/me/navigation/groups`,
  meNavigationGroupsReorder: `${TEST_BASE_URL}/api/v1/me/navigation/groups/reorder`,
  meNavigationCatalogImport: `${TEST_BASE_URL}/api/v1/me/navigation/catalog/import`,
  meNavigationImportPreview: `${TEST_BASE_URL}/api/v1/me/navigation/import/preview`,
  meNavigationImportApply: `${TEST_BASE_URL}/api/v1/me/navigation/import/apply`,
  meNavigationExport: `${TEST_BASE_URL}/api/v1/me/navigation/export`,
  // 阶段 04：活动（HUB-011）与同步水位（HUB-051）。
  publicEvents: `${TEST_BASE_URL}/api/v1/events`,
  meEvents: `${TEST_BASE_URL}/api/v1/me/events`,
  meSyncChanges: `${TEST_BASE_URL}/api/v1/me/sync/changes`,
} as const;

/** 单个模块状态端点。 */
export function moduleUrl(moduleId: string): string {
  return `${URLS.meModules}/${moduleId}`;
}

/** 清数据端点（本阶段恒 501）。 */
export function modulePurgeUrl(moduleId: string): string {
  return `${URLS.meModules}/${moduleId}/purge`;
}

// ---------------------------------------------------------------------------
// 工作台端点（阶段 03）
// ---------------------------------------------------------------------------

/** 单个页面端点（PATCH / DELETE）。 */
export function pageUrl(pageId: string): string {
  return `${URLS.pages}/${pageId}`;
}

/** 页面布局端点（GET / PUT，按断点独立保存）。 */
export function pageLayoutUrl(pageId: string): string {
  return `${pageUrl(pageId)}/layout`;
}

/** 页面 Widget 实例集合端点（GET / POST）。 */
export function pageWidgetsUrl(pageId: string): string {
  return `${pageUrl(pageId)}/widgets`;
}

/** 从墓碑恢复页面的端点。 */
export function pageRestoreUrl(pageId: string): string {
  return `${pageUrl(pageId)}/restore`;
}

/** 单个 Widget 实例端点（PATCH / DELETE）。 */
export function widgetUrl(widgetId: string): string {
  return `${URLS.widgets}/${widgetId}`;
}

/** 复制 Widget 实例的端点。 */
export function widgetDuplicateUrl(widgetId: string): string {
  return `${widgetUrl(widgetId)}/duplicate`;
}

// ---------------------------------------------------------------------------
// 导航 / 活动 / 同步端点（阶段 04）
// ---------------------------------------------------------------------------

/** 单个个人链接端点（PATCH / DELETE）。 */
export function navLinkUrl(linkId: string): string {
  return `${URLS.meNavigationLinks}/${linkId}`;
}

/** 链接的分组归属端点（PUT 整体替换）。 */
export function navLinkGroupsUrl(linkId: string): string {
  return `${navLinkUrl(linkId)}/groups`;
}

/** 单个分组端点（PATCH / DELETE）。 */
export function navGroupUrl(groupId: string): string {
  return `${URLS.meNavigationGroups}/${groupId}`;
}

/** 单个个人活动端点（PATCH / DELETE）。 */
export function eventUrl(eventId: string): string {
  return `${URLS.meEvents}/${eventId}`;
}

/** 变更水位端点（带 since / limit 查询参数）。 */
export function syncChangesUrl(since?: string, limit?: number): string {
  const params = new URLSearchParams();
  if (since !== undefined) {
    params.set('since', since);
  }
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  const query = params.toString();
  return query.length === 0 ? URLS.meSyncChanges : `${URLS.meSyncChanges}?${query}`;
}

/** 用可恢复备份撤销一次替换导入的端点。 */
export function backupRestoreUrl(backupId: string): string {
  return `${URLS.workbenchBackup}/${backupId}/restore`;
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

/** 构造带 JSON 体的 PUT 请求（布局整页保存用）。 */
export function jsonPut(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'PUT',
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

/**
 * 清空全部身份、模块与工作台相关表（顺序满足外键约束）。
 *
 * 阶段 03 新增的 7 张工作台表**必须**在 `workspaces` 之前显式清空：
 * `workspaces` 上的级联删除虽然也能带走它们，但依赖级联会让「清空顺序」变成隐含假设；
 * 显式按「子表 → 父表」顺序删除（布局 → 实例 → 页面 → 工作空间级状态）更可验证。
 * 既有调用方（阶段 01/02 的 spec）拿到的是同一份契约：调用后所有表为空。
 */
export async function resetIdentityState(): Promise<void> {
  await env.DB.batch([
    // 阶段 03：工作台相关（子表在前，避免外键失败）。
    // 0007 的两张配套表（幂等意图指纹 / 本次清理标记）也显式清空：
    // 依赖 `workspaces` 的级联删除会把「清空顺序」变成隐含假设，而这两个用例都要求干净起点。
    env.DB.prepare('DELETE FROM widget_cleanup_marks'),
    env.DB.prepare('DELETE FROM workbench_operation_intents'),
    env.DB.prepare('DELETE FROM workbench_operations'),
    env.DB.prepare('DELETE FROM workbench_backups'),
    env.DB.prepare('DELETE FROM widget_layouts'),
    env.DB.prepare('DELETE FROM page_layout_revisions'),
    env.DB.prepare('DELETE FROM widget_instances'),
    env.DB.prepare('DELETE FROM workspace_pages'),
    env.DB.prepare('DELETE FROM workspace_workbench_state'),
    // 阶段 01/02：身份与模块。
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
  // 阶段 03：工作台。
  'workspace_pages',
  'widget_instances',
  'widget_layouts',
  'page_layout_revisions',
  'workspace_workbench_state',
  'workbench_operations',
  'workbench_backups',
  // 阶段 03 复核（迁移 0007）：幂等意图指纹与单次清理标记。
  'workbench_operation_intents',
  'widget_cleanup_marks',
] as const;

export type CountableTable = (typeof COUNTABLE_TABLES)[number];

/**
 * 每个可统计表对应的**固定**计数语句。
 *
 * 为什么不写成 `SELECT COUNT(*) FROM ${table}`：即使表名来自白名单，
 * 把变量拼进 SQL 文本也会被静态分析判为「SQL 注入面」（Sonar S3649），
 * 而且这种写法确实让「白名单检查少了/写错了」变成真正的注入。
 * 这里用一张常量表：拼接面彻底消失。
 */
const COUNT_ROWS_SQL: Readonly<Record<CountableTable, string>> = {
  workspaces: 'SELECT COUNT(*) AS count FROM workspaces',
  devices: 'SELECT COUNT(*) AS count FROM devices',
  device_pairings: 'SELECT COUNT(*) AS count FROM device_pairings',
  identity_audit: 'SELECT COUNT(*) AS count FROM identity_audit',
  workspace_bootstrap_guard: 'SELECT COUNT(*) AS count FROM workspace_bootstrap_guard',
  auth_rate_limits: 'SELECT COUNT(*) AS count FROM auth_rate_limits',
  pairing_claims: 'SELECT COUNT(*) AS count FROM pairing_claims',
  workspace_modules: 'SELECT COUNT(*) AS count FROM workspace_modules',
  workspace_module_operations: 'SELECT COUNT(*) AS count FROM workspace_module_operations',
  workspace_pages: 'SELECT COUNT(*) AS count FROM workspace_pages',
  widget_instances: 'SELECT COUNT(*) AS count FROM widget_instances',
  widget_layouts: 'SELECT COUNT(*) AS count FROM widget_layouts',
  page_layout_revisions: 'SELECT COUNT(*) AS count FROM page_layout_revisions',
  workspace_workbench_state: 'SELECT COUNT(*) AS count FROM workspace_workbench_state',
  workbench_operations: 'SELECT COUNT(*) AS count FROM workbench_operations',
  workbench_backups: 'SELECT COUNT(*) AS count FROM workbench_backups',
  workbench_operation_intents: 'SELECT COUNT(*) AS count FROM workbench_operation_intents',
  widget_cleanup_marks: 'SELECT COUNT(*) AS count FROM widget_cleanup_marks',
};

/** 统计行数。表名只接受 `CountableTable` 联合类型中的值（编译期白名单 + 运行期兜底）。 */
export async function countRows(table: CountableTable): Promise<number> {
  if (!COUNTABLE_TABLES.includes(table)) {
    throw new Error(`不允许统计的表：${table}`);
  }
  const row = await env.DB.prepare(COUNT_ROWS_SQL[table]).first<{ count: number }>();
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

/** 工作台测试通用的「已鉴权工作空间」形状（含设备凭证与恢复密钥，便于断言与二次配对）。 */
export interface AuthedWorkspace {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly recoveryKey: string;
  readonly authorization: string;
}

/** 直接种一个带设备的工作空间并返回可用的 Authorization 头值。 */
export async function seedAuth(): Promise<AuthedWorkspace> {
  const { workspace, device } = await seedWorkspaceWithDevice();
  return {
    workspaceId: workspace.workspaceId,
    deviceId: device.deviceId,
    deviceToken: device.token,
    recoveryKey: workspace.recoveryKey,
    authorization: device.authorization,
  };
}

let operationCounter = 0;

/**
 * 生成测试用 operationId。
 * 每个测试文件由 Vitest 独立加载模块，因此计数器天然按文件隔离；
 * 即使在同文件内也保证单调唯一，便于断言「同 ID 换意图」与「真重放」。
 */
export function opId(label: string): string {
  operationCounter += 1;
  return `op-${label}-${String(operationCounter).padStart(4, '0')}`;
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

/** 通过真实生命周期端点启用演示模块（首次安装：`expectedRevision` 必须为 0）。 */
export async function enableDemoModule(authorization: string, moduleId: string): Promise<void> {
  const response = await patchModule(authorization, moduleId, { action: 'enable', expectedRevision: 0 });
  if (response.status !== 200) {
    throw new Error(`启用模块未成功：module=${moduleId} status=${response.status} body=${await response.text()}`);
  }
}

// ---------------------------------------------------------------------------
// 阶段 03：工作台数据库事实读取器
// ---------------------------------------------------------------------------
//
// 为什么单独写一份（而不是复用 `modules/workbench/internal.ts` 的读函数）：
//   那些读函数**按业务语义过滤**（排除墓碑、排除「页面已删除」的实例），
//   而测试要断言的恰恰是「墓碑行还在不在」「布局行是不是真的被删了」。
//   因此这里的读取器一律不过滤墓碑，读的是最原始的行事实。

export interface WorkbenchPageRowSnapshot {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly slug: string;
  readonly is_default: number;
  readonly sort_order: number;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const PAGE_ROW_COLUMNS =
  'id, workspace_id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at';

/** 读取一个页面行；**不**按墓碑过滤（墓碑本身就是待断言的事实）。 */
export async function readPageRow(
  workspaceId: string,
  pageId: string,
): Promise<WorkbenchPageRowSnapshot | null> {
  return await env.DB.prepare(
    `SELECT ${PAGE_ROW_COLUMNS} FROM workspace_pages WHERE id = ? AND workspace_id = ?`,
  )
    .bind(pageId, workspaceId)
    .first<WorkbenchPageRowSnapshot>();
}

/** 读取本工作空间全部页面行（含墓碑），顺序与列表接口一致。 */
export async function readPageRows(workspaceId: string): Promise<WorkbenchPageRowSnapshot[]> {
  const result = await env.DB.prepare(
    `SELECT ${PAGE_ROW_COLUMNS} FROM workspace_pages WHERE workspace_id = ?
      ORDER BY sort_order ASC, created_at ASC`,
  )
    .bind(workspaceId)
    .all<WorkbenchPageRowSnapshot>();
  return result.results;
}

export interface WorkbenchInstanceRowSnapshot {
  readonly id: string;
  readonly workspace_id: string;
  readonly page_id: string;
  readonly module_id: string;
  readonly widget_type: string;
  readonly config_json: string;
  readonly config_version: number;
  readonly is_hidden: number;
  readonly revision: number;
  readonly created_revision: number;
  readonly deleted_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const INSTANCE_ROW_COLUMNS =
  'id, workspace_id, page_id, module_id, widget_type, config_json, config_version, ' +
  'is_hidden, revision, created_revision, deleted_at, created_at, updated_at';

/** 读取一个 Widget 实例行；**不**按墓碑过滤（用于证明「移除 = 墓碑而非硬删除」）。 */
export async function readInstanceRow(
  workspaceId: string,
  widgetId: string,
): Promise<WorkbenchInstanceRowSnapshot | null> {
  return await env.DB.prepare(
    `SELECT ${INSTANCE_ROW_COLUMNS} FROM widget_instances WHERE id = ? AND workspace_id = ?`,
  )
    .bind(widgetId, workspaceId)
    .first<WorkbenchInstanceRowSnapshot>();
}

/** 读取一个页面的全部实例行（含墓碑与隐藏），按创建顺序。 */
export async function readInstanceRows(pageId: string): Promise<WorkbenchInstanceRowSnapshot[]> {
  const result = await env.DB.prepare(
    `SELECT ${INSTANCE_ROW_COLUMNS} FROM widget_instances WHERE page_id = ?
      ORDER BY created_at ASC, id ASC`,
  )
    .bind(pageId)
    .all<WorkbenchInstanceRowSnapshot>();
  return result.results;
}

export interface WorkbenchLayoutRowSnapshot {
  readonly widget_id: string;
  readonly breakpoint: LayoutBreakpoint;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 读取一个页面的全部布局行。
 * **不**排除墓碑实例：实例被移除后其布局行是否真的被删掉，正是要断言的事实。
 */
export async function readLayoutRows(pageId: string): Promise<WorkbenchLayoutRowSnapshot[]> {
  const result = await env.DB.prepare(
    `SELECT wl.widget_id, wl.breakpoint, wl.x, wl.y, wl.w, wl.h
       FROM widget_layouts wl
       JOIN widget_instances wi ON wi.id = wl.widget_id
      WHERE wi.page_id = ?
      ORDER BY wl.breakpoint ASC, wl.widget_id ASC`,
  )
    .bind(pageId)
    .all<WorkbenchLayoutRowSnapshot>();
  return result.results;
}

/** 读取一个页面三个断点的布局修订号（行缺失的断点不出现在 Map 里）。 */
export async function readLayoutRevisions(pageId: string): Promise<Map<LayoutBreakpoint, number>> {
  const result = await env.DB.prepare(
    'SELECT breakpoint, revision FROM page_layout_revisions WHERE page_id = ?',
  )
    .bind(pageId)
    .all<{ breakpoint: LayoutBreakpoint; revision: number }>();
  const revisions = new Map<LayoutBreakpoint, number>();
  for (const row of result.results) {
    revisions.set(row.breakpoint, row.revision);
  }
  return revisions;
}

/** 读取工作台级修订号行（不存在即 null；行缺失等价于 0）。 */
export async function readWorkbenchStateRow(
  workspaceId: string,
): Promise<{ readonly revision: number; readonly updated_at: number } | null> {
  return await env.DB.prepare(
    'SELECT revision, updated_at FROM workspace_workbench_state WHERE workspace_id = ?',
  )
    .bind(workspaceId)
    .first<{ revision: number; updated_at: number }>();
}

/**
 * 工作台级修订号的**数值**（行缺失等价于 0）。
 *
 * 恢复备份（`POST /me/workbench/backup/:id/restore`）要求客户端回显
 * `expectedRevision`，测试里需要的就是这个数——单独给一个数值读取器，
 * 免得每个用例都写 `?? 0`。
 */
export async function readWorkbenchStateRevision(workspaceId: string): Promise<number> {
  return (await readWorkbenchStateRow(workspaceId))?.revision ?? 0;
}

// ---------------------------------------------------------------------------
// 布局不变量：任意两个矩形不得重叠
// ---------------------------------------------------------------------------

/** 两个网格矩形是否重叠（半开区间：相邻不算重叠）。 */
export function rectsOverlap(left: GridRect, right: GridRect): boolean {
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  );
}

/**
 * 布局不变量断言：一组矩形两两不重叠。
 *
 * 为什么集中在这里：并发新增/复制必须保证「两个请求不会选中同一个空位」，
 * 而三个断点的矩形集合都要检查，写成散落的双重循环很容易漏掉某个断点。
 */
export function assertNoOverlap(rects: readonly GridRect[]): void {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const left = rects[i];
      const right = rects[j];
      if (left === undefined || right === undefined) {
        continue;
      }
      expect(
        rectsOverlap(left, right),
        `矩形重叠：${JSON.stringify(left)} 与 ${JSON.stringify(right)}`,
      ).toBe(false);
    }
  }
}

export interface WorkbenchOperationRowSnapshot {
  readonly kind: string;
  readonly result_json: string;
  readonly attempt_token: string | null;
  readonly created_at: number;
}

/** 读取幂等操作留痕行（直接读库，用于断言「重放没有留下第二行」）。 */
export async function readWorkbenchOperationRow(
  workspaceId: string,
  operationId: string,
): Promise<WorkbenchOperationRowSnapshot | null> {
  return await env.DB.prepare(
    `SELECT kind, result_json, attempt_token, created_at
       FROM workbench_operations WHERE workspace_id = ? AND operation_id = ?`,
  )
    .bind(workspaceId, operationId)
    .first<WorkbenchOperationRowSnapshot>();
}

export interface WorkbenchBackupRowSnapshot {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly schema_version: number;
  readonly payload_json: string;
  readonly created_at: number;
  readonly created_by_device: string | null;
  readonly consumed_at: number | null;
}

/** 读取可恢复备份行（替换导入「先备份、可撤销」的持久事实）。 */
export async function readBackupRow(
  workspaceId: string,
  backupId: string,
): Promise<WorkbenchBackupRowSnapshot | null> {
  return await env.DB.prepare(
    `SELECT id, workspace_id, kind, schema_version, payload_json, created_at, created_by_device, consumed_at
       FROM workbench_backups WHERE id = ? AND workspace_id = ?`,
  )
    .bind(backupId, workspaceId)
    .first<WorkbenchBackupRowSnapshot>();
}

// ---------------------------------------------------------------------------
// 阶段 03：工作台 API 便捷入口（只用于「应当成功」的路径）
// ---------------------------------------------------------------------------

export interface TemplateSkipSummary {
  readonly widgetType: string;
  readonly detail: string;
}

export interface WorkbenchPageResponse {
  readonly page: WorkspacePage;
  /** 新建后的默认页：新页面成为默认页时是它自己，否则是原有默认页。 */
  readonly defaultPageId: string | null;
  readonly skipped: readonly TemplateSkipSummary[];
  readonly replayed: boolean;
}

/** 创建页面（成功路径）；失败时抛错，失败路径请直接用 SELF.fetch 断言。 */
export async function createPageViaApi(
  authorization: string,
  input: { readonly name: string; readonly operationId: string; readonly templateId?: string },
): Promise<WorkbenchPageResponse> {
  const body: Record<string, unknown> = { name: input.name, operationId: input.operationId };
  if (input.templateId !== undefined) {
    body['templateId'] = input.templateId;
  }
  const response = await SELF.fetch(URLS.pages, jsonPost(body, { Authorization: authorization }));
  if (response.status !== 201) {
    throw new Error(`创建页面未成功：status=${response.status} body=${await response.text()}`);
  }
  return await response.json<WorkbenchPageResponse>();
}

export interface WidgetInstanceResponse {
  readonly instance: WidgetInstance;
  readonly replayed: boolean;
}

/** 添加 Widget 实例（成功路径）；失败时抛错，失败路径请直接用 SELF.fetch 断言。 */
export async function addWidgetViaApi(
  authorization: string,
  pageId: string,
  input: {
    readonly widgetType: string;
    readonly operationId: string;
    readonly config?: unknown;
    readonly hidden?: boolean;
  },
): Promise<WidgetInstanceResponse> {
  const body: Record<string, unknown> = {
    widgetType: input.widgetType,
    operationId: input.operationId,
  };
  if (input.config !== undefined) {
    body['config'] = input.config;
  }
  if (input.hidden !== undefined) {
    body['hidden'] = input.hidden;
  }
  const response = await SELF.fetch(pageWidgetsUrl(pageId), jsonPost(body, { Authorization: authorization }));
  if (response.status !== 201) {
    throw new Error(`添加组件未成功：status=${response.status} body=${await response.text()}`);
  }
  return await response.json<WidgetInstanceResponse>();
}

/** 读取工作台快照（GET /me/workbench）。 */
export async function readSnapshotViaApi(authorization: string): Promise<WorkbenchSnapshot> {
  const response = await SELF.fetch(URLS.workbench, { headers: { Authorization: authorization } });
  if (response.status !== 200) {
    throw new Error(`读取工作台快照未成功：status=${response.status} body=${await response.text()}`);
  }
  return await response.json<WorkbenchSnapshot>();
}

/** 读取某页面三个断点的布局（GET /me/pages/:id/layout）。 */
export async function readLayoutsViaApi(
  authorization: string,
  pageId: string,
): Promise<readonly BreakpointLayout[]> {
  const response = await SELF.fetch(pageLayoutUrl(pageId), { headers: { Authorization: authorization } });
  if (response.status !== 200) {
    throw new Error(`读取布局未成功：status=${response.status} body=${await response.text()}`);
  }
  const body = await response.json<{ layouts: BreakpointLayout[] }>();
  return body.layouts;
}

/** 读取某页面的活跃实例（GET /me/pages/:id/widgets）。 */
export async function readInstancesViaApi(
  authorization: string,
  pageId: string,
): Promise<readonly WidgetInstance[]> {
  const response = await SELF.fetch(pageWidgetsUrl(pageId), { headers: { Authorization: authorization } });
  if (response.status !== 200) {
    throw new Error(`读取实例未成功：status=${response.status} body=${await response.text()}`);
  }
  const body = await response.json<{ instances: WidgetInstance[] }>();
  return body.instances;
}

/** 发起一次整页布局保存（返回 Response，便于断言 409 / 422）。 */
export async function saveLayoutRequest(
  authorization: string,
  pageId: string,
  body: { readonly breakpoint: LayoutBreakpoint; readonly baseRevision: number; readonly rects: readonly GridRect[]; readonly operationId: string },
): Promise<Response> {
  return await SELF.fetch(pageLayoutUrl(pageId), jsonPut(body, { Authorization: authorization }));
}

// ---------------------------------------------------------------------------
// 导入：预览 → 应用（复核后 previewToken 成为必需字段）
// ---------------------------------------------------------------------------

/**
 * 预览返回体。
 *
 * `previewToken` 是复核新增的字段：它绑定 `document + mode + 工作台 revision +
 * 所有相关模块的门禁状态与 revision`，应用时必须原样回显，否则 409。
 * 这里把它显式声明出来，避免调用方「以为拿到了令牌其实没有」。
 */
export interface WorkbenchImportPreviewPayload {
  readonly importable: boolean;
  readonly mode: string;
  readonly schemaVersion: number | null;
  readonly problems: readonly { readonly code: string; readonly detail: string; readonly path?: string }[];
  readonly warnings: readonly { readonly code: string; readonly detail: string }[];
  readonly unknownModules: readonly {
    readonly moduleId: string;
    readonly instanceCount: number;
    readonly widgetTypes: readonly string[];
    readonly registered: boolean;
  }[];
  readonly counts: {
    readonly pagesNew: number;
    readonly pagesReplaced: number;
    readonly pagesSkipped: number;
    readonly instancesNew: number;
    readonly instancesReplaced: number;
    readonly instancesSkipped: number;
  };
  readonly affectedPages: readonly string[];
  readonly previewRevision: number;
  readonly previewToken: string;
  readonly confirmPrompt: string;
}

/** 发起一次导入预览（返回原始 Response 与已解析的 `preview`，便于断言两者）。 */
export async function previewImportViaApi(
  authorization: string,
  input: { readonly document: unknown; readonly mode: 'merge' | 'replace' },
): Promise<{ readonly status: number; readonly preview: WorkbenchImportPreviewPayload }> {
  const response = await SELF.fetch(
    URLS.workbenchImportPreview,
    jsonPost({ mode: input.mode, document: input.document }, { Authorization: authorization }),
  );
  const body = await response.json<{ preview: WorkbenchImportPreviewPayload }>();
  return { status: response.status, preview: body.preview };
}

/** 发起一次导入应用（必须回显预览令牌）。 */
export function applyImportViaApi(
  authorization: string,
  input: {
    readonly document: unknown;
    readonly mode: 'merge' | 'replace';
    readonly previewRevision: number;
    readonly previewToken: string;
    readonly operationId: string;
    readonly confirm?: unknown;
  },
): Promise<Response> {
  const body: Record<string, unknown> = {
    document: input.document,
    mode: input.mode,
    previewRevision: input.previewRevision,
    previewToken: input.previewToken,
    operationId: input.operationId,
  };
  if (input.confirm !== undefined) {
    body['confirm'] = input.confirm;
  }
  return SELF.fetch(URLS.workbenchImportApply, jsonPost(body, { Authorization: authorization }));
}

/** 「预览 → 应用」的完整成功路径（失败路径请直接用上面两个函数断言）。 */
export async function previewThenApplyViaApi(
  authorization: string,
  input: { readonly document: unknown; readonly mode: 'merge' | 'replace'; readonly operationId: string },
): Promise<{ readonly preview: WorkbenchImportPreviewPayload; readonly apply: Response }> {
  const { preview } = await previewImportViaApi(authorization, {
    document: input.document,
    mode: input.mode,
  });
  const apply = await applyImportViaApi(authorization, {
    document: input.document,
    mode: input.mode,
    previewRevision: preview.previewRevision,
    previewToken: preview.previewToken,
    operationId: input.operationId,
    confirm: true,
  });
  return { preview, apply };
}

/**
 * 把 `/me/*` 的错误响应体解析成可断言的形状。
 * 集中在这里：7 个工作台 spec 都需要它，各写一份会造成重复代码。
 */
export function errorBodyOf(text: string): { code: string; message: string } {
  return JSON.parse(text) as { code: string; message: string };
}