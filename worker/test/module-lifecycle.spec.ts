/**
 * 模块生命周期集成测试（HUB-050 验收）。
 *
 * 两层证据，缺一不可：
 * 1. **真实 HTTP + 真实 D1**：走 SELF.fetch 打真实端点，再用 SQL 直接读 `workspace_modules`
 *    断言数据库事实（例如「卸载没有删掉设置」不能只看响应体自述）。
 * 2. **服务层 + 注入端口**：验证平台副作用（实例清理、任务取消）与失败语义，
 *    这些在阶段 02 还没有持久实现，但语义必须被真实断言。
 */
import {
  DEMO_BASICS_MODULE_ID,
  DEMO_SOLO_MODULE_ID,
  PURGE_UNSUPPORTED_MESSAGE,
  moduleCatalogResponseSchema,
  moduleMutationResponseSchema,
  myModulesResponseSchema,
  workspaceModuleStatusResponseSchema,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createModuleLifecycle } from '../modules/lifecycle/module-lifecycle';
import { createInMemoryScheduledTaskStore, createModuleScheduler } from '../modules/lifecycle/scheduler';
import { readEffectiveModuleStatus } from '../modules/lifecycle/workspace-modules';
import type { ModuleInstanceStore, ScheduledTaskStore } from '../modules/ports';
import { builtinModuleRegistry } from '../modules/registry/builtin-modules';
import { buildModuleRegistryOrThrow } from '../modules/registry/module-registry';
import {
  URLS,
  countRows,
  jsonPatch,
  modulePurgeUrl,
  moduleUrl,
  patchModule,
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
    // 只含元数据：不能出现 handler 名（内部注册细节）或工作空间状态。
    expect(text).not.toContain('demo.basics.enable');
    expect(text).not.toContain('"status"');
    expect(text).not.toContain('lifecycle');

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

    // A 从未安装该模块：disable 属于非法迁移，必须 409，且不能碰到 B 的行。
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

    // A 的列表里该模块仍是「未安装」，且看不到 B 的设置。
    const listResponse = await SELF.fetch(URLS.meModules, { headers: { Authorization: a.authorization } });
    const list = myModulesResponseSchema.parse(await listResponse.json());
    const basics = list.modules.find((module) => module.moduleId === DEMO_BASICS_MODULE_ID);
    expect(basics?.status).toBe('not_installed');
    expect(basics?.settings).toEqual({});
    expect(basics?.revision).toBe(0);
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

describe('生命周期状态机', () => {
  it('enable 建立状态并写入 Schema 默认设置', async () => {
    const auth = await seedAuth();
    const response = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 0,
      action: 'enable',
    });
    expect(response.status).toBe(200);
    const body = moduleMutationResponseSchema.parse(await response.json());
    expect(body.module.status).toBe('enabled');
    expect(body.module.revision).toBe(1);
    expect(body.effect.changed).toBe(true);
    expect(body.effect.handlersRun).toEqual(['demo.basics.enable']);
    expect(body.effect.userDataRetained).toBe(true);
    expect(body.module.settings['greeting']).toBe('你好');

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
    expect(first.status).toBe(200);
    const firstBody = moduleMutationResponseSchema.parse(await first.json());
    expect(firstBody.effect.changed).toBe(false);
    expect(firstBody.effect.handlersRun).toEqual([]);
    expect(firstBody.module.revision).toBe(1);

    const again = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, { expectedRevision: 1, action: 'enable' });
    const againBody = moduleMutationResponseSchema.parse(await again.json());
    expect(againBody.module.revision).toBe(1);
    expect(againBody.effect.changed).toBe(false);

    const disable = await patchModule(auth.authorization, DEMO_BASICS_MODULE_ID, {
      expectedRevision: 1,
      action: 'disable',
    });
    expect(disable.status).toBe(200);
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
    expect(body.effect.message).toContain('个人数据');
    expect(body.effect.message).toContain('可随时恢复');

    // 数据库事实：行还在、设置还在、当前状态时间戳互斥。
    expect(await countRows('workspace_modules')).toBe(before);
    const row = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.status).toBe('uninstalled');
    expect(row?.uninstalled_at).not.toBeNull();
    expect(row?.enabled_at).toBeNull();
    expect(await readModuleSettings(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toMatchObject({
      greeting: '别删我',
      announce: true,
    });

    // 恢复后设置沿用。
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

  it('请求体必须严格符合契约：缺少或缺失 expectedRevision、空请求、未知 action 都返回 422', async () => {
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

describe('并发与防静默覆盖', () => {
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
  });
});

// ---------------------------------------------------------------------------
// 服务层：平台副作用、失败语义、调度门禁（真实 D1 + 注入端口）
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
  readonly scheduler: ReturnType<typeof createModuleScheduler>;
  readonly scheduledTasks: ScheduledTaskStore;
  readonly instances: RecordingInstanceStore;
}

function serviceHarness(instanceStore?: ModuleInstanceStore): ServiceHarness {
  const scheduledTasks = createInMemoryScheduledTaskStore();
  const scheduler = createModuleScheduler({
    store: scheduledTasks,
    readModuleStatus: ({ workspaceId, moduleId }) => readEffectiveModuleStatus(env.DB, workspaceId, moduleId),
  });
  const instances = recordingInstanceStore();
  const lifecycle = createModuleLifecycle({
    db: env.DB,
    registry: builtinModuleRegistry,
    instanceStore: instanceStore ?? instances.store,
    scheduler,
    now: () => NOW,
  });
  return { lifecycle, scheduler, scheduledTasks, instances };
}

describe('平台副作用与端口', () => {
  it('卸载会请求移除实例并取消已排队任务，同时如实报告计数', async () => {
    const workspace = await seedWorkspace();
    const harness = serviceHarness();

    const enabled = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 0, action: 'enable' },
    });
    expect(enabled.ok).toBe(true);

    const scheduled = await harness.scheduler.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'demo-task-1',
      runAt: NOW + 60_000,
    });
    expect(scheduled.ok).toBe(true);

    const uninstalled = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(uninstalled.ok).toBe(true);
    if (uninstalled.ok) {
      expect(uninstalled.effect.instancesRemoved).toBe(2);
      expect(uninstalled.effect.scheduledTasksCancelled).toBe(1);
      expect(uninstalled.effect.message).toContain('移除 2 个当前实例');
    }

    // 端口被调用且参数正确（这正是「卸载移除当前 Host 实例」的可验证落点）。
    expect(harness.instances.calls).toEqual([
      { workspaceId: workspace.workspaceId, moduleId: DEMO_BASICS_MODULE_ID, reason: 'module_uninstalled' },
    ]);
    expect(await harness.scheduledTasks.listByModule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
    })).toHaveLength(0);

    // 数据保留：行与设置都还在。
    expect(await readModuleRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).not.toBeNull();
  });

  it('卸载失败（端口抛错）时不写库，状态与 revision 保持不变', async () => {
    const workspace = await seedWorkspace();
    const failingStore: ModuleInstanceStore = {
      persistent: false,
      removeInstancesForModule: () => Promise.reject(new Error('实例库不可用')),
      countInstancesForModule: () => Promise.resolve(0),
    };
    const harness = serviceHarness(failingStore);
    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 0, action: 'enable' },
    });

    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 1, action: 'uninstall' },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('side_effect_failed');
    }
    const row = await readModuleRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(row?.status).toBe('enabled');
    expect(row?.revision).toBe(1);
  });

  it('生命周期 handler 抛错时不写库，也不执行平台副作用', async () => {
    const workspace = await seedWorkspace();
    const failingRegistry = buildModuleRegistryOrThrow([
      {
        manifest: {
          id: 'test.failing',
          version: '1.0.0',
          displayName: '必然失败的测试模块',
          capabilities: [],
          widgets: [],
          routes: [],
          settingsSchemaVersion: 1,
          lifecycle: { onEnable: 'test.failing.enable' },
        },
        handlerTable: {
          'test.failing.enable': () => {
            throw new Error('handler 故意失败');
          },
        },
        settingsSchema: z.object({}).strict(),
        settingsSchemaVersion: 1,
        grantedCapabilities: [],
      },
    ]);
    const scheduledTasks = createInMemoryScheduledTaskStore();
    const instances = recordingInstanceStore();
    const lifecycle = createModuleLifecycle({
      db: env.DB,
      registry: failingRegistry,
      instanceStore: instances.store,
      scheduler: createModuleScheduler({
        store: scheduledTasks,
        readModuleStatus: ({ workspaceId, moduleId }) => readEffectiveModuleStatus(env.DB, workspaceId, moduleId),
      }),
      now: () => NOW,
    });

    const outcome = await lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: 'test.failing',
      request: { expectedRevision: 0, action: 'enable' },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('handler_failed');
    }
    expect(await readModuleRow(workspace.workspaceId, 'test.failing')).toBeNull();
    expect(instances.calls).toHaveLength(0);
  });
});

describe('调度门禁受模块启停状态约束', () => {
  it('未启用 / 已停用 / 已卸载都不能排入后台任务，启用后才可排程', async () => {
    const workspace = await seedWorkspace();
    const harness = serviceHarness();
    const schedule = (taskKey: string) =>
      harness.scheduler.schedule({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        taskKey,
        runAt: NOW + 60_000,
      });

    // 未安装。
    expect(await schedule('t-before')).toEqual({ ok: false, reason: 'module_inactive' });

    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 0, action: 'enable' },
    });
    expect((await schedule('t-enabled')).ok).toBe(true);

    // 停用：已排队任务被取消，且不能再排新的。
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

    // 卸载后同样不能排程。
    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 2, action: 'uninstall' },
    });
    expect(await schedule('t-uninstalled')).toEqual({ ok: false, reason: 'module_inactive' });
  });

  it('非法的执行时间被拒绝；同一 taskKey 重复排程是幂等成功', async () => {
    const workspace = await seedWorkspace();
    const harness = serviceHarness();
    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 0, action: 'enable' },
    });

    expect(
      await harness.scheduler.schedule({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        taskKey: 'bad-time',
        runAt: -1,
      }),
    ).toEqual({ ok: false, reason: 'invalid_run_at' });

    const first = await harness.scheduler.schedule({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'same-key',
      runAt: NOW + 1000,
    });
    expect(first.ok).toBe(true);
    const second = await harness.scheduler.schedule({
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
    const harness = serviceHarness();
    await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 0, action: 'enable' },
    });
    await harness.scheduler.schedule({
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

    const cancelled = await harness.scheduler.cancel({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      taskKey: 'to-cancel',
    });
    expect(cancelled.cancelled).toBe(0);
    expect(
      await harness.scheduler.cancelAllForModule({
        workspaceId: workspace.workspaceId,
        moduleId: DEMO_BASICS_MODULE_ID,
        reason: 'module_disabled',
      }),
    ).toEqual({ cancelled: 0 });
  });
});

describe('服务层的设置上限与 purge', () => {
  it('设置超过字节上限时拒绝，且不写库', async () => {
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
    const harness = serviceHarness();
    const lifecycle = createModuleLifecycle({
      db: env.DB,
      registry,
      instanceStore: harness.instances.store,
      scheduler: harness.scheduler,
      now: () => NOW,
    });

    const outcome = await lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: 'test.permissive',
      request: { expectedRevision: 0, action: 'enable', settings: { blob: 'x'.repeat(9000) } },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('settings_too_large');
    }
    expect(await readModuleRow(workspace.workspaceId, 'test.permissive')).toBeNull();
  });

  it('purge 在服务层同样被显式拒绝（不会走到写库）', async () => {
    const workspace = await seedWorkspace();
    const harness = serviceHarness();
    const outcome = await harness.lifecycle.mutate({
      workspaceId: workspace.workspaceId,
      moduleId: DEMO_BASICS_MODULE_ID,
      request: { expectedRevision: 0, action: 'purge' },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('purge_unsupported');
    }
    expect(await readModuleRow(workspace.workspaceId, DEMO_BASICS_MODULE_ID)).toBeNull();
  });
});
