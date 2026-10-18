/**
 * 工作台备份 / 恢复集成测试（HUB-054 验收）。
 *
 * 证据标准：
 * 1. 导出 → 预览 → 落地全部走真实 HTTP + 真实 D1；
 * 2. **凭证零泄漏**：导出文档（以及整个响应体）里不得出现设备 Token、恢复密钥或其摘要，
 *    也不得出现任何名为 token / password / secret / recovery 的字段；
 * 3. **导出与导入容量自洽**：导出上限必须小于写请求体上限，且正常规模的导出必定能被导入；
 * 4. 每一种被拒绝的导入都要断言「一个字节都没写」（页面、幂等记录、工作台修订号都不动）。
 */
import {
  DEMO_BASICS_MODULE_ID,
  DEMO_WIDGET_IDS,
  MAX_JSON_BODY_BYTES,
  WORKBENCH_BACKUP_MAX_BYTES,
  WORKBENCH_BACKUP_SCHEMA_VERSION,
  workbenchBackupDocumentSchema,
  type GridRect,
  type LayoutBreakpoint,
  type WidgetInstance,
  type WorkspacePage,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  URLS,
  addWidgetViaApi,
  assertNoOverlap,
  backupRestoreUrl,
  countRows,
  createPageViaApi,
  createPairingViaApi,
  enableDemoModule,
  jsonPatch,
  jsonPost,
  pageWidgetsUrl,
  previewThenApplyViaApi,
  readBackupRow,
  readInstanceRow,
  readInstanceRows,
  readInstancesViaApi,
  readLayoutRows,
  readLayoutsViaApi,
  readModuleRow,
  readPageRow,
  readPageRows,
  readTokenHash,
  readWorkbenchOperationRow,
  readWorkbenchStateRevision,
  readWorkbenchStateRow,
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

/**
 * 结构上合法（长度落在 schema 的 16..128 内）但**不是**任何一次真实预览产出的令牌。
 *
 * 用途：证明「一段内容不合格的文档」在应用阶段会被**服务层的可解释拒绝**拦下，
 * 而不是被「缺少 previewToken」这类结构问题提前挡掉——后者会让断言变得空洞。
 */
const SYNTHETIC_PREVIEW_TOKEN = 'synthetic-preview-token-0000000000000000';

interface AuthedWorkspace {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly recoveryKey: string;
  readonly authorization: string;
}

async function seedAuth(): Promise<AuthedWorkspace> {
  const { workspace, device } = await seedWorkspaceWithDevice();
  return {
    workspaceId: workspace.workspaceId,
    deviceId: device.deviceId,
    deviceToken: device.token,
    recoveryKey: workspace.recoveryKey,
    authorization: device.authorization,
  };
}

function errorBodyOf(text: string): { code: string; message: string } {
  return JSON.parse(text) as { code: string; message: string };
}

interface ExportedBackup {
  readonly backup: Record<string, unknown>;
  readonly byteLength: number;
  readonly maxBytes: number;
}

async function exportBackup(authorization: string): Promise<ExportedBackup> {
  const response = await SELF.fetch(URLS.workbenchBackup, { headers: { Authorization: authorization } });
  if (response.status !== 200) {
    throw new Error(`导出未成功：status=${response.status} body=${await response.text()}`);
  }
  return await response.json<ExportedBackup>();
}

function previewImport(
  authorization: string,
  document: unknown,
  mode: 'merge' | 'replace',
): Promise<Response> {
  return SELF.fetch(
    URLS.workbenchImportPreview,
    jsonPost({ mode, document }, { Authorization: authorization }),
  );
}

/**
 * 走一次真实的「预览 → 应用」。
 *
 * 预览令牌绑定 `document + mode + 工作台 revision + 相关模块门禁`，
 * 因此应用时必须原样回显预览返回的 `previewToken`（这正是复核要求的语义），
 * 这里把它做成便捷函数，避免每个用例手抄一遍。
 */
async function previewThenApply(
  authorization: string,
  input: {
    readonly document: unknown;
    readonly mode: 'merge' | 'replace';
    readonly operationId: string;
    readonly confirm?: unknown;
  },
): Promise<{ readonly preview: Response; readonly previewBody: PreviewBody; readonly apply: Response }> {
  const preview = await previewImport(authorization, input.document, input.mode);
  const previewBody = await preview.json<PreviewBody>();
  const apply = await applyImport(authorization, {
    document: input.document,
    mode: input.mode,
    previewRevision: previewBody.preview.previewRevision,
    previewToken: previewBody.preview.previewToken,
    operationId: input.operationId,
    ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
  });
  return { preview, previewBody, apply };
}

function applyImport(
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

interface PreviewBody {
  readonly preview: {
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
    /**
     * 复核新增：预览令牌绑定 `document + mode + 工作台 revision + 相关模块门禁`。
     * 应用时必须原样回显；任何一项变化都会 409 且零写入。
     */
    readonly previewToken: string;
    readonly confirmPrompt: string;
  };
}

interface ApplyBody {
  readonly result: {
    readonly mode: string;
    readonly backupId: string | null;
    readonly pages: readonly WorkspacePage[];
    readonly defaultPageId: string | null;
    readonly counts: {
      readonly pagesNew: number;
      readonly pagesReplaced: number;
      readonly instancesNew: number;
      readonly instancesSkipped: number;
    };
    readonly skipped: readonly { readonly widgetType: string; readonly detail: string }[];
    readonly warnings: readonly { readonly code: string; readonly detail: string }[];
  };
  readonly replayed: boolean;
}

/** 一份可用的备份文档构造器（测试里手写文档时用，结构与导出完全一致）。 */
interface DocPageInput {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly isDefault?: boolean;
  readonly sortOrder?: number;
  readonly instances?: readonly {
    readonly id: string;
    readonly widgetType: string;
    readonly config?: unknown;
    readonly hidden?: boolean;
    readonly layouts?: Partial<Record<LayoutBreakpoint, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>>;
  }[];
}

function buildDocument(pages: readonly DocPageInput[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ff14-hub.workbench',
    schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
    exportedAt: Date.now(),
    appVersion: '0.0.0',
    moduleVersions: { [DEMO_BASICS_MODULE_ID]: '1.0.0' },
    widgetConfigVersions: { [DEMO_COUNTER]: 1 },
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      slug: page.slug,
      isDefault: page.isDefault ?? false,
      sortOrder: page.sortOrder ?? 0,
      instances: (page.instances ?? []).map((instance) => ({
        id: instance.id,
        widgetType: instance.widgetType,
        moduleId: DEMO_BASICS_MODULE_ID,
        config: instance.config ?? { step: 1, label: '演示计数', initDelayMs: 0 },
        configVersion: 1,
        hidden: instance.hidden ?? false,
        layouts: Object.fromEntries(
          Object.entries(instance.layouts ?? {}).map(([breakpoint, rect]) => [
            breakpoint,
            { i: instance.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h },
          ]),
        ),
      })),
    })),
    ...overrides,
  };
}

/** 页面的可比结构（忽略 ID）：名字、是否默认、实例（类型/配置/隐藏）、三个断点的矩形。 */
interface PageStructure {
  readonly name: string;
  readonly isDefault: boolean;
  readonly instances: readonly { readonly widgetType: string; readonly config: unknown; readonly hidden: boolean }[];
  readonly layouts: Readonly<Record<string, readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[]>>;
}

function sortKey(value: unknown): string {
  return JSON.stringify(value);
}

async function structureOf(authorization: string): Promise<PageStructure[]> {
  const response = await SELF.fetch(URLS.pages, { headers: { Authorization: authorization } });
  if (response.status !== 200) {
    throw new Error(`读取页面未成功：status=${response.status}`);
  }
  const { pages } = await response.json<{ pages: WorkspacePage[] }>();
  const result: PageStructure[] = [];
  for (const page of pages) {
    const instances = await readInstancesViaApi(authorization, page.id);
    const layouts = await readLayoutsViaApi(authorization, page.id);
    result.push({
      name: page.name,
      isDefault: page.isDefault,
      instances: instances
        .map((instance: WidgetInstance) => ({
          widgetType: instance.widgetType,
          config: instance.config,
          hidden: instance.hidden,
        }))
        .sort((left, right) => sortKey(left).localeCompare(sortKey(right))),
      layouts: Object.fromEntries(
        layouts.map((layout) => [
          layout.breakpoint,
          layout.rects
            .map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }))
            .sort((left, right) => sortKey(left).localeCompare(sortKey(right))),
        ]),
      ),
    });
  }
  return result;
}

/** 递归收集对象里的所有键名（用于断言没有任何凭证命名的字段）。 */
function collectKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, found);
    }
    return found;
  }
  if (typeof value !== 'object' || value === null) {
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.push(key);
    collectKeys(child, found);
  }
  return found;
}

/** 「这次导入没有写任何东西」的统一断言。 */
async function expectNoImportWrites(input: {
  readonly workspaceId: string;
  readonly pagesBefore: number;
  readonly stateBefore: { readonly revision: number } | null;
  readonly operationsBefore: number;
  readonly intentsBefore: number;
}): Promise<void> {
  expect(await countRows('workspace_pages')).toBe(input.pagesBefore);
  expect(await readWorkbenchStateRow(input.workspaceId)).toEqual(input.stateBefore);
  expect(await countRows('workbench_operations')).toBe(input.operationsBefore);
  // 0007 的指纹表与 0006 的幂等记录同批写入：被拒绝的请求两张表都不能多行。
  expect(await countRows('workbench_operation_intents')).toBe(input.intentsBefore);
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('导出：形状与凭证零泄漏', () => {
  it('导出文档包含契约要求的元数据与页面/实例/布局，且不含任何凭证', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '日常页', operationId: opId('page-1') });
    await createPageViaApi(auth.authorization, { name: '钓鱼页', operationId: opId('page-2') });
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
      config: { step: 2, label: '导出用', initDelayMs: 0 },
    });

    const exported = await exportBackup(auth.authorization);
    const document = exported.backup;
    expect(document['kind']).toBe('ff14-hub.workbench');
    expect(document['schemaVersion']).toBe(WORKBENCH_BACKUP_SCHEMA_VERSION);
    expect(document['appVersion']).toBe('0.0.0');
    expect(document['moduleVersions']).toEqual({ [DEMO_BASICS_MODULE_ID]: '1.0.0' });
    expect(document['widgetConfigVersions']).toEqual({ [DEMO_COUNTER]: 1 });

    const pages = document['pages'] as Record<string, unknown>[];
    expect(pages).toHaveLength(2);
    const firstPage = pages.find((candidate) => candidate['name'] === '日常页');
    expect(firstPage?.['isDefault']).toBe(true);
    const instances = firstPage?.['instances'] as Record<string, unknown>[];
    expect(instances).toHaveLength(1);
    expect(instances[0]?.['id']).toBe(added.instance.id);
    expect(instances[0]?.['widgetType']).toBe(DEMO_COUNTER);
    expect(instances[0]?.['moduleId']).toBe(DEMO_BASICS_MODULE_ID);
    expect(instances[0]?.['config']).toEqual({ step: 2, label: '导出用', initDelayMs: 0 });
    expect(instances[0]?.['configVersion']).toBe(1);
    expect(instances[0]?.['hidden']).toBe(false);
    const layouts = instances[0]?.['layouts'] as Record<string, unknown>;
    expect(Object.keys(layouts).sort()).toEqual(['desktop', 'mobile', 'tablet']);

    // 容量自洽：导出报的字节数与真实序列化长度一致，且上限来自共享契约。
    expect(exported.byteLength).toBe(new TextEncoder().encode(JSON.stringify(document)).byteLength);
    expect(exported.maxBytes).toBe(WORKBENCH_BACKUP_MAX_BYTES);
    expect(exported.byteLength).toBeLessThanOrEqual(exported.maxBytes);

    // ── 凭证零泄漏（对整个响应体做字符串与字段名两重检查）──────
    const response = await SELF.fetch(URLS.workbenchBackup, { headers: { Authorization: auth.authorization } });
    const raw = await response.text();
    expect(raw).not.toContain(auth.deviceToken);
    expect(raw).not.toContain(auth.recoveryKey);
    const tokenHash = await readTokenHash(auth.deviceId);
    expect(tokenHash).not.toBeNull();
    expect(raw).not.toContain(tokenHash ?? '');
    expect(raw).not.toContain('token_hash');

    const forbidden = /token|password|passwd|secret|recovery|cookie|authorization|privatekey/i;
    const keys = collectKeys(JSON.parse(raw) as unknown);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => forbidden.test(key))).toEqual([]);
  });
});

describe('导入 round-trip（结构等价）', () => {
  it('导出 2 页 3 实例的工作台，merge 导入到另一个空工作空间后结构等价（ID 重新分配）', async () => {
    const source = await seedAuth();
    await enableDemoModule(source.authorization, DEMO_BASICS_MODULE_ID);
    const home = await createPageViaApi(source.authorization, { name: '日常', operationId: opId('src-page-1') });
    const fishing = await createPageViaApi(source.authorization, { name: '钓鱼', operationId: opId('src-page-2') });
    const first = await addWidgetViaApi(source.authorization, home.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('src-widget-1'),
      config: { step: 3, label: '甲', initDelayMs: 0 },
    });
    const second = await addWidgetViaApi(source.authorization, home.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('src-widget-2'),
      config: { step: 4, label: '乙', initDelayMs: 10 },
      hidden: true,
    });
    await addWidgetViaApi(source.authorization, fishing.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('src-widget-3'),
      config: { step: 5, label: '丙', initDelayMs: 20 },
    });
    // 显式保存三个断点中的两个，让 round-trip 覆盖「显式矩形 + 自动排布」两种来源。
    for (const breakpoint of ['desktop', 'tablet'] as const) {
      const base = (await readLayoutsViaApi(source.authorization, home.page.id)).find(
        (layout) => layout.breakpoint === breakpoint,
      );
      const response = await saveLayoutRequest(source.authorization, home.page.id, {
        breakpoint,
        baseRevision: base?.revision ?? 0,
        rects: [
          { i: first.instance.id, x: 0, y: 0, w: 4, h: 3 },
          { i: second.instance.id, x: 4, y: 0, w: 4, h: 3 },
        ],
        operationId: opId(`src-layout-${breakpoint}`),
      });
      expect(response.status).toBe(200);
    }

    const sourceStructure = await structureOf(source.authorization);
    const exported = await exportBackup(source.authorization);
    const sourceDocument = exported.backup;

    // 目标：全新工作空间（只有模块被启用，没有任何页面）。
    const target = await seedAuth();
    await enableDemoModule(target.authorization, DEMO_BASICS_MODULE_ID);
    expect((await readWorkbenchStateRow(target.workspaceId))?.revision ?? 0).toBe(0);

    const previewResponse = await previewImport(target.authorization, sourceDocument, 'merge');
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);
    expect(preview.problems).toEqual([]);
    expect(preview.counts.pagesNew).toBe(2);
    expect(preview.counts.instancesNew).toBe(3);
    expect(preview.counts.instancesSkipped).toBe(0);
    expect(preview.previewRevision).toBe(0);

    const applied = await applyImport(target.authorization, {
      document: sourceDocument,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-roundtrip'),
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json<ApplyBody>()).result;
    expect(result.mode).toBe('merge');
    expect(result.backupId).toBeNull();
    expect(result.pages).toHaveLength(2);
    expect(result.counts).toEqual(
      expect.objectContaining({ pagesNew: 2, pagesReplaced: 0, instancesNew: 3, instancesSkipped: 0 }),
    );

    // 结构等价：只比名字 / 组件类型 / 配置 / 隐藏 / 三断点矩形（不比 ID 与 slug）。
    const targetStructure = await structureOf(target.authorization);
    expect(targetStructure).toEqual(sourceStructure);
    expect(sourceStructure[0]?.isDefault).toBe(true);
    expect(targetStructure[0]?.isDefault).toBe(true);

    // ID 与 slug 都是**重新分配**的：导入后的页面 ID 绝不等于源页面 ID。
    const sourcePageIds = new Set((await readPageRows(source.workspaceId)).map((row) => row.id));
    const importedRows = await readPageRows(target.workspaceId);
    expect(importedRows).toHaveLength(2);
    for (const row of importedRows) {
      expect(sourcePageIds.has(row.id)).toBe(false);
    }
    const sourceInstanceIds = new Set(
      (await readInstancesViaApi(source.authorization, home.page.id)).map((instance) => instance.id),
    );
    for (const instance of await readInstancesViaApi(target.authorization, importedRows[0]?.id ?? '')) {
      expect(sourceInstanceIds.has(instance.id)).toBe(false);
    }
  });

  it('merge 导入到**已有默认页**的工作空间：导入成功、导入页一律非默认、默认页仍是原来的那一页', async () => {
    const target = await seedAuth();
    await enableDemoModule(target.authorization, DEMO_BASICS_MODULE_ID);
    const existing = await createPageViaApi(target.authorization, { name: '原有页面', operationId: opId('t-page') });
    expect(existing.page.isDefault).toBe(true);

    const document = buildDocument([
      {
        id: 'doc-page-1',
        name: '导入页甲',
        slug: 'imported-a',
        isDefault: true,
        instances: [{ id: 'doc-instance-1', widgetType: DEMO_COUNTER }],
      },
    ]);
    const previewResponse = await previewImport(target.authorization, document, 'merge');
    const preview = (await previewResponse.json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);

    const applied = await applyImport(target.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-merge-default'),
    });
    // 关键：不得 500（数据库的唯一默认页约束不能被撞到）。
    expect(applied.status).toBe(200);
    const result = (await applied.json<ApplyBody>()).result;
    for (const page of result.pages) {
      expect(page.isDefault).toBe(false);
    }
    expect(result.defaultPageId).toBe(existing.page.id);

    const rows = await readPageRows(target.workspaceId);
    const active = rows.filter((row) => row.deleted_at === null);
    expect(active).toHaveLength(2);
    expect(active.filter((row) => row.is_default === 1).map((row) => row.id)).toEqual([existing.page.id]);
    expect(active.find((row) => row.name === '导入页甲')?.is_default).toBe(0);
  });

  it('merge 导入到**空**工作空间：备份里的默认页成为默认页', async () => {
    const target = await seedAuth();
    await enableDemoModule(target.authorization, DEMO_BASICS_MODULE_ID);
    expect((await readPageRows(target.workspaceId)).filter((row) => row.deleted_at === null)).toHaveLength(0);

    const document = buildDocument([
      { id: 'doc-page-1', name: '第一页', slug: 'first-page', sortOrder: 0 },
      { id: 'doc-page-2', name: '第二页', slug: 'second-page', isDefault: true, sortOrder: 1 },
    ]);
    const preview = (await (await previewImport(target.authorization, document, 'merge')).json<PreviewBody>())
      .preview;
    const applied = await applyImport(target.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-empty-default'),
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json<ApplyBody>()).result;
    expect(result.defaultPageId).toBe(result.pages.find((page) => page.name === '第二页')?.id);
    expect(result.pages.find((page) => page.name === '第二页')?.isDefault).toBe(true);
    expect(result.pages.find((page) => page.name === '第一页')?.isDefault).toBe(false);

    const active = (await readPageRows(target.workspaceId)).filter((row) => row.deleted_at === null);
    expect(active).toHaveLength(2);
    expect(active.filter((row) => row.is_default === 1)).toHaveLength(1);
    expect(active.find((row) => row.is_default === 1)?.name).toBe('第二页');
  });
});

describe('replace 模式与可撤销备份', () => {
  it('replace 在同一事务里写 pre_import 备份并替换页面；restore 能回到替换前，二次 restore 失败', async () => {
    // 被替换的一方：两个页面 + 实例。
    const target = await seedAuth();
    await enableDemoModule(target.authorization, DEMO_BASICS_MODULE_ID);
    const oldFirst = await createPageViaApi(target.authorization, { name: '旧一', operationId: opId('old-1') });
    const oldSecond = await createPageViaApi(target.authorization, { name: '旧二', operationId: opId('old-2') });
    const oldInstance = await addWidgetViaApi(target.authorization, oldFirst.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('old-widget'),
      config: { step: 8, label: '旧配置', initDelayMs: 0 },
    });
    expect(oldSecond.page.isDefault).toBe(false);

    // 用来替换的文档。
    const document = buildDocument([
      {
        id: 'doc-new-1',
        name: '新页面',
        slug: 'brand-new',
        isDefault: true,
        instances: [{ id: 'doc-new-instance', widgetType: DEMO_COUNTER, config: { step: 9, label: '新配置', initDelayMs: 0 } }],
      },
    ]);

    const preview = (await (await previewImport(target.authorization, document, 'replace')).json<PreviewBody>())
      .preview;
    expect(preview.importable).toBe(true);
    expect(preview.counts.pagesReplaced).toBe(2);
    expect(preview.affectedPages).toEqual(['旧一', '旧二']);
    expect(preview.confirmPrompt).toContain('替换');

    const applied = await applyImport(target.authorization, {
      document,
      mode: 'replace',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-replace'),
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json<ApplyBody>()).result;
    expect(result.mode).toBe('replace');
    expect(result.backupId).not.toBeNull();
    expect(result.counts.pagesReplaced).toBe(2);
    expect(result.pages.map((page) => page.name)).toEqual(['新页面']);

    // pre_import 备份：同事务写入的持久事实，内容是替换**前**的状态。
    const backupId = result.backupId ?? '';
    const backup = await readBackupRow(target.workspaceId, backupId);
    expect(backup?.kind).toBe('pre_import');
    expect(backup?.schema_version).toBe(WORKBENCH_BACKUP_SCHEMA_VERSION);
    expect(backup?.created_by_device).toBe(target.deviceId);
    expect(backup?.consumed_at).toBeNull();
    const payload = JSON.parse(backup?.payload_json ?? 'null') as { pages: { name: string; instances: unknown[] }[] };
    expect(payload.pages.map((page) => page.name)).toEqual(['旧一', '旧二']);
    expect(payload.pages[0]?.instances).toHaveLength(1);

    // 替换 = 墓碑：旧页面与旧实例都还在（内容可恢复）。
    const afterReplace = await readPageRows(target.workspaceId);
    expect(afterReplace.filter((row) => row.deleted_at === null).map((row) => row.name)).toEqual(['新页面']);
    expect(afterReplace.filter((row) => row.deleted_at !== null).map((row) => row.name).sort()).toEqual(['旧一', '旧二']);
    // 旧页面已被墓碑化：它的实例查询按「页面不存在」处理（404），
    // 与 `GET /me/pages/:id/layout` 的语义一致（前端据此识别过期的 pageId）。
    const oldPageInstances = await SELF.fetch(pageWidgetsUrl(oldFirst.page.id), {
      headers: { Authorization: target.authorization },
    });
    expect(oldPageInstances.status).toBe(404);
    // 替换只墓碑**页面**：页面下的实例与布局原样保留（因此恢复能整体带回来），
    // 实例本身不是被「移除」，只是随页面一起从活跃视图中消失。
    const oldInstanceRow = await env.DB.prepare('SELECT page_id, deleted_at FROM widget_instances WHERE id = ?')
      .bind(oldInstance.instance.id)
      .first<{ page_id: string; deleted_at: number | null }>();
    expect(oldInstanceRow).not.toBeNull();
    expect(oldInstanceRow?.deleted_at).toBeNull();
    expect((await readPageRow(target.workspaceId, oldInstanceRow?.page_id ?? ''))?.deleted_at).not.toBeNull();

    // restore：回到替换前的状态（复核后必须回显 expectedRevision）。
    const restoreOperationId = opId('backup-restore');
    const restored = await SELF.fetch(backupRestoreUrl(backupId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: target.authorization },
      body: JSON.stringify({
        operationId: restoreOperationId,
        expectedRevision: await readWorkbenchStateRevision(target.workspaceId),
      }),
    });
    expect(restored.status).toBe(200);
    const restoredBody = await restored.json<{ result: ApplyBody['result']; notice: string }>();
    expect(restoredBody.notice).toContain('已恢复');
    expect(restoredBody.result.pages.map((page) => page.name).sort()).toEqual(['旧一', '旧二']);

    const afterRestore = (await readPageRows(target.workspaceId)).filter((row) => row.deleted_at === null);
    expect(afterRestore.map((row) => row.name).sort()).toEqual(['旧一', '旧二']);
    expect(afterRestore.filter((row) => row.is_default === 1)).toHaveLength(1);
    // 复核语义：撤销点在**替换的同一个事务**里被标记消费（不再有「已恢复但未消费」的窗口）。
    expect((await readBackupRow(target.workspaceId, backupId))?.consumed_at).not.toBeNull();
    const backups = await SELF.fetch(URLS.workbenchBackups, { headers: { Authorization: target.authorization } });
    const listed = await backups.json<{ backups: { id: string; consumedAt: number | null }[] }>();
    expect(listed.backups.some((entry) => entry.id === backupId && entry.consumedAt !== null)).toBe(true);

    // 同一份备份第二次恢复必须失败：换一个 operationId 就是「再消费一次」，
    // 复核后是 409 backup_consumed（而不是把它当成不存在的备份）。
    const secondRestore = await SELF.fetch(backupRestoreUrl(backupId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: target.authorization },
      body: JSON.stringify({
        operationId: opId('backup-restore-again'),
        expectedRevision: await readWorkbenchStateRevision(target.workspaceId),
      }),
    });
    expect(secondRestore.status).toBe(409);
    const secondBody = errorBodyOf(await secondRestore.text());
    expect(secondBody.code).toBe('conflict');
    expect(secondBody.message).toContain('备份已被使用过');
  });

  it('同一个工作空间里导出 → merge 导入回原地必须成功，且 slug 仍然两两唯一（回归）', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '原地页面', operationId: opId('page') });
    await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    const exported = await exportBackup(auth.authorization);

    const preview = (await (await previewImport(auth.authorization, exported.backup, 'merge')).json<PreviewBody>())
      .preview;
    expect(preview.importable).toBe(true);
    const applied = await applyImport(auth.authorization, {
      document: exported.backup,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-in-place'),
    });
    // 修复前：备份里的 slug 已被自己占用 → 唯一索引冲突 → 整个事务回滚 → 500。
    expect(applied.status).toBe(200);

    const rows = await readPageRows(auth.workspaceId);
    expect(rows.filter((row) => row.deleted_at === null)).toHaveLength(2);
    const duplicates = await env.DB.prepare(
      `SELECT slug, COUNT(*) AS count FROM workspace_pages
        WHERE workspace_id = ? GROUP BY slug HAVING COUNT(*) > 1`,
    )
      .bind(auth.workspaceId)
      .all<{ slug: string; count: number }>();
    expect(duplicates.results).toEqual([]);
  });

  it('同一个工作空间里导出 → replace 导入回原地同样成功，且 slug 两两唯一', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '原地页面', operationId: opId('page') });
    await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
    });
    const exported = await exportBackup(auth.authorization);
    const preview = (await (await previewImport(auth.authorization, exported.backup, 'replace')).json<PreviewBody>())
      .preview;

    const applied = await applyImport(auth.authorization, {
      document: exported.backup,
      mode: 'replace',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-in-place-replace'),
    });
    expect(applied.status).toBe(200);
    const active = (await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null);
    expect(active).toHaveLength(1);
    expect(active.filter((row) => row.is_default === 1)).toHaveLength(1);
    const duplicates = await env.DB.prepare(
      `SELECT slug FROM workspace_pages WHERE workspace_id = ? GROUP BY slug HAVING COUNT(*) > 1`,
    )
      .bind(auth.workspaceId)
      .all<{ slug: string }>();
    expect(duplicates.results).toEqual([]);
  });
});

describe('导入的拒绝：可解释结果 + 零写入', () => {
  it('previewRevision 陈旧（期间工作台被改动）返回 409 import_preview_stale，且什么都没写', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await createPageViaApi(auth.authorization, { name: '原有页面', operationId: opId('page-1') });
    const document = buildDocument([
      { id: 'doc-page', name: '导入页', slug: 'doc-page', isDefault: true, instances: [{ id: 'doc-instance', widgetType: DEMO_COUNTER }] },
    ]);

    const preview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);
    // 预览之后改动工作台（新增一个页面）→ 预览令牌作废。
    await createPageViaApi(auth.authorization, { name: '打断预览', operationId: opId('page-2') });

    const pagesBefore = await countRows('workspace_pages');
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);
    const operationsBefore = await countRows('workbench_operations');
    const intentsBefore = await countRows('workbench_operation_intents');
    const operationId = opId('import-stale');

    const applied = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId,
    });
    expect(applied.status).toBe(409);
    const body = errorBodyOf(await applied.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('预览之后工作台');

    expect(await readWorkbenchOperationRow(auth.workspaceId, operationId)).toBeNull();
    await expectNoImportWrites({
      workspaceId: auth.workspaceId,
      pagesBefore,
      stateBefore,
      operationsBefore,
      intentsBefore,
    });
    // 导入页没有被写进去。
    expect((await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null)).toHaveLength(2);
  });

  it('confirm 必须是字面量 true：缺失 / false / 字符串都返回 422', async () => {
    const auth = await seedAuth();
    const document = buildDocument([{ id: 'doc-page', name: '页面', slug: 'doc-page' }]);
    const operationsBefore = await countRows('workbench_operations');
    const pagesBefore = await countRows('workspace_pages');

    // 先用一份**真实且成功**的预览拿到合法令牌：这样三次失败都只可能来自 confirm 本身，
    // 而不是被「缺少 previewToken」这类结构问题提前拦掉。
    const preview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>())
      .preview;
    expect(preview.importable).toBe(true);
    expect(preview.previewToken.length).toBeGreaterThan(0);

    const missing = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      operationId: opId('import-no-confirm'),
    });
    expect(missing.status).toBe(422);
    expect(errorBodyOf(await missing.text()).code).toBe('validation_failed');

    const wrong = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: false,
      operationId: opId('import-false-confirm'),
    });
    expect(wrong.status).toBe(422);

    const notBoolean = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: 'true',
      operationId: opId('import-string-confirm'),
    });
    expect(notBoolean.status).toBe(422);

    expect(await countRows('workbench_operations')).toBe(operationsBefore);
    expect(await countRows('workbench_operation_intents')).toBe(0);
    expect(await countRows('workspace_pages')).toBe(pagesBefore);
  });

  it('结构 / 版本 / 重复 ID / 未知组件 / 危险字段 / 超限文档都被可解释地拒绝，且零写入', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await createPageViaApi(auth.authorization, { name: '原有页面', operationId: opId('page') });
    const pagesBefore = await countRows('workspace_pages');
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);
    const operationsBefore = await countRows('workbench_operations');
    const intentsBefore = await countRows('workbench_operation_intents');

    const cases: { readonly label: string; readonly document: unknown; readonly code: string }[] = [
      {
        label: '结构完全不符',
        document: { kind: 'ff14-hub.workbench', schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION, pages: 'not-an-array' },
        code: 'invalid_shape',
      },
      {
        label: '顶层出现多余字段（Schema 必须是 strict）',
        document: { ...buildDocument([{ id: 'doc-page', name: '导入页', slug: 'doc-page' }]), extraField: true },
        code: 'invalid_shape',
      },
      {
        label: '页面缺少必需字段',
        document: buildDocument([{ id: 'doc-page', name: '导入页', slug: 'doc-page' }], {
          pages: [{ id: 'doc-page', name: '导入页' }],
        }),
        code: 'invalid_shape',
      },
      {
        label: '不支持的 schemaVersion',
        document: buildDocument([{ id: 'doc-page', name: '导入页', slug: 'doc-page' }], { schemaVersion: 99 }),
        code: 'unsupported_version',
      },
      {
        label: '备份内页面 ID 重复',
        document: buildDocument([
          { id: 'dup-page', name: '甲', slug: 'page-a' },
          { id: 'dup-page', name: '乙', slug: 'page-b' },
        ]),
        code: 'duplicate_page_id',
      },
      {
        label: '备份内实例 ID 重复',
        document: buildDocument([
          {
            id: 'doc-page',
            name: '导入页',
            slug: 'doc-page',
            instances: [
              { id: 'dup-instance', widgetType: DEMO_COUNTER },
              { id: 'dup-instance', widgetType: DEMO_COUNTER },
            ],
          },
        ]),
        code: 'duplicate_instance_id',
      },
      {
        label: '未注册的组件类型',
        document: buildDocument([
          { id: 'doc-page', name: '导入页', slug: 'doc-page', instances: [{ id: 'doc-instance', widgetType: 'not-registered' }] },
        ]),
        code: 'unknown_widget_type',
      },
      {
        label: '组件配置里嵌套疑似凭证字段',
        document: buildDocument([
          {
            id: 'doc-page',
            name: '导入页',
            slug: 'doc-page',
            instances: [
              {
                id: 'doc-instance',
                widgetType: DEMO_COUNTER,
                config: { step: 1, label: '偷带凭证', initDelayMs: 0, token: 'should-never-be-stored' },
              },
            ],
          },
        ]),
        code: 'dangerous_field',
      },
      {
        label: '文档超过备份上限',
        document: buildDocument([
          {
            id: 'doc-page',
            name: '导入页',
            slug: 'doc-page',
            instances: [
              {
                id: 'doc-instance',
                widgetType: DEMO_COUNTER,
                // 50 KiB 左右：超过 WORKBENCH_BACKUP_MAX_BYTES（48 KiB），但仍在写请求体上限内。
                config: { step: 1, label: 'x'.repeat(50_000), initDelayMs: 0 },
              },
            ],
          },
        ]),
        code: 'too_large',
      },
    ];

    for (const testCase of cases) {
      const previewResponse = await previewImport(auth.authorization, testCase.document, 'merge');
      expect(previewResponse.status, testCase.label).toBe(200);
      const preview = (await previewResponse.json<PreviewBody>()).preview;
      expect(preview.importable, testCase.label).toBe(false);
      expect(
        preview.problems.map((problem) => problem.code),
        testCase.label,
      ).toContain(testCase.code);

      // 令牌用结构合法的合成值：这些文档在预览阶段就已 `importable === false`，
      // 应用阶段必须由**服务层的可解释拒绝**（而不是 Schema 层缺字段）拦下并零写入。
      const applied = await applyImport(auth.authorization, {
        document: testCase.document,
        mode: 'merge',
        previewRevision: preview.previewRevision,
        previewToken: SYNTHETIC_PREVIEW_TOKEN,
        confirm: true,
        operationId: opId('import-rejected'),
      });
      expect(applied.status, testCase.label).toBe(422);
      expect(errorBodyOf(await applied.text()).code, testCase.label).toBe('validation_failed');
    }

    await expectNoImportWrites({
      workspaceId: auth.workspaceId,
      pagesBefore,
      stateBefore,
      operationsBefore,
      intentsBefore,
    });
  });

  it('危险字段的路径必须能指到嵌套位置（可解释）', async () => {
    const auth = await seedAuth();
    const document = buildDocument([
      {
        id: 'doc-page',
        name: '导入页',
        slug: 'doc-page',
        instances: [
          {
            id: 'doc-instance',
            widgetType: DEMO_COUNTER,
            config: { step: 1, label: '偷带凭证', initDelayMs: 0, password: 'x' },
          },
        ],
      },
    ]);
    const preview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>()).preview;
    const dangerous = preview.problems.find((problem) => problem.code === 'dangerous_field');
    expect(dangerous?.path).toBe('$.pages[0].instances[0].config.password');
    expect(preview.importable).toBe(false);
  });

  it('预览之后模块被停用：旧令牌 apply ⇒ 409 且零写入；重新预览后 apply ⇒ 实例被跳过、模块行一字不变', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const document = buildDocument([
      {
        id: 'doc-page',
        name: '模块页',
        slug: 'module-page',
        isDefault: true,
        instances: [{ id: 'doc-instance', widgetType: DEMO_COUNTER }],
      },
    ]);

    const preview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);
    expect(preview.counts.instancesNew).toBe(1);
    expect(preview.unknownModules).toEqual([]);

    // 预览与落地之间：模块被停用。令牌绑定相关模块的门禁状态与 revision，
    // 因此旧令牌必须失效（而不是「执行时再悄悄跳过实例」——那会改变用户确认过的结果）。
    const disabled = await SELF.fetch(
      `${URLS.meModules}/${DEMO_BASICS_MODULE_ID}`,
      jsonPatch({ action: 'disable', expectedRevision: 1 }, { Authorization: auth.authorization }),
    );
    expect(disabled.status).toBe(200);
    const moduleRowBefore = await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID);
    expect(moduleRowBefore?.status).toBe('disabled');

    const pagesBefore = await countRows('workspace_pages');
    const stateBefore = await readWorkbenchStateRow(auth.workspaceId);
    const operationsBefore = await countRows('workbench_operations');
    const intentsBefore = await countRows('workbench_operation_intents');
    const staleOperationId = opId('import-disabled-after-preview');

    const staleApply = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: staleOperationId,
    });
    expect(staleApply.status).toBe(409);
    const staleBody = errorBodyOf(await staleApply.text());
    expect(staleBody.code).toBe('conflict');
    expect(staleBody.message).toContain('预览之后工作台');

    // 零写入：页面、实例、模块行、幂等记录（及其 0007 指纹行）全都没动。
    expect(await readWorkbenchOperationRow(auth.workspaceId, staleOperationId)).toBeNull();
    await expectNoImportWrites({
      workspaceId: auth.workspaceId,
      pagesBefore,
      stateBefore,
      operationsBefore,
      intentsBefore,
    });
    expect(await countRows('widget_instances')).toBe(0);
    expect(await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toEqual(moduleRowBefore);

    // 重新预览（此时模块已停用）：这一次的令牌才是「用户确认过的计划」。
    const repreview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>())
      .preview;
    expect(repreview.importable).toBe(true);
    expect(repreview.counts.instancesNew).toBe(0);
    expect(repreview.counts.instancesSkipped).toBe(1);
    expect(repreview.previewToken).not.toBe(preview.previewToken);

    const applied = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: repreview.previewRevision,
      previewToken: repreview.previewToken,
      confirm: true,
      operationId: opId('import-disabled-repreview'),
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json<ApplyBody>()).result;
    expect(result.pages).toHaveLength(1);
    expect(result.counts.instancesNew).toBe(0);
    expect(result.counts.instancesSkipped).toBe(1);
    expect(result.skipped.map((entry) => entry.widgetType)).toEqual([DEMO_COUNTER]);

    // 页面写进去了，但实例被明确跳过；模块行（状态 / revision / 设置）一字未变。
    const active = (await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null);
    expect(active.map((row) => row.name)).toEqual(['模块页']);
    expect(await countRows('widget_instances')).toBe(0);
    expect(await readModuleRow(auth.workspaceId, DEMO_BASICS_MODULE_ID)).toEqual(moduleRowBefore);
    expect(await countRows('workspace_module_operations')).toBe(0);
  });

  it('导入到模块未启用的工作空间：实例被跳过、模块不会被隐式启用', async () => {
    const auth = await seedAuth();
    // 刻意**不**启用 demo.basics。
    const document = buildDocument([
      {
        id: 'doc-page',
        name: '无模块页面',
        slug: 'no-module',
        isDefault: true,
        instances: [{ id: 'doc-instance', widgetType: DEMO_COUNTER }],
      },
    ]);

    const preview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);
    expect(preview.unknownModules).toHaveLength(1);
    expect(preview.unknownModules[0]).toMatchObject({
      moduleId: DEMO_BASICS_MODULE_ID,
      instanceCount: 1,
      widgetTypes: [DEMO_COUNTER],
      registered: true,
    });
    expect(preview.counts.pagesNew).toBe(1);
    expect(preview.counts.instancesNew).toBe(0);
    expect(preview.counts.instancesSkipped).toBe(1);

    const applied = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-no-module'),
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json<ApplyBody>()).result;
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.widgetType).toBe(DEMO_COUNTER);
    expect(result.counts.instancesSkipped).toBe(1);

    // 页面写进去了，但实例被明确跳过；模块状态**完全没变**（没有被隐式 enable）。
    const active = (await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null);
    expect(active.map((row) => row.name)).toEqual(['无模块页面']);
    const widgetRows = await env.DB.prepare('SELECT COUNT(*) AS count FROM widget_instances WHERE workspace_id = ?')
      .bind(auth.workspaceId)
      .first<{ count: number }>();
    expect(widgetRows?.count).toBe(0);
    expect(await readModuleRows(auth.workspaceId)).toEqual([]);
    expect(await countRows('workspace_module_operations')).toBe(0);
  });
});

describe('容量自洽与空工作空间', () => {
  it('导出上限小于写请求体上限；正常规模的导出必定能被导入', async () => {
    // 「不做导不回来的文件」的前提：导出上限必须小于全局写请求体上限。
    expect(WORKBENCH_BACKUP_MAX_BYTES).toBeLessThan(MAX_JSON_BODY_BYTES);

    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page') });
    await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget'),
      config: { step: 6, label: '正常规模', initDelayMs: 0 },
    });
    const exported = await exportBackup(auth.authorization);
    expect(exported.byteLength).toBeLessThan(WORKBENCH_BACKUP_MAX_BYTES);

    // 同一份导出必须能被导入路径接受（不是「导出得了、导不回来」）。
    const preview = (await (await previewImport(auth.authorization, exported.backup, 'merge')).json<PreviewBody>())
      .preview;
    expect(preview.importable).toBe(true);
    expect(preview.problems).toEqual([]);
  });

  it('空工作空间（零页面）导出成功，并且这份文档可以导入', async () => {
    const auth = await seedAuth();
    expect((await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null)).toHaveLength(0);

    const exported = await exportBackup(auth.authorization);
    expect(exported.backup['pages']).toEqual([]);
    expect(exported.byteLength).toBeLessThan(WORKBENCH_BACKUP_MAX_BYTES);

    const previewResponse = await previewImport(auth.authorization, exported.backup, 'merge');
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json<PreviewBody>()).preview;
    expect(preview.problems).toEqual([]);
    expect(preview.importable).toBe(true);
    expect(preview.counts.pagesNew).toBe(0);

    const applied = await applyImport(auth.authorization, {
      document: exported.backup,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('import-empty'),
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json<ApplyBody>()).result;
    expect(result.pages).toEqual([]);
    expect(result.defaultPageId).toBeNull();
    expect((await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null)).toHaveLength(0);
  });
});

/** 读取工作空间全部模块行（用于断言「没有隐式启用模块」）。 */
async function readModuleRows(workspaceId: string): Promise<{ module_id: string; status: string }[]> {
  const result = await env.DB.prepare('SELECT module_id, status FROM workspace_modules WHERE workspace_id = ?')
    .bind(workspaceId)
    .all<{ module_id: string; status: string }>();
  return result.results;
}

// ---------------------------------------------------------------------------
// Part B：复核回归测试（B2 导出一致性 / B3 恢复原子性 / B4 预览令牌绑定）
// ---------------------------------------------------------------------------

const BREAKPOINTS = ['desktop', 'tablet', 'mobile'] as const;

/**
 * 备份实例的 `layouts` 形状。
 *
 * 显式写出 `| undefined`（而不是 `Partial<Record<...>>`）：Schema 推断出来的是
 * 「可选且可能显式为 undefined」，在 `exactOptionalPropertyTypes` 下两者不兼容。
 */
type BackupInstanceLayouts = {
  readonly desktop?: GridRect | undefined;
  readonly tablet?: GridRect | undefined;
  readonly mobile?: GridRect | undefined;
};

/** 断言某个实例的三个断点矩形都存在，且归属是它自己。 */
function assertInstanceCoversAllBreakpoints(
  instance: { readonly id: string; readonly layouts: BackupInstanceLayouts },
): void {
  for (const breakpoint of BREAKPOINTS) {
    const rect = instance.layouts[breakpoint];
    expect(rect, `实例 ${instance.id} 缺少 ${breakpoint} 的矩形`).toBeDefined();
    expect(rect?.i, `实例 ${instance.id}/${breakpoint}`).toBe(instance.id);
  }
}

/** 收集一组实例在**同一个断点**上的矩形（不重叠必须按断点分别判断）。 */
function rectsAtBreakpoint(
  instances: readonly { readonly layouts: BackupInstanceLayouts }[],
  breakpoint: LayoutBreakpoint,
): GridRect[] {
  const rects: GridRect[] = [];
  for (const instance of instances) {
    const rect = instance.layouts[breakpoint];
    if (rect !== undefined) {
      rects.push(rect);
    }
  }
  return rects;
}

/**
 * 「这一次导入/恢复没有写任何东西」的全量计数器。
 *
 * 比单个 `expectNoImportWrites` 更严：把 0007 的意图指纹行与撤销点行也算进来，
 * 因此「被拒绝的替换导入偷偷写了一份 pre_import 备份」这类半状态会被抓住。
 */
interface ImportWriteCounters {
  readonly pages: number;
  readonly operations: number;
  readonly intents: number;
  readonly backups: number;
  readonly state: { readonly revision: number; readonly updated_at: number } | null;
}

async function importWriteCounters(workspaceId: string): Promise<ImportWriteCounters> {
  return {
    pages: await countRows('workspace_pages'),
    operations: await countRows('workbench_operations'),
    intents: await countRows('workbench_operation_intents'),
    backups: await countRows('workbench_backups'),
    state: await readWorkbenchStateRow(workspaceId),
  };
}

/** 工作台的**逐字节**快照（页面/实例/布局/撤销点/修订号），用于「什么都没变」的强断言。 */
async function workbenchSnapshot(workspaceId: string): Promise<string> {
  const pages = await readPageRows(workspaceId);
  const instances: unknown[] = [];
  const layouts: unknown[] = [];
  for (const page of pages) {
    instances.push(...(await readInstanceRows(page.id)));
    layouts.push(...(await readLayoutRows(page.id)));
  }
  const backups = await env.DB.prepare(
    'SELECT id, kind, schema_version, payload_json, created_at, consumed_at FROM workbench_backups WHERE workspace_id = ? ORDER BY id ASC',
  )
    .bind(workspaceId)
    .all();
  return JSON.stringify({
    pages,
    instances,
    layouts,
    backups: backups.results,
    counters: await importWriteCounters(workspaceId),
  });
}

/** 恢复请求（必须回显 `expectedRevision`）。 */
function restoreRequest(
  authorization: string,
  backupId: string,
  body: { readonly operationId: string; readonly expectedRevision: number },
): Promise<Response> {
  return SELF.fetch(backupRestoreUrl(backupId), jsonPost(body, { Authorization: authorization }));
}

/** 走一次 replace 导入并返回它写下的 pre_import 撤销点。 */
async function replaceImportWithBackup(
  authorization: string,
  document: unknown,
  label: string,
): Promise<{ readonly backupId: string; readonly result: ApplyBody['result'] }> {
  const { apply } = await previewThenApplyViaApi(authorization, {
    document,
    mode: 'replace',
    operationId: opId(label),
  });
  expect(apply.status).toBe(200);
  const body = await apply.json<ApplyBody>();
  expect(body.result.backupId).not.toBeNull();
  return { backupId: body.result.backupId ?? '', result: body.result };
}

/** 仅在本文件使用的「阻断页面插入」触发器（用于证明恢复批次整体回滚）。 */
const RESTORE_ROLLBACK_TRIGGER = 'test_restore_rollback_guard';

async function createPagesInsertBlocker(): Promise<void> {
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS ${RESTORE_ROLLBACK_TRIGGER}
       BEFORE INSERT ON workspace_pages
       BEGIN
         SELECT RAISE(ABORT, 'UNIQUE constraint failed: workspace_pages.workspace_id, workspace_pages.slug');
       END`,
  ).run();
}

async function dropPagesInsertBlocker(): Promise<void> {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${RESTORE_ROLLBACK_TRIGGER}`).run();
}

/** 配一台同工作空间的第二设备：用于「另一台设备改了工作台」这类真实跨设备场景。 */
async function pairSecondDevice(authorization: string): Promise<string> {
  const pairing = await createPairingViaApi(authorization);
  const claim = await SELF.fetch(
    URLS.pairingClaim,
    jsonPost({ pairingCode: pairing.pairingCode, deviceName: '第二台设备' }),
  );
  expect(claim.status).toBe(201);
  const body = await claim.json<{ deviceToken: string }>();
  return `Bearer ${body.deviceToken}`;
}

describe('B2 导出一致性', () => {
  it('2 页 3 实例的导出：每个实例在三个断点都有矩形，文档通过 workbenchBackupDocumentSchema', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const home = await createPageViaApi(auth.authorization, { name: '首页', operationId: opId('export-home') });
    const fishing = await createPageViaApi(auth.authorization, { name: '钓鱼页', operationId: opId('export-fishing') });
    const first = await addWidgetViaApi(auth.authorization, home.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('export-w1'),
      config: { step: 1, label: '甲', initDelayMs: 0 },
    });
    const second = await addWidgetViaApi(auth.authorization, home.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('export-w2'),
      config: { step: 2, label: '乙', initDelayMs: 10 },
      hidden: true,
    });
    const third = await addWidgetViaApi(auth.authorization, fishing.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('export-w3'),
      config: { step: 3, label: '丙', initDelayMs: 20 },
    });
    // 覆盖「显式矩形」这条来源：手动保存 desktop。
    const desktopBefore = (await readLayoutsViaApi(auth.authorization, home.page.id)).find(
      (layout) => layout.breakpoint === 'desktop',
    );
    const saved = await saveLayoutRequest(auth.authorization, home.page.id, {
      breakpoint: 'desktop',
      baseRevision: desktopBefore?.revision ?? 0,
      rects: [
        { i: first.instance.id, x: 0, y: 0, w: 4, h: 3 },
        { i: second.instance.id, x: 4, y: 0, w: 4, h: 3 },
      ],
      operationId: opId('export-layout'),
    });
    expect(saved.status).toBe(200);

    const exported = await exportBackup(auth.authorization);
    const parsed = workbenchBackupDocumentSchema.safeParse(exported.backup);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    if (!parsed.success) {
      throw new Error('导出文档未通过自身契约校验');
    }
    const document = parsed.data;
    expect(document.pages).toHaveLength(2);
    const instances = document.pages.flatMap((page) => page.instances);
    expect(instances).toHaveLength(3);
    expect(new Set(document.pages.map((page) => page.id)).size).toBe(2);
    expect(new Set(instances.map((instance) => instance.id)).size).toBe(3);

    const expectedIds = new Set([first.instance.id, second.instance.id, third.instance.id]);
    for (const instance of instances) {
      expect(expectedIds.has(instance.id), `意外的实例 ${instance.id}`).toBe(true);
      // 三个断点都必须有矩形，且矩形归属就是实例自身。
      assertInstanceCoversAllBreakpoints(instance);
    }
    // 导出的矩形必须两两不重叠（文档本身也要是一份合法布局），按页面、按断点分别判断。
    for (const docPage of document.pages) {
      for (const breakpoint of BREAKPOINTS) {
        assertNoOverlap(rectsAtBreakpoint(docPage.instances, breakpoint));
      }
    }
    // 显式保存过的 desktop 矩形被原样导出。
    const exportedFirst = instances.find((instance) => instance.id === first.instance.id);
    expect(exportedFirst?.layouts.desktop).toMatchObject({ x: 0, y: 0, w: 4, h: 3 });
    expect(exportedFirst?.layouts.tablet).toBeDefined();
    expect(exportedFirst?.layouts.mobile).toBeDefined();
  });

  it('导出是原子一致快照：与「新增页面 + 改布局」并发时，两份文档都内部自洽（无混合态）', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '基线页', operationId: opId('snapshot-page') });
    const widget = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('snapshot-widget'),
    });

    // 并发变更：新增一个页面，并改动基线页的 desktop 布局。
    const mutate = async (): Promise<void> => {
      await createPageViaApi(auth.authorization, { name: '并发新增页', operationId: opId('snapshot-mutate-page') });
      const desktop = (await readLayoutsViaApi(auth.authorization, page.page.id)).find(
        (layout) => layout.breakpoint === 'desktop',
      );
      const saved = await saveLayoutRequest(auth.authorization, page.page.id, {
        breakpoint: 'desktop',
        baseRevision: desktop?.revision ?? 0,
        rects: [{ i: widget.instance.id, x: 2, y: 1, w: 4, h: 3 }],
        operationId: opId('snapshot-mutate-layout'),
      });
      expect([200, 409]).toContain(saved.status);
    };

    const [firstExport, , secondExport] = await Promise.all([
      exportBackup(auth.authorization),
      mutate(),
      exportBackup(auth.authorization),
    ]);

    for (const [label, exported] of [
      ['第一次导出', firstExport],
      ['第二次导出', secondExport],
    ] as const) {
      const parsed = workbenchBackupDocumentSchema.safeParse(exported.backup);
      expect(parsed.success, `${label}未通过契约校验`).toBe(true);
      if (!parsed.success) {
        continue;
      }
      const document = parsed.data;
      // 内部自洽：页面 ID 唯一；每个出现的实例在三个断点都有矩形（不允许「有页面缺布局」的混合态）。
      expect(new Set(document.pages.map((page) => page.id)).size, label).toBe(document.pages.length);
      const allInstanceIds = document.pages.flatMap((docPage) => docPage.instances.map((instance) => instance.id));
      expect(new Set(allInstanceIds).size, label).toBe(allInstanceIds.length);
      expect(allInstanceIds, label).toContain(widget.instance.id);
      for (const docPage of document.pages) {
        for (const instance of docPage.instances) {
          assertInstanceCoversAllBreakpoints(instance);
        }
        for (const breakpoint of BREAKPOINTS) {
          assertNoOverlap(rectsAtBreakpoint(docPage.instances, breakpoint));
        }
      }
    }
  });
});

describe('B3 恢复原子性与一次性', () => {
  it('restore 带 expectedRevision ⇒ 200：撤销点在同事务里被消费，恢复本身又写一份新的 pre_import', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const oldPage = await createPageViaApi(auth.authorization, { name: '旧一', operationId: opId('b3-old') });
    const oldWidget = await addWidgetViaApi(auth.authorization, oldPage.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('b3-old-widget'),
      config: { step: 8, label: '旧配置', initDelayMs: 0 },
    });
    const document = buildDocument([
      {
        id: 'b3-doc-page',
        name: '新页面',
        slug: 'b3-brand-new',
        isDefault: true,
        instances: [{ id: 'b3-doc-instance', widgetType: DEMO_COUNTER }],
      },
    ]);
    const { backupId } = await replaceImportWithBackup(auth.authorization, document, 'b3-replace');
    expect((await readBackupRow(auth.workspaceId, backupId))?.consumed_at).toBeNull();
    const backupsBefore = await countRows('workbench_backups');
    const revision = await readWorkbenchStateRevision(auth.workspaceId);

    const restored = await restoreRequest(auth.authorization, backupId, {
      operationId: opId('b3-restore'),
      expectedRevision: revision,
    });
    expect(restored.status).toBe(200);
    const restoredBody = await restored.json<{ result: ApplyBody['result']; replayed: boolean }>();
    expect(restoredBody.replayed).toBe(false);
    expect(restoredBody.result.pages.map((page) => page.name).sort()).toEqual(['旧一']);

    // 消费与恢复在同一个事务里：撤销点已消费，恢复本身也留下了一份新的可撤销备份。
    expect((await readBackupRow(auth.workspaceId, backupId))?.consumed_at).not.toBeNull();
    expect(restoredBody.result.backupId).not.toBeNull();
    const newBackup = await readBackupRow(auth.workspaceId, restoredBody.result.backupId ?? '');
    expect(newBackup?.kind).toBe('pre_import');
    expect(newBackup?.consumed_at).toBeNull();
    expect(await countRows('workbench_backups')).toBe(backupsBefore + 1);

    // 页面回到替换前（D9：导入路径**总是**重新分配 ID，因此恢复出来的是新行，不是原 ID）。
    const active = (await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null);
    expect(active.map((row) => row.name)).toEqual(['旧一']);
    const restoredPage = active[0];
    expect(restoredPage).toBeDefined();
    if (restoredPage !== undefined) {
      const restoredInstances = await readInstancesViaApi(auth.authorization, restoredPage.id);
      expect(restoredInstances).toHaveLength(1);
      expect(restoredInstances[0]?.config).toEqual({ step: 8, label: '旧配置', initDelayMs: 0 });
    }
    // 原实例行自始至终没有被硬删除（替换只墓碑页面）。
    expect((await readInstanceRow(auth.workspaceId, oldWidget.instance.id))?.deleted_at).toBeNull();
  });

  it('同 operationId 重试 ⇒ 200 replayed 且零额外写入；换 operationId ⇒ 409 backup_consumed 且工作台逐字节未变', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await createPageViaApi(auth.authorization, { name: '旧一', operationId: opId('b3r-old') });
    const document = buildDocument([
      { id: 'b3r-doc-page', name: '新页面', slug: 'b3r-new', isDefault: true, instances: [] },
    ]);
    const { backupId } = await replaceImportWithBackup(auth.authorization, document, 'b3r-replace');
    const revision = await readWorkbenchStateRevision(auth.workspaceId);
    const restoreOperationId = opId('b3r-restore');

    const first = await restoreRequest(auth.authorization, backupId, {
      operationId: restoreOperationId,
      expectedRevision: revision,
    });
    expect(first.status).toBe(200);
    const afterFirstRestore = await workbenchSnapshot(auth.workspaceId);

    // 同一 operationId 原样重试：幂等短路必须发生在「已消费」检查**之前**。
    const replay = await restoreRequest(auth.authorization, backupId, {
      operationId: restoreOperationId,
      expectedRevision: revision,
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json<{ replayed: boolean; result: ApplyBody['result'] }>();
    expect(replayBody.replayed).toBe(true);
    expect(await workbenchSnapshot(auth.workspaceId)).toBe(afterFirstRestore);

    // 换一个 operationId：撤销点已经被消费，必须 409 且什么都不写。
    const again = await restoreRequest(auth.authorization, backupId, {
      operationId: opId('b3r-restore-again'),
      expectedRevision: revision,
    });
    expect(again.status).toBe(409);
    const againBody = errorBodyOf(await again.text());
    expect(againBody.code).toBe('conflict');
    expect(againBody.message).toContain('备份已被使用过');
    // 页面行逐字节未变（含实例/布局/撤销点/计数器）。
    expect(await workbenchSnapshot(auth.workspaceId)).toBe(afterFirstRestore);
  });

  it('陈旧 expectedRevision ⇒ 409 backup_revision_conflict，撤销点不被消费且零写入；随后仍可正常恢复', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await createPageViaApi(auth.authorization, { name: '旧一', operationId: opId('b3s-old') });
    const document = buildDocument([
      { id: 'b3s-doc-page', name: '新页面', slug: 'b3s-new', isDefault: true, instances: [] },
    ]);
    const { backupId } = await replaceImportWithBackup(auth.authorization, document, 'b3s-replace');
    const revision = await readWorkbenchStateRevision(auth.workspaceId);
    const before = await workbenchSnapshot(auth.workspaceId);

    const stale = await restoreRequest(auth.authorization, backupId, {
      operationId: opId('b3s-restore-stale'),
      expectedRevision: revision + 1,
    });
    expect(stale.status).toBe(409);
    const staleBody = errorBodyOf(await stale.text());
    expect(staleBody.code).toBe('conflict');
    expect(staleBody.message).toContain('工作台已被其他设备修改');
    // 关键的「不消费」：失败的恢复不能烧掉撤销点。
    expect((await readBackupRow(auth.workspaceId, backupId))?.consumed_at).toBeNull();
    expect(await workbenchSnapshot(auth.workspaceId)).toBe(before);

    // 用正确的 revision 仍然可以恢复（证明上面的失败确实没有留下任何痕迹）。
    const ok = await restoreRequest(auth.authorization, backupId, {
      operationId: opId('b3s-restore-ok'),
      expectedRevision: revision,
    });
    expect(ok.status).toBe(200);
  });

  it('恢复批次中途失败（页面插入被触发器阻断）：撤销点不被消费，页面、备份与计数器全部回滚', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await createPageViaApi(auth.authorization, { name: '旧一', operationId: opId('b3a-old') });
    const document = buildDocument([
      { id: 'b3a-doc-page', name: '新页面', slug: 'b3a-new', isDefault: true, instances: [] },
    ]);
    const { backupId } = await replaceImportWithBackup(auth.authorization, document, 'b3a-replace');
    const revision = await readWorkbenchStateRevision(auth.workspaceId);
    const before = await workbenchSnapshot(auth.workspaceId);

    await createPagesInsertBlocker();
    try {
      const response = await restoreRequest(auth.authorization, backupId, {
        operationId: opId('b3a-restore-blocked'),
        expectedRevision: revision,
      });
      // 事务失败如实报告为服务器内部错误（绝不假装成功）。
      expect(response.status).toBe(500);
      expect(errorBodyOf(await response.text()).code).toBe('internal_error');
      // 撤销点没有被消费（同批的 consume 语句也回滚了）。
      expect((await readBackupRow(auth.workspaceId, backupId))?.consumed_at).toBeNull();
      expect(await workbenchSnapshot(auth.workspaceId)).toBe(before);
    } finally {
      await dropPagesInsertBlocker();
    }

    // 触发器移除后同一份撤销点仍可恢复：证明刚才的失败确实是整批回滚，而不是撤销点被烧掉。
    const recovered = await restoreRequest(auth.authorization, backupId, {
      operationId: opId('b3a-restore-after'),
      expectedRevision: revision,
    });
    expect(recovered.status).toBe(200);
  });
});

describe('B4 预览令牌绑定', () => {
  it('同一 revision、不同文档：拿文档 A 的令牌 apply 文档 B ⇒ 409 且零写入', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const documentA = buildDocument([{ id: 'b4-a-page', name: '文档甲页', slug: 'b4-doc-a' }]);
    const documentB = buildDocument([{ id: 'b4-b-page', name: '文档乙页', slug: 'b4-doc-b' }]);

    const preview = (await (await previewImport(auth.authorization, documentA, 'merge')).json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);
    const before = await importWriteCounters(auth.workspaceId);

    const applied = await applyImport(auth.authorization, {
      document: documentB,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('b4-different-document'),
    });
    expect(applied.status).toBe(409);
    const body = errorBodyOf(await applied.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('预览之后工作台');
    expect(await importWriteCounters(auth.workspaceId)).toEqual(before);
  });

  it('同一文档、不同 mode：preview merge 的令牌不能用于 replace ⇒ 409 且零写入（不写 pre_import 备份）', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    await createPageViaApi(auth.authorization, { name: '原有页面', operationId: opId('b4-mode-existing') });
    const document = buildDocument([{ id: 'b4-mode-page', name: '模式页', slug: 'b4-mode' }]);

    const preview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);
    const before = await importWriteCounters(auth.workspaceId);

    const applied = await applyImport(auth.authorization, {
      document,
      mode: 'replace',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('b4-different-mode'),
    });
    expect(applied.status).toBe(409);
    expect(errorBodyOf(await applied.text()).message).toContain('预览之后工作台');
    const after = await importWriteCounters(auth.workspaceId);
    expect(after).toEqual(before);
    // replace 会写 pre_import 备份：令牌失效时必须一份都没写。
    expect(after.backups).toBe(before.backups);
    expect((await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null)).toHaveLength(1);
  });

  it('预览之后另一台设备改了工作台：旧令牌 ⇒ 409 且零写入', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const document = buildDocument([{ id: 'b4-client-page', name: '导入页', slug: 'b4-client' }]);
    const preview = (await (await previewImport(auth.authorization, document, 'merge')).json<PreviewBody>()).preview;
    expect(preview.importable).toBe(true);

    // 真实的第二台设备（配对产生独立 Token），在同一个工作空间里新增页面。
    const secondAuthorization = await pairSecondDevice(auth.authorization);
    await createPageViaApi(secondAuthorization, { name: '第二台设备建的页面', operationId: opId('b4-second-device') });
    const before = await importWriteCounters(auth.workspaceId);

    const applied = await applyImport(auth.authorization, {
      document,
      mode: 'merge',
      previewRevision: preview.previewRevision,
      previewToken: preview.previewToken,
      confirm: true,
      operationId: opId('b4-stale-client'),
    });
    expect(applied.status).toBe(409);
    expect(errorBodyOf(await applied.text()).message).toContain('预览之后工作台');
    expect(await importWriteCounters(auth.workspaceId)).toEqual(before);
    // 导入页没有被写进去：活跃页面仍然只有第二台设备建的那一页。
    const active = (await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null);
    expect(active.map((row) => row.name)).toEqual(['第二台设备建的页面']);
    expect(active.map((row) => row.name)).not.toContain('导入页');
  });

  it('有效路径：预览 → 状态未变时 apply ⇒ 200，且令牌只对这份文档+模式有效', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const document = buildDocument([
      { id: 'b4-ok-page', name: '有效页', slug: 'b4-ok', instances: [{ id: 'b4-ok-instance', widgetType: DEMO_COUNTER }] },
    ]);
    const { previewBody, apply } = await previewThenApply(auth.authorization, {
      document,
      mode: 'merge',
      operationId: opId('b4-valid'),
      confirm: true,
    });
    expect(previewBody.preview.importable).toBe(true);
    expect(previewBody.preview.previewToken.length).toBeGreaterThan(0);
    expect(apply.status).toBe(200);
    const body = await apply.json<ApplyBody>();
    expect(body.replayed).toBe(false);
    expect(body.result.counts.instancesNew).toBe(1);
    const active = (await readPageRows(auth.workspaceId)).filter((row) => row.deleted_at === null);
    expect(active.map((row) => row.name)).toEqual(['有效页']);
  });
});
