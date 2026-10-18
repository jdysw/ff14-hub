/**
 * 跨设备变更/水位端点测试（HUB-051 / ADR-0004 D7）。
 *
 * 证据取向：
 * 1. **契约**：每个响应都过 `syncChangesResponseSchema`，每条变更都过 `syncChangeSchema`
 *    （严格：恰好 `{seq, entityType, entityId, op, revision, updatedAt, payload}` + 响应级 `meta`；
 *    `delete` 的 `payload` 必须是显式的 `null`）。
 * 2. **水位是数据库单调序号**（复核修正的 P1 缺陷）：旧实现按 `updated_at` 扫描、
 *    `nextCursor = lastTs + 1`，会**永久**丢掉「同一毫秒内后续的写入/删除/显式恢复」
 *    与「Worker 时钟回退」时的变更。这里逐条证明这些场景现在都能被投递。
 * 3. **写路径完备性**：模块卸载（`PATCH /me/modules/:id` 的 uninstall）、模板重置
 *    （`POST /me/workbench/apply-template` 的 reset）、备份导入（`import/apply` 的 replace）
 *    都必须天然进入同步流——它们不是常规 CRUD，靠的正是迁移 0011 的**触发器**。
 * 4. **分页不变量**：`seq` 严格递增 ⇒ 页与页之间既不漏也不重；分页期间持续写入也不影响。
 * 5. **作用域隔离**：工作空间 B 的行绝不出现在 A 的响应里。
 *
 * 夹具策略：导航 / 活动行直接 `env.DB.prepare(...).run()` 插入并**显式设置 `updated_at`**
 * （不依赖并行实现中的 nav/events 端点）。直接 SQL 写入同样会触发 0011 的变更触发器，
 * 因此它既能精确控制时间戳，又能真实覆盖「写路径」。
 */
import {
  DEMO_BASICS_MODULE_ID,
  DEMO_WIDGET_IDS,
  SYNC_ENTITY_ID_MAX_LENGTH,
  SYNC_ENTITY_TYPES,
  SYNC_MAX_LIMIT,
  WORKBENCH_BACKUP_SCHEMA_VERSION,
  decodeSyncCursor,
  encodeSyncCursor,
  syncChangeSchema,
  syncChangesResponseSchema,
  type SyncChange,
  type SyncChangesResponse,
  type SyncEntityType,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_CATALOG_SEED, applyCatalogSeed } from '../modules/nav/catalog';
import {
  URLS,
  addWidgetViaApi,
  createPageViaApi,
  enableDemoModule,
  errorBodyOf,
  jsonDelete,
  jsonPost,
  navLinkUrl,
  opId,
  patchModule,
  previewThenApplyViaApi,
  readWorkbenchStateRevision,
  resetIdentityState,
  seedAuth,
  syncChangesUrl,
} from './helpers';

/** 固定基准时间戳：夹具全部显式给出时间，游标推演不依赖真实时钟。 */
const T0 = 1_760_000_000_000;
const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;

beforeEach(async () => {
  await resetIdentityState();
});

// ---------------------------------------------------------------------------
// 请求与契约辅助
// ---------------------------------------------------------------------------

async function fetchChanges(
  authorization: string | undefined,
  since?: string,
  limit?: number,
): Promise<Response> {
  const headers: Record<string, string> =
    authorization === undefined ? {} : { Authorization: authorization };
  return await SELF.fetch(syncChangesUrl(since, limit), { headers });
}

/** 读取并**强制**校验契约的响应；不合规直接让用例失败（而不是静默放行）。 */
async function readChanges(
  authorization: string,
  since?: string,
  limit?: number,
): Promise<SyncChangesResponse> {
  const response = await fetchChanges(authorization, since, limit);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const parsed = syncChangesResponseSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new Error(`响应不符合 syncChangesResponseSchema：${JSON.stringify(parsed.error.issues)}`);
  }
  for (const change of parsed.data.changes) {
    const single = syncChangeSchema.safeParse(change);
    expect(single.success, `变更不符合 syncChangeSchema：${JSON.stringify(change)}`).toBe(true);
  }
  return parsed.data;
}

function cursorOf(response: SyncChangesResponse): string {
  if (response.nextCursor === null) {
    throw new Error('本用例期望拿到可继续的游标，但响应为 null');
  }
  return response.nextCursor;
}

/** 解码游标里的序号（断言「游标确实前进」时用；解析失败直接让用例失败）。 */
function seqOf(cursor: string): number {
  const decoded = decodeSyncCursor(cursor);
  if (!decoded.ok) {
    throw new Error(`游标不可解析：${cursor}`);
  }
  return decoded.seq;
}

function findChange(
  response: SyncChangesResponse,
  entityType: SyncEntityType,
  entityId: string,
): SyncChange | undefined {
  return response.changes.find(
    (change) => change.entityType === entityType && change.entityId === entityId,
  );
}

/** 按**序号**取第一条匹配（变更流里同一实体可能有多条日志：先墓碑后恢复）。 */
function requireChange(
  response: SyncChangesResponse,
  entityType: SyncEntityType,
  entityId: string,
): SyncChange {
  const found = findChange(response, entityType, entityId);
  if (found === undefined) {
    throw new Error(
      `响应里没有 ${entityType}:${entityId}（实际：${response.changes
        .map((change) => `${change.entityType}:${change.entityId}`)
        .join(', ')}）`,
    );
  }
  return found;
}

/** 同一实体在本页里的**全部**日志（按 seq 升序，正好是响应顺序）。 */
function changesOf(
  response: SyncChangesResponse,
  entityType: SyncEntityType,
  entityId: string,
): SyncChange[] {
  return response.changes.filter(
    (change) => change.entityType === entityType && change.entityId === entityId,
  );
}

/** 本页最大的 seq（无变更时为 0）。 */
function maxSeq(response: SyncChangesResponse): number {
  return response.changes.reduce((max, change) => Math.max(max, change.seq), 0);
}

/** 变更流必须严格按 seq 递增（排序/去重的唯一依据）。 */
function expectStrictlyIncreasingSeq(changes: readonly SyncChange[]): void {
  for (let index = 1; index < changes.length; index += 1) {
    const previous = changes[index - 1];
    const current = changes[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    expect(current.seq, `第 ${String(index)} 条没有严格递增`).toBeGreaterThan(previous.seq);
  }
}

/** 结构化错误体（422 的 `details.reason` 是客户端程序化处理的依据）。 */
function syncErrorBodyOf(text: string): { code: string; message: string; details?: unknown } {
  return JSON.parse(text) as { code: string; message: string; details?: unknown };
}

function detailsReasonOf(body: { details?: unknown }): unknown {
  const details = body.details;
  return typeof details === 'object' && details !== null
    ? (details as { reason?: unknown }).reason
    : undefined;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface SyncSeedIds {
  readonly pageId: string;
  readonly widgetId: string;
  readonly navLinkId: string;
  readonly navGroupId: string;
  readonly eventId: string;
}

/**
 * 种下「八种实体各一条」。
 *
 * 导航链接 / 分组的 ID 刻意用**短 ID**（与共享契约 `sync-api.spec.ts` 的样例一致），
 * 这样 `nav_membership` 的 `linkId:groupId` 组合不会触及长度上限；
 * 组合键接近上限的真实情况（36 字符 UUID）由专门的用例覆盖。
 */
async function seedEveryEntityType(workspaceId: string, baseTs: number): Promise<SyncSeedIds> {
  const pageId = crypto.randomUUID();
  const widgetId = crypto.randomUUID();
  const navLinkId = 'seed-nav-link';
  const navGroupId = 'seed-nav-group';
  const eventId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_pages
         (id, workspace_id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at)
       VALUES (?, ?, '首页', 'home', 1, 0, 3, NULL, ?, ?)`,
    ).bind(pageId, workspaceId, baseTs, baseTs),
    env.DB.prepare(
      `INSERT INTO widget_instances
         (id, workspace_id, page_id, module_id, widget_type, config_json, config_version, is_hidden,
          revision, created_revision, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{"step":2,"label":"种子","initDelayMs":0}', 4, 0, 5, 1, NULL, ?, ?)`,
    ).bind(widgetId, workspaceId, pageId, DEMO_BASICS_MODULE_ID, DEMO_COUNTER, baseTs, baseTs + 1),
    env.DB.prepare(
      `INSERT INTO widget_layouts (widget_id, breakpoint, x, y, w, h) VALUES (?, 'desktop', 0, 0, 4, 2)`,
    ).bind(widgetId),
    env.DB.prepare(
      `INSERT INTO page_layout_revisions (page_id, breakpoint, revision, updated_at) VALUES (?, 'desktop', 7, ?)`,
    ).bind(pageId, baseTs + 2),
    env.DB.prepare(
      `INSERT INTO workspace_nav_links
         (id, workspace_id, source_catalog_id, imported_source_version, title, url, description,
          tags_json, aliases_json, icon, open_mode, region, status, is_favorite, sort_order,
          health, health_checked_at, revision, deleted_at, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, '官网', 'https://example.com/', '', '["日常"]', '["gw"]', '🌐',
               'new_tab', 'cn', 'active', 1, 2, 'unknown', NULL, 2, NULL, ?, ?)`,
    ).bind(navLinkId, workspaceId, baseTs, baseTs + 3),
    env.DB.prepare(
      `INSERT INTO workspace_nav_groups (id, workspace_id, name, sort_order, revision, deleted_at, created_at, updated_at)
       VALUES (?, ?, '分组甲', 1, 1, NULL, ?, ?)`,
    ).bind(navGroupId, workspaceId, baseTs, baseTs + 4),
    env.DB.prepare(
      `INSERT INTO workspace_nav_memberships (link_id, group_id, workspace_id, sort_order, deleted_at, updated_at)
       VALUES (?, ?, ?, 0, NULL, ?)`,
    ).bind(navLinkId, navGroupId, workspaceId, baseTs + 5),
    env.DB.prepare(
      `INSERT INTO workspace_modules
         (workspace_id, module_id, status, settings_json, settings_version, revision,
          installed_at, enabled_at, disabled_at, uninstalled_at, created_at, updated_at)
       VALUES (?, ?, 'enabled', '{"greeting":"你好","announce":false}', 1, 1, ?, ?, NULL, NULL, ?, ?)`,
    ).bind(workspaceId, DEMO_BASICS_MODULE_ID, baseTs, baseTs, baseTs, baseTs + 6),
    env.DB.prepare(
      `INSERT INTO workspace_events
         (id, workspace_id, title, description, region, starts_at, ends_at, source_url,
          verification_status, revision, deleted_at, created_at, updated_at)
       VALUES (?, ?, '测试活动', '', 'cn', ?, ?, 'https://example.com/event', 'unverified', 1, NULL, ?, ?)`,
    ).bind(eventId, workspaceId, baseTs + 1000, baseTs + 2000, baseTs, baseTs + 7),
  ]);

  return { pageId, widgetId, navLinkId, navGroupId, eventId };
}

async function insertPage(
  workspaceId: string,
  id: string,
  slug: string,
  updatedAt: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspace_pages
       (id, workspace_id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 1, NULL, ?, ?)`,
  )
    .bind(id, workspaceId, `页-${id}`.slice(0, 60), slug, updatedAt, updatedAt)
    .run();
}

async function insertNavGroup(workspaceId: string, id: string, updatedAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspace_nav_groups
       (id, workspace_id, name, sort_order, revision, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, NULL, ?, ?)`,
  )
    .bind(id, workspaceId, `组-${id}`.slice(0, 40), updatedAt, updatedAt)
    .run();
}

/** 直接墓碑化一行（与业务写路径同形的 UPDATE：同样会触发变更日志）。 */
async function tombstoneNavGroup(workspaceId: string, id: string, ts: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE workspace_nav_groups SET deleted_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
  )
    .bind(ts, ts, id, workspaceId)
    .run();
}

/** 工作空间级导航修订号（行缺失等价于 0）。 */
async function readNavStateRevision(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT revision FROM workspace_nav_state WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

/** 库内**应投递**的全部变更序号（分页并集的对照基准）。 */
async function readJournalSeqs(workspaceId: string): Promise<number[]> {
  const result = await env.DB.prepare(
    'SELECT seq FROM workspace_changes WHERE workspace_id = ? ORDER BY seq ASC',
  )
    .bind(workspaceId)
    .all<{ seq: number }>();
  return result.results.map((row) => row.seq);
}

// ---------------------------------------------------------------------------
// 鉴权与首次全量
// ---------------------------------------------------------------------------

describe('GET /me/sync/changes：鉴权与首次全量', () => {
  it('未认证 → 401（且不返回任何变更）', async () => {
    const response = await fetchChanges(undefined);
    expect(response.status).toBe(401);
    const body = errorBodyOf(await response.text());
    expect(body.code).toBe('unauthorized');
  });

  it('since 缺失 = 首次全量：八种实体各至少一条，每条都过 syncChangeSchema 且 seq 严格递增', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);

    const response = await readChanges(auth.authorization);

    // entityTypes 是契约的一部分：客户端据此知道服务端**实际扫描**了哪些类型。
    expect(response.entityTypes).toEqual([...SYNC_ENTITY_TYPES]);
    expect(response.serverTimeMs).toBeGreaterThan(0);
    expect(response.hasMore).toBe(false);
    expectStrictlyIncreasingSeq(response.changes);
    // 每条 seq 都是正整数，且游标恰好停在最后一条 seq 上。
    for (const change of response.changes) {
      expect(change.seq).toBeGreaterThan(0);
    }
    expect(cursorOf(response)).toBe(encodeSyncCursor(maxSeq(response)));

    const byType = new Map<SyncEntityType, SyncChange>();
    for (const change of response.changes) {
      byType.set(change.entityType, change);
    }
    expect([...byType.keys()].sort((a, b) => a.localeCompare(b))).toEqual([...SYNC_ENTITY_TYPES].sort((a, b) => a.localeCompare(b)));

    // 每种实体都能按 ID 找到，且是 upsert（有内容）。
    expect(requireChange(response, 'page', seed.pageId).op).toBe('upsert');
    expect(requireChange(response, 'widget', seed.widgetId).op).toBe('upsert');
    expect(requireChange(response, 'layout', `${seed.pageId}:desktop`).op).toBe('upsert');
    expect(requireChange(response, 'nav_link', seed.navLinkId).op).toBe('upsert');
    expect(requireChange(response, 'nav_group', seed.navGroupId).op).toBe('upsert');
    expect(requireChange(response, 'nav_membership', `${seed.navLinkId}:${seed.navGroupId}`).op).toBe(
      'upsert',
    );
    expect(requireChange(response, 'module', DEMO_BASICS_MODULE_ID).op).toBe('upsert');
    expect(requireChange(response, 'workspace_event', seed.eventId).op).toBe('upsert');

    // revision 取自**变更日志**（= 实体自身修订号），成员的日志修订号恒为 0。
    expect(requireChange(response, 'page', seed.pageId).revision).toBe(3);
    expect(requireChange(response, 'widget', seed.widgetId).revision).toBe(5);
    expect(requireChange(response, 'layout', `${seed.pageId}:desktop`).revision).toBe(7);
    expect(requireChange(response, 'nav_membership', `${seed.navLinkId}:${seed.navGroupId}`).revision).toBe(0);

    // payload 是**已解析**的实体快照（不是 config_json / settings_json 字符串）。
    const widgetPayload = requireChange(response, 'widget', seed.widgetId).payload as {
      config?: unknown;
      configParsed?: boolean;
      isHidden?: boolean;
      createdRevision?: number;
    } | null;
    expect(widgetPayload?.config).toEqual({ step: 2, label: '种子', initDelayMs: 0 });
    expect(widgetPayload?.configParsed).toBe(true);
    expect(widgetPayload?.isHidden).toBe(false);
    expect(widgetPayload?.createdRevision).toBe(1);

    const layoutPayload = requireChange(response, 'layout', `${seed.pageId}:desktop`).payload as {
      rects?: readonly { i: string; x: number; y: number; w: number; h: number }[];
      revision?: number;
    } | null;
    expect(layoutPayload?.revision).toBe(7);
    expect(layoutPayload?.rects).toEqual([{ i: seed.widgetId, x: 0, y: 0, w: 4, h: 2 }]);

    const modulePayload = requireChange(response, 'module', DEMO_BASICS_MODULE_ID).payload as {
      status?: string;
      settings?: unknown;
    } | null;
    expect(modulePayload?.status).toBe('enabled');
    expect(modulePayload?.settings).toEqual({ greeting: '你好', announce: false });

    // 作用域字段绝不出现在 payload 里（作用域由认证决定）。
    for (const change of response.changes) {
      expect(JSON.stringify(change.payload)).not.toContain('workspace_id');
      expect(JSON.stringify(change.payload)).not.toContain(auth.workspaceId);
    }

    // 用首次全量的游标再同步一次：没有任何新变更，游标停驻（不是「+1 前移」）。
    const idle = await readChanges(auth.authorization, cursorOf(response));
    expect(idle.changes).toEqual([]);
    expect(idle.hasMore).toBe(false);
    expect(cursorOf(idle)).toBe(cursorOf(response));
  });

  it('空水位：没有任何行的首次全量返回空列表、hasMore=false、watermark=0', async () => {
    const auth = await seedAuth();
    const response = await readChanges(auth.authorization);
    expect(response.changes).toEqual([]);
    expect(response.hasMore).toBe(false);
    // 契约：无变更时 nextCursor = encodeSyncCursor(requestSeq ?? 0)，watermark 同理。
    expect(cursorOf(response)).toBe(encodeSyncCursor(0));
    expect(response.meta.watermark).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 增量与墓碑
// ---------------------------------------------------------------------------

describe('增量：只返回水位（seq）之后的变更', () => {
  it('bump 某行 updated_at 后，用上一次的 nextCursor 只拿到该行', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);
    const first = await readChanges(auth.authorization);

    const bumpTs = T0 + 500;
    await env.DB.prepare(
      'UPDATE widget_instances SET revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?',
    )
      .bind(bumpTs, seed.widgetId, auth.workspaceId)
      .run();

    const second = await readChanges(auth.authorization, cursorOf(first));
    expect(second.changes.map((change) => `${change.entityType}:${change.entityId}`)).toEqual([
      `widget:${seed.widgetId}`,
    ]);
    expect(second.hasMore).toBe(false);
    // 游标恰好停在最后一条 seq 上（不是「时间戳 + 1」）。
    expect(cursorOf(second)).toBe(encodeSyncCursor(maxSeq(second)));
    expect(seqOf(cursorOf(second))).toBeGreaterThan(seqOf(cursorOf(first)));
    const change = second.changes[0];
    expect(change?.revision).toBe(6);
    expect(change?.updatedAt).toBe(bumpTs);
    const payload = change?.payload as { revision?: number } | null;
    expect(payload?.revision).toBe(6);
  });

  it('墓碑：widget 被墓碑化后出现 op=delete 且 payload 为 null（行仍在库里）', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);
    const first = await readChanges(auth.authorization);

    const tombTs = T0 + 600;
    await env.DB.prepare(
      'UPDATE widget_instances SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?',
    )
      .bind(tombTs, tombTs, seed.widgetId, auth.workspaceId)
      .run();

    const second = await readChanges(auth.authorization, cursorOf(first));
    const change = requireChange(second, 'widget', seed.widgetId);
    expect(change.op).toBe('delete');
    expect(change.payload).toBeNull();
    expect(change.revision).toBe(6);
    expect(second.changes).toHaveLength(1);

    const row = await env.DB.prepare(
      'SELECT deleted_at FROM widget_instances WHERE id = ? AND workspace_id = ?',
    )
      .bind(seed.widgetId, auth.workspaceId)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBe(tombTs);
  });

  it('页面墓碑：page 以 delete 投递；layout 的 op 由变更日志决定（日志说 upsert 就是 upsert）', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);
    const first = await readChanges(auth.authorization);
    const cursor = cursorOf(first);
    expect(requireChange(first, 'layout', `${seed.pageId}:desktop`).op).toBe('upsert');

    const tombTs = T0 + 700;
    // 与 `tombstonePageStatement` 一致：只有页面行被墓碑化（工作台路径**不** bump 子行的 updated_at）。
    await env.DB.prepare(
      'UPDATE workspace_pages SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?',
    )
      .bind(tombTs, tombTs, seed.pageId, auth.workspaceId)
      .run();

    const incremental = await readChanges(auth.authorization, cursor);
    const page = requireChange(incremental, 'page', seed.pageId);
    expect(page.op).toBe('delete');
    expect(page.payload).toBeNull();
    // 页面墓碑只产生**一条**日志（page）。布局行没有被改动，因此日志里没有新的 layout 条目：
    // 客户端移除页面的依据是这条 page=delete，而不是靠「布局也消失了」推断。
    expect(findChange(incremental, 'layout', `${seed.pageId}:desktop`)).toBeUndefined();

    // 若布局在页面已墓碑之后被 bump（例如卸载清理），触发器按页面的墓碑状态记 delete。
    const layoutBumpTs = T0 + 701;
    await env.DB.prepare(
      `UPDATE page_layout_revisions SET revision = revision + 1, updated_at = ?
        WHERE page_id = ? AND breakpoint = 'desktop'`,
    )
      .bind(layoutBumpTs, seed.pageId)
      .run();

    const afterLayoutBump = await readChanges(auth.authorization, cursorOf(incremental));
    const layout = requireChange(afterLayoutBump, 'layout', `${seed.pageId}:desktop`);
    expect(layout.op).toBe('delete');
    expect(layout.payload).toBeNull();
    expect(layout.revision).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 复核修正的核心：同一毫秒 / 时钟回退 / 显式恢复
// ---------------------------------------------------------------------------

describe('水位是单调序号：同一毫秒、时钟回退、显式恢复都被投递', () => {
  it('同一毫秒内「更新 → 删除 → 显式恢复」三条都按 seq 投递（旧实现会全丢）', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);
    const first = await readChanges(auth.authorization);
    const cursor = cursorOf(first);

    // 组件行原本的 updated_at 就是 T0+1；下面三次写入**全部**落在同一个毫秒。
    // 旧实现里游标是 lastTs+1 = T0+8（本页最后一条是 T0+7），这三条的时间戳全都小于它，
    // 于是会被**永久**跳过——这正是复核发现的 P1 缺陷。
    const sameMs = T0 + 1;
    const update = (sql: string, binds: readonly unknown[]): Promise<unknown> =>
      env.DB.prepare(sql).bind(...binds).run();

    await update(
      `UPDATE widget_instances SET revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      [sameMs, seed.widgetId, auth.workspaceId],
    );
    await update(
      `UPDATE widget_instances SET deleted_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
      [sameMs, sameMs, seed.widgetId, auth.workspaceId],
    );
    // 显式恢复：墓碑回活跃（与业务恢复路径同形的 UPDATE）。
    await update(
      `UPDATE widget_instances SET deleted_at = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
      [sameMs, seed.widgetId, auth.workspaceId],
    );

    const second = await readChanges(auth.authorization, cursor);
    const mine = changesOf(second, 'widget', seed.widgetId);
    expect(mine.map((change) => change.op)).toEqual(['upsert', 'delete', 'upsert']);
    // 三条的时间戳完全相同：先后**只能**由 seq 表达，时间比较在这里没有任何信息量。
    expect(mine.map((change) => change.updatedAt)).toEqual([sameMs, sameMs, sameMs]);
    expect(mine.map((change) => change.revision)).toEqual([6, 7, 8]);
    expectStrictlyIncreasingSeq(mine);
    for (const change of mine) {
      expect(change.seq).toBeGreaterThan(seqOf(cursor));
    }
    // 删除的那条是墓碑：payload 必须为 null；恢复的那条必须带内容（客户端不能当旧数据丢弃）。
    expect(mine[1]?.payload).toBeNull();
    expect((mine[2]?.payload as { deletedAt?: number | null } | null)?.deletedAt).toBeNull();
    // 游标前移到最后一条 seq：下一轮不会重放它们，也不会漏掉之后的写入。
    expect(cursorOf(second)).toBe(encodeSyncCursor(maxSeq(second)));
  });

  it('时钟倒退：updated_at 改小（乱序）时，新变更仍按 seq 被投递并排在正确位置', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);
    const first = await readChanges(auth.authorization);
    const cursor = cursorOf(first);

    // ① 时间戳大幅前进的写入；② 时间戳**倒退**（模拟 Worker 时钟回退/乱序）的写入。
    const aheadTs = T0 + 90_000;
    await env.DB.prepare(
      `UPDATE workspace_nav_groups SET name = '时间前进', revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    )
      .bind(aheadTs, seed.navGroupId, auth.workspaceId)
      .run();
    const staleTs = T0 - 90_000;
    await insertNavGroup(auth.workspaceId, 'clock-rewind', staleTs);

    const second = await readChanges(auth.authorization, cursor);
    const ordered = second.changes.map((change) => `${change.entityType}:${change.entityId}`);
    // 顺序是写入顺序（= seq 顺序），与时间戳大小无关。
    expect(ordered).toEqual([`nav_group:${seed.navGroupId}`, 'nav_group:clock-rewind']);
    expect(second.changes.map((change) => change.updatedAt)).toEqual([aheadTs, staleTs]);
    expect(second.changes[1]?.updatedAt).toBeLessThan(second.changes[0]?.updatedAt ?? 0);
    expectStrictlyIncreasingSeq(second.changes);
    // 时间倒退回的那条仍然带着**最新**内容（它不是「旧数据」）。
    expect((second.changes[1]?.payload as { updatedAt?: number } | null)?.updatedAt).toBe(staleTs);
    // 旧实现下这条永远拿不到：它的时间戳远小于上次的 lastTs+1。
    expect(seqOf(cursorOf(second))).toBeGreaterThan(seqOf(cursor));
  });

  it('删除 → 显式恢复（真实 HTTP：墓碑化链接 + explicitReimport 再导入）：delete 后紧跟 upsert', async () => {
    // 目录种子：与导航导入端点的真实前置一致（否则导入决策无法命中同一条目录条目）。
    await env.DB.prepare('DELETE FROM nav_catalog_links').run();
    await applyCatalogSeed({ db: env.DB, now: T0 });
    const entry = NAV_CATALOG_SEED.find((item) => item.category === '官方');
    if (entry === undefined) {
      throw new Error('目录种子缺少「官方」分类条目');
    }
    const auth = await seedAuth();

    const imported = await SELF.fetch(
      URLS.meNavigationCatalogImport,
      jsonPost({ catalogIds: [entry.id], operationId: opId('sync-reimport-insert') }, { Authorization: auth.authorization }),
    );
    expect(imported.status, await imported.clone().text()).toBe(200);
    const importedBody = await imported.json<{
      decisions: readonly { linkId: string | null }[];
    }>();
    const linkId = importedBody.decisions[0]?.linkId ?? '';
    expect(linkId.length).toBeGreaterThan(0);

    const before = await readChanges(auth.authorization);
    const cursor = cursorOf(before);
    expect(requireChange(before, 'nav_link', linkId).op).toBe('upsert');

    const linkRow = await env.DB.prepare(
      'SELECT revision FROM workspace_nav_links WHERE id = ? AND workspace_id = ?',
    )
      .bind(linkId, auth.workspaceId)
      .first<{ revision: number }>();
    const deleted = await SELF.fetch(
      navLinkUrl(linkId),
      jsonDelete({ operationId: opId('sync-reimport-delete'), expectedRevision: linkRow?.revision ?? 0 }, { Authorization: auth.authorization }),
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    // 显式再导入：这是复活墓碑的**唯一**入口（非显式导入会跳过墓碑）。
    const restored = await SELF.fetch(
      URLS.meNavigationCatalogImport,
      jsonPost(
        { catalogIds: [entry.id], operationId: opId('sync-reimport-restore'), explicitReimport: true },
        { Authorization: auth.authorization },
      ),
    );
    expect(restored.status, await restored.clone().text()).toBe(200);
    const restoredBody = await restored.json<{ restoredLinkIds: readonly string[] }>();
    expect(restoredBody.restoredLinkIds).toContain(linkId);

    const after = await readChanges(auth.authorization, cursor);
    const mine = changesOf(after, 'nav_link', linkId);
    expect(mine.map((change) => change.op)).toEqual(['delete', 'upsert']);
    expect(mine[0]?.payload).toBeNull();
    // 后一条是 upsert 且带活跃内容：客户端必须按 seq 生效，**不能**因为它「看起来比本地旧」而丢弃。
    expect(mine[1]?.op).toBe('upsert');
    expect((mine[1]?.payload as { deletedAt?: number | null } | null)?.deletedAt).toBeNull();
    expect(mine[0]?.seq).toBeLessThan(mine[1]?.seq ?? 0);
    expectStrictlyIncreasingSeq(after.changes);
  });
});

// ---------------------------------------------------------------------------
// 写路径完备性（验收重点）
// ---------------------------------------------------------------------------

describe('写路径完备性：非 CRUD 写路径也天然进入同步流', () => {
  it('卸载 demo.basics 通过真实 HTTP 写路径墓碑化实例，增量里以 op=delete 出现', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, {
      name: '卸载页',
      operationId: opId('sync-uninstall-page'),
    });
    const widget = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('sync-uninstall-widget'),
    });

    const before = await readChanges(auth.authorization);
    const beforeChange = requireChange(before, 'widget', widget.instance.id);
    expect(beforeChange.op).toBe('upsert');
    expect((beforeChange.payload as { moduleId?: string } | null)?.moduleId).toBe(
      DEMO_BASICS_MODULE_ID,
    );

    const uninstall = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'uninstall',
    });
    expect(uninstall.status).toBe(200);

    // 卸载清理把实例墓碑化（不是硬删除、也不是「只在常规 CRUD 记日志」）。
    const row = await env.DB.prepare(
      'SELECT deleted_at FROM widget_instances WHERE id = ? AND workspace_id = ?',
    )
      .bind(widget.instance.id, auth.workspaceId)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).not.toBeNull();

    const incremental = await readChanges(auth.authorization, cursorOf(before));
    const change = requireChange(incremental, 'widget', widget.instance.id);
    expect(change.op).toBe('delete');
    expect(change.payload).toBeNull();
    // 模块自身的卸载（status=uninstalled）也是变更，且**不是** delete（个人设置仍然保留）。
    const moduleChange = requireChange(incremental, 'module', DEMO_BASICS_MODULE_ID);
    expect(moduleChange.op).toBe('upsert');
    expect((moduleChange.payload as { status?: string } | null)?.status).toBe('uninstalled');
  });

  it('模板重置（reset_workspace）后，增量里能看到旧页面墓碑与新页面/实例', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const oldPage = await createPageViaApi(auth.authorization, {
      name: '旧页',
      operationId: opId('sync-reset-old-page'),
    });
    const oldWidget = await addWidgetViaApi(auth.authorization, oldPage.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('sync-reset-old-widget'),
    });

    const before = await readChanges(auth.authorization);
    expect(findChange(before, 'widget', oldWidget.instance.id)?.op).toBe('upsert');

    const apply = await SELF.fetch(
      URLS.workbenchApplyTemplate,
      jsonPost(
        { templateId: 'daily', mode: 'reset_workspace', operationId: opId('sync-reset-apply') },
        { Authorization: auth.authorization },
      ),
    );
    expect(apply.status, await apply.clone().text()).toBe(200);
    const applied = await apply.json<{ pages: readonly { id: string }[] }>();
    const newPageId = applied.pages[0]?.id;
    if (newPageId === undefined) {
      throw new Error('模板重置没有返回新页面');
    }

    const incremental = await readChanges(auth.authorization, cursorOf(before));

    const oldPageChange = requireChange(incremental, 'page', oldPage.page.id);
    expect(oldPageChange.op).toBe('delete');
    expect(oldPageChange.payload).toBeNull();

    const newPageChange = requireChange(incremental, 'page', newPageId);
    expect(newPageChange.op).toBe('upsert');

    const newWidgets = incremental.changes.filter(
      (change) =>
        change.entityType === 'widget' &&
        change.op === 'upsert' &&
        (change.payload as { pageId?: string } | null)?.pageId === newPageId,
    );
    expect(newWidgets.length).toBeGreaterThan(0);
  });

  it('备份导入（replace）后，增量里能看到旧页面墓碑与新页面/实例/布局', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const oldPage = await createPageViaApi(auth.authorization, {
      name: '导入前的页',
      operationId: opId('sync-import-before'),
    });

    const before = await readChanges(auth.authorization);

    const document = {
      kind: 'ff14-hub.workbench',
      schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
      exportedAt: T0,
      appVersion: '0.0.0',
      moduleVersions: { [DEMO_BASICS_MODULE_ID]: '1.0.0' },
      widgetConfigVersions: { [DEMO_COUNTER]: 1 },
      pages: [
        {
          id: 'sync-import-page',
          name: '导入页',
          slug: 'sync-import-page',
          isDefault: true,
          sortOrder: 0,
          instances: [
            {
              id: 'sync-import-instance',
              widgetType: DEMO_COUNTER,
              moduleId: DEMO_BASICS_MODULE_ID,
              config: { step: 1, label: '导入计数', initDelayMs: 0 },
              configVersion: 1,
              hidden: false,
              layouts: { desktop: { i: 'sync-import-instance', x: 0, y: 0, w: 4, h: 2 } },
            },
          ],
        },
      ],
    };

    const { apply } = await previewThenApplyViaApi(auth.authorization, {
      document,
      mode: 'replace',
      operationId: opId('sync-import-apply'),
    });
    expect(apply.status, await apply.clone().text()).toBe(200);
    const applied = await apply.json<{ result: { pages: readonly { id: string }[] } }>();
    const newPageId = applied.result.pages[0]?.id;
    if (newPageId === undefined) {
      throw new Error('备份导入没有返回新页面');
    }

    const incremental = await readChanges(auth.authorization, cursorOf(before));

    // replace 模式在同一事务里墓碑化旧页面（这就是「导入 = 一次大范围写路径」的证据）。
    const oldPageChange = requireChange(incremental, 'page', oldPage.page.id);
    expect(oldPageChange.op).toBe('delete');
    expect(oldPageChange.payload).toBeNull();

    // 新页面 / 新实例 / 新布局都以 upsert 进入同一条变更流（没有任何手写日志代码）。
    expect(requireChange(incremental, 'page', newPageId).op).toBe('upsert');
    const newWidgets = incremental.changes.filter(
      (change) =>
        change.entityType === 'widget' &&
        change.op === 'upsert' &&
        (change.payload as { pageId?: string } | null)?.pageId === newPageId,
    );
    expect(newWidgets.length).toBeGreaterThan(0);
    const newLayouts = incremental.changes.filter(
      (change) => change.entityType === 'layout' && change.op === 'upsert',
    );
    expect(newLayouts.length).toBeGreaterThan(0);
    expectStrictlyIncreasingSeq(incremental.changes);
    // 工作台修订号在同一快照里前进（meta 与变更流不撕裂）。
    expect(incremental.meta.workbenchRevision).toBe(await readWorkbenchStateRevision(auth.workspaceId));
  });
});

// ---------------------------------------------------------------------------
// 分页：seq 严格递增 ⇒ 不漏不重
// ---------------------------------------------------------------------------

describe('分页：seq 严格递增，跨页不漏不重（含分页期间持续写入）', () => {
  it('limit=2 且分页期间持续写入：并集等于库内全部变更、seq 严格递增、墓碑不复活', async () => {
    const auth = await seedAuth();
    await insertNavGroup(auth.workspaceId, 'pg-1', T0 + 1);
    await insertNavGroup(auth.workspaceId, 'pg-2', T0 + 2);
    await insertNavGroup(auth.workspaceId, 'pg-3', T0 + 3);

    let cursor = encodeSyncCursor(0);
    const collected: SyncChange[] = [];
    for (let round = 0; round < 10; round += 1) {
      const page = await readChanges(auth.authorization, cursor, 2);
      expect(page.changes.length).toBeLessThanOrEqual(2);
      collected.push(...page.changes);
      cursor = cursorOf(page);
      if (!page.hasMore) {
        break;
      }
      if (round === 0) {
        // 第一页消费完之后继续写入：墓碑 + 两条新增。
        await tombstoneNavGroup(auth.workspaceId, 'pg-1', T0 + 4);
        await insertNavGroup(auth.workspaceId, 'pg-4', T0 + 5);
        await insertNavGroup(auth.workspaceId, 'pg-5', T0 + 6);
      }
    }

    // ① 所有页的 seq 拼接后严格递增（不重复投递已消费的 seq）。
    expectStrictlyIncreasingSeq(collected);
    const seqs = collected.map((change) => change.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // ② 并集 = 库内应投递集合（直接读变更日志对照）。
    expect(seqs).toEqual(await readJournalSeqs(auth.workspaceId));
    // ③ 每条都只出现自己的身份，且没有别的实体类型混进来。
    expect(collected.every((change) => change.entityType === 'nav_group')).toBe(true);
    expect(new Set(collected.map((change) => change.entityId))).toEqual(
      new Set(['pg-1', 'pg-2', 'pg-3', 'pg-4', 'pg-5']),
    );
    // ④ 墓碑不复活：pg-1 的最后一条必须是 delete（之后没有任何 upsert）。
    const pg1 = collected.filter((change) => change.entityId === 'pg-1');
    expect(pg1.map((change) => change.op)).toEqual(['upsert', 'delete']);
    expect(pg1.at(-1)?.op).toBe('delete');
    // ⑤ 最后一次游标停在最后一条 seq 上。
    expect(seqOf(cursor)).toBe(seqs.at(-1) ?? 0);
  });

  it('limit=1 合法：逐条投递，hasMore 由「是否填满一页」决定', async () => {
    const auth = await seedAuth();
    await insertNavGroup(auth.workspaceId, 'limit-one-a', T0 + 4_000);
    await insertNavGroup(auth.workspaceId, 'limit-one-b', T0 + 4_001);

    const response = await readChanges(auth.authorization, undefined, 1);
    expect(response.changes).toHaveLength(1);
    expect(response.changes[0]?.entityId).toBe('limit-one-a');
    expect(response.hasMore).toBe(true);

    const next = await readChanges(auth.authorization, cursorOf(response), 1);
    expect(next.changes.map((change) => change.entityId)).toEqual(['limit-one-b']);
    // 恰好填满一页 ⇒ hasMore 保守为 true；再问一次得到空页并停驻，不会漏也不会重。
    expect(next.hasMore).toBe(true);
    const idle = await readChanges(auth.authorization, cursorOf(next), 1);
    expect(idle.changes).toEqual([]);
    expect(idle.hasMore).toBe(false);
    expect(cursorOf(idle)).toBe(cursorOf(next));
  });

  it('同毫秒 5 行 + limit=3：分页只由 seq 决定，页大小为真实上限（3，不放大）', async () => {
    const auth = await seedAuth();
    const groupTs = T0 + 1_000;
    for (const index of [1, 2, 3, 4, 5]) {
      await insertNavGroup(auth.workspaceId, `ms-group-${String(index)}`, groupTs);
    }
    await insertNavGroup(auth.workspaceId, 'ms-group-later', groupTs + 1);

    const first = await readChanges(auth.authorization, undefined, 3);
    // 与旧实现不同：页大小**不会**因为「同一毫秒有 5 行」而扩张到 5。
    expect(first.changes).toHaveLength(3);
    expect(first.hasMore).toBe(true);

    const second = await readChanges(auth.authorization, cursorOf(first), 3);
    expect(second.changes).toHaveLength(3);
    const third = await readChanges(auth.authorization, cursorOf(second), 3);
    expect(third.changes).toHaveLength(0);
    expect(third.hasMore).toBe(false);

    const union = [...first.changes, ...second.changes].map((change) => change.entityId);
    expect(new Set(union).size).toBe(6);
    expect([...union].sort((a, b) => a.localeCompare(b))).toEqual(
      ['ms-group-1', 'ms-group-2', 'ms-group-3', 'ms-group-4', 'ms-group-5', 'ms-group-later'].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expectStrictlyIncreasingSeq([...first.changes, ...second.changes]);

    // 一行不漏：并集与库里的行完全一致。
    const stored = await env.DB.prepare(
      'SELECT id FROM workspace_nav_groups WHERE workspace_id = ? ORDER BY id ASC',
    )
      .bind(auth.workspaceId)
      .all<{ id: string }>();
    expect([...new Set(union)].sort((a, b) => a.localeCompare(b))).toEqual(
      stored.results.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
    );
  });
});

// ---------------------------------------------------------------------------
// 作用域隔离
// ---------------------------------------------------------------------------

describe('作用域隔离', () => {
  it('工作空间 B 的行绝不出现在 A 的响应里（连 seq 水位也各算各的）', async () => {
    const authA = await seedAuth();
    const authB = await seedAuth();
    await insertPage(authA.workspaceId, 'scope-page-a', 'scope-a', T0);
    await insertPage(authB.workspaceId, 'scope-page-b', 'scope-b', T0);

    const responseA = await readChanges(authA.authorization);
    expect(responseA.changes.map((change) => change.entityId)).toEqual(['scope-page-a']);
    expect(JSON.stringify(responseA.changes)).not.toContain(authB.workspaceId);

    const responseB = await readChanges(authB.authorization);
    expect(responseB.changes.map((change) => change.entityId)).toEqual(['scope-page-b']);
    expect(JSON.stringify(responseB.changes)).not.toContain(authA.workspaceId);

    // 各自的水位只覆盖自己的工作空间（A 消费完自己的变更后不会「顺带」消费 B 的）。
    const idleA = await readChanges(authA.authorization, cursorOf(responseA));
    expect(idleA.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 游标版本与参数校验
// ---------------------------------------------------------------------------

describe('游标版本与参数校验', () => {
  it('v1（时间戳游标）→ 422 cursor_version_unsupported（明确要求客户端重建）', async () => {
    const auth = await seedAuth();
    for (const since of ['v1:0', 'v1:123', 'v1:1760000000000', 'v1:abc']) {
      const response = await fetchChanges(auth.authorization, since);
      expect(response.status, `since=${since}`).toBe(422);
      const body = syncErrorBodyOf(await response.text());
      expect(body.code, `since=${since}`).toBe('validation_failed');
      expect(detailsReasonOf(body), `since=${since}`).toBe('cursor_version_unsupported');
    }
  });

  it('其他版本前缀 → 同样的 cursor_version_unsupported；损坏输入 → cursor_malformed', async () => {
    const auth = await seedAuth();
    for (const since of ['v3:0', 'v10:42']) {
      const response = await fetchChanges(auth.authorization, since);
      expect(response.status, `since=${since}`).toBe(422);
      expect(detailsReasonOf(syncErrorBodyOf(await response.text())), `since=${since}`).toBe(
        'cursor_version_unsupported',
      );
    }
    for (const since of ['v2:abc', 'v2:007', 'v2:-1', 'v2:1.5', 'abc', '', 'v2']) {
      const response = await fetchChanges(auth.authorization, since);
      expect(response.status, `since=${since}`).toBe(422);
      const body = syncErrorBodyOf(await response.text());
      expect(body.code, `since=${since}`).toBe('validation_failed');
      expect(detailsReasonOf(body), `since=${since}`).toBe('cursor_malformed');
    }
  });

  it('v2:0 合法：等价于首次全量', async () => {
    const auth = await seedAuth();
    await insertPage(auth.workspaceId, 'cursor-zero', 'cursor-zero', T0);
    const fromZero = await readChanges(auth.authorization, encodeSyncCursor(0));
    const fromScratch = await readChanges(auth.authorization);
    expect(fromZero.changes.map((change) => change.entityId)).toEqual(['cursor-zero']);
    expect(fromZero.changes.map((change) => change.seq)).toEqual(
      fromScratch.changes.map((change) => change.seq),
    );
  });

  it('limit 越界或非整数 → 422', async () => {
    const auth = await seedAuth();
    for (const raw of ['0', String(SYNC_MAX_LIMIT + 1), 'abc', '1.5', '-1', '']) {
      const response = await SELF.fetch(`${URLS.meSyncChanges}?limit=${encodeURIComponent(raw)}`, {
        headers: { Authorization: auth.authorization },
      });
      expect(response.status, `limit=${raw}`).toBe(422);
      const body = errorBodyOf(await response.text());
      expect(body.code, `limit=${raw}`).toBe('validation_failed');
    }
  });
});

// ---------------------------------------------------------------------------
// meta：与变更流同一快照的全局修订号
// ---------------------------------------------------------------------------

describe('meta：与变更流同一快照的全局修订号', () => {
  it('空工作空间：navRevision / workbenchRevision / watermark 都是 0', async () => {
    const auth = await seedAuth();
    const response = await readChanges(auth.authorization);
    expect(response.meta).toEqual({ navRevision: 0, workbenchRevision: 0, watermark: 0 });
  });

  it('导航写入后 navRevision 前进，且与 workspace_nav_state.revision 一致', async () => {
    await env.DB.prepare('DELETE FROM nav_catalog_links').run();
    await applyCatalogSeed({ db: env.DB, now: T0 });
    const entry = NAV_CATALOG_SEED.find((item) => item.category === '官方');
    if (entry === undefined) {
      throw new Error('目录种子缺少「官方」分类条目');
    }
    const auth = await seedAuth();
    expect((await readChanges(auth.authorization)).meta.navRevision).toBe(0);

    // 一次真实导航写入（目录导入 = 建链接 + 建分组 + 建成员关系，并 bump 导航修订号）。
    const created = await SELF.fetch(
      URLS.meNavigationCatalogImport,
      jsonPost(
        { catalogIds: [entry.id], operationId: opId('sync-meta-import') },
        { Authorization: auth.authorization },
      ),
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const imported = await created.json<{ importedLinkIds: readonly string[] }>();
    expect(imported.importedLinkIds).toHaveLength(1);
    const linkId = imported.importedLinkIds[0] ?? '';
    const linkRow = await env.DB.prepare(
      'SELECT deleted_at FROM workspace_nav_links WHERE id = ? AND workspace_id = ?',
    )
      .bind(linkId, auth.workspaceId)
      .first<{ deleted_at: number | null }>();
    expect(linkRow?.deleted_at).toBeNull();

    const stored = await readNavStateRevision(auth.workspaceId);
    expect(stored).toBeGreaterThan(0);
    const after = await readChanges(auth.authorization);
    expect(after.meta.navRevision).toBe(stored);
    // 导航写入确实进了变更流（nav_link upsert 可见）。
    expect(requireChange(after, 'nav_link', linkId).op).toBe('upsert');
    // watermark = 本页最后一条 seq。
    expect(after.meta.watermark).toBe(maxSeq(after));
    expect(maxSeq(after)).toBeGreaterThan(0);

    // 无变更时 watermark = 请求游标（停驻），而不是编造一个更大的值。
    const idle = await readChanges(auth.authorization, cursorOf(after));
    expect(idle.changes).toEqual([]);
    expect(idle.meta.watermark).toBe(seqOf(cursorOf(after)));
  });

  it('工作台写入后 workbenchRevision 与 workspace_workbench_state.revision 一致', async () => {
    const auth = await seedAuth();
    await createPageViaApi(auth.authorization, { name: 'meta 页', operationId: opId('sync-meta-page') });

    const stored = await readWorkbenchStateRevision(auth.workspaceId);
    expect(stored).toBeGreaterThan(0);
    const response = await readChanges(auth.authorization);
    expect(response.meta.workbenchRevision).toBe(stored);
  });
});

// ---------------------------------------------------------------------------
// 组合实体 ID 的长度边界（契约冲突的显式记录）
// ---------------------------------------------------------------------------

describe('组合实体 ID', () => {
  it('36 字符 UUID 组成的 linkId:groupId 完整保留（契约上限 96 容纳 73 字符的组合键）', async () => {
    const auth = await seedAuth();
    const linkId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const updatedAt = T0 + 3_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspace_nav_links
           (id, workspace_id, source_catalog_id, imported_source_version, title, url, description,
            tags_json, aliases_json, icon, open_mode, region, status, is_favorite, sort_order,
            health, health_checked_at, revision, deleted_at, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, '链接', 'https://example.com/', '', '[]', '[]', '',
                 'new_tab', 'cn', 'active', 0, 0, 'unknown', NULL, 0, NULL, ?, ?)`,
      ).bind(linkId, auth.workspaceId, updatedAt, updatedAt),
      env.DB.prepare(
        `INSERT INTO workspace_nav_groups (id, workspace_id, name, sort_order, revision, deleted_at, created_at, updated_at)
         VALUES (?, ?, '组', 0, 0, NULL, ?, ?)`,
      ).bind(groupId, auth.workspaceId, updatedAt, updatedAt),
      env.DB.prepare(
        `INSERT INTO workspace_nav_memberships (link_id, group_id, workspace_id, sort_order, deleted_at, updated_at)
         VALUES (?, ?, ?, 0, NULL, ?)`,
      ).bind(linkId, groupId, auth.workspaceId, updatedAt),
    ]);

    // readChanges 会校验整个响应：因此这条用例同时证明「组合键 ≤ 契约上限」这一契约事实。
    const response = await readChanges(auth.authorization);
    const composite = `${linkId}:${groupId}`;
    const change = requireChange(response, 'nav_membership', composite);
    // 关键：**不截断**（变更日志里的 entity_id 即触发器写入的完整组合键）。
    expect(change.entityId).toBe(composite);
    expect(change.entityId.length).toBeGreaterThan(64);
    expect(change.entityId.length).toBeLessThanOrEqual(SYNC_ENTITY_ID_MAX_LENGTH);
    // payload 里同样带完整的 linkId / groupId：客户端能重建归属关系。
    expect(change.payload).toMatchObject({ linkId, groupId });
  });
});
