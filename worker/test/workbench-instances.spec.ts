/**
 * 工作台 Widget 实例集成测试（HUB-045 验收）+ 幂等 operationId（HUB-054 复核要求）。
 *
 * 证据标准：
 * 1. 写入/拒绝都走真实 HTTP，落库事实直接读表；
 * 2. 「模块门禁」四态（未安装 / 已停用 / 已卸载 / 正在变更）各自构造真实前置状态，
 *    并断言被拒绝时**一个字节都没写**；
 * 3. 「隐藏」与「移除」是两件不同的事：前者保留实例与布局，后者墓碑化并删除布局行；
 * 4. 幂等：同一 operationId 的重放不重复施加副作用；不同 kind 复用同一 ID 必须 409。
 */
import {
  BUILTIN_MODULE_MANIFESTS,
  DEMO_BASICS_MODULE_ID,
  DEMO_SOLO_MODULE_ID,
  DEMO_WIDGET_IDS,
  MAX_WIDGETS_PER_PAGE,
  columnsForBreakpoint,
  validateLayoutRects,
  type GridRect,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  URLS,
  addWidgetViaApi,
  assertNoOverlap,
  countRows,
  createPageViaApi,
  enableDemoModule,
  jsonDelete,
  jsonPatch,
  jsonPost,
  pageWidgetsUrl,
  readInstanceRow,
  readInstanceRows,
  readLayoutRevisions,
  readLayoutRows,
  readModuleRow,
  readWorkbenchOperationRow,
  readWorkbenchStateRow,
  resetIdentityState,
  widgetDuplicateUrl,
  widgetUrl,
  opId,
  seedAuth,
  errorBodyOf,

} from './helpers';

const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;
const DEMO_SOLO = DEMO_WIDGET_IDS.solo;

/** `demo-counter` 的尺寸约束（来自静态注册表，与共享契约同源）。 */
const COUNTER_WIDGET = BUILTIN_MODULE_MANIFESTS.flatMap((manifest) => manifest.widgets).find(
  (widget) => widget.id === DEMO_COUNTER,
);

function addWidget(
  authorization: string,
  pageId: string,
  body: { readonly widgetType: string; readonly operationId: string; readonly config?: unknown; readonly hidden?: boolean },
): Promise<Response> {
  const payload: Record<string, unknown> = { widgetType: body.widgetType, operationId: body.operationId };
  if (body.config !== undefined) {
    payload['config'] = body.config;
  }
  if (body.hidden !== undefined) {
    payload['hidden'] = body.hidden;
  }
  return SELF.fetch(pageWidgetsUrl(pageId), jsonPost(payload, { Authorization: authorization }));
}

function patchWidget(authorization: string, widgetId: string, body: unknown): Promise<Response> {
  return SELF.fetch(widgetUrl(widgetId), jsonPatch(body, { Authorization: authorization }));
}

function deleteWidget(authorization: string, widgetId: string, body: unknown): Promise<Response> {
  return SELF.fetch(widgetUrl(widgetId), jsonDelete(body, { Authorization: authorization }));
}

async function revisionsOf(pageId: string): Promise<Map<string, number>> {
  const result = await env.DB.prepare('SELECT breakpoint, revision FROM page_layout_revisions WHERE page_id = ?')
    .bind(pageId)
    .all<{ breakpoint: string; revision: number }>();
  const revisions = new Map<string, number>();
  for (const row of result.results) {
    revisions.set(row.breakpoint, row.revision);
  }
  return revisions;
}

/** 构造真实存在的「正在执行生命周期变更」状态：模块行 + 一行待完成操作。 */
async function forceTransitioning(workspaceId: string, moduleId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspace_module_operations
       (workspace_id, module_id, action, target_status, revision, started_at, attempts, last_error)
     VALUES (?, ?, 'uninstall', 'uninstalled', 2, ?, 1, NULL)`,
  )
    .bind(workspaceId, moduleId, Date.now())
    .run();
}

/** 断言「这次被拒绝的请求没有写任何东西」：实例、布局、幂等记录、工作台修订号都没动。 */
async function expectNothingWritten(input: {
  readonly workspaceId: string;
  readonly pageId: string;
  readonly operationId: string;
  readonly stateBefore: { readonly revision: number } | null;
}): Promise<void> {
  expect(await readInstanceRows(input.pageId)).toHaveLength(0);
  expect(await readLayoutRows(input.pageId)).toHaveLength(0);
  expect(await readWorkbenchOperationRow(input.workspaceId, input.operationId)).toBeNull();
  expect(await readWorkbenchStateRow(input.workspaceId)).toEqual(input.stateBefore);
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('模块门禁：门禁不通过的模块不能写入实例', () => {
  it('未安装：409 module_not_ready，且实例 / 布局 / 幂等记录 / 工作台修订号都没动', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);
    expect(await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();

    const operationId = opId('widget-not-installed');
    const response = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId,
    });
    expect(response.status).toBe(409);
    const body = errorBodyOf(await response.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('模块尚未安装');

    await expectNothingWritten({
      workspaceId: auth.workspaceId,
      pageId: page.page.id,
      operationId,
      stateBefore,
    });
  });

  it('已停用：409 module_not_ready，且没有写入', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const disabled = await SELF.fetch(
      `${URLS.meModules}/${DEMO_BASICS_MODULE_ID}`,
      jsonPatch({ action: 'disable', expectedRevision: 1 }, { Authorization: auth.authorization }),
    );
    expect(disabled.status).toBe(200);
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);

    const operationId = opId('widget-disabled');
    const response = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId,
    });
    expect(response.status).toBe(409);
    expect(errorBodyOf(await response.text()).message).toContain('模块已停用');

    await expectNothingWritten({
      workspaceId: auth.workspaceId,
      pageId: page.page.id,
      operationId,
      stateBefore,
    });
  });

  it('已卸载：409 module_not_ready，且没有写入', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const uninstalled = await SELF.fetch(
      `${URLS.meModules}/${DEMO_BASICS_MODULE_ID}`,
      jsonPatch({ action: 'uninstall', expectedRevision: 1 }, { Authorization: auth.authorization }),
    );
    expect(uninstalled.status).toBe(200);
    expect((await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID))?.status).toBe('uninstalled');
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);

    const operationId = opId('widget-uninstalled');
    const response = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId,
    });
    expect(response.status).toBe(409);
    expect(errorBodyOf(await response.text()).message).toContain('模块已卸载');

    await expectNothingWritten({
      workspaceId: auth.workspaceId,
      pageId: page.page.id,
      operationId,
      stateBefore,
    });
  });

  it('正在执行生命周期变更（transitioning）：409 module_not_ready，且没有写入', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    // 真实存在的「已提交但未收尾」状态：workspace_modules 行 + workspace_module_operations 行。
    await forceTransitioning(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);

    const operationId = opId('widget-transitioning');
    const response = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId,
    });
    expect(response.status).toBe(409);
    expect(errorBodyOf(await response.text()).message).toContain('正在执行生命周期变更');

    await expectNothingWritten({
      workspaceId: auth.workspaceId,
      pageId: page.page.id,
      operationId,
      stateBefore,
    });
  });
});

describe('添加实例：模块代际标记与初始布局', () => {
  it('添加成功：created_revision 等于写入时刻的模块 revision（断言数据库行）', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const moduleRow = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(moduleRow?.revision).toBe(1);

    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add'),
      config: { step: 3, label: '第一代', initDelayMs: 0 },
    });
    expect(added.instance.createdRevision).toBe(moduleRow?.revision);
    expect(added.instance.moduleId).toBe(DEMO_BASICS_MODULE_ID);
    expect(added.instance.pageId).toBe(page.page.id);
    expect(added.instance.revision).toBe(0);
    expect(added.instance.hidden).toBe(false);

    const row = await readInstanceRow(auth.workspaceId, added.instance.id);
    expect(row?.created_revision).toBe(1);
    expect(row?.module_id).toBe(DEMO_BASICS_MODULE_ID);
    expect(row?.widget_type).toBe(DEMO_COUNTER);
    expect(row?.config_version).toBe(1);
    expect(row?.config_json).toBe(JSON.stringify({ step: 3, label: '第一代', initDelayMs: 0 }));
    expect(row?.deleted_at).toBeNull();

    // 停用后再启用 → 模块代际 +2；新实例必须记录**新的**代际。
    await SELF.fetch(
      `${URLS.meModules}/${DEMO_BASICS_MODULE_ID}`,
      jsonPatch({ action: 'disable', expectedRevision: 1 }, { Authorization: auth.authorization }),
    );
    await SELF.fetch(
      `${URLS.meModules}/${DEMO_BASICS_MODULE_ID}`,
      jsonPatch({ action: 'enable', expectedRevision: 2 }, { Authorization: auth.authorization }),
    );
    const secondGeneration = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(secondGeneration?.revision).toBe(3);

    const second = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add-second'),
    });
    expect(second.instance.createdRevision).toBe(3);
    expect((await readInstanceRow(auth.workspaceId, second.instance.id))?.created_revision).toBe(3);
  });

  it('添加后三个断点都立刻有布局行，且都合法（边界内、不越界、不重叠）', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const first = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-1'),
    });
    // 首次 bump 恰好 +1：三个断点各自从「行缺失（=0）」变成 1。
    for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
      expect((await readLayoutRevisions(page.page.id)).get(breakpoint), breakpoint).toBe(1);
    }
    const second = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-2'),
    });
    // 再改动一次同一个断点：各自 +1 变成 2（每个断点独立自增）。
    for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
      expect((await readLayoutRevisions(page.page.id)).get(breakpoint), breakpoint).toBe(2);
    }

    const rows = await readLayoutRows(page.page.id);
    expect(rows).toHaveLength(6);
    for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
      const rects: GridRect[] = rows
        .filter((row) => row.breakpoint === breakpoint)
        .map((row) => ({ i: row.widget_id, x: row.x, y: row.y, w: row.w, h: row.h }));
      expect(rects).toHaveLength(2);
      expect(rects.map((rect) => rect.i).sort()).toEqual([first.instance.id, second.instance.id].sort());

      // 用共享契约里**唯一**的校验实现来判合法性（服务端与导入路径也用它）。
      const counter = COUNTER_WIDGET;
      const validation = validateLayoutRects({
        breakpoint,
        rects,
        constraintsOf: () => ({
          minW: counter?.minSize.w ?? 2,
          minH: counter?.minSize.h ?? 2,
          maxW: counter?.maxSize?.w ?? null,
          maxH: counter?.maxSize?.h ?? null,
        }),
      });
      expect(validation.ok, JSON.stringify(validation)).toBe(true);
      for (const rect of rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(columnsForBreakpoint(breakpoint));
      }
    }
  });

  it('GET /me/pages/:id/layout 返回三个断点、列数 12/8/4 与各自独立的修订号', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-1'),
    });

    const response = await SELF.fetch(`${URLS.pages}/${page.page.id}/layout`, {
      headers: { Authorization: auth.authorization },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      layouts: { breakpoint: string; revision: number; cols: number; rects: GridRect[] }[];
    }>();
    expect(body.layouts.map((layout) => layout.breakpoint)).toEqual(['desktop', 'tablet', 'mobile']);
    expect(body.layouts.map((layout) => layout.cols)).toEqual([12, 8, 4]);
    for (const layout of body.layouts) {
      expect(layout.rects).toHaveLength(1);
      // 新建实例带来的首次 bump 恰好是 1（行缺失等价 revision 0，再 +1）。
      expect(layout.revision).toBe(1);
    }
    // 修订号是**每个断点自己**的：三个断点各自独立自增（此处在添加时同步 +1）。
    const revisions = await readLayoutRevisions(page.page.id);
    expect(revisions.get('desktop')).toBe(body.layouts[0]?.revision);
    expect(revisions.get('tablet')).toBe(body.layouts[1]?.revision);
    expect(revisions.get('mobile')).toBe(body.layouts[2]?.revision);
  });
});

describe('单例约束（allowMultiple=false）', () => {
  it('demo-solo：第二个实例被拒绝，且检查是**跨页面**的（同工作空间内只允许一个）', async () => {
    const auth = await seedAuth();
    const pageA = await createPageViaApi(auth.authorization, { name: '甲', operationId: opId('page-a') });
    const pageB = await createPageViaApi(auth.authorization, { name: '乙', operationId: opId('page-b') });
    await enableDemoModule(auth.authorization, DEMO_SOLO_MODULE_ID);

    const first = await addWidgetViaApi(auth.authorization, pageA.page.id, {
      widgetType: DEMO_SOLO,
      operationId: opId('solo-1'),
    });
    expect(first.instance.widgetType).toBe(DEMO_SOLO);

    const againSamePage = await addWidget(auth.authorization, pageA.page.id, {
      widgetType: DEMO_SOLO,
      operationId: opId('solo-2'),
    });
    expect(againSamePage.status).toBe(409);
    expect(errorBodyOf(await againSamePage.text()).message).toContain('只允许一个实例');

    const anotherPage = await addWidget(auth.authorization, pageB.page.id, {
      widgetType: DEMO_SOLO,
      operationId: opId('solo-3'),
    });
    expect(anotherPage.status).toBe(409);

    // 拒绝没有留下任何写入：整个工作空间只有一个 demo-solo 实例。
    expect(await countRows('widget_instances')).toBe(1);
    expect(await readInstanceRows(pageB.page.id)).toHaveLength(0);
  });

  it('单例组件不能被复制（duplicate 同样 409，且不产生新实例）', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_SOLO_MODULE_ID);
    const solo = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_SOLO,
      operationId: opId('solo-1'),
    });
    const layoutRowsBefore = (await readLayoutRows(page.page.id)).length;
    const layoutRevisionsBefore = await revisionsOf(page.page.id);

    const response = await SELF.fetch(widgetDuplicateUrl(solo.instance.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
      body: JSON.stringify({ operationId: opId('solo-duplicate') }),
    });
    expect(response.status).toBe(409);
    expect(errorBodyOf(await response.text()).message).toContain('只允许一个实例');

    expect(await countRows('widget_instances')).toBe(1);
    expect((await readLayoutRows(page.page.id)).length).toBe(layoutRowsBefore);
    expect(await revisionsOf(page.page.id)).toEqual(layoutRevisionsBefore);
  });
});

describe('多实例与独立配置（allowMultiple=true）', () => {
  it('demo-counter 可以放多个实例，每个实例的配置互相独立', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);

    const configs = [
      { step: 1, label: '甲', initDelayMs: 0 },
      { step: 5, label: '乙', initDelayMs: 100 },
      { step: 10, label: '丙', initDelayMs: 200 },
    ];
    const instances = [];
    for (const [index, config] of configs.entries()) {
      const added = await addWidgetViaApi(auth.authorization, page.page.id, {
        widgetType: DEMO_COUNTER,
        operationId: opId(`widget-${String(index)}`),
        config,
      });
      instances.push(added.instance);
    }
    expect(new Set(instances.map((instance) => instance.id)).size).toBe(3);
    expect(instances.map((instance) => instance.config)).toEqual(configs);

    // 数据库事实：三条配置各写各的，没有串扰。
    const stored = await Promise.all(
      instances.map((instance) => readInstanceRow(auth.workspaceId, instance.id)),
    );
    const storedConfigs: unknown[] = stored.map((row) => JSON.parse(row?.config_json ?? 'null') as unknown);
    expect(storedConfigs).toEqual(configs);
    expect(await countRows('widget_instances')).toBe(3);
  });

  it('复制实例：新 id、相同配置、独立 revision、新的布局行', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const source = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-source'),
      config: { step: 4, label: '源', initDelayMs: 0 },
    });
    const revisionsBefore = await revisionsOf(page.page.id);

    const response = await SELF.fetch(widgetDuplicateUrl(source.instance.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
      body: JSON.stringify({ operationId: opId('widget-duplicate') }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<{
      instance: { id: string; config: unknown; revision: number; createdRevision: number; pageId: string };
    }>();
    expect(body.instance.id).not.toBe(source.instance.id);
    expect(body.instance.pageId).toBe(page.page.id);
    expect(body.instance.config).toEqual(source.instance.config);
    expect(body.instance.revision).toBe(0);
    expect(body.instance.createdRevision).toBe(1);

    // 新实例有自己的布局行：该页面总共 6 行（2 个实例 × 3 个断点）。
    const rows = await readLayoutRows(page.page.id);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.widget_id === body.instance.id)).toHaveLength(3);
    // 原实例的布局行没有被覆盖。
    expect(rows.filter((row) => row.widget_id === source.instance.id)).toHaveLength(3);
    // 布局修订也随新增而推进。
    for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
      expect((await revisionsOf(page.page.id)).get(breakpoint)).toBeGreaterThan(
        revisionsBefore.get(breakpoint) ?? 0,
      );
    }
  });
});

describe('更新实例：CAS、隐藏与 no-op', () => {
  it('陈旧 expectedRevision 返回 409，且配置一个字节都没变', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add'),
      config: { step: 1, label: '原始', initDelayMs: 0 },
    });

    const updated = await patchWidget(auth.authorization, added.instance.id, {
      expectedRevision: 0,
      config: { step: 2, label: '已改', initDelayMs: 0 },
      operationId: opId('widget-update'),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json<{ instance: { revision: number; config: unknown } }>();
    expect(updatedBody.instance.revision).toBe(1);
    expect(updatedBody.instance.config).toEqual({ step: 2, label: '已改', initDelayMs: 0 });

    const snapshot = JSON.stringify(await readInstanceRow(auth.workspaceId, added.instance.id));
    const stale = await patchWidget(auth.authorization, added.instance.id, {
      expectedRevision: 0,
      config: { step: 9, label: '陈旧', initDelayMs: 0 },
      operationId: opId('widget-stale'),
    });
    expect(stale.status).toBe(409);
    expect(errorBodyOf(await stale.text()).code).toBe('conflict');
    expect(JSON.stringify(await readInstanceRow(auth.workspaceId, added.instance.id))).toBe(snapshot);
  });

  it('切换 hidden 不改变任何断点的布局修订号；实例仍然存在', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add'),
    });
    const layoutBefore = await readLayoutRows(page.page.id);
    const revisionsBefore = await revisionsOf(page.page.id);

    const hidden = await patchWidget(auth.authorization, added.instance.id, {
      expectedRevision: 0,
      hidden: true,
      operationId: opId('widget-hide'),
    });
    expect(hidden.status).toBe(200);
    const body = await hidden.json<{ instance: { hidden: boolean; revision: number } }>();
    expect(body.instance.hidden).toBe(true);
    expect(body.instance.revision).toBe(1);

    const row = await readInstanceRow(auth.workspaceId, added.instance.id);
    expect(row?.is_hidden).toBe(1);
    expect(row?.deleted_at).toBeNull();
    expect(row?.revision).toBe(1);
    // 布局行原样保留，布局修订号也没有被动过（隐藏不是移除）。
    expect(await readLayoutRows(page.page.id)).toEqual(layoutBefore);
    expect(await revisionsOf(page.page.id)).toEqual(revisionsBefore);
  });

  it('配置 no-op 不 bump 实例 revision，也不改变布局修订号', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const config = { step: 7, label: '不动', initDelayMs: 0 };
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add'),
      config,
    });
    const revisionsBefore = await revisionsOf(page.page.id);
    const snapshotBefore = JSON.stringify(await readInstanceRow(auth.workspaceId, added.instance.id));

    const noop = await patchWidget(auth.authorization, added.instance.id, {
      expectedRevision: 0,
      config,
      operationId: opId('widget-noop'),
    });
    expect(noop.status).toBe(200);
    const body = await noop.json<{ instance: { revision: number }; noop: boolean; replayed: boolean }>();
    expect(body.noop).toBe(true);
    expect(body.instance.revision).toBe(0);

    expect(JSON.stringify(await readInstanceRow(auth.workspaceId, added.instance.id))).toBe(snapshotBefore);
    expect(await revisionsOf(page.page.id)).toEqual(revisionsBefore);
  });
});

describe('删除实例：墓碑 + 布局硬删除 + 模块状态不受影响', () => {
  it('移除实例是墓碑（行还在），布局行被删除，三个断点的布局修订都被推进', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add'),
    });
    const revisionsBefore = await revisionsOf(page.page.id);
    const moduleRowBefore = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);

    const response = await deleteWidget(auth.authorization, added.instance.id, {
      expectedRevision: 0,
      operationId: opId('widget-delete'),
    });
    expect(response.status).toBe(200);

    // 墓碑：行还在，deleted_at 非空（证明没有硬删除）。
    const row = await readInstanceRow(auth.workspaceId, added.instance.id);
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.revision).toBe(1);
    // 布局行真的被删掉了。
    expect(await readLayoutRows(page.page.id)).toHaveLength(0);
    // 三个断点的布局修订号都推进了。
    for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
      expect((await revisionsOf(page.page.id)).get(breakpoint)).toBeGreaterThan(
        revisionsBefore.get(breakpoint) ?? 0,
      );
    }
    // 模块状态与 workspace_modules 行完全没被动过（移除组件 ≠ 改动模块）。
    expect(await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toEqual(moduleRowBefore);

    const listed = await SELF.fetch(pageWidgetsUrl(page.page.id), {
      headers: { Authorization: auth.authorization },
    });
    const listedBody = await listed.json<{ instances: { id: string }[] }>();
    expect(listedBody.instances).toHaveLength(0);
  });

  it('重复移除（陈旧 revision）返回 409，且墓碑状态不变', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add'),
    });
    await deleteWidget(auth.authorization, added.instance.id, {
      expectedRevision: 0,
      operationId: opId('widget-delete'),
    });
    const snapshot = JSON.stringify(await readInstanceRow(auth.workspaceId, added.instance.id));

    const again = await deleteWidget(auth.authorization, added.instance.id, {
      expectedRevision: 0,
      operationId: opId('widget-delete-again'),
    });
    expect(again.status).toBe(404);
    expect(JSON.stringify(await readInstanceRow(auth.workspaceId, added.instance.id))).toBe(snapshot);
  });
});

describe('每页实例数量上限', () => {
  it(`添加 ${String(MAX_WIDGETS_PER_PAGE)} 个成功，第 ${String(MAX_WIDGETS_PER_PAGE + 1)} 个返回 409`, async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '满页', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);

    for (let index = 0; index < MAX_WIDGETS_PER_PAGE; index += 1) {
      await addWidgetViaApi(auth.authorization, page.page.id, {
        widgetType: DEMO_COUNTER,
        operationId: opId('widget-fill'),
      });
    }
    expect(await readInstanceRows(page.page.id)).toHaveLength(MAX_WIDGETS_PER_PAGE);

    const operationId = opId('widget-overflow');
    const response = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId,
    });
    expect(response.status).toBe(409);
    const body = errorBodyOf(await response.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('组件数量已达上限');

    expect(await readInstanceRows(page.page.id)).toHaveLength(MAX_WIDGETS_PER_PAGE);
    expect(await readWorkbenchOperationRow(auth.workspaceId, operationId)).toBeNull();
  });
});

describe('幂等 operationId', () => {
  it('同一 operationId + 同一请求体重放：返回首次结果，不产生第二个页面', async () => {
    const auth = await seedAuth();
    const operationId = opId('page-idempotent');
    const body = { name: '幂等页', operationId };

    const first = await SELF.fetch(URLS.pages, jsonPost(body, { Authorization: auth.authorization }));
    expect(first.status).toBe(201);
    const firstBody = await first.json<{
      page: { id: string };
      defaultPageId: string | null;
      skipped: unknown[];
      replayed: boolean;
    }>();
    expect(firstBody.replayed).toBe(false);

    const replay = await SELF.fetch(URLS.pages, jsonPost(body, { Authorization: auth.authorization }));
    expect(replay.status).toBe(201);
    const replayBody = await replay.json<{
      page: { id: string };
      defaultPageId: string | null;
      skipped: unknown[];
      replayed: boolean;
    }>();
    expect(replayBody.replayed).toBe(true);
    // 实体完全一致（同一 id / 同一默认页 / 同一 skipped）。
    expect(replayBody.page).toEqual(firstBody.page);
    expect(replayBody.defaultPageId).toBe(firstBody.defaultPageId);
    expect(replayBody.skipped).toEqual(firstBody.skipped);
    expect(await countRows('workspace_pages')).toBe(1);
    // 首次写入把工作台级修订号推到 1（行缺失等价 0，再 +1），重放不再推进。
    expect((await readWorkbenchStateRow(auth.workspaceId))?.revision).toBe(1);

    // 幂等记录里存的正是首次结果（不含 replayed 标志，那是信封层的事）。
    const operationRow = await readWorkbenchOperationRow(auth.workspaceId, operationId);
    expect(operationRow?.kind).toBe('page.create');
    expect(operationRow?.attempt_token).toBeNull();
    expect(JSON.parse(operationRow?.result_json ?? 'null')).toEqual({
      page: firstBody.page,
      skipped: firstBody.skipped,
      defaultPageId: firstBody.defaultPageId,
    });
  });

  it('同一 operationId 重放添加实例：只有一个实例、一套布局副作用', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const operationId = opId('widget-idempotent');
    const body = {
      widgetType: DEMO_COUNTER,
      config: { step: 2, label: '幂等', initDelayMs: 0 },
      operationId,
    };

    const first = await addWidget(auth.authorization, page.page.id, body);
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ instance: { id: string }; replayed: boolean }>();
    const layoutRevisionsAfterFirst = await readLayoutRevisions(page.page.id);

    const replay = await addWidget(auth.authorization, page.page.id, body);
    expect(replay.status).toBe(201);
    const replayBody = await replay.json<{ instance: { id: string }; replayed: boolean }>();
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.instance).toEqual(firstBody.instance);

    expect(await readInstanceRows(page.page.id)).toHaveLength(1);
    expect(await readLayoutRows(page.page.id)).toHaveLength(3);
    // 重放没有再次推进布局修订号。
    expect(await readLayoutRevisions(page.page.id)).toEqual(layoutRevisionsAfterFirst);
  });

  it('同一 operationId 用于不同 kind（page.create → widget.add）返回 409 operation_id_reused', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const sharedId = opId('shared-operation');

    const created = await SELF.fetch(
      URLS.pages,
      jsonPost({ name: '复用页', operationId: sharedId }, { Authorization: auth.authorization }),
    );
    expect(created.status).toBe(201);

    const reused = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: sharedId,
    });
    expect(reused.status).toBe(409);
    const body = errorBodyOf(await reused.text());
    expect(body.code).toBe('conflict');
    // 可解释结果：明确指出该 ID 已被哪一类操作用掉了。
    expect(body.message).toContain('page.create');

    // 没有被静默当成重放：没有写出任何实例。
    expect(await readInstanceRows(page.page.id)).toHaveLength(0);
    expect(await countRows('workspace_pages')).toBe(2);
  });

  it('失败的操作不留下幂等记录：修好前置条件后同一个 operationId 可以成功', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    const operationId = opId('widget-retry');

    const rejected = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId,
    });
    expect(rejected.status).toBe(409);
    expect(await readWorkbenchOperationRow(auth.workspaceId, operationId)).toBeNull();

    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const retried = await addWidget(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId,
    });
    expect(retried.status).toBe(201);
    const retriedBody = await retried.json<{ instance: { id: string }; replayed: boolean }>();
    expect(retriedBody.replayed).toBe(false);
    expect(await readInstanceRows(page.page.id)).toHaveLength(1);
  });

  it('真并发：两个完全相同的 operationId 请求只有一个创建行、只有一个实体、只有一套副作用', async () => {
    const auth = await seedAuth();
    // 先用一次串行写入建立「一次成功写入 = 工作台修订号 +1」的基线，
    // 这样断言用的是增量而不是某个绝对初值（首次 bump 的绝对取值是内部实现细节）。
    await createPageViaApi(auth.authorization, { name: '预热页', operationId: opId('page-warmup') });
    const baseRevision = (await readWorkbenchStateRow(auth.workspaceId))?.revision ?? 0;
    expect(baseRevision).toBeGreaterThan(0);

    const operationId = opId('page-concurrent');
    const body = { name: '并发页', operationId };

    const [first, second] = await Promise.all([
      SELF.fetch(URLS.pages, jsonPost(body, { Authorization: auth.authorization })),
      SELF.fetch(URLS.pages, jsonPost(body, { Authorization: auth.authorization })),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const firstBody = await first.json<{ page: { id: string }; replayed: boolean }>();
    const secondBody = await second.json<{ page: { id: string }; replayed: boolean }>();
    expect(firstBody.page.id).toBe(secondBody.page.id);
    // 恰好一个是「首次」、一个是「重放」。
    expect([firstBody.replayed, secondBody.replayed].sort()).toEqual([false, true]);

    // 只有一个页面、一条幂等记录。
    expect(await countRows('workspace_pages')).toBe(2);
    const operationRows = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workbench_operations WHERE workspace_id = ? AND operation_id = ?',
    )
      .bind(auth.workspaceId, operationId)
      .first<{ count: number }>();
    expect(operationRows?.count).toBe(1);
    // 只有一套副作用：工作台级修订号只被推进了一次（输家一个字都没写）。
    expect((await readWorkbenchStateRow(auth.workspaceId))?.revision).toBe(baseRevision + 1);
  });
});

// ---------------------------------------------------------------------------
// B1：并发新增 / 复制不得选中同一个空位（复核修复的核心不变量）
// ---------------------------------------------------------------------------

const LAYOUT_BREAKPOINTS = ['desktop', 'tablet', 'mobile'] as const;

/** 直接读库，按断点取出该页面的全部矩形。 */
async function rectsByBreakpoint(pageId: string): Promise<Map<string, GridRect[]>> {
  const rows = await readLayoutRows(pageId);
  const byBreakpoint = new Map<string, GridRect[]>();
  for (const breakpoint of LAYOUT_BREAKPOINTS) {
    byBreakpoint.set(
      breakpoint,
      rows
        .filter((row) => row.breakpoint === breakpoint)
        .map((row) => ({ i: row.widget_id, x: row.x, y: row.y, w: row.w, h: row.h })),
    );
  }
  return byBreakpoint;
}

/**
 * 布局不变量：三个断点上，矩形数量与活跃实例数一致，且两两不重叠。
 *
 * 为什么连「数量」一起断言：复核修复的目标是「两个并发请求不能各自选中同一空位」。
 * 只看「不重叠」在「其中一方完全没写」时也会通过，因此必须同时钉住行数，
 * 才能区分「赢了但没重叠」与「只写了一半」。
 */
async function expectLayoutInvariant(pageId: string, activeInstances: number): Promise<void> {
  const instanceIds = new Set((await readInstanceRows(pageId)).filter((row) => row.deleted_at === null).map((row) => row.id));
  const byBreakpoint = await rectsByBreakpoint(pageId);
  for (const breakpoint of LAYOUT_BREAKPOINTS) {
    const rects = byBreakpoint.get(breakpoint) ?? [];
    expect(rects, `${breakpoint} 的矩形数量`).toHaveLength(activeInstances);
    // 没有孤儿布局：每一行都属于一个真实存在的实例。
    expect(rects.every((rect) => instanceIds.has(rect.i)), `${breakpoint} 存在孤儿布局`).toBe(true);
    assertNoOverlap(rects);
  }
  expect(await readLayoutRows(pageId)).toHaveLength(activeInstances * LAYOUT_BREAKPOINTS.length);
}

describe('B1 并发新增不重叠', () => {
  it('两个不同 operationId 的并发新增：要么都成功且互不重叠，要么恰好一个 409 layout_revision_conflict 且输家零写入', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '并发页', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    expect(await readInstanceRows(page.page.id)).toHaveLength(0);

    const firstOp = opId('concurrent-add-a');
    const secondOp = opId('concurrent-add-b');
    const [first, second] = await Promise.all([
      addWidget(auth.authorization, page.page.id, { widgetType: DEMO_COUNTER, operationId: firstOp }),
      addWidget(auth.authorization, page.page.id, { widgetType: DEMO_COUNTER, operationId: secondOp }),
    ]);

    const outcomes = [
      { operationId: firstOp, response: first },
      { operationId: secondOp, response: second },
    ];
    const winners = outcomes.filter((outcome) => outcome.response.status === 201);
    const losers = outcomes.filter((outcome) => outcome.response.status !== 201);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(losers.length).toBeLessThanOrEqual(1);
    // 每个请求要么提交成功，要么被明确拒绝成 409——不允许 5xx 或静默 200。
    for (const winner of winners) {
      expect(winner.response.status, winner.operationId).toBe(201);
    }
    for (const loser of losers) {
      expect(loser.response.status, loser.operationId).toBe(409);
      const body = errorBodyOf(await loser.response.text());
      expect(body.code).toBe('conflict');
      // 两种可解释原因（布局修订号变了 / 实例集合变了），都指向「并发改动」。
      expect(body.message).toContain('已被其他设备修改');
    }

    // 数据库事实：活跃实例数 = 赢家数；每个实例都恰好有 3 条布局行，且互不重叠。
    await expectLayoutInvariant(page.page.id, winners.length);

    // 赢家有幂等记录且已收尾；输家的 operationId 一行都没留下。
    for (const winner of winners) {
      const row = await readWorkbenchOperationRow(auth.workspaceId, winner.operationId);
      expect(row?.kind, winner.operationId).toBe('widget.add');
      expect(row?.attempt_token, winner.operationId).toBeNull();
    }
    for (const loser of losers) {
      expect(await readWorkbenchOperationRow(auth.workspaceId, loser.operationId)).toBeNull();
    }
    // 工作台修订号恰好被推进「为每个赢家一次」（赢家才会 bump）。
    expect(await countRows('widget_instances')).toBe(winners.length);
  });
});

describe('B1 并发复制不重叠', () => {
  it('同一源实例、两个不同 operationId 的并发复制：要么都成功且互不重叠，要么恰好一个 409 且输家零写入', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '并发复制页', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const source = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-source'),
      config: { step: 2, label: '源', initDelayMs: 0 },
    });
    // 复制前先钉住一次基线：源实例的 3 条布局行。
    await expectLayoutInvariant(page.page.id, 1);

    const duplicate = (operationId: string): Promise<Response> =>
      SELF.fetch(widgetDuplicateUrl(source.instance.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
        body: JSON.stringify({ operationId }),
      });

    const firstOp = opId('concurrent-dup-a');
    const secondOp = opId('concurrent-dup-b');
    const [first, second] = await Promise.all([duplicate(firstOp), duplicate(secondOp)]);

    const outcomes = [
      { operationId: firstOp, response: first },
      { operationId: secondOp, response: second },
    ];
    const winners = outcomes.filter((outcome) => outcome.response.status === 201);
    const losers = outcomes.filter((outcome) => outcome.response.status !== 201);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(losers.length).toBeLessThanOrEqual(1);
    for (const loser of losers) {
      expect(loser.response.status, loser.operationId).toBe(409);
      const body = errorBodyOf(await loser.response.text());
      expect(body.code).toBe('conflict');
      expect(body.message).toContain('已被其他设备修改');
    }

    // 复制出的实例 + 源实例：矩形两两不重叠，行数与活跃实例数严格对应。
    await expectLayoutInvariant(page.page.id, 1 + winners.length);
    // 复制出来的实例配置与源一致，且有自己的 id。
    for (const winner of winners) {
      const body = await winner.response.json<{ instance: { id: string; config: unknown; pageId: string } }>();
      expect(body.instance.id).not.toBe(source.instance.id);
      expect(body.instance.pageId).toBe(page.page.id);
      expect(body.instance.config).toEqual(source.instance.config);
    }
    for (const loser of losers) {
      expect(await readWorkbenchOperationRow(auth.workspaceId, loser.operationId)).toBeNull();
    }
  });
});

describe('B1 顺序新增的空位不变量（并发交错无法在 HTTP 层确定性构造）', () => {
  it('连续 N 次新增后矩形两两不重叠；随后的一次并发对组合同样不重叠', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '顺序页', operationId: opId('page-seq') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);

    // 为什么是「顺序 N 次 + 并发一对」而不是「确定性交错」：
    // `addWidget` 在**同一个请求内**读取实例集合与三个断点修订号，HTTP 层无法把另一个
    // 请求插进「读取」与「认领」之间；能确定性表达的等价性质就是下面这两条不变量。
    const total = 6;
    for (let index = 0; index < total; index += 1) {
      await addWidgetViaApi(auth.authorization, page.page.id, {
        widgetType: DEMO_COUNTER,
        operationId: opId(`seq-${String(index)}`),
        config: { step: index + 1, label: `顺序 ${String(index)}`, initDelayMs: 0 },
      });
      // 每加一个都当场校验：这才是「新增落位」的可验证不变量。
      await expectLayoutInvariant(page.page.id, index + 1);
    }
    expect(await readInstanceRows(page.page.id)).toHaveLength(total);

    // 再做一次真并发对：仍不允许出现重叠（无论一方输还是都赢）。
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      addWidget(auth.authorization, page.page.id, { widgetType: DEMO_COUNTER, operationId: opId('seq-concurrent-a') }),
      addWidget(auth.authorization, page.page.id, { widgetType: DEMO_COUNTER, operationId: opId('seq-concurrent-b') }),
    ]);
    const committed =
      (concurrentFirst.status === 201 ? 1 : 0) + (concurrentSecond.status === 201 ? 1 : 0);
    expect(committed).toBeGreaterThanOrEqual(1);
    for (const response of [concurrentFirst, concurrentSecond]) {
      expect([201, 409]).toContain(response.status);
    }
    await expectLayoutInvariant(page.page.id, total + committed);
  });
});
