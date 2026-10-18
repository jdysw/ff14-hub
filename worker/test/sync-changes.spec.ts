/**
 * 跨设备变更/水位端点测试（HUB-051 / ADR-0004 D7）。
 *
 * 证据取向：
 * 1. **契约**：每个响应都过 `syncChangesResponseSchema`，每条变更都过 `syncChangeSchema`
 *    （严格：恰好 `{entityType, entityId, op, revision, updatedAt, payload}`；`delete` 的
 *    `payload` 必须是显式的 `null`）。
 * 2. **写路径完备性**：模块卸载（`PATCH /me/modules/:id` 的 uninstall）与模板重置
 *    （`POST /me/workbench/apply-template` 的 reset）都必须天然进入同步流 ——
 *    它们不写「变更日志」，所以这两条用例证明的是「按行扫描 `updated_at`」而非「只在常规 CRUD 记日志」。
 * 3. **分页不变量**：同一毫秒写入 `limit + 1` 行时，第一页必须包含该毫秒的**全部**行、
 *    游标必然前进、第二页不重复、所有页的并集与库里的行一一对应（一行不漏）。
 * 4. **作用域隔离**：工作空间 B 的行绝不出现在 A 的响应里。
 *
 * 夹具策略：导航 / 活动行直接 `env.DB.prepare(...).run()` 插入并**显式设置 `updated_at`**
 * （不依赖并行实现中的 nav/events 端点，也让水位推演完全确定）。
 */
import {
  DEMO_BASICS_MODULE_ID,
  DEMO_WIDGET_IDS,
  SYNC_ENTITY_ID_MAX_LENGTH,
  SYNC_ENTITY_TYPES,
  SYNC_MAX_LIMIT,
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
import {
  URLS,
  addWidgetViaApi,
  createPageViaApi,
  enableDemoModule,
  errorBodyOf,
  jsonPost,
  opId,
  patchModule,
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

function findChange(
  response: SyncChangesResponse,
  entityType: SyncEntityType,
  entityId: string,
): SyncChange | undefined {
  return response.changes.find(
    (change) => change.entityType === entityType && change.entityId === entityId,
  );
}

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

/** 响应里最晚的一条时间戳（用作「从上一轮边界（含）继续」的游标）。 */
function maxUpdatedAt(response: SyncChangesResponse): number {
  return response.changes.reduce((max, change) => Math.max(max, change.updatedAt), 0);
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
 * 这样 `nav_membership` 的 `linkId:groupId` 组合不会触及 64 字符上限；
 * 组合键超限的真实情况（36 字符 UUID）由专门的用例覆盖。
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

  it('since 缺失 = 首次全量：八种实体各至少一条，且每条都通过 syncChangeSchema', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);

    const response = await readChanges(auth.authorization);

    // entityTypes 是契约的一部分：客户端据此知道服务端**实际扫描**了哪些类型。
    expect(response.entityTypes).toEqual([...SYNC_ENTITY_TYPES]);
    expect(response.serverTimeMs).toBeGreaterThan(0);
    expect(response.hasMore).toBe(false);
    // 最后一个时间戳是 T0+7 → 游标前移到 T0+8。
    expect(cursorOf(response)).toBe(encodeSyncCursor(T0 + 8));

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
  });
});

// ---------------------------------------------------------------------------
// 增量与墓碑
// ---------------------------------------------------------------------------

describe('增量：只返回水位之后的行', () => {
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
    expect(cursorOf(second)).toBe(encodeSyncCursor(bumpTs + 1));
    const payload = second.changes[0]?.payload as { revision?: number } | null;
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

  it('页面墓碑时该页面的 layout 以 delete 返回（全量扫描里 payload=null）', async () => {
    const auth = await seedAuth();
    const seed = await seedEveryEntityType(auth.workspaceId, T0);
    const before = await readChanges(auth.authorization);
    expect(requireChange(before, 'layout', `${seed.pageId}:desktop`).op).toBe('upsert');

    const tombTs = T0 + 700;
    // 与 `tombstonePageStatement` 一致：只有页面行被墓碑化（工作台路径**不** bump 子行的 updated_at）。
    await env.DB.prepare(
      'UPDATE workspace_pages SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?',
    )
      .bind(tombTs, tombTs, seed.pageId, auth.workspaceId)
      .run();

    // 增量：页面的墓碑是新增水位，因此必然可见（客户端据此移除页面）。
    const incremental = await readChanges(auth.authorization, encodeSyncCursor(tombTs));
    const page = requireChange(incremental, 'page', seed.pageId);
    expect(page.op).toBe('delete');
    expect(page.payload).toBeNull();
    // 明确记录：页面墓碑**不会**移动子布局行的水位，因此增量里不会重复出现该 layout；
    // 一旦 layout 行出现在扫描范围内（下面的全量扫描），它的 op 必须是 delete。
    expect(findChange(incremental, 'layout', `${seed.pageId}:desktop`)).toBeUndefined();

    // 全量：页面已墓碑 → 该页面每个断点的布局都以 delete 返回，payload 为 null。
    const full = await readChanges(auth.authorization);
    const layout = requireChange(full, 'layout', `${seed.pageId}:desktop`);
    expect(layout.op).toBe('delete');
    expect(layout.payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 写路径完备性（验收重点）
// ---------------------------------------------------------------------------

describe('写路径完备性：模块卸载与模板重置天然进入同步流', () => {
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

    // 卸载清理把实例墓碑化并 bump updated_at（不是硬删除、也不是「只在常规 CRUD 记日志」）。
    const row = await env.DB.prepare(
      'SELECT deleted_at, updated_at FROM widget_instances WHERE id = ? AND workspace_id = ?',
    )
      .bind(widget.instance.id, auth.workspaceId)
      .first<{ deleted_at: number | null; updated_at: number }>();
    expect(row?.deleted_at).not.toBeNull();
    const tombTs = row?.updated_at;
    if (tombTs === undefined) {
      throw new Error('卸载后读不到实例行');
    }

    // 从**墓碑所在毫秒（含边界）**开始增量扫描：墓碑必须可见。
    const incremental = await readChanges(auth.authorization, encodeSyncCursor(tombTs));
    const change = requireChange(incremental, 'widget', widget.instance.id);
    expect(change.op).toBe('delete');
    expect(change.payload).toBeNull();
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
    const boundaryTs = maxUpdatedAt(before);
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

    // 从上一轮的边界毫秒（含）继续：重置的所有写入都 ≥ 该毫秒。
    const incremental = await readChanges(auth.authorization, encodeSyncCursor(boundaryTs));

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
});

// ---------------------------------------------------------------------------
// 分页（毫秒组边界）
// ---------------------------------------------------------------------------

describe('毫秒组分页：同一毫秒不会被切成两页', () => {
  it('同一毫秒 5 行 + limit=3：第一页包含该毫秒全部行、游标前进、第二页不重复、一行不漏', async () => {
    const auth = await seedAuth();
    const groupTs = T0 + 1_000;
    for (const index of [1, 2, 3, 4, 5]) {
      await insertNavGroup(auth.workspaceId, `ms-group-${String(index)}`, groupTs);
    }
    const laterTs = groupTs + 1;
    await insertNavGroup(auth.workspaceId, 'ms-group-later', laterTs);

    const first = await readChanges(auth.authorization, undefined, 3);
    // 边界毫秒组被**全部**补齐：页大小可以大于 limit（这里 5 > 3）。
    expect(first.changes).toHaveLength(5);
    expect(first.changes.every((change) => change.updatedAt === groupTs)).toBe(true);
    expect(first.changes.every((change) => change.entityType === 'nav_group')).toBe(true);
    expect(first.hasMore).toBe(true);

    const firstCursor = cursorOf(first);
    expect(firstCursor).toBe(encodeSyncCursor(groupTs + 1));
    const decoded = decodeSyncCursor(firstCursor);
    expect(decoded.ok && decoded.updatedAtMs > groupTs).toBe(true);

    const second = await readChanges(auth.authorization, firstCursor, 3);
    expect(second.changes.map((change) => change.entityId)).toEqual(['ms-group-later']);
    expect(second.hasMore).toBe(false);

    // 一行不漏：两页的 entityId 并集与库里的行完全一致。
    const stored = await env.DB.prepare(
      'SELECT id FROM workspace_nav_groups WHERE workspace_id = ? ORDER BY id ASC',
    )
      .bind(auth.workspaceId)
      .all<{ id: string }>();
    const union = new Set([...first.changes, ...second.changes].map((change) => change.entityId));
    expect([...union].sort((a, b) => a.localeCompare(b))).toEqual(stored.results.map((row) => row.id).sort((a, b) => a.localeCompare(b)));
  });

  it('同毫秒行数少于 limit 时不补齐、不重复（hasMore=false 且停在 lastTs+1）', async () => {
    const auth = await seedAuth();
    await insertNavGroup(auth.workspaceId, 'small-a', T0 + 2_000);
    await insertNavGroup(auth.workspaceId, 'small-b', T0 + 2_000);

    const response = await readChanges(auth.authorization, undefined, 5);
    expect(response.changes).toHaveLength(2);
    expect(response.hasMore).toBe(false);
    expect(cursorOf(response)).toBe(encodeSyncCursor(T0 + 2_001));

    const next = await readChanges(auth.authorization, cursorOf(response), 5);
    expect(next.changes).toEqual([]);
    expect(next.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 作用域隔离
// ---------------------------------------------------------------------------

describe('作用域隔离', () => {
  it('工作空间 B 的行绝不出现在 A 的响应里', async () => {
    const authA = await seedAuth();
    const authB = await seedAuth();
    await insertPage(authA.workspaceId, 'scope-page-a', 'scope-a', T0);
    await insertPage(authB.workspaceId, 'scope-page-b', 'scope-b', T0);

    const responseA = await readChanges(authA.authorization);
    expect(responseA.changes.map((change) => change.entityId)).toEqual(['scope-page-a']);

    const responseB = await readChanges(authB.authorization);
    expect(responseB.changes.map((change) => change.entityId)).toEqual(['scope-page-b']);
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
    // 关键：**不截断**。截断会让极端情况下两个不同关系映射到同一键，客户端去重会互相覆盖。
    expect(change.entityId).toBe(composite);
    expect(change.entityId.length).toBeGreaterThan(64);
    expect(change.entityId.length).toBeLessThanOrEqual(SYNC_ENTITY_ID_MAX_LENGTH);
    // payload 里同样带完整的 linkId / groupId：客户端能重建归属关系。
    expect(change.payload).toMatchObject({ linkId, groupId });
  });
});

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

describe('参数校验', () => {
  it('非法游标 → 422（绝不猜成 0 触发静默全量）', async () => {
    const auth = await seedAuth();
    for (const since of ['v1:abc', 'v2:1', '', 'abc', 'v1:007']) {
      const response = await fetchChanges(auth.authorization, since);
      expect(response.status, `since=${since}`).toBe(422);
      const body = errorBodyOf(await response.text());
      expect(body.code, `since=${since}`).toBe('validation_failed');
    }
  });

  it('limit 越界或非整数 → 422', async () => {
    const auth = await seedAuth();
    for (const raw of ['0', String(SYNC_MAX_LIMIT + 1), 'abc', '1.5', '-1']) {
      const response = await SELF.fetch(`${URLS.meSyncChanges}?limit=${encodeURIComponent(raw)}`, {
        headers: { Authorization: auth.authorization },
      });
      expect(response.status, `limit=${raw}`).toBe(422);
      const body = errorBodyOf(await response.text());
      expect(body.code, `limit=${raw}`).toBe('validation_failed');
    }
  });

  it('limit=1 合法：只返回一行，且 hasMore 由「是否还有更晚的行」决定', async () => {
    const auth = await seedAuth();
    await insertNavGroup(auth.workspaceId, 'limit-one-a', T0 + 4_000);
    await insertNavGroup(auth.workspaceId, 'limit-one-b', T0 + 4_001);

    const response = await readChanges(auth.authorization, undefined, 1);
    expect(response.changes).toHaveLength(1);
    expect(response.changes[0]?.entityId).toBe('limit-one-a');
    expect(response.hasMore).toBe(true);

    const next = await readChanges(auth.authorization, cursorOf(response), 1);
    expect(next.changes.map((change) => change.entityId)).toEqual(['limit-one-b']);
    expect(next.hasMore).toBe(false);
  });

  it('空水位：没有任何行的首次全量返回空列表且 hasMore=false', async () => {
    const auth = await seedAuth();
    const response = await readChanges(auth.authorization);
    expect(response.changes).toEqual([]);
    expect(response.hasMore).toBe(false);
    // 契约：无行时 nextCursor = encodeSyncCursor(cursor ?? 0)。
    expect(cursorOf(response)).toBe(encodeSyncCursor(0));
  });
});
