/**
 * 工作台的作用域/鉴权/输入边界、迁移级约束与「批次中途失败整体回滚」（HUB-045 / HUB-046 验收）。
 *
 * 三层证据：
 * 1. **作用域只来自认证结果**：无凭证 401、被撤销 401、拿 A 的凭证碰 B 的资源只会 404 或空集合，
 *    且必须断言 B 的行**逐字节未变**（不是只看状态码）。
 * 2. **约束在真实 D1 上实测**：部分唯一索引、slug 唯一索引（含墓碑）、CHECK、外键、主键，
 *    全部用原始 SQL 构造写入并断言「真的被拒绝」。
 * 3. **事务原子性**：用一个只在该测试里存在的触发器在批次中途制造约束失败，
 *    断言这一批里的**所有**写入（含已经成功的那条）都被回滚。
 */
import { DEMO_BASICS_MODULE_ID, DEMO_WIDGET_IDS } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  URLS,
  addWidgetViaApi,
  backupRestoreUrl,
  countRows,
  createPageViaApi,
  enableDemoModule,
  jsonDelete,
  jsonPatch,
  jsonPost,
  jsonPut,
  pageLayoutUrl,
  pageRestoreUrl,
  pageUrl,
  pageWidgetsUrl,
  readInstanceRows,
  readLayoutRows,
  readPageRow,
  readPageRows,
  readWorkbenchOperationRow,
  readWorkbenchStateRow,
  resetIdentityState,
  seedWorkspace,
  seedWorkspaceWithDevice,
  widgetDuplicateUrl,
  widgetUrl,
  opId,
  seedAuth,
} from './helpers';

const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;
const NOW = 1_760_000_000_000;
/** 只在本文件里使用的回滚触发器名（每个用例结束都会 DROP）。 */
const ROLLBACK_TRIGGER = 'test_force_rollback_guard';
/** 结构合法但不对应任何真实预览的令牌（用于「先过 Schema，再被业务拒绝」的探针）。 */
const SYNTHETIC_PREVIEW_TOKEN = 'synthetic-preview-token-0000000000000000';

function errorBodyOf(text: string): { code: string; message: string } {
  return JSON.parse(text) as { code: string; message: string };
}

interface RouteProbe {
  readonly label: string;
  readonly url: string;
  readonly init: RequestInit;
}

/** 全部工作台路由（含读与写），用于逐个验证鉴权与作用域。 */
function workbenchRouteProbes(id: string): RouteProbe[] {
  const operationId = 'op-probe-00000001';
  return [
    { label: 'GET /me/workbench', url: URLS.workbench, init: { method: 'GET' } },
    { label: 'GET /me/pages', url: URLS.pages, init: { method: 'GET' } },
    { label: 'POST /me/pages', url: URLS.pages, init: jsonPost({ name: '探针页', operationId }) },
    {
      label: 'PATCH /me/pages/:id',
      url: pageUrl(id),
      init: jsonPatch({ expectedRevision: 0, name: '探针页', operationId }),
    },
    { label: 'DELETE /me/pages/:id', url: pageUrl(id), init: jsonDelete({ expectedRevision: 0, operationId }) },
    { label: 'POST /me/pages/:id/restore', url: pageRestoreUrl(id), init: jsonPost({ operationId }) },
    { label: 'GET /me/pages/:id/layout', url: pageLayoutUrl(id), init: { method: 'GET' } },
    {
      label: 'PUT /me/pages/:id/layout',
      url: pageLayoutUrl(id),
      init: jsonPut({ breakpoint: 'desktop', baseRevision: 0, rects: [], operationId }),
    },
    { label: 'GET /me/pages/:id/widgets', url: pageWidgetsUrl(id), init: { method: 'GET' } },
    {
      label: 'POST /me/pages/:id/widgets',
      url: pageWidgetsUrl(id),
      init: jsonPost({ widgetType: DEMO_COUNTER, operationId }),
    },
    {
      label: 'PATCH /me/widgets/:id',
      url: widgetUrl(id),
      init: jsonPatch({ expectedRevision: 0, hidden: true, operationId }),
    },
    { label: 'DELETE /me/widgets/:id', url: widgetUrl(id), init: jsonDelete({ expectedRevision: 0, operationId }) },
    { label: 'POST /me/widgets/:id/duplicate', url: widgetDuplicateUrl(id), init: jsonPost({ operationId }) },
    { label: 'GET /me/workbench/templates', url: URLS.workbenchTemplates, init: { method: 'GET' } },
    {
      label: 'POST /me/workbench/apply-template',
      url: URLS.workbenchApplyTemplate,
      init: jsonPost({ templateId: 'blank', mode: 'new_page', operationId }),
    },
    { label: 'GET /me/workbench/backup', url: URLS.workbenchBackup, init: { method: 'GET' } },
    { label: 'GET /me/workbench/backups', url: URLS.workbenchBackups, init: { method: 'GET' } },
    {
      label: 'POST /me/workbench/import/preview',
      url: URLS.workbenchImportPreview,
      init: jsonPost({ mode: 'merge', document: {} }),
    },
    {
      label: 'POST /me/workbench/import/apply',
      url: URLS.workbenchImportApply,
      // 复核后 apply 必须回显预览令牌；这里给一个结构合法的合成值，
      // 让鉴权用例拦在**认证**上，而不是被 Schema 层缺字段提前挡掉。
      init: jsonPost({
        mode: 'merge',
        document: {},
        previewRevision: 0,
        previewToken: SYNTHETIC_PREVIEW_TOKEN,
        confirm: true,
        operationId,
      }),
    },
    { label: 'POST /me/workbench/backup/:id/restore', url: backupRestoreUrl(id), init: jsonPost({ operationId, expectedRevision: 0 }) },
  ];
}

/** B 工作空间的可观测状态（用于断言「逐字节未变」）。 */
async function snapshotOf(workspaceId: string, pageId: string): Promise<string> {
  return JSON.stringify({
    pages: await readPageRows(workspaceId),
    instances: await readInstanceRows(pageId),
    layouts: await readLayoutRows(pageId),
  });
}

// ---------------------------------------------------------------------------
// 原始 SQL 辅助（迁移级约束用）
// ---------------------------------------------------------------------------

function insertPageRow(input: {
  readonly workspaceId: string;
  readonly id: string;
  readonly slug: string;
  readonly name?: string;
  readonly isDefault?: boolean;
  readonly sortOrder?: number;
  readonly deletedAt?: number | null;
}): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO workspace_pages
       (id, workspace_id, name, slug, is_default, sort_order, revision, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.workspaceId,
      input.name ?? '页面',
      input.slug,
      input.isDefault === true ? 1 : 0,
      input.sortOrder ?? 0,
      input.deletedAt ?? null,
      NOW,
      NOW,
    )
    .run();
}

function insertInstanceRow(input: {
  readonly workspaceId: string;
  readonly pageId: string;
  readonly id: string;
  readonly moduleId?: string;
  readonly widgetType?: string;
  readonly createdRevision?: number;
}): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO widget_instances
       (id, workspace_id, page_id, module_id, widget_type, config_json, config_version,
        is_hidden, revision, created_revision, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', 1, 0, 0, ?, NULL, ?, ?)`,
  )
    .bind(
      input.id,
      input.workspaceId,
      input.pageId,
      input.moduleId ?? DEMO_BASICS_MODULE_ID,
      input.widgetType ?? DEMO_COUNTER,
      input.createdRevision ?? 0,
      NOW,
      NOW,
    )
    .run();
}

function insertLayoutRow(input: {
  readonly widgetId: string;
  readonly breakpoint?: string;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
}): Promise<unknown> {
  return env.DB.prepare('INSERT INTO widget_layouts (widget_id, breakpoint, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(
      input.widgetId,
      input.breakpoint ?? 'desktop',
      input.x ?? 0,
      input.y ?? 0,
      input.w ?? 4,
      input.h ?? 3,
    )
    .run();
}

function insertOperationRow(input: {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly kind?: string;
}): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO workbench_operations (workspace_id, operation_id, kind, result_json, created_at, attempt_token)
     VALUES (?, ?, ?, '{}', ?, NULL)`,
  )
    .bind(input.workspaceId, input.operationId, input.kind ?? 'page.create', NOW)
    .run();
}

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

async function indexExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

/** 在 `workspace_pages` 插入时强制失败的触发器（模拟唯一约束冲突）。 */
async function createRollbackTrigger(): Promise<void> {
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS ${ROLLBACK_TRIGGER}
       BEFORE INSERT ON workspace_pages
       BEGIN
         SELECT RAISE(ABORT, 'UNIQUE constraint failed: workspace_pages.workspace_id, workspace_pages.slug');
       END`,
  ).run();
}

async function dropRollbackTrigger(): Promise<void> {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${ROLLBACK_TRIGGER}`).run();
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('作用域与鉴权', () => {
  it('未携带设备凭证：全部工作台路由一律 401（读、写、备份、恢复都算）', async () => {
    const probes = workbenchRouteProbes('no-such-id');
    expect(probes).toHaveLength(20);
    for (const probe of probes) {
      const response = await SELF.fetch(probe.url, probe.init);
      expect(response.status, probe.label).toBe(401);
      expect(errorBodyOf(await response.text()).code, probe.label).toBe('unauthorized');
    }
  });

  it('设备凭证已被撤销：全部工作台路由一律 401', async () => {
    const { workspace, device } = await seedWorkspaceWithDevice({ revoked: true });
    expect(workspace.workspaceId.length).toBeGreaterThan(0);
    const probes = workbenchRouteProbes('no-such-id');
    for (const probe of probes) {
      const response = await SELF.fetch(probe.url, {
        ...probe.init,
        headers: { ...(probe.init.headers as Record<string, string>), Authorization: device.authorization },
      });
      expect(response.status, probe.label).toBe(401);
    }
  });

  it('拿 A 的凭证访问 B 的资源：只会 404 或空集合，且 B 的行逐字节未变', async () => {
    const a = await seedAuth();
    const b = await seedAuth();
    await enableDemoModule(b.authorization, DEMO_BASICS_MODULE_ID);
    const bPage = await createPageViaApi(b.authorization, { name: 'B 的页面', operationId: opId('b-page') });
    const bWidget = await addWidgetViaApi(b.authorization, bPage.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b-widget'),
    });
    // 在 B 里做一次替换导入，产生一份真实的 pre_import 备份供跨工作空间引用。
    const replaceDocument = {
      kind: 'ff14-hub.workbench',
      schemaVersion: 1,
      exportedAt: NOW,
      appVersion: '0.0.0',
      moduleVersions: {},
      widgetConfigVersions: {},
      pages: [{ id: 'b-doc-page', name: 'B 替换页', slug: 'b-replaced', isDefault: true, sortOrder: 0, instances: [] }],
    };
    const preview = await SELF.fetch(
      URLS.workbenchImportPreview,
      jsonPost({ mode: 'replace', document: replaceDocument }, { Authorization: b.authorization }),
    );
    const previewBody = await preview.json<{ preview: { previewRevision: number; previewToken: string } }>();
    const imported = await SELF.fetch(
      URLS.workbenchImportApply,
      jsonPost(
        {
          mode: 'replace',
          document: replaceDocument,
          previewRevision: previewBody.preview.previewRevision,
          previewToken: previewBody.preview.previewToken,
          confirm: true,
          operationId: opId('b-import'),
        },
        { Authorization: b.authorization },
      ),
    );
    expect(imported.status).toBe(200);
    const importedBody = await imported.json<{ result: { backupId: string | null } }>();
    const bBackupId = importedBody.result.backupId ?? '';
    expect(bBackupId.length).toBeGreaterThan(0);

    const snapshotBefore = await snapshotOf(b.workspaceId, bPage.page.id);
    const authorization = { Authorization: a.authorization };

    // 读路径：只可能拿到 A 自己的（空）数据，绝不出现 B 的 ID。
    const workbench = await SELF.fetch(URLS.workbench, { headers: authorization });
    expect(workbench.status).toBe(200);
    const workbenchText = await workbench.text();
    expect(workbenchText).not.toContain(bPage.page.id);
    expect(workbenchText).not.toContain('B 的页面');

    const pages = await SELF.fetch(URLS.pages, { headers: authorization });
    expect(pages.status).toBe(200);
    expect(await pages.text()).not.toContain(bPage.page.id);

    const backups = await SELF.fetch(URLS.workbenchBackups, { headers: authorization });
    expect(backups.status).toBe(200);
    expect(await backups.text()).not.toContain(bBackupId);

    // 路径参数指向 B 的资源：写路径一律 404（作用域只来自认证结果）。
    const notFoundCases: RouteProbe[] = [
      { label: 'PATCH /me/pages/:bPage', url: pageUrl(bPage.page.id), init: jsonPatch({ expectedRevision: 1, name: '越权改名', operationId: opId('x-page-patch') }) },
      { label: 'DELETE /me/pages/:bPage', url: pageUrl(bPage.page.id), init: jsonDelete({ expectedRevision: 1, operationId: opId('x-page-delete') }) },
      { label: 'POST /me/pages/:bPage/restore', url: pageRestoreUrl(bPage.page.id), init: jsonPost({ operationId: opId('x-page-restore') }) },
      { label: 'GET /me/pages/:bPage/layout', url: pageLayoutUrl(bPage.page.id), init: { method: 'GET' } },
      // 读路径也要一致：别人的页面在**所有** `:id` 路由上都表现为「不存在」，
      // 而不是「存在但空」——否则前端无法区分「过期的 pageId」与「这个页面确实没有组件」。
      { label: 'GET /me/pages/:bPage/widgets', url: pageWidgetsUrl(bPage.page.id), init: { method: 'GET' } },
      { label: 'PUT /me/pages/:bPage/layout', url: pageLayoutUrl(bPage.page.id), init: jsonPut({ breakpoint: 'desktop', baseRevision: 0, rects: [], operationId: opId('x-layout') }) },
      { label: 'POST /me/pages/:bPage/widgets', url: pageWidgetsUrl(bPage.page.id), init: jsonPost({ widgetType: DEMO_COUNTER, operationId: opId('x-widget-add') }) },
      { label: 'PATCH /me/widgets/:bWidget', url: widgetUrl(bWidget.instance.id), init: jsonPatch({ expectedRevision: 0, hidden: true, operationId: opId('x-widget-patch') }) },
      { label: 'DELETE /me/widgets/:bWidget', url: widgetUrl(bWidget.instance.id), init: jsonDelete({ expectedRevision: 0, operationId: opId('x-widget-delete') }) },
      { label: 'POST /me/widgets/:bWidget/duplicate', url: widgetDuplicateUrl(bWidget.instance.id), init: jsonPost({ operationId: opId('x-widget-dup') }) },
      { label: 'POST /me/workbench/backup/:bBackup/restore', url: backupRestoreUrl(bBackupId), init: jsonPost({ operationId: opId('x-backup-restore'), expectedRevision: 0 }) },
    ];
    for (const probe of notFoundCases) {
      const response = await SELF.fetch(probe.url, {
        ...probe.init,
        headers: { ...(probe.init.headers as Record<string, string>), Authorization: a.authorization },
      });
      expect(response.status, probe.label).toBe(404);
    }

    // B 的页面 / 实例 / 布局逐字节未变。
    expect(await snapshotOf(b.workspaceId, bPage.page.id)).toBe(snapshotBefore);
  });

  it('客户端提交的 workspaceId / pageId 既不会越权，也不会留下任何写入', async () => {
    const a = await seedAuth();
    const b = await seedAuth();
    const bPage = await createPageViaApi(b.authorization, { name: 'B 的页面', operationId: opId('b-page') });
    const snapshotBefore = await snapshotOf(b.workspaceId, bPage.page.id);

    // 1) 写入体里夹带 workspaceId：严格 Schema 直接拒绝。
    const withWorkspaceId = await SELF.fetch(
      URLS.pages,
      jsonPost(
        { name: '越权页', operationId: opId('a-page'), workspaceId: b.workspaceId },
        { Authorization: a.authorization },
      ),
    );
    expect(withWorkspaceId.status).toBe(422);
    expect(errorBodyOf(await withWorkspaceId.text()).code).toBe('validation_failed');

    // 2) 写入体里夹带 pageId：同样被拒绝。
    const aPage = await createPageViaApi(a.authorization, { name: 'A 的页面', operationId: opId('a-page-2') });
    const withPageId = await SELF.fetch(
      pageWidgetsUrl(aPage.page.id),
      jsonPost(
        { widgetType: DEMO_COUNTER, operationId: opId('a-widget'), pageId: bPage.page.id },
        { Authorization: a.authorization },
      ),
    );
    expect(withPageId.status).toBe(422);

    // 3) 路径参数指向别的工作空间的页面：404，且不会改动它。
    const crossPath = await SELF.fetch(
      pageUrl(bPage.page.id),
      jsonPatch(
        { expectedRevision: 0, isDefault: true, operationId: opId('a-cross') },
        { Authorization: a.authorization },
      ),
    );
    expect(crossPath.status).toBe(404);

    // A 只多出自己那一页；B 一切照旧。
    const aActive = (await readPageRows(a.workspaceId)).filter((row) => row.deleted_at === null);
    expect(aActive.map((row) => row.name)).toEqual(['A 的页面']);
    expect(await countRows('widget_instances')).toBe(0);
    expect(await snapshotOf(b.workspaceId, bPage.page.id)).toBe(snapshotBefore);
  });
});

describe('请求体严格校验', () => {
  it('多余字段 / 缺少 operationId / operationId 太短或含非法字符 / 未知断点 / 缺少 expectedRevision 一律 422，且不写入', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    const pagesBefore = await countRows('workspace_pages');
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);
    const instancesBefore = await countRows('widget_instances');
    const operationsBefore = await countRows('workbench_operations');

    const cases: RouteProbe[] = [
      { label: 'POST /me/pages 多余字段', url: URLS.pages, init: jsonPost({ name: '页面', operationId: opId('s1'), extra: true }) },
      { label: 'POST /me/pages 缺少 operationId', url: URLS.pages, init: jsonPost({ name: '页面' }) },
      { label: 'POST /me/pages operationId 太短（< 8）', url: URLS.pages, init: jsonPost({ name: '页面', operationId: 'short' }) },
      { label: 'POST /me/pages operationId 含非法字符', url: URLS.pages, init: jsonPost({ name: '页面', operationId: 'op strict 0001' }) },
      { label: 'POST /me/pages 页面名为空', url: URLS.pages, init: jsonPost({ name: '', operationId: opId('s2') }) },
      { label: 'PATCH /me/pages/:id 缺少 expectedRevision', url: pageUrl(page.page.id), init: jsonPatch({ name: '改名', operationId: opId('s3') }) },
      { label: 'PATCH /me/pages/:id 没有任何待改字段', url: pageUrl(page.page.id), init: jsonPatch({ expectedRevision: 0, operationId: opId('s4') }) },
      { label: 'DELETE /me/pages/:id 缺少 expectedRevision', url: pageUrl(page.page.id), init: jsonDelete({ operationId: opId('s5') }) },
      { label: 'PUT layout 未知断点', url: pageLayoutUrl(page.page.id), init: jsonPut({ breakpoint: 'ultrawide', baseRevision: 0, rects: [], operationId: opId('s6') }) },
      { label: 'PUT layout 缺少 baseRevision', url: pageLayoutUrl(page.page.id), init: jsonPut({ breakpoint: 'desktop', rects: [], operationId: opId('s7') }) },
      { label: 'PUT layout 多余字段', url: pageLayoutUrl(page.page.id), init: jsonPut({ breakpoint: 'desktop', baseRevision: 0, rects: [], operationId: opId('s8'), cols: 99 }) },
      { label: 'POST widgets 缺少 operationId', url: pageWidgetsUrl(page.page.id), init: jsonPost({ widgetType: DEMO_COUNTER }) },
      { label: 'PATCH /me/widgets/:id 缺少 expectedRevision', url: widgetUrl('no-such-widget'), init: jsonPatch({ hidden: true, operationId: opId('s9') }) },
      { label: 'DELETE /me/widgets/:id 缺少 expectedRevision', url: widgetUrl('no-such-widget'), init: jsonDelete({ operationId: opId('s10') }) },
      { label: 'POST duplicate 缺少 operationId', url: widgetDuplicateUrl('no-such-widget'), init: jsonPost({}) },
      { label: 'POST restore 多余字段', url: pageRestoreUrl(page.page.id), init: jsonPost({ operationId: opId('s11'), expectedRevision: 0 }) },
    ];

    for (const probe of cases) {
      const response = await SELF.fetch(probe.url, {
        ...probe.init,
        headers: { ...(probe.init.headers as Record<string, string>), Authorization: auth.authorization },
      });
      expect(response.status, probe.label).toBe(422);
      expect(errorBodyOf(await response.text()).code, probe.label).toBe('validation_failed');
    }

    expect(await countRows('workspace_pages')).toBe(pagesBefore);
    expect(await countRows('widget_instances')).toBe(instancesBefore);
    expect(await readWorkbenchStateRow(auth.workspaceId)).toEqual(stateBefore);
    // 每一次被拒绝的请求都没有留下幂等记录（只有创建页面那次留下了 1 条）。
    expect(await countRows('workbench_operations')).toBe(operationsBefore);
    expect(operationsBefore).toBe(1);
  });
});

describe('迁移级约束（真实 D1 原始 SQL）', () => {
  it('部分唯一索引：同一工作空间最多一个活跃默认页，但墓碑默认页不受约束', async () => {
    const workspace = await seedWorkspace();
    await insertPageRow({ workspaceId: workspace.workspaceId, id: 'p-1', slug: 'first', isDefault: true });

    // 第二个活跃默认页必须被数据库拒绝。
    await expect(
      insertPageRow({ workspaceId: workspace.workspaceId, id: 'p-2', slug: 'second', isDefault: true }),
    ).rejects.toThrow(/unique/i);

    // 部分索引的 WHERE 只覆盖活跃行：墓碑行可以继续带 is_default = 1。
    await insertPageRow({
      workspaceId: workspace.workspaceId,
      id: 'p-3',
      slug: 'third',
      isDefault: true,
      deletedAt: NOW,
    });

    const activeDefaults = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workspace_pages WHERE workspace_id = ? AND is_default = 1 AND deleted_at IS NULL',
    )
      .bind(workspace.workspaceId)
      .first<{ count: number }>();
    expect(activeDefaults?.count).toBe(1);

    // 另一个工作空间互不影响。
    const other = await seedWorkspace();
    await insertPageRow({ workspaceId: other.workspaceId, id: 'p-other', slug: 'first', isDefault: true });
  });

  it('slug 唯一索引覆盖墓碑：重复 slug（含与墓碑撞名）一律被拒绝', async () => {
    const workspace = await seedWorkspace();
    await insertPageRow({ workspaceId: workspace.workspaceId, id: 'p-a', slug: 'shared-slug' });
    await expect(
      insertPageRow({ workspaceId: workspace.workspaceId, id: 'p-b', slug: 'shared-slug' }),
    ).rejects.toThrow(/unique/i);
    // 墓碑页仍然占着这个 slug（这正是「恢复已删除页面永不撞 slug」的代价与保证）。
    await expect(
      insertPageRow({
        workspaceId: workspace.workspaceId,
        id: 'p-c',
        slug: 'shared-slug',
        deletedAt: NOW,
      }),
    ).rejects.toThrow(/unique/i);
    // 不同工作空间可以用同一个 slug。
    const other = await seedWorkspace();
    await insertPageRow({ workspaceId: other.workspaceId, id: 'p-d', slug: 'shared-slug' });
  });

  it('widget_layouts 的 CHECK 拒绝非法坐标与尺寸，外键拒绝不存在的实例', async () => {
    const workspace = await seedWorkspace();
    await insertPageRow({ workspaceId: workspace.workspaceId, id: 'p-layout', slug: 'layout-page' });
    await insertInstanceRow({
      workspaceId: workspace.workspaceId,
      pageId: 'p-layout',
      id: 'w-layout',
    });

    await expect(insertLayoutRow({ widgetId: 'w-layout', w: 0 })).rejects.toThrow();
    await expect(insertLayoutRow({ widgetId: 'w-layout', w: -1 })).rejects.toThrow();
    await expect(insertLayoutRow({ widgetId: 'w-layout', h: 0 })).rejects.toThrow();
    await expect(insertLayoutRow({ widgetId: 'w-layout', x: -1 })).rejects.toThrow();
    await expect(insertLayoutRow({ widgetId: 'w-layout', y: -1 })).rejects.toThrow();
    await expect(insertLayoutRow({ widgetId: 'w-layout', breakpoint: 'ultrawide' })).rejects.toThrow();
    // 主键 (widget_id, breakpoint) 拒绝同一实例同一断点的第二个矩形。
    await insertLayoutRow({ widgetId: 'w-layout', breakpoint: 'desktop' });
    await expect(insertLayoutRow({ widgetId: 'w-layout', breakpoint: 'desktop' })).rejects.toThrow();
    // 外键：不存在的实例不能有布局。
    await expect(insertLayoutRow({ widgetId: 'no-such-instance' })).rejects.toThrow(/foreign key/i);
  });

  it('widget_instances 的 page_id / workspace_id 外键拒绝悬空引用', async () => {
    const workspace = await seedWorkspace();
    await expect(
      insertInstanceRow({ workspaceId: workspace.workspaceId, pageId: 'no-such-page', id: 'w-orphan-page' }),
    ).rejects.toThrow(/foreign key/i);
    await insertPageRow({ workspaceId: workspace.workspaceId, id: 'p-fk', slug: 'fk-page' });
    await expect(
      insertInstanceRow({ workspaceId: 'no-such-workspace', pageId: 'p-fk', id: 'w-orphan-ws' }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('workbench_operations 的 CHECK 拒绝过短/过长的 operation_id，主键拒绝重复；备份 kind 也受 CHECK 约束', async () => {
    const workspace = await seedWorkspace();
    await expect(
      insertOperationRow({ workspaceId: workspace.workspaceId, operationId: 'short' }),
    ).rejects.toThrow();
    await expect(
      insertOperationRow({ workspaceId: workspace.workspaceId, operationId: 'x'.repeat(65) }),
    ).rejects.toThrow();
    await insertOperationRow({ workspaceId: workspace.workspaceId, operationId: 'op-valid-0001' });
    await expect(
      insertOperationRow({ workspaceId: workspace.workspaceId, operationId: 'op-valid-0001' }),
    ).rejects.toThrow();
    // 另一个工作空间可以用同一个 operationId（主键是复合的）。
    const other = await seedWorkspace();
    await insertOperationRow({ workspaceId: other.workspaceId, operationId: 'op-valid-0001' });

    await expect(
      env.DB.prepare(
        `INSERT INTO workbench_backups (id, workspace_id, kind, schema_version, payload_json, created_at, created_by_device, consumed_at)
         VALUES (?, ?, 'snapshot', 1, '{}', ?, NULL, NULL)`,
      )
        .bind('backup-bad-kind', workspace.workspaceId, NOW)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO workbench_backups (id, workspace_id, kind, schema_version, payload_json, created_at, created_by_device, consumed_at)
         VALUES (?, ?, 'pre_import', 1, '{}', ?, NULL, NULL)`,
      )
        .bind('backup-manual', workspace.workspaceId, NOW)
        .run(),
    ).resolves.toBeDefined();
  });

  it('阶段 03 的 9 张表（7 张主表 + 0007 的 2 张配套表）与关键索引都已建立；迁移重放依然安全', async () => {
    for (const table of [
      'workspace_pages',
      'widget_instances',
      'widget_layouts',
      'page_layout_revisions',
      'workspace_workbench_state',
      'workbench_operations',
      'workbench_backups',
      // 0007_workbench_hardening.sql：为了「原始语句重放仍然幂等」而选择的配套表。
      'workbench_operation_intents',
      'widget_cleanup_marks',
    ]) {
      expect(await tableExists(table), `缺少表 ${table}`).toBe(true);
    }
    for (const index of [
      'idx_workspace_pages_slug',
      'idx_workspace_pages_single_default',
      'idx_workspace_pages_active',
      'idx_widget_instances_page',
      'idx_widget_instances_workspace_module',
      'idx_widget_instances_workspace_widget',
      'idx_workbench_operations_created',
      'idx_workbench_backups_workspace',
      'idx_workbench_operation_intents_created',
      'idx_widget_cleanup_marks_token',
      'idx_widget_cleanup_marks_workspace',
    ]) {
      expect(await indexExists(index), `缺少索引 ${index}`).toBe(true);
    }

    // 重复应用迁移安全：逐条重放后仍能正常写入。
    for (const migration of env.TEST_MIGRATIONS) {
      for (const query of migration.queries) {
        await env.DB.prepare(query).run();
      }
    }
    const workspace = await seedWorkspace();
    await insertPageRow({ workspaceId: workspace.workspaceId, id: 'p-replay', slug: 'replay' });
    expect((await readPageRow(workspace.workspaceId, 'p-replay'))?.slug).toBe('replay');
  });
});

describe('批次中途失败：整个事务回滚', () => {
  it('页面创建时批次中途撞上唯一约束：页面、幂等记录与工作台修订号全部回滚', async () => {
    const auth = await seedAuth();
    await createRollbackTrigger();
    try {
      const operationId = opId('rollback-create');
      const response = await SELF.fetch(
        URLS.pages,
        jsonPost({ name: '会被回滚的页面', operationId }, { Authorization: auth.authorization }),
      );
      // 事务失败如实报告为服务器内部错误（绝不假装成功）。
      expect(response.status).toBe(500);
      expect(errorBodyOf(await response.text()).code).toBe('internal_error');

      // 这一批里的**每一条**写入都没有持久化（含 0007 的意图指纹行）。
      expect(await countRows('workspace_pages')).toBe(0);
      expect(await countRows('workbench_operations')).toBe(0);
      expect(await countRows('workbench_operation_intents')).toBe(0);
      expect(await readWorkbenchOperationRow(auth.workspaceId, operationId)).toBeNull();
      expect(await readWorkbenchStateRow(auth.workspaceId)).toBeNull();
    } finally {
      await dropRollbackTrigger();
    }
  });

  it('替换导入时批次中途失败：同批写入的 pre_import 备份、墓碑化与新页面全部回滚', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '原有页面', operationId: opId('page') });
    const pageBefore = await readPageRow(auth.workspaceId, page.page.id);
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);
    expect(stateBefore).not.toBeNull();

    const document = {
      kind: 'ff14-hub.workbench',
      schemaVersion: 1,
      exportedAt: NOW,
      appVersion: '0.0.0',
      moduleVersions: {},
      widgetConfigVersions: {},
      pages: [{ id: 'doc-page', name: '导入页', slug: 'imported-page', isDefault: true, sortOrder: 0, instances: [] }],
    };
    const preview = await SELF.fetch(
      URLS.workbenchImportPreview,
      jsonPost({ mode: 'replace', document }, { Authorization: auth.authorization }),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json<{
      preview: { importable: boolean; previewRevision: number; previewToken: string };
    }>();
    expect(previewBody.preview.importable).toBe(true);

    await createRollbackTrigger();
    try {
      const operationId = opId('rollback-import');
      const operationsBefore = await countRows('workbench_operations');
      const intentsBefore = await countRows('workbench_operation_intents');
      const response = await SELF.fetch(
        URLS.workbenchImportApply,
        jsonPost(
          {
            mode: 'replace',
            document,
            previewRevision: previewBody.preview.previewRevision,
            previewToken: previewBody.preview.previewToken,
            confirm: true,
            operationId,
          },
          { Authorization: auth.authorization },
        ),
      );
      // 修复前这里会先写备份、再墓碑化旧页面，最后才在插入新页面时失败；
      // 现在必须整体回滚。
      expect(response.status).toBe(500);
      expect(errorBodyOf(await response.text()).code).toBe('internal_error');

      // 1) 同批写入的 pre_import 备份没有留下。
      expect(await countRows('workbench_backups')).toBe(0);
      // 2) 原有页面没有被墓碑化，revision 也没有被推进。
      expect(await readPageRow(auth.workspaceId, page.page.id)).toEqual(pageBefore);
      expect((await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null)).toHaveLength(1);
      // 3) 新页面没有留下，幂等记录（含其指纹行）与工作台修订号也没有变。
      expect(await countRows('workspace_pages')).toBe(1);
      expect(await countRows('workbench_operations')).toBe(operationsBefore);
      expect(await countRows('workbench_operation_intents')).toBe(intentsBefore);
      expect(await readWorkbenchOperationRow(auth.workspaceId, operationId)).toBeNull();
      expect(await readWorkbenchStateRow(auth.workspaceId)).toEqual(stateBefore);
    } finally {
      await dropRollbackTrigger();
    }
  });
});
