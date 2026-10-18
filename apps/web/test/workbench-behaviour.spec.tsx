/**
 * 工作台行为回归（阶段 03 / HUB-045 · HUB-046 · HUB-049 · HUB-054）。
 *
 * 三组：
 * 1. **未保存确认横幅**：页面切换 / 断点切换 / 退出编辑三个入口，三个选择各司其职；
 *    切断点绝不把桌面草稿写进手机布局，也不丢桌面草稿。
 * 2. **应用层集成**（真实 `AppShell` + 受控 fetch 替身）：零组件页面下 Shell 入口仍可达；
 *    凭证代际变化清空工作台并丢弃在途响应；普通视图切换保留页面与草稿。
 * 3. **模板 / 备份 / 导入**：`honestyNote` 逐字渲染、应用模板必须显式确认、
 *    导出产生真实下载 + 只读文本、导入必须走文件输入 → 预览 → 显式确认。
 *
 * 360px 无横向滚动：jsdom 不做布局计算，因此这里用**CSS 契约测试**保证
 * （媒体查询、`overflow-x`、触控目标下限、`max-width: 100%`），并在注释里说明这一点。
 */
// @vitest-environment jsdom
/// <reference types="node" />
/**
 * 说明：`test.css` 在 vitest 里是关闭的（CSS 会被替换成空串），因此样式契约
 * 直接从磁盘读源文件；这是**静态契约**断言，不是布局测量。
 */
import {
  API_ROUTES,
  BREAKPOINT_COLUMNS,
  BUILTIN_MODULE_MANIFESTS,
  BUILTIN_WORKBENCH_TEMPLATES,
  type ApiErrorBody,
  type BreakpointLayout,
  type GridRect,
  type LayoutBreakpoint,
  type ModuleDescriptor,
  type WidgetInstance,
  type WorkspacePage,
} from '@ff14-hub/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 窄屏不横向溢出 / 触控目标 / 焦点可见：vitest 关闭了 CSS 处理，因此直接读源样式做**规则契约**断言
// （jsdom 不做布局计算，无法测量 scrollWidth；因此这里断言保证不溢出的那些规则确实存在）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppShell } from '../src/app/shell/AppShell';
import type { ApiResult } from '../src/lib/api-client';
import type { ModuleAccess } from '../src/app/widgets/types';
import { WorkbenchView } from '../src/app/workbench/WorkbenchView';
import { useWorkbench } from '../src/app/workbench/use-workbench';
import type {
  ApplyTemplateRequest,
  BackupSummary,
  ImportApplyRequest,
  ImportPreviewRequest,
  RestoreBackupRequest,
  SaveLayoutRequest,
  TemplateSummary,
  WorkbenchApi,
} from '../src/app/workbench/workbench-api';
import { createWidgetLookup } from '../src/app/workbench/widget-lookup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 共用：契约数据与替身
// ---------------------------------------------------------------------------

const DESCRIPTORS: readonly ModuleDescriptor[] = BUILTIN_MODULE_MANIFESTS.map((manifest) => ({
  id: manifest.id,
  version: manifest.version,
  displayName: manifest.displayName,
  capabilities: [...manifest.capabilities],
  widgets: manifest.widgets.map((widget) => ({ ...widget })),
  routes: (manifest.routes ?? []).map((route) => ({ ...route })),
  settingsSchemaVersion: manifest.settingsSchemaVersion,
}));

const LOOKUP = createWidgetLookup(DESCRIPTORS);

/** 与 `GET /me/workbench/templates` 的服务端映射**逐字**相同（含 honestyNote）。 */
const TEMPLATES: readonly TemplateSummary[] = BUILTIN_WORKBENCH_TEMPLATES.map((template) => ({
  id: template.id,
  displayName: template.displayName,
  description: template.description,
  honestyNote: template.honestyNote,
  isDemoOnly: template.isDemoOnly,
  isEmpty: template.isEmpty,
  recommendedDefault: template.recommendedDefault,
  pageNames: template.pages.map((page) => page.name),
  widgetCount: template.pages.reduce((sum, page) => sum + page.widgets.length, 0),
}));

const EXPORT_DOCUMENT = {
  kind: 'ff14-hub.workbench',
  schemaVersion: 1,
  exportedAt: 1,
  appVersion: '0.0.0',
  moduleVersions: {},
  widgetConfigVersions: {},
  pages: [],
};

/** 预览令牌：服务端给出的计划摘要令牌，导入时必须**原样**回显（≥16 字符）。 */
const PREVIEW_TOKEN = 'preview-token-0123456789abcdef';

/** 快照 revision（替身固定为 1）：备份恢复必须把它作为 expectedRevision 提交。 */
const SNAPSHOT_REVISION = 1;

const MANUAL_BACKUP: BackupSummary = {
  id: 'b-manual-1',
  kind: 'manual',
  schemaVersion: 1,
  createdAt: 0,
  consumedAt: null,
};

function importFile(name: string, body: unknown = EXPORT_DOCUMENT): File {
  return new File([JSON.stringify(body)], name, { type: 'application/json' });
}

function page(id: string, name: string, overrides: Partial<WorkspacePage> = {}): WorkspacePage {
  return {
    id,
    name,
    slug: id,
    isDefault: false,
    sortOrder: 0,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function instance(id: string, widgetType: string, pageId: string, overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  return {
    id,
    pageId,
    moduleId: 'demo.basics',
    widgetType,
    config: { step: 1, label: '演示计数', initDelayMs: 0 },
    configVersion: 1,
    hidden: false,
    revision: 1,
    createdRevision: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function layoutOf(breakpoint: LayoutBreakpoint, revision: number, rects: readonly GridRect[]): BreakpointLayout {
  return { breakpoint, revision, cols: BREAKPOINT_COLUMNS[breakpoint], rects: [...rects] };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, status: 200, data };
}

function failure(code: ApiErrorBody['code'], status: number, message: string): ApiResult<never> {
  return { ok: false, status, error: { code, message, requestId: 'req-test' } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FakeCalls {
  readonly save: { pageId: string; request: SaveLayoutRequest }[];
  readonly applyTemplate: ApplyTemplateRequest[];
  readonly previewImport: ImportPreviewRequest[];
  readonly applyImport: ImportApplyRequest[];
  readonly restoreBackup: { backupId: string; request: RestoreBackupRequest }[];
  readonly createPage: { name: string; operationId: string }[];
  /** 每次读取工作台快照追加一项：用于证明「读不到 revision 时会重新读一次」。 */
  readonly readSnapshot: number[];
}

function createFake(
  options: {
    readonly pages?: readonly WorkspacePage[];
    readonly previewProblems?: boolean;
    /** `GET /me/workbench/backups` 的返回（默认空列表）。 */
    readonly backups?: readonly BackupSummary[];
    /** 恢复备份返回 409：用于验证「工作台已变化」的处理与「不自动重试」。 */
    readonly restoreBackupConflict?: boolean;
    /** 应用导入返回 409：预览令牌过期，必须重新预览。 */
    readonly applyImportConflict?: boolean;
    /** 读取快照失败：用于验证「拿不到 revision 就拒绝恢复」，绝不用猜测值提交。 */
    readonly snapshotFailure?: boolean;
  } = {},
) {
  const pages = [...(options.pages ?? [page('p1', '日常', { isDefault: true }), page('p2', '钓鱼', { sortOrder: 1 })])];
  const instances = new Map<string, WidgetInstance[]>([
    ['p1', [instance('w1', 'demo-counter', 'p1'), instance('w2', 'demo-counter', 'p1')]],
    ['p2', []],
  ]);
  const layouts = new Map<string, BreakpointLayout>([
    [
      'p1#desktop',
      layoutOf('desktop', 3, [
        { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
        { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
      ]),
    ],
    [
      'p1#tablet',
      layoutOf('tablet', 5, [
        { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
        { i: 'w2', x: 4, y: 0, w: 4, h: 3 },
      ]),
    ],
    [
      'p1#mobile',
      layoutOf('mobile', 7, [
        { i: 'w1', x: 0, y: 4, w: 4, h: 3 },
        { i: 'w2', x: 0, y: 7, w: 4, h: 3 },
      ]),
    ],
  ]);
  const calls: FakeCalls = {
    save: [],
    applyTemplate: [],
    previewImport: [],
    applyImport: [],
    restoreBackup: [],
    createPage: [],
    readSnapshot: [],
  };
  /** 备份列表是可变的：恢复会在同一事务里再写一份撤销点，列表因此会多一行。 */
  const backups: BackupSummary[] = [...(options.backups ?? [])];

  const api: WorkbenchApi = {
    readProfile: () =>
      Promise.resolve(
        ok({
          id: 'ws-3f2a91c4',
          region: 'cn',
          timezone: 'Asia/Shanghai',
          locale: 'zh-CN',
          createdAt: 0,
          updatedAt: 0,
        }),
      ),
    readSnapshot: () => {
      calls.readSnapshot.push(1);
      if (options.snapshotFailure === true) {
        return Promise.resolve(failure('internal_error', 500, '数据库暂时不可用。'));
      }
      return Promise.resolve(
        ok({
          pages,
          defaultPageId: pages.find((candidate) => candidate.isDefault)?.id ?? null,
          revision: SNAPSHOT_REVISION,
          limits: { maxPages: 30, maxWidgetsPerPage: 40, maxWidgetConfigBytes: 4096 },
        }),
      );
    },
    listPages: () => Promise.resolve(ok({ pages, defaultPageId: pages[0]?.id ?? null })),
    createPage: (request) => {
      calls.createPage.push({ name: request.name, operationId: request.operationId });
      const created = page(`p${String(pages.length + 1)}`, request.name);
      pages.push(created);
      instances.set(created.id, []);
      return Promise.resolve(ok({ page: created, skipped: [], replayed: false }));
    },
    updatePage: (pageId, request) =>
      Promise.resolve(ok({ page: page(pageId, request.name ?? '页面'), noop: false, replayed: false })),
    deletePage: (pageId) =>
      Promise.resolve(
        ok({ deletedPageId: pageId, defaultPageId: null, remainingPages: 0, notice: null, replayed: false }),
      ),
    restorePage: (pageId) => Promise.resolve(ok({ page: page(pageId, '已恢复'), defaultPageId: pageId, replayed: false })),
    readLayouts: (pageId) =>
      Promise.resolve(
        ok({
          layouts: (['desktop', 'tablet', 'mobile'] as const).map(
            (breakpoint) => layouts.get(`${pageId}#${breakpoint}`) ?? layoutOf(breakpoint, 0, []),
          ),
        }),
      ),
    saveLayout: (pageId, request) => {
      calls.save.push({ pageId, request });
      const saved = layoutOf(request.breakpoint, request.baseRevision + 1, request.rects);
      layouts.set(`${pageId}#${request.breakpoint}`, saved);
      return Promise.resolve(ok({ layout: saved, replayed: false }));
    },
    listInstances: (pageId) => Promise.resolve(ok({ instances: instances.get(pageId) ?? [] })),
    addInstance: () => Promise.resolve(failure('conflict', 409, '所属模块当前不可用。')),
    updateInstance: (instanceId) =>
      Promise.resolve(ok({ instance: instance(instanceId, 'demo-counter', 'p1'), noop: false, replayed: false })),
    deleteInstance: (instanceId) => Promise.resolve(ok({ widgetId: instanceId, replayed: false })),
    duplicateInstance: (instanceId) =>
      Promise.resolve(ok({ instance: instance(`${instanceId}-copy`, 'demo-counter', 'p1'), replayed: false })),
    listTemplates: () => Promise.resolve(ok({ templates: TEMPLATES })),
    applyTemplate: (request) => {
      calls.applyTemplate.push(request);
      return Promise.resolve(
        ok({
          mode: request.mode,
          templateId: request.templateId,
          pages,
          defaultPageId: pages[0]?.id ?? null,
          skipped: [],
          replayed: false,
        }),
      );
    },
    exportBackup: () =>
      Promise.resolve(ok({ backup: EXPORT_DOCUMENT, byteLength: 128, maxBytes: 49152 })),
    listBackups: () => Promise.resolve(ok({ backups: [...backups] })),
    restoreBackup: (backupId, request) => {
      calls.restoreBackup.push({ backupId, request });
      if (options.restoreBackupConflict === true) {
        return Promise.resolve(failure('conflict', 409, '工作台已被其他设备修改，请重新读取备份列表后再恢复。'));
      }
      // 真实服务端会在恢复的同一事务里再留一份撤销点，因此列表会多出一行。
      backups.unshift({
        id: 'b-pre-import-after-restore',
        kind: 'pre_import',
        schemaVersion: 1,
        createdAt: 1,
        consumedAt: null,
      });
      return Promise.resolve(
        ok({
          result: {
            mode: 'replace',
            backupId: 'b1',
            pages,
            defaultPageId: null,
            counts: {
              pagesNew: 1,
              pagesReplaced: 0,
              pagesSkipped: 0,
              instancesNew: 0,
              instancesReplaced: 0,
              instancesSkipped: 0,
            },
            skipped: [],
            warnings: [],
          },
          notice: '已恢复到该备份的状态。',
          replayed: false,
        }),
      );
    },
    previewImport: (request) => {
      calls.previewImport.push(request);
      return Promise.resolve(
        ok({
          preview: {
            importable: options.previewProblems !== true,
            mode: request.mode,
            schemaVersion: 1,
            problems:
              options.previewProblems === true
                ? [
                    {
                      code: 'unknown_widget_type',
                      detail: '组件类型未注册，整份文档不可导入。',
                      path: 'pages[0].instances[0].widgetType',
                    },
                  ]
                : [],
            warnings: [{ code: 'invalid_shape', detail: '示例警告：服务端会逐条给出可读原因。' }],
            unknownModules: [{ moduleId: 'ff14.unknown', instanceCount: 2, widgetTypes: ['x-widget'], registered: false }],
            counts: {
              pagesNew: 2,
              pagesReplaced: 1,
              pagesSkipped: 0,
              instancesNew: 3,
              instancesReplaced: 2,
              instancesSkipped: 1,
            },
            affectedPages: ['日常', '钓鱼'],
            previewRevision: 12,
            previewToken: PREVIEW_TOKEN,
            confirmPrompt: '确认后按上面的影响范围写入。',
          },
        }),
      );
    },
    applyImport: (request) => {
      calls.applyImport.push(request);
      if (options.applyImportConflict === true) {
        return Promise.resolve(failure('conflict', 409, '预览之后工作台或相关模块状态已变化，请重新预览。'));
      }
      return Promise.resolve(
        ok({
          result: {
            mode: request.mode,
            backupId: null,
            pages,
            defaultPageId: null,
            counts: {
              pagesNew: 2,
              pagesReplaced: 1,
              pagesSkipped: 0,
              instancesNew: 3,
              instancesReplaced: 2,
              instancesSkipped: 1,
            },
            skipped: [],
            warnings: [],
          },
          replayed: false,
        }),
      );
    },
  };

  return { api, calls };
}

const ENABLED_ACCESS = (): ModuleAccess => ({ status: 'enabled', grantedCapabilities: [] });

function Harness(props: { readonly api: WorkbenchApi }) {
  const state = useWorkbench({
    api: props.api,
    enabled: true,
    widgetOf: LOOKUP,
    moduleAccess: ENABLED_ACCESS,
  });
  return <WorkbenchView state={state} />;
}

function elementFor(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`找不到元素：${selector}`);
  }
  return element as HTMLElement;
}

function cardFor(instanceId: string): HTMLElement {
  return elementFor(`[data-testid="widget-card"][data-instance-id="${instanceId}"]`);
}

function pageTabFor(pageId: string): HTMLElement {
  return elementFor(`[data-testid="page-tab"][data-page-id="${pageId}"]`);
}

function breakpointButton(breakpoint: LayoutBreakpoint): HTMLElement {
  return elementFor(`[data-testid="breakpoint-switch"][data-breakpoint="${breakpoint}"]`);
}

function dirtyState(): string | null {
  return screen.getByTestId('dirty-indicator').getAttribute('data-dirty');
}

async function openWorkbenchView(): Promise<void> {
  await screen.findByTestId('workbench-view');
  await waitFor(() => {
    expect(document.querySelectorAll('[data-testid="page-tab"]').length).toBeGreaterThan(0);
  });
  await waitFor(() => {
    expect(document.querySelectorAll('[data-testid="widget-card"]').length).toBeGreaterThan(0);
  });
}

// ---------------------------------------------------------------------------
// 1. 未保存确认横幅
// ---------------------------------------------------------------------------

describe('未保存改动确认横幅', () => {
  it('切换页面时弹出横幅：取消保留草稿、放弃丢弃草稿、保存先提交再切换', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    expect(dirtyState()).toBe('true');

    // ① 取消：留在原页面，草稿仍在。
    await user.click(pageTabFor('p2'));
    expect(screen.getByTestId('unsaved-banner')).toBeDefined();
    await user.click(screen.getByTestId('unsaved-cancel'));
    expect(screen.queryByTestId('unsaved-banner')).toBeNull();
    expect(pageTabFor('p1').getAttribute('aria-current')).toBe('page');
    expect(dirtyState()).toBe('true');
    expect(calls.save).toHaveLength(0);

    // ② 保存并继续：先提交桌面草稿，再切到 p2。
    await user.click(pageTabFor('p2'));
    await user.click(screen.getByTestId('unsaved-save'));
    await waitFor(() => {
      expect(calls.save).toHaveLength(1);
    });
    expect(calls.save[0]?.request.breakpoint).toBe('desktop');
    await waitFor(() => {
      expect(pageTabFor('p2').getAttribute('aria-current')).toBe('page');
    });

    // ③ 放弃草稿并继续：回到 p1 时草稿已经没了。
    await user.click(pageTabFor('p1'));
    await waitFor(() => {
      expect(pageTabFor('p1').getAttribute('aria-current')).toBe('page');
    });
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    expect(dirtyState()).toBe('true');
    await user.click(pageTabFor('p2'));
    await user.click(screen.getByTestId('unsaved-discard'));
    await waitFor(() => {
      expect(pageTabFor('p2').getAttribute('aria-current')).toBe('page');
    });
    await user.click(pageTabFor('p1'));
    await waitFor(() => {
      expect(dirtyState()).toBe('false');
    });
    // 放弃没有产生新的写请求（仍然是 ① 之后那一次保存）。
    expect(calls.save).toHaveLength(1);
  });

  it('切换断点时弹出横幅；桌面草稿不会被写进手机布局，也不会丢', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    // 手机断点的持久布局与桌面不同：w1 在 (0, 4)，用于证明没有被桌面草稿污染。
    await user.click(breakpointButton('mobile'));
    await waitFor(() => {
      expect(screen.getByTestId('workbench-view').getAttribute('data-breakpoint')).toBe('mobile');
    });
    expect(cardFor('w1').textContent).toContain('@(0, 4)');
    await user.click(breakpointButton('desktop'));
    await waitFor(() => {
      expect(screen.getByTestId('workbench-view').getAttribute('data-breakpoint')).toBe('desktop');
    });

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    expect(dirtyState()).toBe('true');

    // 切换断点被横幅拦下，此时还没有切换。
    await user.click(breakpointButton('mobile'));
    expect(screen.getByTestId('unsaved-banner')).toBeDefined();
    expect(screen.getByTestId('workbench-view').getAttribute('data-breakpoint')).toBe('desktop');

    // 保存并继续：只提交桌面断点。
    await user.click(screen.getByTestId('unsaved-save'));
    await waitFor(() => {
      expect(calls.save).toHaveLength(1);
    });
    expect(calls.save[0]?.request.breakpoint).toBe('desktop');
    expect(calls.save[0]?.request.baseRevision).toBe(3);
    await waitFor(() => {
      expect(screen.getByTestId('workbench-view').getAttribute('data-breakpoint')).toBe('mobile');
    });
    // 手机布局仍是它自己的 (0, 4)：桌面草稿没有被写进手机断点。
    expect(cardFor('w1').textContent).toContain('@(0, 4)');
    expect(cardFor('w1').textContent).toContain('4×3');
    // 也没有对 mobile 断点发出任何保存。
    expect(calls.save.filter((call) => call.request.breakpoint === 'mobile')).toHaveLength(0);

    // 回到桌面：草稿已保存（没有丢），位置是保存后的 (1, 0)。
    await user.click(breakpointButton('desktop'));
    await waitFor(() => {
      expect(screen.getByTestId('workbench-view').getAttribute('data-breakpoint')).toBe('desktop');
    });
    expect(cardFor('w1').textContent).toContain('@(1, 0)');
    expect(dirtyState()).toBe('false');
  });

  it('退出编辑模式前也要确认：取消则仍处于编辑模式', async () => {
    const user = userEvent.setup();
    const { api } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    await user.click(screen.getByTestId('edit-toggle'));

    expect(screen.getByTestId('unsaved-banner')).toBeDefined();
    await user.click(screen.getByTestId('unsaved-cancel'));
    expect(screen.getByTestId('edit-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(dirtyState()).toBe('true');

    // 放弃草稿后退出：编辑模式关闭，草稿消失。
    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(screen.getByTestId('unsaved-discard'));
    await waitFor(() => {
      expect(screen.getByTestId('edit-toggle').getAttribute('aria-pressed')).toBe('false');
    });
    expect(dirtyState()).toBe('false');
  });

  it('逐断点脏标记：只有改过的断点被标记', async () => {
    const user = userEvent.setup();
    const { api } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));

    const indicator = screen.getByTestId('breakpoint-dirty-indicator');
    expect(within(indicator).getByText(/桌面：有未保存改动/)).toBeDefined();
    expect(within(indicator).getByText(/平板：已保存/)).toBeDefined();
    expect(within(indicator).getByText(/手机：已保存/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 模板 / 备份 / 导入
// ---------------------------------------------------------------------------

describe('模板选择', () => {
  it('四个模板的 honestyNote 逐字渲染，并且必须显式确认才提交', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();
    await screen.findByTestId('template-picker');

    // 逐字比对：界面上的诚实说明必须与服务端目录一致（不改写、不截断）。
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="template-option"]').length).toBe(
        BUILTIN_WORKBENCH_TEMPLATES.length,
      );
    });
    for (const template of BUILTIN_WORKBENCH_TEMPLATES) {
      const option = elementFor(`[data-testid="template-option"][data-template-id="${template.id}"]`);
      const item = option.closest('li');
      expect(item).not.toBeNull();
      const note = within(item as HTMLElement).getByTestId('template-honesty-note');
      expect(note.textContent).toBe(template.honestyNote);
    }
    // 诚实说明里必须出现阶段 04/05 的真实交代，不能只写「演示」两个字。
    const notes = [...document.querySelectorAll('[data-testid="template-honesty-note"]')].map(
      (node) => node.textContent ?? '',
    );
    expect(notes.some((note) => note.includes('阶段 04'))).toBe(true);
    expect(notes.some((note) => note.includes('阶段 05'))).toBe(true);

    // 未选择模板时不能提交。
    expect(screen.getByTestId<HTMLButtonElement>('template-confirm').disabled).toBe(true);
    expect(calls.applyTemplate).toHaveLength(0);

    await user.click(elementFor('[data-testid="template-option"][data-template-id="daily"]'));
    expect(screen.getByTestId<HTMLButtonElement>('template-confirm').disabled).toBe(false);
    await user.click(screen.getByTestId('template-confirm'));

    await waitFor(() => {
      expect(calls.applyTemplate).toHaveLength(1);
    });
    expect(calls.applyTemplate[0]?.templateId).toBe('daily');
    expect(calls.applyTemplate[0]?.mode).toBe('new_page');
    expect(calls.applyTemplate[0]?.pageName).toBe('日常');
    expect(calls.applyTemplate[0]?.operationId).toMatch(/^[A-Za-z0-9_-]{8,}$/);

    // 取消选择：不会提交，且给出说明。
    await user.click(elementFor('[data-testid="template-option"][data-template-id="raid"]'));
    await user.click(screen.getByTestId('template-cancel'));
    expect(screen.getByTestId('workbench-notice').textContent).toContain('已取消模板选择');
  });

  it('替换当前页面时带上 pageId 与 expectedRevision（防静默覆盖）', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();
    await screen.findByTestId('template-picker');

    await user.click(elementFor('[data-testid="template-option"][data-template-id="blank"]'));
    await user.click(screen.getByLabelText('替换当前页面内容（现有组件会被移除）'));
    await user.click(screen.getByTestId('template-confirm'));

    await waitFor(() => {
      expect(calls.applyTemplate).toHaveLength(1);
    });
    expect(calls.applyTemplate[0]?.mode).toBe('replace_page');
    expect(calls.applyTemplate[0]?.pageId).toBe('p1');
    expect(calls.applyTemplate[0]?.expectedRevision).toBe(0);
  });
});

describe('备份导出与导入', () => {
  beforeEach(() => {
    // jsdom 不实现 createObjectURL：显式补上，才能验证「真实下载」这条链路。
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:mock-download'),
    });
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  it('导出成功后既触发真实下载，又把 JSON 文本渲染到只读元素', async () => {
    const user = userEvent.setup();
    // 局部 mock：避免把 URL.createObjectURL 作为方法值传出去（unbound-method）。
    const createObjectURL = vi.fn(() => 'blob:mock-download');
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    const { api } = createFake();
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.click(screen.getByTestId('backup-export'));

    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    // 文件名带工作空间 ID（`GET /me/profile` 的 id），便于人眼与端到端断言核对。
    expect(downloads[0]).toBe('ff14-hub-workbench-ws-3f2a91c4.json');
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    const output = screen.getByTestId<HTMLTextAreaElement>('backup-export-output');
    await waitFor(() => {
      expect(output.value).toContain('"kind": "ff14-hub.workbench"');
    });
    // 容量边界可见。
    expect(screen.getByTestId('backup-size').textContent).toContain('128 字节');
    expect(screen.getByTestId('backup-size').textContent).toContain('49152');
  });

  it('导入走真实文件输入 → 预览 → 显式确认（confirm: true + previewRevision + previewToken）', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.upload(screen.getByTestId('backup-import-file'), importFile('backup.json'));

    await waitFor(() => {
      expect(calls.previewImport).toHaveLength(1);
    });
    expect(calls.previewImport[0]?.mode).toBe('merge');
    // 预览阶段**不**发确认请求。
    expect(calls.applyImport).toHaveLength(0);

    const preview = await screen.findByTestId('import-preview');
    expect(preview.textContent).toContain('新增页面 2 / 替换 1 / 跳过 0');
    expect(screen.getByTestId('import-impact').textContent).toContain('日常、钓鱼');
    expect(screen.getByTestId('import-unknown-module').textContent).toContain('完全未知');

    await user.click(screen.getByTestId('import-confirm'));

    await waitFor(() => {
      expect(calls.applyImport).toHaveLength(1);
    });
    expect(calls.applyImport[0]?.confirm).toBe(true);
    expect(calls.applyImport[0]?.previewRevision).toBe(12);
    // 预览令牌必须**原样**回显（服务端会重算比对）。
    expect(calls.applyImport[0]?.previewToken).toBe(PREVIEW_TOKEN);
    expect(calls.applyImport[0]?.mode).toBe('merge');
    expect(calls.applyImport[0]?.document).toEqual(EXPORT_DOCUMENT);
  });

  it('预览之后改导入模式必须重新预览：旧令牌作废、确认入口消失', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.upload(screen.getByTestId('backup-import-file'), importFile('mode-merge.json'));
    await waitFor(() => {
      expect(calls.previewImport).toHaveLength(1);
    });
    expect(screen.getByTestId('import-preview')).toBeDefined();

    // 改模式：旧预览绑定的是 merge，必须整体作废（连同确认按钮）。
    await user.click(screen.getByLabelText('替换导入（服务端会先自动留一份可恢复备份）'));
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(screen.queryByTestId('import-confirm')).toBeNull();
    expect(screen.getByTestId('workbench-notice').textContent).toContain('令牌已失效');
    expect(calls.applyImport).toHaveLength(0);

    // 重新选文件 → 用**新模式**重新预览；提交时用的是新令牌，不是上一次的。
    await user.upload(screen.getByTestId('backup-import-file'), importFile('mode-replace.json'));
    await waitFor(() => {
      expect(calls.previewImport).toHaveLength(2);
    });
    expect(calls.previewImport[1]?.mode).toBe('replace');
    await user.click(screen.getByTestId('import-confirm'));
    await waitFor(() => {
      expect(calls.applyImport).toHaveLength(1);
    });
    expect(calls.applyImport[0]?.mode).toBe('replace');
    expect(calls.applyImport[0]?.previewToken).toBe(PREVIEW_TOKEN);
  });

  it('预览之后换了文件（解析失败）也会丢弃旧预览令牌', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.upload(screen.getByTestId('backup-import-file'), importFile('good.json'));
    await waitFor(() => {
      expect(calls.previewImport).toHaveLength(1);
    });
    expect(screen.getByTestId('import-preview')).toBeDefined();

    await user.upload(
      screen.getByTestId('backup-import-file'),
      new File(['{不是 JSON'], 'broken.json', { type: 'application/json' }),
    );
    expect(await screen.findByTestId('import-file-error')).toBeDefined();
    // 旧预览必须消失：否则用户会对着「上一份文件」的影响范围点确认。
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(calls.previewImport).toHaveLength(1);
  });

  it('导入遇到 409（预览过期）时要求重新预览，且不自动重试', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ applyImportConflict: true });
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.upload(screen.getByTestId('backup-import-file'), importFile('stale.json'));
    await screen.findByTestId('import-preview');
    await user.click(screen.getByTestId('import-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-error').textContent).toContain('请重新预览');
    });
    // 只提交了一次：过期令牌绝不自动重试。
    expect(calls.applyImport).toHaveLength(1);
    // 过期的预览结果被丢弃：不能再对着旧令牌点第二次确认。
    expect(screen.queryByTestId('import-preview')).toBeNull();
  });

  it('恢复可恢复备份带上「点击时的工作台 revision」作为准入条件', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ backups: [MANUAL_BACKUP] });
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.click(screen.getByRole('button', { name: '刷新可恢复备份' }));
    const restore = await screen.findByTestId('backup-restore');
    expect(restore.getAttribute('data-backup-id')).toBe(MANUAL_BACKUP.id);
    await user.click(restore);

    await waitFor(() => {
      expect(calls.restoreBackup).toHaveLength(1);
    });
    expect(calls.restoreBackup[0]?.backupId).toBe(MANUAL_BACKUP.id);
    // 快照 revision 原样提交（不是省略、不是猜一个值）。
    expect(calls.restoreBackup[0]?.request.expectedRevision).toBe(SNAPSHOT_REVISION);
    expect(calls.restoreBackup[0]?.request.operationId).toMatch(/^[A-Za-z0-9_-]{8,}$/);

    // 恢复成功后必须重新读取备份列表：服务端在同一事务里多写了一份撤销点，
    // 因此列表会多一行（渲染绝不能假设长度不变）。
    await waitFor(() => {
      expect(screen.getAllByTestId('backup-list-item').length).toBe(2);
    });
    expect(
      screen
        .getAllByTestId('backup-list-item')
        .map((item) => item.getAttribute('data-backup-id')),
    ).toContain('b-pre-import-after-restore');
  });

  it('恢复备份遇到 409 时提示重新读取备份列表，且不自动重试', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ backups: [MANUAL_BACKUP], restoreBackupConflict: true });
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.click(screen.getByRole('button', { name: '刷新可恢复备份' }));
    await user.click(await screen.findByTestId('backup-restore'));

    await waitFor(() => {
      expect(screen.getByTestId('workbench-error').textContent).toContain('工作台已变化，请重新读取备份列表');
    });
    expect(calls.restoreBackup).toHaveLength(1);
  });

  it('拿不到工作台 revision 时先重读快照，仍然拿不到就拒绝恢复（绝不用猜测值提交）', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ backups: [MANUAL_BACKUP], snapshotFailure: true });
    render(<Harness api={api} />);
    await screen.findByTestId('workbench-error');
    const readsBefore = calls.readSnapshot.length;

    await user.click(screen.getByRole('button', { name: '刷新可恢复备份' }));
    await user.click(await screen.findByTestId('backup-restore'));

    await waitFor(() => {
      // 先向服务端重新读一次快照，而不是直接放弃或用猜测值提交。
      expect(calls.readSnapshot.length).toBeGreaterThan(readsBefore);
    });
    expect(screen.getByTestId('workbench-error').textContent).toContain('还没有读到工作台 revision');
    // 一个写请求都没有发：拿不到准入条件就不恢复。
    expect(calls.restoreBackup).toHaveLength(0);
  });

  it('预览存在致命问题时逐条展示 problem，且确认按钮不可用（服务端不会写入）', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ previewProblems: true });
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.upload(
      screen.getByTestId('backup-import-file'),
      new File([JSON.stringify(EXPORT_DOCUMENT)], 'broken-backup.json', { type: 'application/json' }),
    );

    const problem = await screen.findByTestId('import-problem');
    expect(problem.textContent).toContain('unknown_widget_type');
    expect(problem.textContent).toContain('组件类型未注册');
    expect(screen.getByTestId<HTMLButtonElement>('import-confirm').disabled).toBe(true);
    expect(calls.applyImport).toHaveLength(0);
  });

  it('文件不是合法 JSON 时给出可读错误，且不发预览请求', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbenchView();

    await user.upload(
      screen.getByTestId('backup-import-file'),
      new File(['{不是 JSON'], 'broken.json', { type: 'application/json' }),
    );

    expect(await screen.findByTestId('import-file-error')).toBeDefined();
    expect(screen.getByTestId('import-file-error').textContent).toContain('不是合法的 JSON');
    expect(calls.previewImport).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 空状态恢复
// ---------------------------------------------------------------------------

describe('空状态恢复入口', () => {
  it('零页面时渲染 empty-recovery 面板（新建页面 + 应用模板），且始终可达', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ pages: [] });
    render(<Harness api={api} />);
    await screen.findByTestId('workbench-view');

    const recovery = await screen.findByTestId('empty-recovery');
    expect(recovery.textContent).toContain('当前没有页面');
    // `page-add` 必须唯一（否则端到端测试的 getByTestId 会命中多个）。
    expect(screen.getAllByTestId('page-add')).toHaveLength(1);
    expect(screen.getByTestId('empty-recovery-template')).toBeDefined();
    // 组件库 / 模板 / 导入恢复在零页面时同样可达。
    expect(screen.getByTestId('widget-library')).toBeDefined();
    expect(screen.getByTestId('template-picker')).toBeDefined();
    expect(screen.getByTestId('backup-import-file')).toBeDefined();

    // 「应用模板」把用户带到模板面板并给出说明。
    await user.click(screen.getByTestId('empty-recovery-template'));
    expect(screen.getByTestId('workbench-notice').textContent).toContain('模板');

    // 新建页面：带上名称与一个新的幂等 operationId。
    await user.click(screen.getByTestId('page-add'));
    await user.clear(screen.getByTestId('page-name-input'));
    await user.type(screen.getByTestId('page-name-input'), '重新开始');
    await user.click(screen.getByTestId('page-create-confirm'));

    await waitFor(() => {
      expect(calls.createPage).toHaveLength(1);
    });
    expect(calls.createPage[0]?.name).toBe('重新开始');
    expect(calls.createPage[0]?.operationId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });
});

// ---------------------------------------------------------------------------
// 4. AppShell 集成：受控 fetch 替身
// ---------------------------------------------------------------------------

interface RouterState {
  pages: WorkspacePage[];
  instances: Map<string, WidgetInstance[]>;
  layouts: Map<string, BreakpointLayout>;
  deferNextWorkbenchGet: boolean;
  workbenchGetCount: number;
  pendingWorkbenchGets: (() => void)[];
}

function installRouter(): RouterState {
  const state: RouterState = {
    pages: [page('p1', '日常', { isDefault: true })],
    instances: new Map([['p1', [instance('w1', 'demo-counter', 'p1')]]]),
    layouts: new Map([
      [
        'p1#desktop',
        layoutOf('desktop', 3, [{ i: 'w1', x: 0, y: 0, w: 4, h: 3 }]),
      ],
      ['p1#tablet', layoutOf('tablet', 0, [{ i: 'w1', x: 0, y: 0, w: 4, h: 3 }])],
      ['p1#mobile', layoutOf('mobile', 0, [{ i: 'w1', x: 0, y: 0, w: 4, h: 3 }])],
    ]),
    deferNextWorkbenchGet: false,
    workbenchGetCount: 0,
    pendingWorkbenchGets: [],
  };

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const authorized = new Headers(init?.headers).get('Authorization') !== null;
    const unauthorized = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ code: 'unauthorized', message: '设备凭证无效。', requestId: 'r' }, 401));

    if (path === API_ROUTES.health) {
      return Promise.resolve(
        jsonResponse({
          status: 'ok',
          service: 'ff14-hub',
          version: '0.0.0',
          environment: 'test',
          database: 'ok',
          nowUtcMs: 1,
        }),
      );
    }
    if (path === API_ROUTES.moduleCatalog) {
      return Promise.resolve(jsonResponse({ modules: DESCRIPTORS }));
    }
    if (path === API_ROUTES.meProfile) {
      return authorized
        ? Promise.resolve(
            jsonResponse({
              id: 'ws-e2e',
              region: 'cn',
              timezone: 'Asia/Shanghai',
              locale: 'zh-CN',
              createdAt: 0,
              updatedAt: 0,
            }),
          )
        : unauthorized();
    }
    if (path === API_ROUTES.meModules) {
      return authorized ? Promise.resolve(jsonResponse({ modules: [] })) : unauthorized();
    }
    if (path === API_ROUTES.meWorkbench && method === 'GET') {
      state.workbenchGetCount += 1;
      if (!authorized) {
        return unauthorized();
      }
      if (state.deferNextWorkbenchGet) {
        state.deferNextWorkbenchGet = false;
        return new Promise<Response>((resolve) => {
          state.pendingWorkbenchGets.push(() => {
            resolve(
              jsonResponse({
                pages: state.pages,
                defaultPageId: 'p1',
                revision: 1,
                limits: { maxPages: 30, maxWidgetsPerPage: 40, maxWidgetConfigBytes: 4096 },
              }),
            );
          });
        });
      }
      return Promise.resolve(
        jsonResponse({
          pages: state.pages,
          defaultPageId: 'p1',
          revision: 1,
          limits: { maxPages: 30, maxWidgetsPerPage: 40, maxWidgetConfigBytes: 4096 },
        }),
      );
    }
    if (path === API_ROUTES.meWorkbenchTemplates) {
      return authorized ? Promise.resolve(jsonResponse({ templates: TEMPLATES })) : unauthorized();
    }
    const layoutMatch = /^\/api\/v1\/me\/pages\/([^/]+)\/layout$/.exec(path);
    if (layoutMatch !== null) {
      if (!authorized) {
        return unauthorized();
      }
      const pageId = layoutMatch[1] ?? '';
      return Promise.resolve(
        jsonResponse({
          layouts: (['desktop', 'tablet', 'mobile'] as const).map(
            (breakpoint) => state.layouts.get(`${pageId}#${breakpoint}`) ?? layoutOf(breakpoint, 0, []),
          ),
        }),
      );
    }
    const widgetsMatch = /^\/api\/v1\/me\/pages\/([^/]+)\/widgets$/.exec(path);
    if (widgetsMatch !== null) {
      if (!authorized) {
        return unauthorized();
      }
      const pageId = widgetsMatch[1] ?? '';
      return Promise.resolve(jsonResponse({ instances: state.instances.get(pageId) ?? [] }));
    }
    const deleteWidgetMatch = /^\/api\/v1\/me\/widgets\/([^/]+)$/.exec(path);
    if (deleteWidgetMatch !== null && method === 'DELETE') {
      if (!authorized) {
        return unauthorized();
      }
      const instanceId = deleteWidgetMatch[1] ?? '';
      for (const [pageId, list] of state.instances) {
        state.instances.set(
          pageId,
          list.filter((candidate) => candidate.id !== instanceId),
        );
      }
      for (const [key, layout] of state.layouts) {
        state.layouts.set(key, { ...layout, rects: layout.rects.filter((rect) => rect.i !== instanceId) });
      }
      return Promise.resolve(jsonResponse({ widgetId: instanceId, replayed: false }));
    }
    return Promise.resolve(jsonResponse({ code: 'not_found', message: '资源不存在。', requestId: 'r' }, 404));
  });

  return state;
}

async function saveCredential(user: ReturnType<typeof userEvent.setup>, token: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^会话凭证/ }));
  const field = await screen.findByLabelText('设备令牌（Bearer）');
  await user.clear(field);
  await user.type(field, token);
  await user.click(screen.getByRole('button', { name: '保存到会话内存' }));
}

async function openWorkbenchFromShell(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^自定义工作台/ }));
  await screen.findByTestId('workbench-view');
  await waitFor(() => {
    expect(document.querySelectorAll('[data-testid="page-tab"]').length).toBeGreaterThan(0);
  });
}

describe('AppShell 集成：Shell 入口与工作台状态', () => {
  it('移除全部组件后，Shell 入口与工作台各面板仍然可达', async () => {
    installRouter();
    const user = userEvent.setup();
    render(<AppShell />);
    await saveCredential(user, 'ffh_dev_workbench');
    await openWorkbenchFromShell(user);

    expect(screen.getByRole('button', { name: /^自定义工作台/ })).toBeDefined();
    expect(cardFor('w1')).toBeDefined();

    await user.click(within(cardFor('w1')).getByTestId('widget-remove'));

    const emptyNote = await screen.findByTestId('empty-page');
    expect(emptyNote.textContent).toContain('当前页面没有任何组件');
    expect(document.querySelectorAll('[data-testid="widget-card"]')).toHaveLength(0);

    // 页面切换、组件库、系统设置、导入 / 恢复、设备入口都还在。
    expect(screen.getAllByTestId('page-tab').length).toBeGreaterThan(0);
    expect(screen.getByTestId('widget-library')).toBeDefined();
    expect(document.querySelectorAll('[data-testid="widget-library-item"]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('template-picker')).toBeDefined();
    expect(document.querySelectorAll('[data-testid="template-option"]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('backup-import-file')).toBeDefined();
    expect(screen.getByTestId('backup-export')).toBeDefined();
    for (const name of [/^模块管理/, /^会话凭证/, /^系统设置/, /^导入 \/ 恢复/, /^设备管理/]) {
      expect(screen.getByRole('button', { name })).toBeDefined();
    }
  });

  it('普通视图切换保留页面与草稿（也不重新拉取快照）', async () => {
    const router = installRouter();
    const user = userEvent.setup();
    render(<AppShell />);
    await saveCredential(user, 'ffh_dev_keep');
    await openWorkbenchFromShell(user);

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    expect(dirtyState()).toBe('true');
    const getsBefore = router.workbenchGetCount;

    await user.click(screen.getByRole('button', { name: /^工作台概览/ }));
    await screen.findByText('当前阶段');
    expect(screen.queryByTestId('workbench-view')).toBeNull();

    await openWorkbenchFromShell(user);
    expect(within(pageTabFor('p1')).getByText('日常')).toBeDefined();
    expect(dirtyState()).toBe('true');
    expect(cardFor('w1').textContent).toContain('@(1, 0)');
    // 状态被保留，因此没有重新请求快照。
    expect(router.workbenchGetCount).toBe(getsBefore);
  });

  it('凭证代际变化清空工作台，并丢弃旧会话在途的响应', async () => {
    const router = installRouter();
    const user = userEvent.setup();
    render(<AppShell />);
    await saveCredential(user, 'ffh_dev_old');

    // 第一次（已授权）的工作台快照请求挂起，模拟「旧会话的响应还没回来」。
    router.deferNextWorkbenchGet = true;
    await user.click(screen.getByRole('button', { name: /^自定义工作台/ }));
    await screen.findByTestId('workbench-view');
    expect(router.pendingWorkbenchGets).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="page-tab"]')).toHaveLength(0);

    // 清除凭证（退出）→ 代际推进 → 整棵会话子树重挂，旧请求的归属者已被卸载。
    await user.click(screen.getByRole('button', { name: /^会话凭证/ }));
    await user.click(screen.getByRole('button', { name: '清除凭证' }));

    // 新会话（匿名）拿不到工作台：显示服务端文案，而不是旧数据。
    await user.click(screen.getByRole('button', { name: /^自定义工作台/ }));
    const error = await screen.findByTestId('workbench-error');
    expect(error.textContent).toContain('加载工作台失败');
    expect(error.textContent).toContain('unauthorized');

    // 旧会话的响应现在才成功返回：必须被丢弃，页面不得「复活」。
    for (const resolve of router.pendingWorkbenchGets) {
      resolve();
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(document.querySelectorAll('[data-testid="page-tab"]')).toHaveLength(0);
    expect(screen.queryByText('日常')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. 360px 无横向滚动：CSS 契约（jsdom 不做布局计算，因此断言规则本身）
// ---------------------------------------------------------------------------

/** 从磁盘读源样式：兼容「在包目录里跑」与「在仓库根跑」两种 cwd。 */
function readStylesSource(): string {
  const candidates = [
    join(process.cwd(), 'src', 'styles.css'),
    join(process.cwd(), 'apps', 'web', 'src', 'styles.css'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf8');
    }
  }
  return '';
}

describe('窄屏与可访问性样式契约', () => {
  const css = readStylesSource();

  it('样式文件可被读取（否则下面的契约断言没有意义）', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(css).toContain('.workbench');
  });

  it('360px 宽度下有专门的收紧规则，且容器不允许横向溢出', () => {
    expect(css).toContain('@media (max-width: 360px)');
    // 工作台根容器与网格容器都不得产生横向滚动。
    expect(css).toMatch(/\.workbench\s*\{[^}]*overflow-x:\s*hidden/);
    expect(css).toMatch(/\.workbench__grid-wrap\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.workbench__grid-wrap\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('触控目标 ≥ 32px，且焦点可见样式存在', () => {
    expect(css).toMatch(/\.workbench button[\s\S]{0,80}\{[^}]*min-height:\s*32px/);
    expect(css).toMatch(/\.workbench button\s*\{[^}]*min-width:\s*32px/);
    expect(css).toMatch(/\.widget-card__drag-handle\s*\{[^}]*min-height:\s*32px/);
    expect(css).toContain(':focus-visible');
  });
});
