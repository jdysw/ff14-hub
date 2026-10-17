/**
 * 工作台布局与**独立断点**集成测试（HUB-045 / HUB-046，ADR-010）。
 *
 * 立场：
 * - 三个断点（桌面 12 / 平板 8 / 手机 4 列）各有**独立**修订号；一端保存不得让另一端
 *   的在途保存变成 409。这一点必须用「先用桌面保存，再用平板自己的 baseRevision 保存成功」证明。
 * - 保存是**整页替换**：必须恰好覆盖该页面的全部活跃实例，不接受部分提交
 *   （否则会出现「有实例没位置」的半状态）。
 * - 服务端只拒绝非法输入，**绝不**自动纠偏；每次拒绝都要断言存储的矩形与修订号一字未动。
 */
import {
  BUILTIN_MODULE_MANIFESTS,
  DEMO_BASICS_MODULE_ID,
  DEMO_WIDGET_IDS,
  MAX_LAYOUT_Y,
  WORKBENCH_MESSAGES,
  columnsForBreakpoint,
  validateLayoutRects,
  type GridRect,
} from '@ff14-hub/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addWidgetViaApi,
  createPageViaApi,
  enableDemoModule,
  readLayoutRevisions,
  readLayoutRows,
  readLayoutsViaApi,
  readPageRows,
  readWorkbenchOperationRow,
  resetIdentityState,
  saveLayoutRequest,
  seedWorkspaceWithDevice,
} from './helpers';

const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;

let operationCounter = 0;

function opId(label: string): string {
  operationCounter += 1;
  return `op-${label}-${String(operationCounter).padStart(4, '0')}`;
}

interface AuthedWorkspace {
  readonly workspaceId: string;
  readonly authorization: string;
}

async function seedAuth(): Promise<AuthedWorkspace> {
  const { workspace, device } = await seedWorkspaceWithDevice();
  return { workspaceId: workspace.workspaceId, authorization: device.authorization };
}

function errorBodyOf(text: string): { code: string; message: string } {
  return JSON.parse(text) as { code: string; message: string };
}

function rect(widgetId: string, overrides: Partial<Omit<GridRect, 'i'>> = {}): GridRect {
  return { i: widgetId, x: 0, y: 0, w: 4, h: 3, ...overrides };
}

function revisionMap(pageId: string): Promise<Record<string, number>> {
  return readLayoutRevisions(pageId).then((map) => Object.fromEntries(map.entries()));
}

/** 读取三个断点的布局（断点 → 修订号 / 列数 / 矩形）。 */
async function layoutOf(
  pageId: string,
  authorization: string,
): Promise<Map<string, { revision: number; cols: number; rects: GridRect[] }>> {
  const layouts = await readLayoutsViaApi(authorization, pageId);
  return new Map(
    layouts.map((layout) => [layout.breakpoint, { revision: layout.revision, cols: layout.cols, rects: [...layout.rects] }]),
  );
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('断点独立（ADR-010）', () => {
  it('GET 布局返回三个断点与 12/8/4 列；保存桌面后平板/手机的修订号不受影响', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });

    const before = await layoutOf(page.page.id, auth.authorization);
    expect([...before.keys()]).toEqual(['desktop', 'tablet', 'mobile']);
    expect(before.get('desktop')?.cols).toBe(12);
    expect(before.get('tablet')?.cols).toBe(8);
    expect(before.get('mobile')?.cols).toBe(4);
    const desktopRevision = before.get('desktop')?.revision ?? -1;
    const tabletRevision = before.get('tablet')?.revision ?? -1;
    const mobileRevision = before.get('mobile')?.revision ?? -1;
    expect(desktopRevision).toBeGreaterThan(0);

    // 保存桌面。
    const savedDesktop = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopRevision,
      rects: [rect(added.instance.id, { x: 4, y: 0 })],
      operationId: opId('layout-desktop'),
    });
    expect(savedDesktop.status).toBe(200);
    const desktopBody = await savedDesktop.json<{
      layout: { breakpoint: string; revision: number; cols: number; rects: GridRect[] };
      replayed: boolean;
    }>();
    expect(desktopBody.layout.breakpoint).toBe('desktop');
    expect(desktopBody.layout.revision).toBe(desktopRevision + 1);
    expect(desktopBody.layout.cols).toBe(12);
    expect(desktopBody.layout.rects).toEqual([rect(added.instance.id, { x: 4, y: 0 })]);

    // 关键：平板用它**自己的** baseRevision 仍然能保存成功，且手机完全没被动过。
    const savedTablet = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'tablet',
      baseRevision: tabletRevision,
      rects: [rect(added.instance.id, { x: 0, y: 0, w: 8, h: 3 })],
      operationId: opId('layout-tablet'),
    });
    expect(savedTablet.status).toBe(200);
    const tabletBody = await savedTablet.json<{ layout: { revision: number } }>();
    expect(tabletBody.layout.revision).toBe(tabletRevision + 1);

    const after = await layoutOf(page.page.id, auth.authorization);
    expect(after.get('desktop')?.revision).toBe(desktopRevision + 1);
    expect(after.get('tablet')?.revision).toBe(tabletRevision + 1);
    expect(after.get('mobile')?.revision).toBe(mobileRevision);
    expect(after.get('desktop')?.rects).toEqual([rect(added.instance.id, { x: 4, y: 0 })]);
    expect(after.get('tablet')?.rects).toEqual([rect(added.instance.id, { x: 0, y: 0, w: 8, h: 3 })]);
  });

  it('陈旧 baseRevision 返回 409，且存储的矩形与修订号都没有变', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });

    const stale = await readLayoutRevisions(page.page.id).then((map) => map.get('desktop') ?? 0);
    const saved = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: stale,
      rects: [rect(added.instance.id, { x: 4, y: 0 })],
      operationId: opId('layout-ok'),
    });
    expect(saved.status).toBe(200);

    const rowsBefore = JSON.stringify(await readLayoutRows(page.page.id));
    const revisionsBefore = await revisionMap(page.page.id);

    const conflict = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: stale,
      rects: [rect(added.instance.id, { x: 0, y: 0 })],
      operationId: opId('layout-stale'),
    });
    expect(conflict.status).toBe(409);
    const body = errorBodyOf(await conflict.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain(WORKBENCH_MESSAGES.layout_revision_conflict);

    expect(JSON.stringify(await readLayoutRows(page.page.id))).toBe(rowsBefore);
    expect(await revisionMap(page.page.id)).toEqual(revisionsBefore);
  });

  it('真并发：两个客户端拿同一个 baseRevision 同时提交，恰好一个成功、另一个 409', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    const baseRevision = await readLayoutRevisions(page.page.id).then((map) => map.get('desktop') ?? 0);

    const left = rect(added.instance.id, { x: 0, y: 0 });
    const right = rect(added.instance.id, { x: 4, y: 0 });
    const [first, second] = await Promise.all([
      saveLayoutRequest(auth.authorization, page.page.id, {
        breakpoint: 'desktop',
        baseRevision,
        rects: [left],
        operationId: opId('layout-race-a'),
      }),
      saveLayoutRequest(auth.authorization, page.page.id, {
        breakpoint: 'desktop',
        baseRevision,
        rects: [right],
        operationId: opId('layout-race-b'),
      }),
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const winnerRect = first.status === 200 ? left : right;
    const stored = await readLayoutRows(page.page.id);
    expect(stored.filter((row) => row.breakpoint === 'desktop')).toHaveLength(1);
    expect(stored.find((row) => row.breakpoint === 'desktop')).toMatchObject({
      widget_id: winnerRect.i,
      x: winnerRect.x,
      y: winnerRect.y,
      w: winnerRect.w,
      h: winnerRect.h,
    });
    expect(await readLayoutRevisions(page.page.id).then((map) => map.get('desktop'))).toBe(baseRevision + 1);
  });
});

describe('整页保存的服务端校验（全部拒绝且不写入）', () => {
  it('x + w 超出列数、越界坐标、平板列数更小同样被拒绝', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    const rowsBefore = JSON.stringify(await readLayoutRows(page.page.id));
    const revisionsBefore = await revisionMap(page.page.id);
    const base = await readLayoutRevisions(page.page.id);

    const desktopOverflow = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: base.get('desktop') ?? 0,
      // 10 + 4 = 14 > 12 列
      rects: [rect(added.instance.id, { x: 10, y: 0 })],
      operationId: opId('layout-overflow'),
    });
    expect(desktopOverflow.status).toBe(422);
    const overflowBody = errorBodyOf(await desktopOverflow.text());
    expect(overflowBody.code).toBe('validation_failed');
    expect(overflowBody.message).toContain(WORKBENCH_MESSAGES.layout_invalid);
    expect(overflowBody.message).toContain('out_of_bounds');

    const tabletOverflow = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'tablet',
      baseRevision: base.get('tablet') ?? 0,
      // 6 + 4 = 10 > 8 列（同一份矩形在桌面上合法、在平板上越界）
      rects: [rect(added.instance.id, { x: 6, y: 0 })],
      operationId: opId('layout-tablet-overflow'),
    });
    expect(tabletOverflow.status).toBe(422);
    expect(errorBodyOf(await tabletOverflow.text()).message).toContain('out_of_bounds');

    expect(JSON.stringify(await readLayoutRows(page.page.id))).toBe(rowsBefore);
    expect(await revisionMap(page.page.id)).toEqual(revisionsBefore);
  });

  it('y + h 超过 MAX_LAYOUT_Y 被拒绝（防「无限往下堆」）', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    const rowsBefore = JSON.stringify(await readLayoutRows(page.page.id));
    const base = await readLayoutRevisions(page.page.id);

    const tooDeep = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: base.get('desktop') ?? 0,
      rects: [rect(added.instance.id, { x: 0, y: MAX_LAYOUT_Y, h: 3 })],
      operationId: opId('layout-too-deep'),
    });
    expect(tooDeep.status).toBe(422);
    expect(errorBodyOf(await tooDeep.text()).message).toContain('out_of_bounds');
    expect(JSON.stringify(await readLayoutRows(page.page.id))).toBe(rowsBefore);
  });

  it('尺寸小于组件 minSize、重叠、重复实例都被拒绝', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const firstInstance = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-1'),
    });
    const rowsBefore = JSON.stringify(await readLayoutRows(page.page.id));

    // 1) 同一实例在同一个断点出现两次：集合大小与活跃实例数相同（1），
    //    因此会走到矩形校验，命中 duplicate_widget。
    const duplicate = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: (await readLayoutRevisions(page.page.id)).get('desktop') ?? 0,
      rects: [rect(firstInstance.instance.id, { x: 0, y: 0 }), rect(firstInstance.instance.id, { x: 4, y: 0 })],
      operationId: opId('layout-duplicate'),
    });
    expect(duplicate.status).toBe(422);
    expect(errorBodyOf(await duplicate.text()).message).toContain('duplicate_widget');

    // 再放一个实例，用于验证「小于 minSize」与「重叠」。
    const secondInstance = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-2'),
    });
    const rowsBeforeTwo = JSON.stringify(await readLayoutRows(page.page.id));
    const revisionsBeforeTwo = await revisionMap(page.page.id);
    const desktopBase = (await readLayoutRevisions(page.page.id)).get('desktop') ?? 0;

    // 2) 小于 minSize（demo-counter 的最小尺寸是 2×2）。
    const belowMin = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(firstInstance.instance.id, { w: 1, h: 2 }), rect(secondInstance.instance.id, { x: 4, y: 0 })],
      operationId: opId('layout-below-min'),
    });
    expect(belowMin.status).toBe(422);
    expect(errorBodyOf(await belowMin.text()).message).toContain('size_below_min');

    // 3) 两个矩形重叠。
    const overlap = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(firstInstance.instance.id, { x: 0, y: 0 }), rect(secondInstance.instance.id, { x: 2, y: 1 })],
      operationId: opId('layout-overlap'),
    });
    expect(overlap.status).toBe(422);
    expect(errorBodyOf(await overlap.text()).message).toContain('overlap');

    // 每一次拒绝都没有写任何东西。
    expect(JSON.stringify(await readLayoutRows(page.page.id))).toBe(rowsBeforeTwo);
    expect(await revisionMap(page.page.id)).toEqual(revisionsBeforeTwo);
    expect(rowsBefore).toContain(firstInstance.instance.id);
  });

  it('部分提交（漏掉一个活跃实例）、别页实例、不存在的实例都被拒绝', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '甲页', operationId: opId('page-a') });
    const otherPage = await createPageViaApi(auth.authorization, { name: '乙页', operationId: opId('page-b') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const firstInstance = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-1'),
    });
    const secondInstance = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-2'),
    });
    const foreignInstance = await addWidgetViaApi(auth.authorization, otherPage.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-foreign'),
    });
    const rowsBefore = JSON.stringify(await readLayoutRows(page.page.id));
    const revisionsBefore = await revisionMap(page.page.id);
    const desktopBase = (await readLayoutRevisions(page.page.id)).get('desktop') ?? 0;

    // 1) 只提交一个实例（整页保存必须覆盖全部活跃实例）。
    const partial = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(firstInstance.instance.id)],
      operationId: opId('layout-partial'),
    });
    expect(partial.status).toBe(422);
    const partialBody = errorBodyOf(await partial.text());
    expect(partialBody.code).toBe('validation_failed');
    expect(partialBody.message).toContain('不能只提交一部分');

    // 2) 把**别页**的实例写进本页布局：集合大小不匹配，被「必须覆盖本页全部实例」挡下。
    const foreign = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(firstInstance.instance.id), rect(foreignInstance.instance.id, { x: 4, y: 0 })],
      operationId: opId('layout-foreign'),
    });
    expect(foreign.status).toBe(422);

    // 3) 引用了不存在的实例：同样被覆盖度校验挡下。
    const ghost = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(firstInstance.instance.id), rect('no-such-instance', { x: 4, y: 0 })],
      operationId: opId('layout-ghost'),
    });
    expect(ghost.status).toBe(422);

    expect(JSON.stringify(await readLayoutRows(page.page.id))).toBe(rowsBefore);
    expect(await revisionMap(page.page.id)).toEqual(revisionsBefore);
    // 别页实例的布局与本页的布局都一字未动（本页仍是 2 个实例 × 3 个断点）。
    expect(await readLayoutRows(otherPage.page.id)).toHaveLength(3);
    expect((await readLayoutRows(page.page.id)).filter((row) => row.widget_id === secondInstance.instance.id)).toHaveLength(3);
    expect(await readLayoutRows(page.page.id)).toHaveLength(6);
  });

  it('x / y 为负、h 超过网格契约上界都在 Schema 层被拒（422）', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    const rowsBefore = JSON.stringify(await readLayoutRows(page.page.id));
    const desktopBase = (await readLayoutRevisions(page.page.id)).get('desktop') ?? 0;

    const negativeX = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(added.instance.id, { x: -1 })],
      operationId: opId('layout-negative-x'),
    });
    expect(negativeX.status).toBe(422);

    const negativeY = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(added.instance.id, { y: -1 })],
      operationId: opId('layout-negative-y'),
    });
    expect(negativeY.status).toBe(422);

    // 内置组件都没有声明 maxSize；高度上界由网格契约（h ≤ 64，见 gridRectSchema）承担。
    const hugeHeight = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBase,
      rects: [rect(added.instance.id, { h: 65 })],
      operationId: opId('layout-huge-h'),
    });
    expect(hugeHeight.status).toBe(422);

    expect(JSON.stringify(await readLayoutRows(page.page.id))).toBe(rowsBefore);
  });

  it('内置演示组件没有声明 maxSize；maxSize 一旦声明，共享校验函数会拒绝超限尺寸', () => {
    for (const manifest of BUILTIN_MODULE_MANIFESTS) {
      for (const widget of manifest.widgets) {
        expect(widget.maxSize, `${widget.id} 不应声明 maxSize（没有依据的上限会限制用户）`).toBeUndefined();
      }
    }
    // 服务端与导入路径共用的判定实现：声明了 maxH 时，h 超限即为 size_above_max。
    const validation = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [{ i: 'w', x: 0, y: 0, w: 2, h: 3 }],
      constraintsOf: () => ({ minW: 2, minH: 2, maxW: 4, maxH: 2 }),
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.violations.map((violation) => violation.code)).toContain('size_above_max');
    }
  });
});

describe('空页面的整页保存', () => {
  it('没有任何实例的页面可以用 rects: [] 保存成功', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '空页面', operationId: opId('page') });

    const response = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: 0,
      rects: [],
      operationId: opId('layout-empty'),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ layout: { revision: number; cols: number; rects: GridRect[] } }>();
    expect(body.layout.revision).toBe(1);
    expect(body.layout.cols).toBe(columnsForBreakpoint('desktop'));
    expect(body.layout.rects).toEqual([]);

    // 空页面是合法状态：没有实例、也没有布局行，但修订号确实被推进了。
    expect(await readLayoutRows(page.page.id)).toHaveLength(0);
    expect(await readLayoutRevisions(page.page.id).then((map) => map.get('desktop'))).toBe(1);
  });

  it('空页面保存后，同一 operationId 的重放返回首次结果且不重复推进修订号', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '空页面', operationId: opId('page') });
    const operationId = opId('layout-empty');

    const first = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: 0,
      rects: [],
      operationId,
    });
    expect(first.status).toBe(200);
    expect((await first.json<{ layout: { revision: number } }>()).layout.revision).toBe(1);

    // 重放：同一个 operationId，且**沿用首次的 baseRevision（0）**。
    // 这是「响应丢失后客户端原样重试」的真实场景，也是幂等最该生效的场景：
    // 首次提交后服务端修订号已经变成 1，前置条件必然不再满足，
    // 因此幂等短路必须发生在**任何前置读取之前**（否则重试会被早退成 409，客户端永远拿不到首次结果）。
    const replay = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: 0,
      rects: [],
      operationId,
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json<{ replayed: boolean; layout: { revision: number } }>();
    expect(replayBody.replayed).toBe(true);
    // 返回的是**首次**结果（revision 1），而不是新写一次变成 2。
    expect(replayBody.layout.revision).toBe(1);
    expect(await readLayoutRevisions(page.page.id).then((map) => map.get('desktop'))).toBe(1);

    // 仍然照旧：陈旧 baseRevision 但**换一个** operationId（即一次新意图）必须 409，不得静默覆盖。
    const staleNewIntent = await saveLayoutRequest(auth.authorization, page.page.id, {
      breakpoint: 'desktop',
      baseRevision: 0,
      rects: [],
      operationId: opId('layout-stale-new-intent'),
    });
    expect(staleNewIntent.status).toBe(409);

    // 只有一条幂等记录，且只有一个页面。
    expect(await readPageRows(auth.workspaceId)).toHaveLength(1);
    const operationRow = await readWorkbenchOperationRow(auth.workspaceId, operationId);
    expect(operationRow?.kind).toBe('layout.save.desktop');
    expect(JSON.parse(operationRow?.result_json ?? 'null')).toMatchObject({ layout: { revision: 1, rects: [] } });
  });
});
