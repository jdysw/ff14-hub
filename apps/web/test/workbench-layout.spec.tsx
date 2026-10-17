/**
 * 工作台布局与草稿回归（阶段 03 / HUB-045 · HUB-046）。
 *
 * 全部用真实的 `useWorkbench` + 真实的 `WorkbenchView`（含 react-grid-layout 集成），
 * 只把 HTTP 客户端替换成替身。因此断言的是**真实界面行为**：
 * 草稿是否提交、`baseRevision` 是否是服务端当前修订、脏标记是否来自真实比较、
 * 409 之后草稿是否仍在、键盘移动产生的矩形是否被真的提交。
 */
// @vitest-environment jsdom
import {
  BREAKPOINT_COLUMNS,
  BUILTIN_MODULE_MANIFESTS,
  type ApiErrorBody,
  type BreakpointLayout,
  type GridRect,
  type LayoutBreakpoint,
  type ModuleDescriptor,
  type WidgetInstance,
  type WorkspacePage,
} from '@ff14-hub/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderErrorBoundary } from '../src/lib/RenderErrorBoundary';
import type { ApiResult } from '../src/lib/api-client';
import type { ModuleAccess } from '../src/app/widgets/types';
import { WorkbenchView } from '../src/app/workbench/WorkbenchView';
import { useWorkbench } from '../src/app/workbench/use-workbench';
import type {
  SaveLayoutRequest,
  TemplateSummary,
  WorkbenchApi,
} from '../src/app/workbench/workbench-api';
import { createWidgetLookup } from '../src/app/workbench/widget-lookup';
import { planRectAction, resolveOverlaps, validateRectsWith } from '../src/app/workbench/workbench-model';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 测试用契约数据（全部来自共享包，不手写第二份常量）
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

const TEMPLATES: readonly TemplateSummary[] = [
  {
    id: 'daily',
    displayName: '日常导航',
    description: '一个「日常」页面。',
    honestyNote: '阶段 04 才会提供真实的导航链接模块；本模板只放入已注册的演示组件作为可编辑起点，不含任何游戏数据。',
    isDemoOnly: true,
    isEmpty: false,
    recommendedDefault: true,
    pageNames: ['日常'],
    widgetCount: 1,
  },
];

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

function instance(
  id: string,
  widgetType: string,
  pageId: string,
  overrides: Partial<WidgetInstance> = {},
): WidgetInstance {
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

function layoutOf(
  breakpoint: LayoutBreakpoint,
  revision: number,
  rects: readonly GridRect[],
): BreakpointLayout {
  return { breakpoint, revision, cols: BREAKPOINT_COLUMNS[breakpoint], rects: [...rects] };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, status: 200, data };
}

function failure(code: ApiErrorBody['code'], status: number, message: string): ApiResult<never> {
  return { ok: false, status, error: { code, message, requestId: 'req-test' } };
}

// ---------------------------------------------------------------------------
// 替身：一个「最小的真实服务端」——写入会改变后续读取的结果
// ---------------------------------------------------------------------------

interface FakeOptions {
  readonly pages?: readonly WorkspacePage[];
  readonly instances?: Readonly<Record<string, readonly WidgetInstance[]>>;
  /** key = `页面#断点`。 */
  readonly rects?: Readonly<Record<string, readonly GridRect[]>>;
  readonly revisions?: Readonly<Record<string, number>>;
  readonly conflictOnSave?: boolean;
  /** 让保存响应带一个**更早**的修订号：用于验证「修订围栏」会丢弃它。 */
  readonly staleSaveRevision?: boolean;
  readonly addFailure?: ApiErrorBody | null;
}

interface FakeCalls {
  readonly save: { readonly pageId: string; readonly request: SaveLayoutRequest }[];
  readonly add: { readonly pageId: string; readonly widgetType: string; readonly operationId: string }[];
  readonly update: { readonly instanceId: string; readonly body: unknown }[];
  readonly remove: readonly string[];
  readonly duplicate: readonly string[];
  readonly applyTemplate: readonly unknown[];
}

function createFake(options: FakeOptions = {}) {
  const pages = [...(options.pages ?? [page('p1', '日常', { isDefault: true }), page('p2', '钓鱼', { sortOrder: 1 })])];
  const instances = new Map<string, WidgetInstance[]>(
    Object.entries(options.instances ?? {
      p1: [instance('w1', 'demo-counter', 'p1'), instance('w2', 'demo-counter', 'p1')],
      p2: [],
    }).map(([pageId, list]) => [pageId, [...list]]),
  );
  const layouts = new Map<string, BreakpointLayout>();
  const rects = options.rects ?? {
    'p1#desktop': [
      { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
    ],
    'p1#tablet': [
      { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w2', x: 4, y: 0, w: 4, h: 3 },
    ],
    'p1#mobile': [
      { i: 'w1', x: 0, y: 4, w: 4, h: 3 },
      { i: 'w2', x: 0, y: 7, w: 4, h: 3 },
    ],
  };
  const revisions = options.revisions ?? { desktop: 3, tablet: 5, mobile: 7 };
  for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
    const list = rects[`p1#${breakpoint}`] ?? [];
    layouts.set(
      `p1#${breakpoint}`,
      layoutOf(breakpoint, revisions[breakpoint] ?? 0, list),
    );
    layouts.set(`p2#${breakpoint}`, layoutOf(breakpoint, 0, []));
  }

  const calls: FakeCalls & {
    save: { pageId: string; request: SaveLayoutRequest }[];
    add: { pageId: string; widgetType: string; operationId: string }[];
    update: { instanceId: string; body: unknown }[];
    remove: string[];
    duplicate: string[];
    applyTemplate: unknown[];
  } = {
    save: [],
    add: [],
    update: [],
    remove: [],
    duplicate: [],
    applyTemplate: [],
  };
  const state = {
    conflictOnSave: options.conflictOnSave === true,
    addFailure: options.addFailure ?? null,
    pages,
    instances,
    layouts,
  };

  const api: WorkbenchApi = {
    readProfile: () =>
      Promise.resolve(
        ok({ id: 'ws-test', region: 'cn', timezone: 'Asia/Shanghai', locale: 'zh-CN', createdAt: 0, updatedAt: 0 }),
      ),
    readSnapshot: () =>
      Promise.resolve(
        ok({
          pages: state.pages,
          defaultPageId: state.pages.find((candidate) => candidate.isDefault)?.id ?? null,
          revision: 1,
          limits: { maxPages: 30, maxWidgetsPerPage: 40, maxWidgetConfigBytes: 4096 },
        }),
      ),
    listPages: () =>
      Promise.resolve(ok({ pages: state.pages, defaultPageId: state.pages[0]?.id ?? null })),
    createPage: (request) => {
      const created = page(`p${String(state.pages.length + 1)}`, request.name, {
        sortOrder: state.pages.length,
      });
      state.pages = [...state.pages, created];
      state.instances.set(created.id, []);
      return Promise.resolve(ok({ page: created, skipped: [], replayed: false }));
    },
    updatePage: (pageId, request) => {
      const found = state.pages.find((candidate) => candidate.id === pageId);
      if (found === undefined) {
        return Promise.resolve(failure('not_found', 404, '页面不存在。'));
      }
      const updated: WorkspacePage = {
        ...found,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.sortOrder === undefined ? {} : { sortOrder: request.sortOrder }),
        ...(request.isDefault === undefined ? {} : { isDefault: request.isDefault }),
        revision: found.revision + 1,
      };
      state.pages = state.pages.map((candidate) => (candidate.id === pageId ? updated : candidate));
      return Promise.resolve(ok({ page: updated, noop: false, replayed: false }));
    },
    deletePage: (pageId) => {
      state.pages = state.pages.filter((candidate) => candidate.id !== pageId);
      return Promise.resolve(
        ok({
          deletedPageId: pageId,
          defaultPageId: state.pages[0]?.id ?? null,
          remainingPages: state.pages.length,
          notice: null,
          replayed: false,
        }),
      );
    },
    restorePage: (pageId) => {
      const restored = page(pageId, '已恢复', { revision: 1 });
      state.pages = [...state.pages, restored];
      return Promise.resolve(ok({ page: restored, defaultPageId: state.pages[0]?.id ?? null, replayed: false }));
    },
    readLayouts: (pageId) =>
      Promise.resolve(
        ok({
          layouts: (['desktop', 'tablet', 'mobile'] as const).map(
            (breakpoint) =>
              state.layouts.get(`${pageId}#${breakpoint}`) ?? layoutOf(breakpoint, 0, []),
          ),
        }),
      ),
    saveLayout: (pageId, request) => {
      calls.save.push({ pageId, request });
      if (state.conflictOnSave) {
        return Promise.resolve(failure('conflict', 409, '布局已被其他设备修改，请先比较或重新载入。'));
      }
      const key = `${pageId}#${request.breakpoint}`;
      const current = state.layouts.get(key) ?? layoutOf(request.breakpoint, 0, []);
      if (options.staleSaveRevision === true) {
        // 陈旧响应：修订号比已知值更早，且服务端状态不变。
        return Promise.resolve(ok({ layout: layoutOf(request.breakpoint, 0, request.rects), replayed: true }));
      }
      const saved = layoutOf(request.breakpoint, current.revision + 1, request.rects);
      state.layouts.set(key, saved);
      return Promise.resolve(ok({ layout: saved, replayed: false }));
    },
    listInstances: (pageId) => Promise.resolve(ok({ instances: state.instances.get(pageId) ?? [] })),
    addInstance: (pageId, request) => {
      calls.add.push({ pageId, widgetType: request.widgetType, operationId: request.operationId });
      if (state.addFailure !== null) {
        return Promise.resolve({
          ok: false,
          status: 409,
          error: state.addFailure,
        } satisfies ApiResult<never>);
      }
      const created = instance(`w${String((state.instances.get(pageId) ?? []).length + 10)}`, request.widgetType, pageId);
      state.instances.set(pageId, [...(state.instances.get(pageId) ?? []), created]);
      return Promise.resolve(ok({ instance: created, replayed: false }));
    },
    updateInstance: (instanceId, request) => {
      calls.update.push({ instanceId, body: request });
      const found = [...state.instances.values()].flat().find((candidate) => candidate.id === instanceId);
      if (found === undefined) {
        return Promise.resolve(failure('not_found', 404, '组件实例不存在。'));
      }
      const updated: WidgetInstance = {
        ...found,
        ...(request.config === undefined ? {} : { config: request.config }),
        ...(request.hidden === undefined ? {} : { hidden: request.hidden }),
        revision: found.revision + 1,
      };
      state.instances.set(
        found.pageId,
        (state.instances.get(found.pageId) ?? []).map((candidate) =>
          candidate.id === instanceId ? updated : candidate,
        ),
      );
      return Promise.resolve(ok({ instance: updated, noop: false, replayed: false }));
    },
    deleteInstance: (instanceId) => {
      calls.remove.push(instanceId);
      for (const [pageId, list] of state.instances) {
        state.instances.set(
          pageId,
          list.filter((candidate) => candidate.id !== instanceId),
        );
      }
      return Promise.resolve(ok({ widgetId: instanceId, replayed: false }));
    },
    duplicateInstance: (instanceId) => {
      calls.duplicate.push(instanceId);
      const found = [...state.instances.values()].flat().find((candidate) => candidate.id === instanceId);
      if (found === undefined) {
        return Promise.resolve(failure('not_found', 404, '组件实例不存在。'));
      }
      const copy = instance(`${instanceId}-copy`, found.widgetType, found.pageId);
      state.instances.set(found.pageId, [...(state.instances.get(found.pageId) ?? []), copy]);
      return Promise.resolve(ok({ instance: copy, replayed: false }));
    },
    listTemplates: () => Promise.resolve(ok({ templates: TEMPLATES })),
    applyTemplate: (request) => {
      calls.applyTemplate.push(request);
      return Promise.resolve(
        ok({
          mode: request.mode,
          templateId: request.templateId,
          pages: state.pages,
          defaultPageId: state.pages[0]?.id ?? null,
          skipped: [],
          replayed: false,
        }),
      );
    },
    exportBackup: () =>
      Promise.resolve(
        ok({ backup: { kind: 'ff14-hub.workbench', schemaVersion: 1, pages: [] }, byteLength: 42, maxBytes: 49152 }),
      ),
    listBackups: () => Promise.resolve(ok({ backups: [] })),
    restoreBackup: () =>
      Promise.resolve(
        ok({
          result: {
            mode: 'replace',
            backupId: 'b1',
            pages: state.pages,
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
      ),
    previewImport: () =>
      Promise.resolve(
        ok({
          preview: {
            importable: true,
            mode: 'merge',
            schemaVersion: 1,
            problems: [],
            warnings: [],
            unknownModules: [],
            counts: {
              pagesNew: 1,
              pagesReplaced: 0,
              pagesSkipped: 0,
              instancesNew: 1,
              instancesReplaced: 0,
              instancesSkipped: 0,
            },
            affectedPages: ['日常'],
            previewRevision: 2,
            confirmPrompt: '确认后才会写入。',
          },
        }),
      ),
    applyImport: () =>
      Promise.resolve(
        ok({
          result: {
            mode: 'merge',
            backupId: null,
            pages: state.pages,
            defaultPageId: null,
            counts: {
              pagesNew: 1,
              pagesReplaced: 0,
              pagesSkipped: 0,
              instancesNew: 1,
              instancesReplaced: 0,
              instancesSkipped: 0,
            },
            skipped: [],
            warnings: [],
          },
          replayed: false,
        }),
      ),
  };

  return { api, calls, state };
}

// ---------------------------------------------------------------------------
// 渲染载体：真实的 Hook + 真实的视图
// ---------------------------------------------------------------------------

const ENABLED_ACCESS = (): ModuleAccess => ({ status: 'enabled', grantedCapabilities: [] });

function Harness(props: {
  readonly api: WorkbenchApi;
  readonly access?: (moduleId: string) => ModuleAccess;
}) {
  const state = useWorkbench({
    api: props.api,
    enabled: true,
    widgetOf: LOOKUP,
    moduleAccess: props.access ?? ENABLED_ACCESS,
  });
  return (
    <RenderErrorBoundary onError={() => undefined}>
      <WorkbenchView state={state} />
    </RenderErrorBoundary>
  );
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

async function openWorkbench(): Promise<void> {
  await screen.findByTestId('workbench-view');
  await waitFor(() => {
    expect(document.querySelectorAll('[data-testid="widget-card"]').length).toBeGreaterThan(0);
  });
}

function dirtyState(): string | null {
  return screen.getByTestId('dirty-indicator').getAttribute('data-dirty');
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('工作台：草稿 → 保存', () => {
  it('保存提交草稿的矩形与 baseRevision，成功后脏标记清除', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbench();

    expect(dirtyState()).toBe('false');
    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));

    expect(dirtyState()).toBe('true');
    expect(cardFor('w1').textContent).toContain('@(1, 0)');

    await user.click(screen.getByTestId('save-layout'));

    await waitFor(() => {
      expect(calls.save).toHaveLength(1);
    });
    const call = calls.save[0];
    expect(call?.pageId).toBe('p1');
    // baseRevision 必须是服务端当前修订（桌面 = 3），不是 0 也不是猜的值。
    expect(call?.request.baseRevision).toBe(3);
    expect(call?.request.breakpoint).toBe('desktop');
    expect(call?.request.rects).toEqual([
      { i: 'w1', x: 1, y: 0, w: 4, h: 3 },
      { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
    ]);
    // operationId 必须满足契约（≥8 位、字符集受限）。
    expect(call?.request.operationId).toMatch(/^[A-Za-z0-9_-]{8,}$/);

    await waitFor(() => {
      expect(dirtyState()).toBe('false');
    });
    expect(screen.getByTestId('workbench-notice').textContent).toContain('已保存');
  });

  it('保存后服务端的矩形就是草稿矩形（重新载入也一致）', async () => {
    const user = userEvent.setup();
    const { api, state } = createFake();
    render(<Harness api={api} />);
    await openWorkbench();
    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    await user.click(screen.getByTestId('save-layout'));

    await waitFor(() => {
      expect(state.layouts.get('p1#desktop')?.rects).toEqual([
        { i: 'w1', x: 1, y: 0, w: 4, h: 3 },
        { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
      ]);
    });
    // 修订号 +1（3 → 4），证明写入被采纳而不是被围栏丢弃。
    await waitFor(() => {
      expect(state.layouts.get('p1#desktop')?.revision).toBe(4);
    });
  });
});

describe('工作台：撤销与放弃', () => {
  it('撤销回到本次编辑开始时的持久布局，且不产生任何写请求', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbench();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    expect(dirtyState()).toBe('true');

    await user.click(screen.getByTestId('undo-layout'));

    expect(dirtyState()).toBe('false');
    expect(cardFor('w1').textContent).toContain('@(0, 0)');
    expect(calls.save).toHaveLength(0);
  });

  it('放弃草稿需要先确认；确认后回到服务端布局且不写服务端', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbench();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-left'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    await user.click(within(cardFor('w1')).getByTestId('widget-grow-h'));
    expect(dirtyState()).toBe('true');

    await user.click(screen.getByTestId('discard-layout'));
    // 先弹确认横幅，不直接丢弃。
    expect(screen.getByTestId('unsaved-banner')).toBeDefined();
    expect(dirtyState()).toBe('true');

    await user.click(screen.getByTestId('unsaved-discard'));

    await waitFor(() => {
      expect(dirtyState()).toBe('false');
    });
    expect(screen.queryByTestId('unsaved-banner')).toBeNull();
    expect(cardFor('w1').textContent).toContain('@(0, 0)');
    expect(calls.save).toHaveLength(0);
  });
});

describe('工作台：修订围栏', () => {
  it('更早修订的写响应被忽略：草稿保留，界面不被陈旧响应覆盖', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ staleSaveRevision: true });
    render(<Harness api={api} />);
    await openWorkbench();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    await user.click(screen.getByTestId('save-layout'));

    await waitFor(() => {
      expect(calls.save).toHaveLength(1);
    });
    // 已知修订是 3，响应却只有 0：必须忽略，脏标记保持为 true。
    await waitFor(() => {
      expect(screen.getByTestId('workbench-notice').textContent).toContain('更早的布局修订');
    });
    expect(dirtyState()).toBe('true');
    expect(cardFor('w1').textContent).toContain('@(1, 0)');
  });
});

describe('工作台：409 冲突', () => {
  it('冲突时保留草稿，并可比较 / 用服务端最新修订重新提交', async () => {
    const user = userEvent.setup();
    const { api, calls, state } = createFake({ conflictOnSave: true });
    render(<Harness api={api} />);
    await openWorkbench();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    await user.click(screen.getByTestId('save-layout'));

    const banner = await screen.findByTestId('conflict-banner');
    expect(banner.textContent).toContain('你的本地草稿仍然保留');
    // 草稿**没有**被回滚成服务端值。
    expect(cardFor('w1').textContent).toContain('@(2, 0)');
    expect(dirtyState()).toBe('true');
    expect(calls.save[0]?.request.baseRevision).toBe(3);

    // 比较：显示本地与服务端的差异摘要。
    await user.click(screen.getByTestId('conflict-compare'));
    const comparison = await screen.findByTestId('conflict-comparison');
    expect(comparison.textContent).toContain('位置不同');

    // 服务端在此期间前进到修订 9（另一台设备把 w1 挪到了第二行）。
    state.layouts.set(
      'p1#desktop',
      layoutOf('desktop', 9, [
        { i: 'w1', x: 0, y: 3, w: 4, h: 3 },
        { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
      ]),
    );
    state.conflictOnSave = false;
    await user.click(screen.getByTestId('conflict-resubmit'));

    await waitFor(() => {
      expect(calls.save).toHaveLength(2);
    });
    expect(calls.save[1]?.request.baseRevision).toBe(9);
    // 提交的仍然是**本地草稿**（x=2），不是服务端的 x=6。
    expect(calls.save[1]?.request.rects[0]).toEqual({ i: 'w1', x: 2, y: 0, w: 4, h: 3 });
    // 同一个用户意图复用同一个 operationId（幂等键不换）。
    expect(calls.save[1]?.request.operationId).toBe(calls.save[0]?.request.operationId);
    await waitFor(() => {
      expect(dirtyState()).toBe('false');
    });
  });

  it('「重新载入」丢弃草稿并采用服务端布局', async () => {
    const user = userEvent.setup();
    const { api, state } = createFake({ conflictOnSave: true });
    render(<Harness api={api} />);
    await openWorkbench();

    await user.click(screen.getByTestId('edit-toggle'));
    await user.click(within(cardFor('w1')).getByTestId('widget-move-right'));
    await user.click(screen.getByTestId('save-layout'));
    await screen.findByTestId('conflict-banner');

    // 服务端布局前进到修订 4（w1 被挪到第二行）——重新载入必须采用它。
    state.layouts.set(
      'p1#desktop',
      layoutOf('desktop', 4, [
        { i: 'w1', x: 0, y: 6, w: 4, h: 3 },
        { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
      ]),
    );
    await user.click(screen.getByTestId('conflict-reload'));

    await waitFor(() => {
      expect(screen.queryByTestId('conflict-banner')).toBeNull();
    });
    await waitFor(() => {
      expect(cardFor('w1').textContent).toContain('@(0, 6)');
    });
    expect(dirtyState()).toBe('false');
  });
});

describe('工作台：键盘替代拖拽', () => {
  /** 一个刻意留下「越界 / 重叠 / 触底」三种情形的布局。 */
  const keyboardRects = {
    'p1#desktop': [
      { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
      { i: 'w3', x: 0, y: 3, w: 4, h: 3 },
    ],
  };
  const keyboardInstances = {
    p1: [
      instance('w1', 'demo-counter', 'p1'),
      instance('w2', 'demo-counter', 'p1'),
      instance('w3', 'demo-counter', 'p1'),
    ],
    p2: [],
  };

  it('越界 / 低于最小尺寸时禁用；碰撞按「与拖动同一规则」让位后再判定', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({ rects: keyboardRects, instances: keyboardInstances });
    render(<Harness api={api} />);
    await openWorkbench();
    await user.click(screen.getByTestId('edit-toggle'));

    // 越界：y 不能为负 → 上移禁用。
    expect(within(cardFor('w1')).getByTestId<HTMLButtonElement>('widget-move-up').disabled).toBe(true);
    // 越界：w2 在 x=8、宽 4，右移会到 x=9（9+4 > 12 列）→ 禁用。
    expect(within(cardFor('w2')).getByTestId<HTMLButtonElement>('widget-move-right').disabled).toBe(true);
    // 尺寸：demo-counter 的 minSize 是 2×2。
    expect(within(cardFor('w1')).getByTestId<HTMLButtonElement>('widget-shrink-w').disabled).toBe(false);

    // 重叠（w3 上移会压到 w1）：与拖动一致地让被撞者让位，因此按钮**可用**，
    // 且结果是合法的（服务端一定接受）。
    expect(within(cardFor('w3')).getByTestId<HTMLButtonElement>('widget-move-up').disabled).toBe(false);
    await user.click(within(cardFor('w3')).getByTestId('widget-move-up'));
    expect(dirtyState()).toBe('true');
    // w3 升到 (0,0)，原本在那里的 w1 被让到 (0,3)（与鼠标拖动同一结果）。
    expect(cardFor('w3').textContent).toContain('@(0, 0)');
    expect(cardFor('w1').textContent).toContain('@(0, 3)');

    // 连续缩窄到最小尺寸后继续缩窄必须被禁用（尺寸违规不做「智能纠偏」）。
    await user.click(within(cardFor('w1')).getByTestId('widget-shrink-w'));
    await user.click(within(cardFor('w1')).getByTestId('widget-shrink-w'));
    expect(within(cardFor('w1')).getByTestId<HTMLButtonElement>('widget-shrink-w').disabled).toBe(true);
    // 缩到最小尺寸后，加宽重新可用。
    expect(within(cardFor('w1')).getByTestId<HTMLButtonElement>('widget-grow-w').disabled).toBe(false);

    await user.click(screen.getByTestId('save-layout'));
    await waitFor(() => {
      expect(calls.save).toHaveLength(1);
    });
    const rects = calls.save[0]?.request.rects ?? [];
    // 键盘产生的矩形就是被保存的矩形（含让位后的结果）。
    expect(rects.find((rect) => rect.i === 'w1')).toEqual({ i: 'w1', x: 0, y: 3, w: 2, h: 3 });
    expect(rects.find((rect) => rect.i === 'w3')).toEqual({ i: 'w3', x: 0, y: 0, w: 4, h: 3 });
  });

  it('未进入编辑模式时方向按钮禁用（避免误改布局）', async () => {
    const { api } = createFake({ rects: keyboardRects, instances: keyboardInstances });
    render(<Harness api={api} />);
    await openWorkbench();
    expect(within(cardFor('w1')).getByTestId<HTMLButtonElement>('widget-move-right').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('save-layout').disabled).toBe(true);
  });
});

describe('工作台：卡片级实例操作', () => {
  it('隐藏带上 expectedRevision，配置经校验后提交，复制与重置各走各的路径', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake();
    render(<Harness api={api} />);
    await openWorkbench();

    // 隐藏：PATCH 必须带该实例当前的 revision（防静默覆盖）。
    await user.click(within(cardFor('w1')).getByTestId('widget-hide'));
    await waitFor(() => {
      expect(calls.update).toHaveLength(1);
    });
    expect(calls.update[0]?.instanceId).toBe('w1');
    expect(calls.update[0]?.body).toMatchObject({ expectedRevision: 1, hidden: true });

    // 配置：合法 JSON 通过 Schema 后按「实例配置 + expectedRevision」提交。
    await user.click(within(cardFor('w2')).getByTestId('widget-configure'));
    const input = within(cardFor('w2')).getByTestId('widget-config-input');
    fireEvent.change(input, { target: { value: '{"step":5,"label":"改过的实例","initDelayMs":0}' } });
    await user.click(within(cardFor('w2')).getByTestId('widget-config-apply'));
    await waitFor(() => {
      expect(calls.update).toHaveLength(2);
    });
    expect(calls.update[1]?.instanceId).toBe('w2');
    expect(calls.update[1]?.body).toMatchObject({
      expectedRevision: 1,
      config: { step: 5, label: '改过的实例', initDelayMs: 0 },
    });

    // 非法 JSON 不提交，并给出可读原因。
    await user.click(within(cardFor('w2')).getByTestId('widget-configure'));
    fireEvent.change(within(cardFor('w2')).getByTestId('widget-config-input'), { target: { value: '{不是 JSON' } });
    await user.click(within(cardFor('w2')).getByTestId('widget-config-apply'));
    expect(within(cardFor('w2')).getByRole('alert').textContent).toContain('不是合法的 JSON');
    expect(calls.update).toHaveLength(2);

    // 复制：走 duplicate 端点。
    await user.click(within(cardFor('w1')).getByTestId('widget-duplicate'));
    await waitFor(() => {
      expect(calls.duplicate).toEqual(['w1']);
    });

    // 移除：走 delete 端点。
    await user.click(within(cardFor('w1')).getByTestId('widget-remove'));
    await waitFor(() => {
      expect(calls.remove).toEqual(['w1']);
    });
  });

  it('组件库添加失败时展示服务端文案并提示先启用模块', async () => {
    const user = userEvent.setup();
    const { api, calls } = createFake({
      addFailure: { code: 'conflict', message: '所属模块当前不可用（未启用或正在变更），无法写入组件实例。', requestId: 'r' },
    });
    render(<Harness api={api} />);
    await openWorkbench();

    await user.click(elementFor('[data-testid="widget-add"][data-widget-type="demo-counter"]'));

    await waitFor(() => {
      expect(calls.add).toHaveLength(1);
    });
    const error = await screen.findByTestId('workbench-error');
    expect(error.textContent).toContain('所属模块当前不可用');
    expect(error.textContent).toContain('请先在「模块管理」里启用该模块');
  });
});

describe('工作台：网格项与卡片的 DOM 契约', () => {
  it('卡片自身就是网格项：拖动把手与 RGL 缩放手柄都在卡片内部', async () => {
    const { api } = createFake();
    render(<Harness api={api} />);
    await openWorkbench();

    const card = cardFor('w1');
    // RGL 会把 `react-grid-item` 类与定位样式注入到卡片根节点上（端到端测试依赖这个结构）。
    expect(card.className).toContain('react-grid-item');
    expect(card.getAttribute('style')).toContain('position: absolute');
    expect(card.getAttribute('data-widget-type')).toBe('demo-counter');
    // 拖动把手在卡片内部（RGL 的 dragConfig.handle 指向它）。
    expect(card.querySelector('[data-testid="widget-card__drag-handle"]')).not.toBeNull();
    // react-resizable 追加的缩放手柄也必须在卡片内部，否则「卡片作用域内定位手柄」会落空。
    expect(card.querySelector('.react-resizable-handle-se')).not.toBeNull();
  });
});

describe('工作台：重叠消解（纯函数）', () => {
  const constraintsOfInstance = (): { minW: number; minH: number; maxW: number | null; maxH: number | null } => ({
    minW: 2,
    minH: 2,
    maxW: null,
    maxH: null,
  });
  const instanceById = new Map([
    ['w1', instance('w1', 'demo-counter', 'p1')],
    ['w2', instance('w2', 'demo-counter', 'p1')],
  ]);

  it('没有重叠时一个像素都不动（不自动向上压缩，因此「下移」不会被吃掉）', () => {
    const clean = [
      { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w2', x: 0, y: 6, w: 4, h: 3 },
    ];
    expect(
      resolveOverlaps({
        breakpoint: 'desktop',
        rects: clean,
        constraintsOfInstance,
        instanceById,
        widgetOf: LOOKUP,
      }),
    ).toEqual(clean);
  });

  it('出现重叠时把被撞的组件下移，结果满足服务端同一份判定', () => {
    const overlapping = [
      { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w2', x: 0, y: 2, w: 4, h: 3 },
    ];
    const resolved = resolveOverlaps({
      breakpoint: 'desktop',
      rects: overlapping,
      constraintsOfInstance,
      instanceById,
      widgetOf: LOOKUP,
    });
    expect(validateRectsWith({ breakpoint: 'desktop', rects: resolved, constraintsOfInstance }).ok).toBe(true);
    expect(resolved.find((rect) => rect.i === 'w2')?.y).toBeGreaterThanOrEqual(3);
    // 被拖动的那个（w1）位置不动：用户的操作不会被悄悄改写。
    expect(resolved.find((rect) => rect.i === 'w1')).toMatchObject({ x: 0, y: 0, w: 4, h: 3 });
  });

  it('planRectAction：越界/尺寸违规直接拒绝，只有可消解的碰撞才给出结果', () => {
    const rects = [
      { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w2', x: 8, y: 0, w: 4, h: 3 },
    ];
    const base = {
      breakpoint: 'desktop' as const,
      rects,
      constraintsOfInstance,
      instanceById,
      widgetOf: LOOKUP,
    };
    // 右移越界（8 + 1 + 4 > 12 列）→ null。
    expect(planRectAction({ ...base, instanceId: 'w2', target: { i: 'w2', x: 9, y: 0, w: 4, h: 3 } })).toBeNull();
    // 缩到低于最小尺寸 → null。
    expect(planRectAction({ ...base, instanceId: 'w1', target: { i: 'w1', x: 0, y: 0, w: 1, h: 3 } })).toBeNull();
    // 合法且无碰撞 → 原样返回。
    expect(planRectAction({ ...base, instanceId: 'w1', target: { i: 'w1', x: 1, y: 0, w: 4, h: 3 } })?.rect).toEqual({
      i: 'w1',
      x: 1,
      y: 0,
      w: 4,
      h: 3,
    });
    // 与 w2 重叠：让位后仍然是合法布局（w2 被推下去）。
    const pushed = planRectAction({ ...base, instanceId: 'w1', target: { i: 'w1', x: 5, y: 0, w: 4, h: 3 } });
    expect(pushed).not.toBeNull();
    expect(validateRectsWith({ breakpoint: 'desktop', rects: pushed?.rects ?? [], constraintsOfInstance }).ok).toBe(
      true,
    );
  });
});

describe('工作台：未知组件类型与错误隔离', () => {
  it('不在静态注册表里的组件类型只渲染「不受支持」降级卡片，不执行任何组件', async () => {
    const { api } = createFake({
      instances: {
        p1: [instance('w9', 'not-registered-widget', 'p1', { moduleId: 'ff14.does-not-exist' })],
        p2: [],
      },
      rects: { 'p1#desktop': [{ i: 'w9', x: 0, y: 0, w: 4, h: 3 }] },
    });
    render(<Harness api={api} />);
    await screen.findByTestId('workbench-view');
    await waitFor(() => {
      expect(screen.getByTestId('widget-degraded')).toBeDefined();
    });
    const degraded = screen.getByTestId('widget-degraded');
    expect(degraded.textContent).toContain('不受支持的组件类型');
    // 降级卡片所在的实例被标记为 blocked:config，而不是 ready。
    const host = elementFor('[data-testid="widget-instance"][data-instance-id="w9"]');
    expect(host.getAttribute('data-phase')).toBe('blocked:config');
  });

  it('demo-fault 的渲染期抛错被隔离：其余组件与工作台视图都还活着', async () => {
    // React 会把被错误边界捕获的错误打到 console.error；测试里静音以免噪声。
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = createFake({
      instances: {
        p1: [
          instance('bad', 'demo-fault', 'p1', { config: { mode: 'render-error', delayMs: 0 } }),
          instance('good', 'demo-counter', 'p1'),
        ],
        p2: [],
      },
      rects: {
        'p1#desktop': [
          { i: 'bad', x: 0, y: 0, w: 4, h: 3 },
          { i: 'good', x: 4, y: 0, w: 4, h: 3 },
        ],
      },
    });
    render(<Harness api={api} />);
    await screen.findByTestId('workbench-view');

    // 坏组件显示错误卡片（role=alert），而不是把整棵子树带走。
    const errorCard = await within(cardFor('bad')).findByRole('alert');
    expect(errorCard.textContent).toContain('组件渲染失败');
    // 兄弟组件仍然正常渲染并可用。
    expect(await within(cardFor('good')).findByRole('button', { name: '+1' })).toBeDefined();
    expect(screen.getByTestId('workbench-view')).toBeDefined();
    expect(document.querySelectorAll('[data-testid="widget-card"]')).toHaveLength(2);
  });
});
