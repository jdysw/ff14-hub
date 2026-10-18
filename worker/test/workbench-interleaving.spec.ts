/**
 * 确定性交错回归（复核要求）：用真实 D1 + 一个**委托层**在读取之间插入并发写入。
 *
 * 覆盖两处只有「同一快照 / 同一事务」才能保证的语义：
 * 1. 新增实例的**规划依据**（页面 + 实例集合 + 矩形 + 三断点修订号）必须来自同一时刻；
 *    否则并发保存会造出「前置条件全成立、提交却重叠」的窗口。
 * 2. 导入的原子准入必须钉住**所有相关模块**（含被预览跳过的 disabled / not_installed），
 *    否则它们在 token 校验之后被启用就能绕过「相关门禁变化必须重新预览」。
 *
 * 委托层刻意只做两件事：把「直接执行某类语句」计数，以及在第一次 batch 之前触发一次写入。
 * 它不改变被测代码的语义，因此断言的是**真实实现**的行为。
 */
import { DEMO_BASICS_MODULE_ID, DEMO_WIDGET_IDS, WORKBENCH_BACKUP_SCHEMA_VERSION } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { builtinModuleRegistry } from '../modules/registry/builtin-modules';
import { createWorkbenchBackupService } from '../modules/workbench/backup';
import { createWorkbenchService } from '../modules/workbench/service';
import { normalizeWidgetConfig } from '../modules/workbench/internal';

const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;
const DEMO_SOLO = DEMO_WIDGET_IDS.solo;
import {
  URLS,
  addWidgetViaApi,
  countRows,
  createPageViaApi,
  enableDemoModule,
  moduleUrl,
  opId,
  readLayoutRevisions,
  readLayoutRows,
  readModuleRow,
  readPageRows,
  resetIdentityState,
  saveLayoutRequest,
  seedAuth,
} from './helpers';

/** 四条「规划依据」查询的特征片段：一旦它们被**直接执行**（而不是走 batch），说明读取不是原子的。 */
const PLANNING_FRAGMENTS = ['FROM workspace_pages', 'FROM widget_instances', 'FROM widget_layouts', 'FROM page_layout_revisions'];

interface Delegate {
  readonly db: D1Database;
  /** 每条 SQL 被**直接执行**（.all/.first/.run）的次数。 */
  readonly directExecutions: (fragment: string) => number;
  readonly batchCount: () => number;
}

/**
 * 包一层 D1。
 *
 * - 记录哪些「规划依据」查询被直接执行（用于断言读取是单 batch 的原子快照）；
 * - 在**第一次** `batch()` 真正执行之前，先跑一次注入的写入（模拟另一个设备/执行者插进来）。
 */
function delegateD1(inner: D1Database, beforeFirstBatch: (() => Promise<void>) | null): Delegate {
  let batchCount = 0;
  let fired = false;
  const direct = new Map<string, number>();

  function noteDirect(sql: string): void {
    for (const fragment of PLANNING_FRAGMENTS) {
      if (sql.includes(fragment)) {
        direct.set(fragment, (direct.get(fragment) ?? 0) + 1);
      }
    }
  }

  // 代理 → 原始语句：`batch()` 必须把**原始**语句交给 D1（内部字段不能是代理）。
  const originals = new WeakMap<object, D1PreparedStatement>();

  function wrapStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...args: unknown[]) => wrapStatement(target.bind(...args), sql);
        }
        if (property === 'first' || property === 'all' || property === 'run' || property === 'raw') {
          return async (...args: unknown[]) => {
            noteDirect(sql);
            const fn = (target as unknown as Record<string, (...callArgs: unknown[]) => Promise<unknown>>)[
              property as string
            ];
            if (fn === undefined) {
              throw new Error(`D1PreparedStatement 缺少方法：${String(property)}`);
            }
            return await Reflect.apply(fn, target, args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...callArgs: unknown[]) => unknown).bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  }

  const db = {
    prepare: (sql: string) => wrapStatement(inner.prepare(sql), sql),
    // D1 只接受**原始**语句对象（内部字段不能是代理），因此这里先还原再交给它。
    batch: async (statements: D1PreparedStatement[]) => {
      batchCount += 1;
      const raw = statements.map((statement) => originals.get(statement) ?? statement);
      if (!fired && beforeFirstBatch !== null) {
        fired = true;
        await beforeFirstBatch();
      }
      return await inner.batch(raw);
    },
    exec: async (sql: string) => await inner.exec(sql),
    dump: async () => await inner.dump(),
  } as unknown as D1Database;

  return {
    db,
    directExecutions: (fragment) => direct.get(fragment) ?? 0,
    batchCount: () => batchCount,
  };
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('规划空位必须来自同一快照', () => {
  it('并发保存在读取之间插入：新增实例仍然不重叠（旧实现会重叠），且规划读取是单个 batch', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-1'),
    });

    const before = await readLayoutRows(page.page.id);
    const desktopBefore = before.filter((row) => row.breakpoint === 'desktop');
    expect(desktopBefore).toHaveLength(1);
    const existing = desktopBefore[0];
    expect(existing).toBeDefined();
    if (existing === undefined) {
      return;
    }
    // 现有实例在左半边（自动排布从 (0,0) 开始）；把它挪到 x=4 正是复核给出的反例。
    const moved = [{ i: existing.widget_id, x: 4, y: 0, w: existing.w, h: existing.h }];
    const revisionsBefore = await readLayoutRevisions(page.page.id);
    const baseRevision = revisionsBefore.get('desktop') ?? 0;

    // 注入：在第一次 batch（即规划快照读取）之前，另一个执行者把实例挪到 x=4 并升 revision。
    const delegate = delegateD1(env.DB, async () => {
      const saved = await saveLayoutRequest(auth.authorization, page.page.id, {
        breakpoint: 'desktop',
        baseRevision,
        rects: moved,
        operationId: opId('inject-layout'),
      });
      expect(saved.status).toBe(200);
    });

    const service = createWorkbenchService({ db: delegate.db, registry: builtinModuleRegistry });
    const added = await service.addWidget({
      workspaceId: auth.workspaceId,
      pageId: page.page.id,
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-2'),
    });

    // 注入确实发生了：现有实例已经被挪到 x=4。
    const afterRows = await readLayoutRows(page.page.id);
    const movedRow = afterRows.find((row) => row.widget_id === existing.widget_id && row.breakpoint === 'desktop');
    expect(movedRow?.x).toBe(4);

    // 规划读取是**单 batch**：四条「规划依据」查询没有被直接执行（旧实现会各自 .all()/.first()）。
    for (const fragment of PLANNING_FRAGMENTS) {
      expect(delegate.directExecutions(fragment), `不应直接执行：${fragment}`).toBe(0);
    }
    expect(delegate.batchCount()).toBeGreaterThanOrEqual(1);

    // 关键不变量：无论成功还是 409，结果都不能重叠；成功时新实例必须在另一块空位。
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    const desktopAfter = afterRows
      .filter((row) => row.breakpoint === 'desktop')
      .map((row) => ({ i: row.widget_id, x: row.x, y: row.y, w: row.w, h: row.h }));
    expect(desktopAfter).toHaveLength(2);
    for (let a = 0; a < desktopAfter.length; a += 1) {
      for (let b = a + 1; b < desktopAfter.length; b += 1) {
        const left = desktopAfter[a];
        const right = desktopAfter[b];
        if (left === undefined || right === undefined) {
          continue;
        }
        const overlap =
          left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
        expect(overlap, `实例 ${left.i} 与 ${right.i} 不应重叠：${JSON.stringify([left, right])}`).toBe(false);
      }
    }
  });
});

describe('导入的原子准入钉住所有相关模块门禁', () => {
  /** 一份只含 `demo-solo`（单例、其模块默认未安装）实例的备份文档。 */
  function soloDocument(): unknown {
    const normalized = normalizeWidgetConfig(builtinModuleRegistry, DEMO_SOLO, { title: '单例' });
    if (!normalized.ok) {
      throw new Error('demo-solo 配置应合法');
    }
    return {
      kind: 'ff14-hub.workbench',
      schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
      exportedAt: 1,
      appVersion: '0.0.0',
      moduleVersions: { 'demo.solo': '1.0.0' },
      widgetConfigVersions: { [DEMO_SOLO]: 1 },
      pages: [
        {
          id: 'sync-page',
          name: '同步页',
          slug: 'sync-page',
          isDefault: true,
          sortOrder: 0,
          instances: [
            {
              id: 'sync-instance',
              widgetType: DEMO_SOLO,
              moduleId: 'demo.solo',
              config: JSON.parse(normalized.json) as unknown,
              configVersion: normalized.configVersion,
              hidden: false,
              layouts: { desktop: { i: 'sync-instance', x: 0, y: 0, w: 3, h: 2 } },
            },
          ],
        },
      ],
    };
  }

  it('预览时模块未安装（实例被跳过）→ 在 token 校验后、认领前启用该模块 ⇒ 409 且零写入；重新预览后可导入', async () => {
    const auth = await seedAuth();
    const document = soloDocument();
    const demoModuleCountBefore = await countRows('workspace_modules');

    // 预览：demo.solo 未安装 → 该实例被跳过，但文档本身可导入（返回 token）。
    const preview = await SELF.fetch(URLS.workbenchImportPreview, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
      body: JSON.stringify({ mode: 'merge', document }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json<{
      preview: {
        importable: boolean;
        previewRevision: number;
        previewToken: string;
        counts: { instancesSkipped: number; instancesNew: number };
        unknownModules: readonly { moduleId: string }[];
      };
    }>();
    expect(previewBody.preview.importable).toBe(true);
    expect(previewBody.preview.counts.instancesSkipped).toBe(1);
    expect(previewBody.preview.counts.instancesNew).toBe(0);
    expect(previewBody.preview.unknownModules.map((entry) => entry.moduleId)).toContain('demo.solo');

    const pagesBefore = await countRows('workspace_pages');
    const instancesBefore = await countRows('widget_instances');

    // 注入：在第一次 batch（= 原子认领批次）之前启用 demo.solo。
    // 这正好落在「token 已校验、认领尚未提交」的窗口里。
    let injected = false;
    const delegate = delegateD1(env.DB, async () => {
      injected = true;
      const enabled = await SELF.fetch(moduleUrl('demo.solo'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
        body: JSON.stringify({ action: 'enable', expectedRevision: 0 }),
      });
      expect(enabled.status).toBe(200);
    });

    const backup = createWorkbenchBackupService({ db: delegate.db, registry: builtinModuleRegistry });
    const applied = await backup.applyImport({
      workspaceId: auth.workspaceId,
      deviceId: auth.deviceId,
      rawDocument: document,
      mode: 'merge',
      previewRevision: previewBody.preview.previewRevision,
      previewToken: previewBody.preview.previewToken,
      operationId: opId('import-raced'),
    });

    expect(injected).toBe(true);
    // 被跳过的模块在提交前被启用 ⇒ 相关门禁已变化 ⇒ 必须要求重新预览。
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe('import_preview_stale');
    }

    // 零写入：页面与实例都没有增加，也没有留下幂等记录。
    expect(await countRows('workspace_pages')).toBe(pagesBefore);
    expect(await countRows('widget_instances')).toBe(instancesBefore);
    expect(await readPageRows(auth.workspaceId)).toHaveLength(0);
    // 模块行只因为注入的「启用」而多了一行，导入本身没有再动它。
    expect(await countRows('workspace_modules')).toBe(demoModuleCountBefore + 1);
    expect((await readModuleRow(auth.workspaceId, 'demo.solo'))?.status).toBe('enabled');

    // 重新预览（此时模块已启用）→ 应用应成功，并且该实例被真正写入。
    const previewAgain = await SELF.fetch(URLS.workbenchImportPreview, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
      body: JSON.stringify({ mode: 'merge', document }),
    });
    const previewAgainBody = await previewAgain.json<{
      preview: { previewRevision: number; previewToken: string; counts: { instancesNew: number } };
    }>();
    expect(previewAgainBody.preview.counts.instancesNew).toBe(1);

    const appliedAgain = await createWorkbenchBackupService({ db: env.DB, registry: builtinModuleRegistry }).applyImport({
      workspaceId: auth.workspaceId,
      deviceId: auth.deviceId,
      rawDocument: document,
      mode: 'merge',
      previewRevision: previewAgainBody.preview.previewRevision,
      previewToken: previewAgainBody.preview.previewToken,
      operationId: opId('import-after-repreview'),
    });
    expect(appliedAgain.ok).toBe(true);
    expect(await readPageRows(auth.workspaceId)).toHaveLength(1);
    expect(await countRows('widget_instances')).toBe(1);
  });

  it('未安装模块保持未安装时，导入该模块的实例仍会被跳过而不是报错（不隐式启用）', async () => {
    const auth = await seedAuth();
    const document = soloDocument();
    const preview = await SELF.fetch(URLS.workbenchImportPreview, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
      body: JSON.stringify({ mode: 'merge', document }),
    });
    const previewBody = await preview.json<{
      preview: { previewRevision: number; previewToken: string };
    }>();

    const applied = await createWorkbenchBackupService({ db: env.DB, registry: builtinModuleRegistry }).applyImport({
      workspaceId: auth.workspaceId,
      deviceId: auth.deviceId,
      rawDocument: document,
      mode: 'merge',
      previewRevision: previewBody.preview.previewRevision,
      previewToken: previewBody.preview.previewToken,
      operationId: opId('import-skip'),
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.skipped.map((entry) => entry.widgetType)).toContain(DEMO_SOLO);
      expect(applied.value.counts.instancesNew).toBe(0);
    }
    // 模块仍然没有被隐式创建/启用。
    expect(await readModuleRow(auth.workspaceId, 'demo.solo')).toBeNull();
    expect(await countRows('widget_instances')).toBe(0);
  });
});
