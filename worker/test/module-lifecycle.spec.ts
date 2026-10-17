/**
 * 模块生命周期集成测试（HUB-050 验收）。
 *
 * 三层证据：
 * 1. **真实 HTTP + 真实 D1**：走 SELF.fetch 打真实端点，再用 SQL 直接读表断言数据库事实
 *    （例如「卸载没有删掉设置」不能只看响应体自述）。
 * 2. **服务层 + 注入端口**：验证「原子准入 → 副作用 → 收尾」协议、失败语义与幂等重试。
 * 3. **确定性交错**：CAS 输家必须在**任何可变副作用之前**退出；副作用失败必须留下持久事实；
 *    已发生的部分副作用不得被响应伪装成「状态未变所以没发生」。
 */
import {
  DEMO_BASICS_MODULE_ID,
  DEMO_SOLO_MODULE_ID,
  PURGE_UNSUPPORTED_MESSAGE,
  moduleCatalogResponseSchema,
  moduleMutationResponseSchema,
  myModulesResponseSchema,
  workspaceModuleStatusResponseSchema,
  type ModuleCapability,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createModuleLifecycle } from '../modules/lifecycle/module-lifecycle';
import { createInMemoryScheduledTaskStore, createModuleScheduler } from '../modules/lifecycle/scheduler';
import { readModuleGateStatus } from '../modules/lifecycle/workspace-modules';
import type { ModuleInstanceStore, ModuleSchedulerPort } from '../modules/ports';
import { builtinModuleRegistry } from '../modules/registry/builtin-modules';
import { buildModuleRegistryOrThrow, type ModuleRegistry } from '../modules/registry/module-registry';
import {
  URLS,
  countRows,
  jsonPatch,
  modulePurgeUrl,
  moduleUrl,
  patchModule,
  readModuleOperationRow,
  readModuleRow,
  readModuleSettings,
  resetIdentityState,
  seedDevice,
  seedWorkspace,
} from './helpers';

const NOW = 1_760_000_000_000;

interface SeededAuth {
  readonly workspaceId: string;
  readonly authorization: string;
}

async function seedAuth(): Promise<SeededAuth> {
  const workspace = await seedWorkspace();
  const device = await seedDevice(workspace.workspaceId);
  return { workspaceId: workspace.workspaceId, authorization: device.authorization };
}

function errorBodyOf(text: string): { code: string; message: string } {
  return JSON.parse(text) as { code: string; message: string };
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('公开模块目录（匿名）', () => {
  it('匿名可读到符合契约的目录，且不含个人状态与内部 handler 名', async () => {
    const response = await SELF.fetch(URLS.moduleCatalog);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const text = await response.text();
    expect(text).not.toContain('demo.basics.enable');
    expect(text).not.toContain('"status"');
    expect(text).not.toContain('lifecycle');
    expect(text).not.toContain('pendingOperation');

    const parsed = moduleCatalogResponseSchema.safeParse(JSON.parse(text) as unknown);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const ids = parsed.data.modules.map((module) => module.id);
      expect(ids).toContain(DEMO_BASICS_MODULE_ID);
      expect(ids).toContain(DEMO_SOLO_MODULE_ID);
    }
  });

  it('目录上的非 GET 方法返回结构化 405 并声明 Allow', async () => {
    const response = await SELF.fetch(URLS.moduleCatalog, jsonPatch({ anything: true }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });
});

describe('鉴权边界', () => {
  it('未授权访问 /me/modules 的读、写、清数据一律 401', async () => {
    const responses = await Promise.all([
      SELF.fetch(URLS.meModules),
      SELF.fetch(moduleUrl(DEMO_BASICS_MODULE_ID), jsonPatch({ expectedRevision: 0, action: 'enable' })),
      SELF.fetch(modulePurgeUrl(DEMO_BASICS_MODULE_ID), { method: 'POST' }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      const body = errorBodyOf(await response.text());
      expect(body.code).toBe('unauthorized');
    }
  });

  it('用 A 工作空间的凭证不会影响 B 工作空间的模块状态', async () => {
    const a = await seedAuth();
    const b = await seedAuth();

    const bEnable = await patchModule(b.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      settings: { greeting: 'B 的设置', announce: true },
    });
    expect(bEnable.status).toBe(200);

    const aAttempt = await patchModule(a.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'disable',
    });
    expect(aAttempt.status).toBe(409);

    expect(await readModuleRow(a.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
    const bRow = await readModuleRow(b.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(bRow?.status).toBe('enabled');
    expect(bRow?.revision).toBe(1);
    expect(await readModuleSettings(b.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({ greeting: 'B 的设置' });

    const listResponse = await SELF.fetch(URLS.meModules, { headers: { Authorization: a.authorization } });
    const list = myModulesResponseSchema.parse(await listResponse.json());
    const basics = list.modules.find((module) => module.moduleId === DEMO_BASICS_MODULE_ID);
    expect(basics?.status).toBe('not_installed');
    expect(basics?.settings).toEqual({});
    expect(basics?.revision).toBe(0);
    expect(basics?.pendingOperation).toBeNull();
  });

  it('客户端提交 workspaceId 只会被当成非法字段拒绝（作用域只来自认证结果）', async () => {
    const auth = await seedAuth();
    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      workspaceId: 'attacker-chosen-workspace',
    });
    expect(response.status).toBe(422);
    expect(await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
  });

  it('未注册模块：读取与变更都返回 404（不泄露注册表以外的信息）', async () => {
    const auth = await seedAuth();
    const get = await SELF.fetch(moduleUrl('no.such.module'), { headers: { Authorization: auth.authorization } });
    expect(get.status).toBe(404);
    const patch = await patchModule(auth.authorization, 'no.such.module', { expectedRevision: 0, action: 'enable' });
    expect(patch.status).toBe(404);
  });
});

describe('生命周期状态机（HTTP）', () => {
  it('enable 建立状态、写入 Schema 默认设置，且没有留下待完成标记', async () => {
    const auth = await seedAuth();
    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
    });
    expect(response.status).toBe(200);
    const body = moduleMutationResponseSchema.parse(await response.json());
    expect(body.module.status).toBe('enabled');
    expect(body.module.revision).toBe(1);
    expect(body.module.pendingOperation).toBeNull();
    expect(body.effect.changed).toBe(true);
    expect(body.effect.pending).toBe(false);
    expect(body.effect.failure).toBeNull();
    expect(body.effect.handlersRun).toEqual(['demo.basics.enable']);
    expect(body.effect.userDataRetained).toBe(true);
    expect(body.module.settings['greeting']).toBe('你好');
    // 收尾完成后不应残留「待完成操作」行。
    expect(await readModuleOperationRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();

    const row = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.installed_at).toBeGreaterThan(0);
    expect(row?.enabled_at).not.toBeNull();
    expect(row?.disabled_at).toBeNull();
    expect(row?.uninstalled_at).toBeNull();
  });

  it('未安装时的非法迁移被拒绝为 409（disable / uninstall / restore）', async () => {
    const auth = await seedAuth();
    for (const action of ['disable', 'uninstall', 'restore'] as const) {
      const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 0, action });
      expect(response.status, `action=${action}`).toBe(409);
    }
    expect(await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
  });

  it('重复 enable / disable 是幂等 no-op：不 bump revision、不重复跑 handler', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 0, action: 'enable' });

    const first = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 1, action: 'enable' });
    const firstBody = moduleMutationResponseSchema.parse(await first.json());
    expect(firstBody.effect.changed).toBe(false);
    expect(firstBody.effect.handlersRun).toEqual([]);
    expect(firstBody.module.revision).toBe(1);

    const disable = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'disable',
    });
    const disabled = moduleMutationResponseSchema.parse(await disable.json());
    expect(disabled.module.status).toBe('disabled');
    expect(disabled.module.revision).toBe(2);
    expect(disabled.effect.handlersRun).toEqual(['demo.basics.disable']);
    expect(disabled.effect.message).toContain('个人数据');

    const disableAgain = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 2,
      action: 'disable',
    });
    const disableAgainBody = moduleMutationResponseSchema.parse(await disableAgain.json());
    expect(disableAgainBody.effect.changed).toBe(false);
    expect(disableAgainBody.module.revision).toBe(2);
  });

  it('disable 保留设置；enable 不能替代 restore（已卸载必须先 restore）', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      settings: { greeting: '保留我', announce: true },
    });
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 1, action: 'uninstall' });

    const enableOnUninstalled = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 2,
      action: 'enable',
    });
    expect(enableOnUninstalled.status).toBe(409);

    const restore = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 2,
      action: 'restore',
    });
    expect(restore.status).toBe(200);
    const body = moduleMutationResponseSchema.parse(await restore.json());
    expect(body.module.status).toBe('enabled');
    expect(body.effect.handlersRun).toEqual(['demo.basics.enable']);
    expect(body.module.settings).toMatchObject({ greeting: '保留我', announce: true });
  });

  it('卸载移除实例、停止行为，但保留个人数据与设置行（卸载 ≠ 清数据）', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      settings: { greeting: '别删我', announce: true },
    });
    const before = await countRows('workspace_modules');

    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'uninstall',
    });
    expect(response.status).toBe(200);
    const body = moduleMutationResponseSchema.parse(await response.json());
    expect(body.module.status).toBe('uninstalled');
    expect(body.effect.handlersRun).toEqual(['demo.basics.uninstall']);
    expect(body.effect.userDataRetained).toBe(true);
    expect(body.effect.pending).toBe(false);
    expect(body.effect.message).toContain('个人数据');

    expect(await countRows('workspace_modules')).toBe(before);
    const row = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.status).toBe('uninstalled');
    expect(row?.uninstalled_at).not.toBeNull();
    expect(row?.enabled_at).toBeNull();
    expect(await readModuleSettings(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({
      greeting: '别删我',
      announce: true,
    });

    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 2, action: 'restore' });
    expect(await readModuleSettings(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({ greeting: '别删我' });
  });
});

describe('设置与版本校验', () => {
  it('保存合法设置并反映在状态里', async () => {
    const auth = await seedAuth();
    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      settings: { greeting: '你好呀', announce: true },
    });
    const body = moduleMutationResponseSchema.parse(await response.json());
    expect(body.module.settings).toMatchObject({ greeting: '你好呀', announce: true });
    expect(body.effect.message).toContain('设置');
    // 仅设置变更不产生待完成标记（没有副作用需要收尾）。
    expect(body.module.pendingOperation).toBeNull();
    expect(await readModuleOperationRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
  });

  it('拒绝非法设置（422），且不回显提交的值', async () => {
    const auth = await seedAuth();
    const response = await patchModule(auth.authorization, DEMO_SOLO_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      settings: { topSecretValue: 'should-not-be-echoed' },
    });
    expect(response.status).toBe(422);
    const body = errorBodyOf(await response.text());
    expect(body.code).toBe('validation_failed');
    expect(body.message).not.toContain('should-not-be-echoed');
    expect(await readModuleRow(auth.workspaceId, DEMO_SOLO_MODULE_ID)).toBeNull();
  });

  it('设置版本不匹配返回 409', async () => {
    const auth = await seedAuth();
    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      settingsVersion: 99,
    });
    expect(response.status).toBe(409);
  });

  it('只写设置而不安装返回 409（先 enable）', async () => {
    const auth = await seedAuth();
    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      settings: { greeting: '未安装' },
    });
    expect(response.status).toBe(409);
  });

  it('请求体必须严格符合契约：缺少 expectedRevision、空请求、未知 action、负 revision 都返回 422', async () => {
    const auth = await seedAuth();
    const cases: unknown[] = [
      { action: 'enable' },
      {},
      { expectedRevision: 0 },
      { expectedRevision: 0, action: 'nonsense' },
      { expectedRevision: 0, action: 'enable', unexpected: true },
      { expectedRevision: -1, action: 'enable' },
    ];
    for (const body of cases) {
      const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('并发与防静默覆盖（HTTP）', () => {
  it('revision 不匹配时返回 409 且不写入', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 0, action: 'enable' });
    const conflict = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      settings: { greeting: '抢写' },
    });
    expect(conflict.status).toBe(409);
    const row = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.revision).toBe(1);
  });

  it('同一 expectedRevision 的并发请求只有一个成功', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 0, action: 'enable' });

    const responses = await Promise.all([
      patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 1, action: 'disable' }),
      patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 1, settings: { greeting: '并发' } }),
    ]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const row = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.revision).toBe(2);
    // 只有赢家会写状态；无论谁赢，都不应该留下待完成标记（两个动作的副作用都能成功）。
    expect(await readModuleOperationRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
  });
});

describe('清数据（purge）显式拒绝', () => {
  it('POST purge 返回 501、给出可读原因，且一个字节的数据都没有被删除', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
      settings: { greeting: '必须保留' },
    });
    const before = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);

    const response = await SELF.fetch(modulePurgeUrl(DEMO_BASICS_MODULE_ID), {
      method: 'POST',
      headers: { Authorization: auth.authorization },
    });
    expect(response.status).toBe(501);
    const body = errorBodyOf(await response.text());
    expect(body.code).toBe('not_implemented');
    expect(body.message).toBe(PURGE_UNSUPPORTED_MESSAGE);
    expect(body.message).toContain('没有删除任何数据');

    expect(await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toEqual(before);
  });

  it('PATCH 里的 purge 动作同样被显式拒绝，且状态不变', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 0, action: 'enable' });
    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'purge',
    });
    expect(response.status).toBe(501);
    const row = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.status).toBe('enabled');
    expect(row?.revision).toBe(1);
  });

  it('即使存在待完成操作，purge 也只返回 501，不会顺手改状态或清掉标记', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness({
      wrapScheduler: (management) => ({
        ...management,
        cancelAllForModule: () => Promise.reject(new Error('调度不可用')),
      }),
    });
    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 0, action: 'enable' },
    });
    const failed = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(failed.ok).toBe(true);
    const pendingBefore = await readModuleOperationRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(pendingBefore).not.toBeNull();

    const purge = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 2, action: 'purge' },
    });
    expect(purge.ok).toBe(false);
    if (!purge.ok) {
      expect(purge.reason).toBe('purge_unsupported');
    }
    expect(await readModuleOperationRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toEqual(pendingBefore);
  });
});

describe('读取状态', () => {
  it('GET /me/modules 覆盖全部已注册模块，未安装的显示 not_installed', async () => {
    const auth = await seedAuth();
    const response = await SELF.fetch(URLS.meModules, { headers: { Authorization: auth.authorization } });
    expect(response.status).toBe(200);
    const body = myModulesResponseSchema.parse(await response.json());
    expect(body.modules).toHaveLength(builtinModuleRegistry.list().length);
    for (const module of body.modules) {
      expect(module.status).toBe('not_installed');
      expect(module.revision).toBe(0);
      expect(module.settings).toEqual({});
      expect(module.pendingOperation).toBeNull();
    }
  });

  it('GET /me/modules/:id 返回单个模块状态', async () => {
    const auth = await seedAuth();
    await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 0, action: 'enable' });
    const response = await SELF.fetch(moduleUrl(DEMO_BASICS_MODULE_ID), {
      headers: { Authorization: auth.authorization },
    });
    expect(response.status).toBe(200);
    const body = workspaceModuleStatusResponseSchema.parse(await response.json());
    expect(body.module.status).toBe('enabled');
    expect(body.module.pendingOperation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 服务层：原子准入 → 副作用 → 收尾；失败语义、幂等重试、端口作用域与能力门禁
// ---------------------------------------------------------------------------

interface RecordingInstanceStore {
  readonly store: ModuleInstanceStore;
  readonly calls: { workspaceId: string; moduleId: string; reason: string }[];
}

function recordingInstanceStore(removed = 2): RecordingInstanceStore {
  const calls: { workspaceId: string; moduleId: string; reason: string }[] = [];
  return {
    calls,
    store: {
      persistent: false,
      removeInstancesForModule: (input) => {
        calls.push({ workspaceId: input.workspaceId, moduleId: input.moduleId, reason: input.reason });
        return Promise.resolve({ removed });
      },
      countInstancesForModule: () => Promise.resolve(0),
    },
  };
}

interface ServiceHarness {
  readonly lifecycle: ReturnType<typeof createModuleLifecycle>;
  readonly management: ModuleSchedulerPort;
  readonly scheduler: ModuleSchedulerPort;
  readonly scheduledTasks: ReturnType<typeof createInMemoryScheduledTaskStore>;
  readonly instances: RecordingInstanceStore;
}

interface HarnessOptions {
  readonly instanceStore?: ModuleInstanceStore;
  /** 包装内部管理端口，用于注入「某一步失败」。 */
  readonly wrapScheduler?: (management: ModuleSchedulerPort) => ModuleSchedulerPort;
  readonly registry?: ModuleRegistry;
}

function buildHarness(options: HarnessOptions = {}): ServiceHarness {
  const scheduledTasks = createInMemoryScheduledTaskStore();
  const management = createModuleScheduler({
    store: scheduledTasks,
    readModuleStatus: ({ workspaceId, moduleId }) => readModuleGateStatus(env.DB, workspaceId, moduleId),
  });
  const scheduler = options.wrapScheduler?.(management) ?? management;
  const instances = recordingInstanceStore();
  const lifecycle = createModuleLifecycle({
    db: env.DB,
    registry: options.registry ?? builtinModuleRegistry,
    instanceStore: options.instanceStore ?? instances.store,
    scheduler,
    now: () => NOW,
  });
  return { lifecycle, management, scheduler, scheduledTasks, instances };
}

const GREETING = '保留的设置';

async function enableWithSettings(harness: ServiceHarness, workspaceId: string): Promise<void> {
  const outcome = await harness.lifecycle.mutate({
    workspaceId,
    moduleId: DEMO_BASICS_MODULE_ID,
    request: { expectedRevision: 0, action: 'enable', settings: { greeting: GREETING } },
  });
  if (!outcome.ok) {
    throw new Error(`准备 enable 失败：${outcome.reason}`);
  }
}

describe('原子准入：CAS 输家在任何可变副作用之前退出', () => {
  it('设置更新先赢，卸载用过期 revision 输在 409，且没有移除实例/取消任务/留下标记', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness();
    await enableWithSettings(harness, workspace.workspaceId);
    await harness.management.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'sentinel',
      runAt: NOW + 60_000,
    });
    const instanceCallsBefore = harness.instances.calls.length;

    const settingsWin = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, settings: { greeting: '赢家的设置' } },
    });
    expect(settingsWin.ok).toBe(true);

    const uninstallLoses = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(uninstallLoses.ok).toBe(false);
    if (!uninstallLoses.ok) {
      expect(uninstallLoses.reason).toBe('revision_conflict');
    }

    // 关键断言：输家**没有**产生任何可变副作用。
    expect(harness.instances.calls).toHaveLength(instanceCallsBefore);
    expect(
      await harness.scheduledTasks.listByModule({ workspaceId: workspace.workspaceId, moduleId: DEMO_BASICS_MODULE_ID }),
    ).toHaveLength(1);
    const row = await readModuleRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.status).toBe('enabled');
    expect(await readModuleOperationRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
    expect(await readModuleSettings(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({
      greeting: '赢家的设置',
    });
  });

  it('真并发（同一 revision）：恰好一个成功，且只有赢家产生副作用', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness();
    await enableWithSettings(harness, workspace.workspaceId);
    await harness.management.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'sentinel',
      runAt: NOW + 60_000,
    });

    const [settingsAttempt, uninstallAttempt] = await Promise.all([
      harness.lifecycle.mutate({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        request: { expectedRevision: 1, settings: { greeting: '并发者' } },
      }),
      harness.lifecycle.mutate({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        request: { expectedRevision: 1, action: 'uninstall' },
      }),
    ]);

    const winners = [settingsAttempt, uninstallAttempt].filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);

    const pendingTasks = await harness.scheduledTasks.listByModule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
    });
    if (uninstallAttempt.ok) {
      // 卸载赢了：实例被移除、任务被取消，这正是赢家该做的事。
      expect(harness.instances.calls).toHaveLength(1);
      expect(pendingTasks).toHaveLength(0);
      const row = await readModuleRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID);
      expect(row?.status).toBe('uninstalled');
    } else {
      // 设置赢了：卸载完全没发生，实例与任务都还在。
      expect(harness.instances.calls).toHaveLength(0);
      expect(pendingTasks).toHaveLength(1);
      const row = await readModuleRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID);
      expect(row?.status).toBe('enabled');
    }
    expect(await readModuleOperationRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
  });
});

describe('副作用失败的持久事实与幂等重试', () => {
  it('实例清理成功但任务取消失败：状态已提交 + 待完成标记记录失败，绝不出现「enabled 但实例已删」', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness({
      wrapScheduler: (management) => ({
        ...management,
        cancelAllForModule: () => Promise.reject(new Error('调度不可用')),
      }),
    });
    await enableWithSettings(harness, workspace.workspaceId);
    await harness.management.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'sentinel',
      runAt: NOW + 60_000,
    });

    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    // 状态已提交为 uninstalled，且**没有**被伪装成「什么都没发生」。
    expect(outcome.module.status).toBe('uninstalled');
    expect(outcome.effect.pending).toBe(true);
    expect(outcome.effect.failure).toContain('平台清理失败');
    expect(outcome.effect.instancesRemoved).toBe(2);
    expect(outcome.effect.message).toContain('收尾未完成');
    expect(outcome.effect.message).toContain('个人数据与设置保留');
    expect(outcome.module.pendingOperation).not.toBeNull();
    expect(outcome.module.pendingOperation?.action).toBe('uninstall');
    expect(outcome.module.pendingOperation?.lastError).toContain('平台清理失败');

    // 数据库事实：状态、待完成操作、以及仍然保留的设置。
    const row = await readModuleRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.status).toBe('uninstalled');
    const pendingRow = await readModuleOperationRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(pendingRow?.action).toBe('uninstall');
    expect(pendingRow?.target_status).toBe('uninstalled');
    expect(pendingRow?.attempts).toBe(1);
    expect(pendingRow?.last_error).toContain('平台清理失败');
    expect(await readModuleSettings(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({
      greeting: GREETING,
    });
    // 门禁必须是安全的：不能是 enabled。
    expect(await harness.lifecycle.gateStatus(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toBe('transitioning');
    // 实例清理确实发生了（响应如实报告，而不是隐瞒）。
    expect(harness.instances.calls).toHaveLength(1);
  });

  it('幂等重试可以完成收尾：清除标记、取消任务、个人数据不删', async () => {
    const workspace = await seedWorkspace();
    let cancelFails = true;
    const harness = buildHarness({
      wrapScheduler: (management) => ({
        ...management,
        cancelAllForModule: (input) =>
          cancelFails ? Promise.reject(new Error('调度不可用')) : management.cancelAllForModule(input),
      }),
    });
    await enableWithSettings(harness, workspace.workspaceId);
    await harness.management.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'sentinel',
      runAt: NOW + 60_000,
    });

    const first = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.effect.pending).toBe(true);

    cancelFails = false;
    const retry = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: first.module.revision, action: 'uninstall' },
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) {
      return;
    }
    expect(retry.module.pendingOperation).toBeNull();
    expect(retry.effect.pending).toBe(false);
    expect(retry.effect.failure).toBeNull();
    expect(retry.effect.scheduledTasksCancelled).toBe(1);
    expect(retry.effect.message).toContain('收尾已完成');
    expect(retry.effect.userDataRetained).toBe(true);

    expect(await readModuleOperationRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
    expect(await readModuleSettings(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({
      greeting: GREETING,
    });
    expect(await harness.lifecycle.gateStatus(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toBe('uninstalled');
  });

  it('存在待完成操作时：其他动作或夹带设置都被 409 拒绝，避免交错', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness({
      wrapScheduler: (management) => ({
        ...management,
        cancelAllForModule: () => Promise.reject(new Error('调度不可用')),
      }),
    });
    await enableWithSettings(harness, workspace.workspaceId);
    const failed = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      return;
    }
    const revision = failed.module.revision;

    const otherAction = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: revision, action: 'enable' },
    });
    expect(otherAction.ok).toBe(false);
    if (!otherAction.ok) {
      expect(otherAction.reason).toBe('pending_conflict');
    }

    const withSettings = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: revision, action: 'uninstall', settings: { greeting: '偷改' } },
    });
    expect(withSettings.ok).toBe(false);
    if (!withSettings.ok) {
      expect(withSettings.reason).toBe('pending_conflict');
    }

    // 设置没有被改动，待完成标记仍在。
    expect(await readModuleSettings(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({
      greeting: GREETING,
    });
    expect(await readModuleOperationRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).not.toBeNull();
  });

  it('待完成的 enable（handler 失败）同样让门禁降级为 transitioning，重试后才可排程', async () => {
    const workspace = await seedWorkspace();
    let handlerFails = true;
    const registry = buildModuleRegistryOrThrow([
      {
        manifest: {
          id: 'test.gated',
          version: '1.0.0',
          displayName: '门禁测试模块',
          capabilities: ['scheduled:own'],
          widgets: [],
          routes: [],
          settingsSchemaVersion: 1,
          lifecycle: { onEnable: 'test.gated.enable' },
        },
        handlerTable: {
          'test.gated.enable': () => {
            if (handlerFails) {
              throw new Error('初始化失败');
            }
          },
        },
        settingsSchema: z.object({}).strict(),
        settingsSchemaVersion: 1,
        grantedCapabilities: ['scheduled:own'],
      },
    ]);
    const harness = buildHarness({ registry });
    const moduleId = 'test.gated';

    const first = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId,
      request: { expectedRevision: 0, action: 'enable' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.module.status).toBe('enabled');
    expect(first.effect.pending).toBe(true);
    expect(first.effect.failure).toContain('生命周期 handler 失败');
    expect(await harness.lifecycle.gateStatus(workspace.workspaceId, moduleId)).toBe('transitioning');

    // 待完成期间不得排入后台任务（门禁不是 enabled）。
    expect(
      await harness.management.schedule({
        workspaceId: workspace.workspaceId,
        moduleId,
        taskKey: 'blocked',
        runAt: NOW + 1000,
      }),
    ).toEqual({ ok: false, reason: 'module_inactive' });

    handlerFails = false;
    const retry = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId,
      request: { expectedRevision: first.module.revision, action: 'enable' },
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) {
      return;
    }
    expect(retry.module.pendingOperation).toBeNull();
    expect(await harness.lifecycle.gateStatus(workspace.workspaceId, moduleId)).toBe('enabled');
    expect(
      await harness.management.schedule({
        workspaceId: workspace.workspaceId,
        moduleId,
        taskKey: 'allowed',
        runAt: NOW + 1000,
      }),
    ).toMatchObject({ ok: true });
  });

  it('handler 失败也不会跳过平台清理（安全不变量优先），并记录原因', async () => {
    const workspace = await seedWorkspace();
    const registry = buildModuleRegistryOrThrow([
      {
        manifest: {
          id: 'test.failing',
          version: '1.0.0',
          displayName: '必然失败的测试模块',
          capabilities: [],
          widgets: [],
          routes: [],
          settingsSchemaVersion: 1,
          lifecycle: { onEnable: 'test.failing.enable', onUninstall: 'test.failing.uninstall' },
        },
        handlerTable: {
          'test.failing.enable': () => undefined,
          'test.failing.uninstall': () => {
            throw new Error('卸载 handler 甩锅');
          },
        },
        settingsSchema: z.object({}).strict(),
        settingsSchemaVersion: 1,
        grantedCapabilities: [],
      },
    ]);
    const harness = buildHarness({ registry });
    const moduleId = 'test.failing';
    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId,
      request: { expectedRevision: 0, action: 'enable' },
    });

    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.effect.pending).toBe(true);
    expect(outcome.effect.failure).toContain('生命周期 handler 失败');
    // 关键：handler 失败**没有**阻止实例清理。
    expect(harness.instances.calls).toHaveLength(1);
    expect(outcome.effect.instancesRemoved).toBe(2);
    expect(await readModuleOperationRow(workspace.workspaceId, moduleId)).not.toBeNull();
  });
});

describe('模块服务端口：作用域闭包绑定 + 能力门禁', () => {
  interface ProbeResult {
    readonly decision: unknown;
    readonly pendingInside: number;
  }

  function probeRegistry(options: {
    readonly granted: boolean;
    readonly onProbe: (result: ProbeResult) => void;
  }): ModuleRegistry {
    // 能力声明与授予保持一致：`granted=false` 时两者都为空。
    const capabilities: readonly ModuleCapability[] = options.granted ? ['scheduled:own'] : [];
    return buildModuleRegistryOrThrow([
      {
        manifest: {
          id: 'test.scheduler',
          version: '1.0.0',
          displayName: '调度探针模块',
          capabilities: [...capabilities],
          widgets: [],
          routes: [],
          settingsSchemaVersion: 1,
          lifecycle: { onEnable: 'test.scheduler.enable' },
        },
        handlerTable: {
          'test.scheduler.enable': async (context) => {
            // 运行时**伪造**作用域：多传 workspaceId / moduleId 必须被忽略。
            const forged = {
              taskKey: 'probe-task',
              runAt: NOW + 1000,
              workspaceId: 'forged-workspace',
              moduleId: 'forged.module',
            } as unknown as { taskKey: string; runAt: number };
            const decision: unknown = await context.services.scheduler.schedule(forged);
            const pending = await context.services.scheduler.listPending();
            options.onProbe({ decision, pendingInside: pending.length });
          },
        },
        settingsSchema: z.object({}).strict(),
        settingsSchemaVersion: 1,
        grantedCapabilities: [...capabilities],
      },
    ]);
  }

  it('未授予 scheduled:own 时，模块 handler 的排程被 capability_not_granted 拒绝且不落任何任务', async () => {
    const workspace = await seedWorkspace();
    const probe: { value: ProbeResult | null } = { value: null };
    const harness = buildHarness({
      registry: probeRegistry({
        granted: false,
        onProbe: (result) => {
          probe.value = result;
        },
      }),
    });

    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: 'test.scheduler',
      request: { expectedRevision: 0, action: 'enable' },
    });
    expect(outcome.ok).toBe(true);
    expect(probe.value).not.toBeNull();
    expect(probe.value?.decision).toEqual({ ok: false, reason: 'capability_not_granted' });
    expect(probe.value?.pendingInside).toBe(0);
    expect(
      await harness.scheduledTasks.listByModule({ workspaceId: workspace.workspaceId, moduleId: 'test.scheduler' }),
    ).toHaveLength(0);
    expect(
      await harness.scheduledTasks.listByModule({ workspaceId: 'forged-workspace', moduleId: 'forged.module' }),
    ).toHaveLength(0);
  });

  it('已授予时排程成功，且任务落在**闭包绑定的**真实作用域上（伪造字段无效）', async () => {
    const workspace = await seedWorkspace();
    const probe: { value: ProbeResult | null } = { value: null };
    const harness = buildHarness({
      registry: probeRegistry({
        granted: true,
        onProbe: (result) => {
          probe.value = result;
        },
      }),
    });

    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: 'test.scheduler',
      request: { expectedRevision: 0, action: 'enable' },
    });
    expect(outcome.ok).toBe(true);
    expect(probe.value).not.toBeNull();
    expect(probe.value?.decision).toMatchObject({ ok: true });
    expect(probe.value?.pendingInside).toBe(1);

    // 任务属于真实 workspace/module，而不是伪造值。
    const tasks = await harness.scheduledTasks.listByModule({
      workspaceId: workspace.workspaceId,
      moduleId: 'test.scheduler',
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskKey).toBe('probe-task');
    expect(tasks[0]?.workspaceId).toBe(workspace.workspaceId);
    expect(tasks[0]?.moduleId).toBe('test.scheduler');
    expect(
      await harness.scheduledTasks.listByModule({ workspaceId: 'forged-workspace', moduleId: 'forged.module' }),
    ).toHaveLength(0);
    // 其他工作空间也看不到它。
    expect(
      await harness.scheduledTasks.listByModule({ workspaceId: workspace.workspaceId, moduleId: 'forged.module' }),
    ).toHaveLength(0);
  });

  it('停用 handler 不享有初始化豁免：它已经处于停止过程，排程仍被门禁拒绝', async () => {
    const workspace = await seedWorkspace();
    const moduleId = 'test.stopper';
    const probe: { value: { readonly decision: unknown } | null } = { value: null };
    const registry = buildModuleRegistryOrThrow([
      {
        manifest: {
          id: moduleId,
          version: '1.0.0',
          displayName: '停止过程探针模块',
          capabilities: ['scheduled:own'],
          widgets: [],
          routes: [],
          settingsSchemaVersion: 1,
          lifecycle: { onEnable: 'test.stopper.enable', onDisable: 'test.stopper.disable' },
        },
        handlerTable: {
          'test.stopper.enable': () => undefined,
          'test.stopper.disable': async (context) => {
            probe.value = {
              decision: await context.services.scheduler.schedule({ taskKey: 'stopping-task', runAt: NOW + 1000 }),
            };
          },
        },
        settingsSchema: z.object({}).strict(),
        settingsSchemaVersion: 1,
        grantedCapabilities: ['scheduled:own'],
      },
    ]);
    const harness = buildHarness({ registry });

    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId,
      request: { expectedRevision: 0, action: 'enable' },
    });
    const disabled = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId,
      request: { expectedRevision: 1, action: 'disable' },
    });
    expect(disabled.ok).toBe(true);

    expect(probe.value?.decision).toEqual({ ok: false, reason: 'module_inactive' });
    expect(
      await harness.scheduledTasks.listByModule({ workspaceId: workspace.workspaceId, moduleId }),
    ).toHaveLength(0);
  });
});

describe('调度门禁受模块启停状态约束', () => {
  it('未启用 / 已停用 / 已卸载都不能排入后台任务，启用后才可排程', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness();
    const schedule = (taskKey: string) =>
      harness.management.schedule({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        taskKey,
        runAt: NOW + 60_000,
      });

    expect(await schedule('t-before')).toEqual({ ok: false, reason: 'module_inactive' });

    await enableWithSettings(harness, workspace.workspaceId);
    expect((await schedule('t-enabled')).ok).toBe(true);

    const disabled = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'disable' },
    });
    expect(disabled.ok).toBe(true);
    if (disabled.ok) {
      expect(disabled.effect.scheduledTasksCancelled).toBe(1);
    }
    expect(await schedule('t-disabled')).toEqual({ ok: false, reason: 'module_inactive' });

    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 2, action: 'uninstall' },
    });
    expect(await schedule('t-uninstalled')).toEqual({ ok: false, reason: 'module_inactive' });
  });

  it('非法的执行时间被拒绝；同一 taskKey 重复排程是幂等成功', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness();
    await enableWithSettings(harness, workspace.workspaceId);

    expect(
      await harness.management.schedule({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        taskKey: 'bad-time',
        runAt: -1,
      }),
    ).toEqual({ ok: false, reason: 'invalid_run_at' });

    const first = await harness.management.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'same-key',
      runAt: NOW + 1000,
    });
    expect(first.ok).toBe(true);
    const second = await harness.management.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'same-key',
      runAt: NOW + 1000,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.duplicate).toBe(true);
    }
    expect(
      await harness.scheduledTasks.listByModule({ workspaceId: workspace.workspaceId, moduleId: DEMO_BASICS_MODULE_ID }),
    ).toHaveLength(1);
  });

  it('取消永远可做（包括模块已停用时），否则停用后就清理不掉已排队任务', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness();
    await enableWithSettings(harness, workspace.workspaceId);
    await harness.management.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'to-cancel',
      runAt: NOW + 1000,
    });
    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'disable' },
    });

    expect(
      await harness.management.cancel({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        taskKey: 'to-cancel',
      }),
    ).toEqual({ cancelled: 0 });
    expect(
      await harness.management.cancelAllForModule({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        reason: 'module_disabled',
      }),
    ).toEqual({ cancelled: 0 });
  });
});

describe('设置上限与其他拒绝路径', () => {
  it('设置超过字节上限时拒绝，且不写库也不产生待完成标记', async () => {
    const workspace = await seedWorkspace();
    const registry = buildModuleRegistryOrThrow([
      {
        manifest: {
          id: 'test.permissive',
          version: '1.0.0',
          displayName: '宽松设置测试模块',
          capabilities: [],
          widgets: [],
          routes: [],
          settingsSchemaVersion: 1,
          lifecycle: {},
        },
        handlerTable: {},
        // 这个 Schema 不做长度限制，因此能真正走到「字节上限」这条独立校验。
        settingsSchema: z.record(z.string(), z.unknown()),
        settingsSchemaVersion: 1,
        grantedCapabilities: [],
      },
    ]);
    const harness = buildHarness({ registry });

    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: 'test.permissive',
      request: { expectedRevision: 0, action: 'enable', settings: { blob: 'x'.repeat(9000) } },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('settings_too_large');
    }
    expect(await readModuleRow(workspace.workspaceId, 'test.permissive')).toBeNull();
    expect(await readModuleOperationRow(workspace.workspaceId, 'test.permissive')).toBeNull();
  });

  it('未注册模块在服务层同样返回 module_unknown', async () => {
    const workspace = await seedWorkspace();
    const harness = buildHarness();
    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: 'no.such.module',
      request: { expectedRevision: 0, action: 'enable' },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('module_unknown');
    }
  });
});
