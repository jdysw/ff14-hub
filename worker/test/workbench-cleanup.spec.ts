/**
 * 模块生命周期 × 工作台跨页面集成测试（HUB-050 × HUB-045/046 验收）。
 *
 * 关键语义（规划规则 7，不得混淆）：
 * - **卸载** = 移除该模块在**所有页面**的实例 + 停止后台行为；**个人数据与设置保留**，
 *   因此 `workspace_modules` 行必须还在，`settings_json` 必须一字不变。
 * - **停用** 不动实例（`deleted_at` 仍为 null），实例仍然在列表里。
 * - **代际 fence**：清理 SQL 把「workspace + module + created_revision 上界」作为同一个原子条件，
 *   所以一个被取代的旧执行者删不掉 restore 之后创建的新实例。
 * - 清理与页面布局修订的联动：受影响页面的三个断点修订号必须被推进（客户端据此知道布局变了）。
 */
import { DEMO_BASICS_MODULE_ID, DEMO_SOLO_MODULE_ID, DEMO_WIDGET_IDS } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createModuleLifecycle } from '../modules/lifecycle/module-lifecycle';
import { createInMemoryScheduledTaskStore, createModuleScheduler } from '../modules/lifecycle/scheduler';
import { readModuleGateStatus } from '../modules/lifecycle/workspace-modules';
import type { ModuleSchedulerPort } from '../modules/ports';
import { builtinModuleRegistry } from '../modules/registry/builtin-modules';
import { createD1InstanceStore } from '../modules/workbench/instance-store';
import {
  URLS,
  addWidgetViaApi,
  countRows,
  createPageViaApi,
  enableDemoModule,
  jsonPost,
  pageWidgetsUrl,
  patchModule,
  readInstanceRow,
  readInstanceRows,
  readLayoutRevisions,
  readLayoutRows,
  readModuleOperationRow,
  readModuleRow,
  readModuleSettings,
  readPageRow,
  readPageRows,
  readWorkbenchStateRevision,
  resetIdentityState,
  seedWorkspaceWithDevice,
} from './helpers';

const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;
const DEMO_SOLO = DEMO_WIDGET_IDS.solo;
const BREAKPOINTS = ['desktop', 'tablet', 'mobile'] as const;

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

async function layoutRevisionSnapshot(pageIds: readonly string[]): Promise<Map<string, Map<string, number>>> {
  const snapshot = new Map<string, Map<string, number>>();
  for (const pageId of pageIds) {
    const revisions = await readLayoutRevisions(pageId);
    snapshot.set(pageId, new Map(revisions));
  }
  return snapshot;
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('卸载：跨页面清理实例与布局，但保留个人数据', () => {
  it('卸载 demo.basics 会墓碑化**所有页面**的实例、删除其布局行、推进页面布局修订，且设置行一字不变', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await enableDemoModule(auth.authorization, DEMO_SOLO_MODULE_ID);
    // 顺便写入一份模块设置，用来证明卸载不删个人数据。
    const withSettings = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      settings: { greeting: '卸载也要留着我', announce: true },
    });
    expect(withSettings.status).toBe(200);

    const pageA = await createPageViaApi(auth.authorization, { name: '甲页', operationId: opId('page-a') });
    const pageB = await createPageViaApi(auth.authorization, { name: '乙页', operationId: opId('page-b') });
    const pageC = await createPageViaApi(auth.authorization, { name: '丙页', operationId: opId('page-c') });
    const pages = [pageA.page.id, pageB.page.id, pageC.page.id];

    const counterA = await addWidgetViaApi(auth.authorization, pageA.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('counter-a'),
    });
    const solo = await addWidgetViaApi(auth.authorization, pageA.page.id, {
      widgetType: DEMO_SOLO,
      operationId: opId('solo-a'),
    });
    const counterB = await addWidgetViaApi(auth.authorization, pageB.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('counter-b'),
    });
    const counterC = await addWidgetViaApi(auth.authorization, pageC.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('counter-c'),
    });

    const revisionsBefore = await layoutRevisionSnapshot(pages);
    const settingsBefore = await readModuleSettings(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(settingsBefore).toMatchObject({ greeting: '卸载也要留着我', announce: true });

    const uninstall = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 2,
      action: 'uninstall',
    });
    expect(uninstall.status).toBe(200);
    const effect = await uninstall.json<{
      module: { status: string; pendingOperation: unknown };
      effect: { instancesRemoved: number; userDataRetained: boolean; pending: boolean };
    }>();
    expect(effect.module.status).toBe('uninstalled');
    expect(effect.module.pendingOperation).toBeNull();
    expect(effect.effect.instancesRemoved).toBe(3);
    expect(effect.effect.userDataRetained).toBe(true);
    expect(effect.effect.pending).toBe(false);

    // 1) 三个页面上的 demo.basics 实例全部墓碑化（不是硬删除）。
    for (const [label, pageId, instanceId] of [
      ['甲页', pageA.page.id, counterA.instance.id],
      ['乙页', pageB.page.id, counterB.instance.id],
      ['丙页', pageC.page.id, counterC.instance.id],
    ] as const) {
      const rows = await readInstanceRows(pageId);
      const target = rows.find((row) => row.id === instanceId);
      expect(target, label).not.toBeUndefined();
      expect(target?.deleted_at, label).not.toBeNull();
      expect(target?.module_id).toBe(DEMO_BASICS_MODULE_ID);
    }
    // 另一个模块的实例毫发无损（隐藏与布局都保留）。
    const soloRow = (await readInstanceRows(pageA.page.id)).find((row) => row.id === solo.instance.id);
    expect(soloRow?.deleted_at).toBeNull();
    expect(soloRow?.module_id).toBe(DEMO_SOLO_MODULE_ID);

    // 2) 布局行：basics 的被硬删除，solo 的保留。
    expect(await readLayoutRows(pageB.page.id)).toHaveLength(0);
    expect(await readLayoutRows(pageC.page.id)).toHaveLength(0);
    const pageALayouts = await readLayoutRows(pageA.page.id);
    expect(pageALayouts).toHaveLength(3);
    expect(pageALayouts.every((row) => row.widget_id === solo.instance.id)).toBe(true);

    // 3) 受影响页面的三个断点布局修订号都被推进（甲页的推进由 basics 实例触发）。
    for (const pageId of pages) {
      const before = revisionsBefore.get(pageId);
      const after = await readLayoutRevisions(pageId);
      for (const breakpoint of BREAKPOINTS) {
        expect(after.get(breakpoint), `${pageId}/${breakpoint}`).toBe((before?.get(breakpoint) ?? 0) + 1);
      }
    }

    // 4) 卸载 ≠ 清数据：模块行还在、设置一字不变、门禁是 uninstalled。
    const moduleRow = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(moduleRow?.status).toBe('uninstalled');
    expect(moduleRow?.uninstalled_at).not.toBeNull();
    const storedSettings: unknown = JSON.parse(moduleRow?.settings_json ?? 'null');
    expect(storedSettings).toEqual(settingsBefore);
    expect(await readModuleSettings(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toEqual(settingsBefore);

    // 5) 列表接口里也只剩 solo 的实例。
    const listed = await SELF.fetch(pageWidgetsUrl(pageA.page.id), {
      headers: { Authorization: auth.authorization },
    });
    const listedBody = await listed.json<{ instances: { id: string }[] }>();
    expect(listedBody.instances.map((instance) => instance.id)).toEqual([solo.instance.id]);
  });

  it('停用（不是卸载）保留实例：deleted_at 仍为 null，实例仍然被列出', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });

    const disable = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'disable',
    });
    expect(disable.status).toBe(200);
    const body = await disable.json<{ effect: { instancesRemoved: number } }>();
    expect(body.effect.instancesRemoved).toBe(0);

    const row = (await readInstanceRows(page.page.id)).find((candidate) => candidate.id === added.instance.id);
    expect(row?.deleted_at).toBeNull();
    expect(await readLayoutRows(page.page.id)).toHaveLength(3);
    const listed = await SELF.fetch(pageWidgetsUrl(page.page.id), {
      headers: { Authorization: auth.authorization },
    });
    const listedBody = await listed.json<{ instances: { id: string }[] }>();
    expect(listedBody.instances.map((instance) => instance.id)).toEqual([added.instance.id]);
  });
});

describe('实例清理端口：三条件原子性与代际 fence', () => {
  it('旧执行者用旧 maxRevision 清理：删得掉旧代实例，绝不碰 restore 之后创建的新实例', async () => {
    const auth = await seedAuth();
    const store = createD1InstanceStore({ db: env.DB });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });

    // 第一代实例（模块 revision = 1）。
    const oldGeneration = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-old'),
    });
    expect(oldGeneration.instance.createdRevision).toBe(1);

    // 卸载（revision 2）：第一代实例被墓碑化。
    const uninstall = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'uninstall',
    });
    expect(uninstall.status).toBe(200);
    expect((await readInstanceRow(auth.workspaceId, oldGeneration.instance.id))?.deleted_at).not.toBeNull();

    // 恢复（revision 3）后新建第二代实例。
    const restore = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 2,
      action: 'restore',
    });
    expect(restore.status).toBe(200);
    const newGeneration = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-new'),
    });
    expect(newGeneration.instance.createdRevision).toBe(3);

    // 模拟一个被取代的旧执行者：它仍然拿着第 2 代（卸载时）的准入 revision。
    const staleResult = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 2,
    });
    expect(staleResult.removed).toBe(0);

    // 新代实例绝不能被删；旧代实例本来就是墓碑（状态不变）。
    const newRow = await readInstanceRow(auth.workspaceId, newGeneration.instance.id);
    expect(newRow?.deleted_at).toBeNull();
    expect(newRow?.created_revision).toBe(3);
    const oldRow = await readInstanceRow(auth.workspaceId, oldGeneration.instance.id);
    expect(oldRow?.deleted_at).not.toBeNull();
    const listed = await SELF.fetch(pageWidgetsUrl(page.page.id), {
      headers: { Authorization: auth.authorization },
    });
    const listedBody = await listed.json<{ instances: { id: string }[] }>();
    expect(listedBody.instances.map((instance) => instance.id)).toEqual([newGeneration.instance.id]);
  });

  it('旧执行者的上界之内仍有存活实例时会被清掉（证明 fence 条件真的在起作用）', async () => {
    const auth = await seedAuth();
    const store = createD1InstanceStore({ db: env.DB });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    const instance = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    expect(instance.instance.createdRevision).toBe(1);

    const removed = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 1,
    });
    expect(removed.removed).toBe(1);
    expect((await readInstanceRow(auth.workspaceId, instance.instance.id))?.deleted_at).not.toBeNull();
    expect(await readLayoutRows(page.page.id)).toHaveLength(0);
    expect(await store.countInstancesForModule({ workspaceId: auth.workspaceId, moduleId: DEMO_BASICS_MODULE_ID })).toBe(0);
  });

  it('三个条件缺一不可：换了 workspaceId 或 moduleId 都删不到任何实例', async () => {
    const auth = await seedAuth();
    const other = await seedAuth();
    const store = createD1InstanceStore({ db: env.DB });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    const instance = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    expect(instance.instance.createdRevision).toBe(1);

    // 不同的 workspaceId：目标工作空间里没有该模块的实例 → 一个都删不掉。
    const wrongWorkspace = await store.removeInstancesForModule({
      workspaceId: other.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 99,
    });
    expect(wrongWorkspace.removed).toBe(0);
    expect((await readInstanceRow(auth.workspaceId, instance.instance.id))?.deleted_at).toBeNull();

    // 不同的 moduleId：别的模块的实例不受影响。
    const wrongModule = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: 'demo.solo',
      reason: 'module_uninstalled',
      maxRevision: 99,
    });
    expect(wrongModule.removed).toBe(0);
    expect((await readInstanceRow(auth.workspaceId, instance.instance.id))?.deleted_at).toBeNull();

    // 正确三条件：删除恰好 1 个。
    const correct = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 1,
    });
    expect(correct.removed).toBe(1);
  });

  it('countInstancesForModule 只统计活跃实例：墓碑与墓碑页面下的实例都不算', async () => {
    const auth = await seedAuth();
    const store = createD1InstanceStore({ db: env.DB });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    // 第一代实例（模块 revision = 1）。
    const firstGeneration = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-gen1'),
    });
    expect(firstGeneration.instance.createdRevision).toBe(1);

    // 换一代（停用 → 启用：revision 3），再放一个第二代实例。
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 1, action: 'disable' });
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 2, action: 'enable' });
    const secondGeneration = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-gen2'),
    });
    expect(secondGeneration.instance.createdRevision).toBe(3);
    expect(await store.countInstancesForModule({ workspaceId: auth.workspaceId, moduleId: DEMO_BASICS_MODULE_ID })).toBe(2);

    // 只清理第一代：墓碑掉的实例不能再被计数（1 而不是 2）。
    const removed = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 1,
    });
    expect(removed.removed).toBe(1);
    expect(await store.countInstancesForModule({ workspaceId: auth.workspaceId, moduleId: DEMO_BASICS_MODULE_ID })).toBe(1);
    expect((await readInstanceRow(auth.workspaceId, firstGeneration.instance.id))?.deleted_at).not.toBeNull();
    expect((await readInstanceRow(auth.workspaceId, secondGeneration.instance.id))?.deleted_at).toBeNull();

    // 页面被墓碑化时，其下实例（deleted_at 仍为空）也不算活跃实例。
    const deleted = await SELF.fetch(`${URLS.pages}/${page.page.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
      body: JSON.stringify({ expectedRevision: page.page.revision, operationId: opId('page-delete') }),
    });
    expect(deleted.status).toBe(200);
    expect((await readPageRow(auth.workspaceId, page.page.id))?.deleted_at).not.toBeNull();
    expect(await store.countInstancesForModule({ workspaceId: auth.workspaceId, moduleId: DEMO_BASICS_MODULE_ID })).toBe(0);
  });
});

describe('mid-transition：状态已提交但副作用未收尾时，工作台写入被门禁拒绝', () => {
  it('留下待完成操作的卸载之后，POST 实例返回 409 module_not_ready 且不写入', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });

    // 用真实生命周期服务触发一次「准入成功但收尾失败」的卸载：
    // 调度端口被注入故障，因此会留下 workspace_module_operations 行（诚实性：状态已提交）。
    const scheduledTasks = createInMemoryScheduledTaskStore();
    const management = createModuleScheduler({
      store: scheduledTasks,
      readModuleStatus: ({ workspaceId, moduleId }) => readModuleGateStatus(env.DB, workspaceId, moduleId),
    });
    const failingScheduler: ModuleSchedulerPort = {
      ...management,
      cancelAllForModule: () => Promise.reject(new Error('调度不可用')),
    };
    const lifecycle = createModuleLifecycle({
      db: env.DB,
      registry: builtinModuleRegistry,
      instanceStore: createD1InstanceStore({ db: env.DB }),
      scheduler: failingScheduler,
    });
    const outcome = await lifecycle.mutate({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.effect.pending).toBe(true);
      expect(outcome.module.status).toBe('uninstalled');
    }
    expect(await readModuleOperationRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).not.toBeNull();
    expect(await lifecycle.gateStatus(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toBe('transitioning');

    const operationId = opId('widget-blocked');
    const operationsBefore = await countRows('workbench_operations');
    const instancesBefore = await countRows('widget_instances');
    const response = await SELF.fetch(
      pageWidgetsUrl(page.page.id),
      jsonPost({ widgetType: DEMO_COUNTER, operationId }, { Authorization: auth.authorization }),
    );
    expect(response.status).toBe(409);
    const body = errorBodyOf(await response.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('正在执行生命周期变更');

    // 一个字节都没写。
    expect(await readInstanceRows(page.page.id)).toHaveLength(0);
    expect(await readLayoutRows(page.page.id)).toHaveLength(0);
    expect(await countRows('widget_instances')).toBe(instancesBefore);
    expect(await countRows('workbench_operations')).toBe(operationsBefore);
  });
});

// ---------------------------------------------------------------------------
// B6：清理必须**幂等**，且只推进「本次真正移除」的影响范围（复核修复 D17.6）
// ---------------------------------------------------------------------------

/** 「这些页面的三个断点 revision + 工作台 revision」的可比较快照。 */
async function cleanupRevisionSnapshot(pageIds: readonly string[], workspaceId: string): Promise<string> {
  const pages: Record<string, Record<string, number>> = {};
  for (const pageId of pageIds) {
    pages[pageId] = Object.fromEntries(await readLayoutRevisions(pageId));
  }
  return JSON.stringify({ pages, workbench: await readWorkbenchStateRevision(workspaceId) });
}

describe('B6 清理幂等：0 个新增墓碑就零 revision 变更，部分命中只推进被影响的页面', () => {
  it('卸载同一模块的两个页面：两个页面的三个断点各 +1、工作台 revision 恰好 +1', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const pageA = await createPageViaApi(auth.authorization, { name: '甲页', operationId: opId('b6-page-a') });
    const pageB = await createPageViaApi(auth.authorization, { name: '乙页', operationId: opId('b6-page-b') });
    await addWidgetViaApi(auth.authorization, pageA.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-widget-a'),
    });
    await addWidgetViaApi(auth.authorization, pageB.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-widget-b'),
    });
    const pages = [pageA.page.id, pageB.page.id];
    const revisionsBefore = await layoutRevisionSnapshot(pages);
    const workbenchBefore = await readWorkbenchStateRevision(auth.workspaceId);

    const uninstalled = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'uninstall',
    });
    expect(uninstalled.status).toBe(200);
    expect((await uninstalled.json<{ effect: { instancesRemoved: number } }>()).effect.instancesRemoved).toBe(2);

    // 每个受影响页面的**三个**断点都恰好 +1（不是「推两次」，也不是只推一个断点）。
    for (const pageId of pages) {
      const before = revisionsBefore.get(pageId);
      const after = await readLayoutRevisions(pageId);
      for (const breakpoint of BREAKPOINTS) {
        expect(after.get(breakpoint), `${pageId}/${breakpoint}`).toBe((before?.get(breakpoint) ?? 0) + 1);
      }
    }
    // 工作台 revision 恰好 +1（每个受影响页面都算同一次清理）。
    expect(await readWorkbenchStateRevision(auth.workspaceId)).toBe(workbenchBefore + 1);
    // 本次标记用完即清：表不会无限增长。
    expect(await countRows('widget_cleanup_marks')).toBe(0);
  });

  it('同一 maxRevision 再清理一次：removed 0，且布局 revision 与工作台 revision 一个都不动', async () => {
    const auth = await seedAuth();
    const store = createD1InstanceStore({ db: env.DB });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '幂等页', operationId: opId('b6-idem-page') });
    const instance = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-idem-widget'),
    });
    expect(instance.instance.createdRevision).toBe(1);

    const uninstalled = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'uninstall',
    });
    expect(uninstalled.status).toBe(200);
    expect((await readInstanceRow(auth.workspaceId, instance.instance.id))?.deleted_at).not.toBeNull();

    const before = await cleanupRevisionSnapshot([page.page.id], auth.workspaceId);
    const pagesBefore = JSON.stringify(await readPageRows(auth.workspaceId));
    const instancesBefore = JSON.stringify(await readInstanceRows(page.page.id));

    // 同一个代际上界重试：没有可墓碑化的行 → 0 行受影响 → 零 revision 变更。
    const again = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 1,
    });
    expect(again.removed).toBe(0);
    expect(await cleanupRevisionSnapshot([page.page.id], auth.workspaceId)).toBe(before);
    expect(JSON.stringify(await readPageRows(auth.workspaceId))).toBe(pagesBefore);
    expect(JSON.stringify(await readInstanceRows(page.page.id))).toBe(instancesBefore);
    expect(await countRows('widget_cleanup_marks')).toBe(0);
  });

  it('旧代清理命中 0 个实例（restore 之后的新实例不在上界内）：removed 0 且零 revision 变更', async () => {
    const auth = await seedAuth();
    const store = createD1InstanceStore({ db: env.DB });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '代际页', operationId: opId('b6-gen-page') });
    const oldGeneration = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-gen-old'),
    });
    expect(oldGeneration.instance.createdRevision).toBe(1);

    // 卸载（revision 2）→ 恢复（revision 3）→ 新建第二代实例。
    expect(
      (
        await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
          expectedRevision: 1,
          action: 'uninstall',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
          expectedRevision: 2,
          action: 'restore',
        })
      ).status,
    ).toBe(200);
    const newGeneration = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-gen-new'),
    });
    expect(newGeneration.instance.createdRevision).toBe(3);

    const before = await cleanupRevisionSnapshot([page.page.id], auth.workspaceId);
    const stale = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 2,
    });
    expect(stale.removed).toBe(0);
    // 修复前：没有新增墓碑也会按**历史墓碑**再推一轮 revision，让新布局草稿无端 409。
    expect(await cleanupRevisionSnapshot([page.page.id], auth.workspaceId)).toBe(before);
    expect((await readInstanceRow(auth.workspaceId, newGeneration.instance.id))?.deleted_at).toBeNull();
    expect(await countRows('widget_cleanup_marks')).toBe(0);
  });

  it('部分命中：只有甲页的三个断点 +1，乙/丙页不动，工作台 revision 恰好 +1', async () => {
    const auth = await seedAuth();
    const store = createD1InstanceStore({ db: env.DB });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const pageA = await createPageViaApi(auth.authorization, { name: '甲页', operationId: opId('b6-partial-a') });
    const pageB = await createPageViaApi(auth.authorization, { name: '乙页', operationId: opId('b6-partial-b') });
    const pageC = await createPageViaApi(auth.authorization, { name: '丙页', operationId: opId('b6-partial-c') });

    // 甲页实例属于第 1 代；换一代（停用 → 启用 = revision 3）后乙、丙页的实例属于第 3 代。
    const instanceA = await addWidgetViaApi(auth.authorization, pageA.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-partial-widget-a'),
    });
    expect(instanceA.instance.createdRevision).toBe(1);
    expect(
      (
        await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
          expectedRevision: 1,
          action: 'disable',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
          expectedRevision: 2,
          action: 'enable',
        })
      ).status,
    ).toBe(200);
    const instanceB = await addWidgetViaApi(auth.authorization, pageB.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-partial-widget-b'),
    });
    const instanceC = await addWidgetViaApi(auth.authorization, pageC.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b6-partial-widget-c'),
    });
    expect(instanceB.instance.createdRevision).toBe(3);
    expect(instanceC.instance.createdRevision).toBe(3);

    const pages = [pageA.page.id, pageB.page.id, pageC.page.id];
    const revisionsBefore = await layoutRevisionSnapshot(pages);
    const workbenchBefore = await readWorkbenchStateRevision(auth.workspaceId);

    // 只清理第 1 代：命中的只有甲页那一个实例。
    const removed = await store.removeInstancesForModule({
      workspaceId: auth.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      reason: 'module_uninstalled',
      maxRevision: 1,
    });
    expect(removed.removed).toBe(1);

    const beforeA = revisionsBefore.get(pageA.page.id);
    const afterA = await readLayoutRevisions(pageA.page.id);
    for (const breakpoint of BREAKPOINTS) {
      expect(afterA.get(breakpoint), `甲页/${breakpoint}`).toBe((beforeA?.get(breakpoint) ?? 0) + 1);
    }
    // 乙、丙页**完全没被碰过**（连断点修订行都没动）。
    for (const pageId of [pageB.page.id, pageC.page.id]) {
      const before = revisionsBefore.get(pageId);
      const after = await readLayoutRevisions(pageId);
      for (const breakpoint of BREAKPOINTS) {
        expect(after.get(breakpoint), `${pageId}/${breakpoint}`).toBe(before?.get(breakpoint) ?? 0);
      }
    }
    // 一次清理只推进一次工作台 revision。
    expect(await readWorkbenchStateRevision(auth.workspaceId)).toBe(workbenchBefore + 1);

    expect((await readInstanceRow(auth.workspaceId, instanceA.instance.id))?.deleted_at).not.toBeNull();
    expect((await readInstanceRow(auth.workspaceId, instanceB.instance.id))?.deleted_at).toBeNull();
    expect((await readInstanceRow(auth.workspaceId, instanceC.instance.id))?.deleted_at).toBeNull();
    expect(await countRows('widget_cleanup_marks')).toBe(0);
  });
});
