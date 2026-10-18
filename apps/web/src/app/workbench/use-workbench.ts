/**
 * 工作台状态容器（阶段 03 / HUB-045 · HUB-046 · HUB-049 · HUB-054）。
 *
 * 这个 Hook 是**唯一**持有工作台可变状态的地方；视图组件全部是纯展示。
 * 之所以这样分层：会话代际一变，整棵子树以新 `key` 重挂，而普通视图切换只是「不渲染」，
 * 状态因此**保留**（与阶段 02 的模块状态同一套做法）。
 *
 * 五条硬要求（都能在这里找到对应实现）：
 * 1. **草稿与持久状态显式区分**：`drafts[页面#断点]` 是草稿，`layouts[页面#断点]` 是服务端快照。
 *    `dirty` 由**真实比较**（`rectsEqual`）得出，不是「点过按钮」的标志位。
 * 2. **切页 / 切断点不静默丢草稿**：草稿按「页面 + 断点」分桶存放；切走时弹确认横幅，
 *    三个选择（保存 / 放弃 / 取消）都不会「什么都不说地」丢掉草稿。
 *    切断点只写当前断点那一桶，**永不**跨断点写入。
 * 3. **未保存确认用可视横幅**（不用 `window.confirm`），因此可被键盘与测试驱动。
 * 4. **409 冲突**：保留本地草稿，给出「重新载入 / 比较 / 重新提交」三个显式动作；
 *    绝不盲重试、绝不自动覆盖。
 * 5. **修订围栏 + 会话隔离**：只接受 revision ≥ 已知值的写响应；
 *    组件卸载（凭证代际变化）后所有在途响应一律丢弃。
 */
import {
  LAYOUT_BREAKPOINTS,
  type BreakpointLayout,
  type GridRect,
  type LayoutBreakpoint,
  type WidgetInstance,
  type WidgetSizeConstraint,
  type WorkbenchImportMode,
  type WorkbenchImportPreview,
  type WorkbenchSnapshot,
  type WorkbenchTemplateId,
  type WorkspacePage,
} from '@ff14-hub/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutItem } from 'react-grid-layout';
import type { ApiResult } from '../../lib/api-client';
import type { ModuleAccess } from '../widgets/types';
import {
  BREAKPOINT_LABELS,
  autoFlowRectsFor,
  coveringRects,
  diffRects,
  layoutKey,
  moveRect,
  planRectAction,
  rectsEqual,
  resetRect,
  resolveOverlaps,
  toLayoutItems,
  validateRectsWith,
  type LayoutDraft,
  type RectAction,
  type WorkbenchWidgetLookup,
} from './workbench-model';
import {
  newOperationId,
  type BackupSummary,
  type TemplateSummary,
  type WorkbenchApi,
} from './workbench-api';

/** 工作台容量上限（来自服务端快照，界面据此显示边界）。 */
export interface WorkbenchLimits {
  readonly maxPages: number;
  readonly maxWidgetsPerPage: number;
  readonly maxWidgetConfigBytes: number;
}

/** 挂起的用户意图：确认横幅解决后才会真正执行。 */
export type PendingIntent =
  | { readonly kind: 'switch-page'; readonly pageId: string }
  | { readonly kind: 'switch-breakpoint'; readonly breakpoint: LayoutBreakpoint }
  | { readonly kind: 'exit-edit' }
  | { readonly kind: 'discard-draft' };

export interface PromptState {
  readonly intent: PendingIntent;
  readonly breakpoint: LayoutBreakpoint;
  readonly detail: string;
}

/** 409 冲突状态：保留草稿 + 三个显式出口所需的一切数据。 */
export interface ConflictState {
  readonly pageId: string;
  readonly breakpoint: LayoutBreakpoint;
  readonly code: string;
  readonly message: string;
  readonly localRects: readonly GridRect[];
  readonly serverRects: readonly GridRect[] | null;
  readonly serverRevision: number | null;
  readonly comparison: readonly string[] | null;
}

/** 已预览待确认的导入。`confirm: true` 只能由显式点击产生。 */
export interface ImportPreviewState {
  readonly mode: WorkbenchImportMode;
  readonly document: unknown;
  readonly preview: WorkbenchImportPreview;
}

export interface WorkbenchBackupSize {
  readonly byteLength: number;
  readonly maxBytes: number;
}

interface WorkbenchState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly notice: string | null;
  readonly busy: boolean;
  readonly snapshot: WorkbenchSnapshot | null;
  readonly activePageId: string | null;
  readonly activeBreakpoint: LayoutBreakpoint;
  readonly layouts: Readonly<Record<string, BreakpointLayout>>;
  readonly instances: Readonly<Record<string, readonly WidgetInstance[]>>;
  readonly drafts: Readonly<Record<string, LayoutDraft>>;
  readonly editing: boolean;
  readonly editBaseline: readonly GridRect[] | null;
  readonly conflict: ConflictState | null;
  readonly prompt: PromptState | null;
  readonly templates: readonly TemplateSummary[] | null;
  readonly backups: readonly BackupSummary[] | null;
  readonly backupSize: WorkbenchBackupSize | null;
  readonly exportedJson: string | null;
  readonly importPreview: ImportPreviewState | null;
  readonly lastDeletedPageId: string | null;
}

const INITIAL_STATE: WorkbenchState = {
  status: 'idle',
  error: null,
  notice: null,
  busy: false,
  snapshot: null,
  activePageId: null,
  activeBreakpoint: 'desktop',
  layouts: {},
  instances: {},
  drafts: {},
  editing: false,
  editBaseline: null,
  conflict: null,
  prompt: null,
  templates: null,
  backups: null,
  backupSize: null,
  exportedJson: null,
  importPreview: null,
  lastDeletedPageId: null,
};

export type PromptChoice = 'save' | 'discard' | 'cancel';

export type SaveOutcome =
  | { readonly ok: true; readonly saved: boolean }
  | { readonly ok: false; readonly reason: 'no-page' | 'invalid' | 'conflict' | 'error' | 'stale' };

/** 视图组件需要的全部状态与动作。 */
export interface WorkbenchController {
  readonly status: WorkbenchState['status'];
  readonly busy: boolean;
  readonly error: string | null;
  readonly notice: string | null;
  readonly pages: readonly WorkspacePage[];
  readonly limits: WorkbenchLimits;
  readonly activePage: WorkspacePage | null;
  readonly activePageId: string | null;
  readonly activeBreakpoint: LayoutBreakpoint;
  readonly editing: boolean;
  readonly dirty: boolean;
  readonly dirtyBreakpoints: Readonly<Record<LayoutBreakpoint, boolean>>;
  readonly instances: readonly WidgetInstance[];
  readonly rects: readonly GridRect[];
  readonly persistedRects: readonly GridRect[];
  /** 三个断点各自的布局项：一起交给 RGL，避免它「从别的断点生成」出错误布局。 */
  readonly gridLayouts: Readonly<Record<LayoutBreakpoint, readonly LayoutItem[]>>;
  readonly conflict: ConflictState | null;
  readonly prompt: PromptState | null;
  readonly templates: readonly TemplateSummary[] | null;
  readonly backups: readonly BackupSummary[] | null;
  readonly backupSize: WorkbenchBackupSize | null;
  readonly exportedJson: string | null;
  readonly importPreview: ImportPreviewState | null;
  readonly lastDeletedPageId: string | null;
  readonly widgetOf: WorkbenchWidgetLookup;
  readonly moduleAccess: (moduleId: string) => ModuleAccess;
  readonly reload: () => Promise<void>;
  readonly setActivePage: (pageId: string) => void;
  readonly setBreakpoint: (breakpoint: LayoutBreakpoint) => void;
  readonly toggleEditing: () => void;
  readonly requestDiscardDraft: () => void;
  readonly resolvePrompt: (choice: PromptChoice) => Promise<void>;
  readonly setDraftRects: (rects: readonly GridRect[]) => void;
  readonly moveInstance: (instanceId: string, action: RectAction) => void;
  readonly canMoveInstance: (instanceId: string, action: RectAction) => boolean;
  readonly save: () => Promise<void>;
  readonly undo: () => void;
  readonly resetInstance: (instanceId: string) => void;
  readonly resetPage: () => void;
  readonly addWidget: (widgetType: string) => Promise<void>;
  readonly updateWidgetConfig: (instanceId: string, config: unknown) => Promise<void>;
  readonly setWidgetHidden: (instanceId: string, hidden: boolean) => Promise<void>;
  readonly duplicateWidget: (instanceId: string) => Promise<void>;
  readonly removeWidget: (instanceId: string) => Promise<void>;
  readonly createPage: (name: string, templateId?: WorkbenchTemplateId) => Promise<void>;
  readonly renamePage: (pageId: string, name: string) => Promise<void>;
  readonly setDefaultPage: (pageId: string) => Promise<void>;
  readonly movePageOrder: (pageId: string, direction: -1 | 1) => Promise<void>;
  readonly deletePage: (pageId: string) => Promise<void>;
  readonly restoreDeletedPage: () => Promise<void>;
  readonly loadTemplates: () => Promise<void>;
  readonly applyTemplate: (input: {
    readonly templateId: WorkbenchTemplateId;
    readonly mode: 'new_page' | 'replace_page' | 'reset_workspace';
    readonly pageName?: string;
  }) => Promise<void>;
  readonly loadBackups: () => Promise<void>;
  readonly exportBackup: () => Promise<void>;
  readonly previewImport: (document: unknown, mode: WorkbenchImportMode) => Promise<void>;
  /**
   * 丢弃当前预览（**不**发任何请求）。
   *
   * 预览令牌绑定「这份 document + 这个 mode + 当时的工作台 revision + 模块门禁」，
   * 因此只要用户换了文件或改了导入模式，旧令牌就必须立刻作废，必须重新预览。
   */
  readonly discardImportPreview: () => void;
  readonly confirmImport: () => Promise<void>;
  readonly cancelImport: () => void;
  readonly restoreBackup: (backupId: string) => Promise<void>;
  readonly conflictReload: () => Promise<void>;
  readonly conflictCompare: () => Promise<void>;
  readonly conflictResubmit: () => Promise<void>;
  readonly setNotice: (notice: string | null) => void;
}

export interface UseWorkbenchOptions {
  readonly api: WorkbenchApi;
  /** 何时开始首次加载（进入工作台视图）。离开视图不清空状态，因此草稿得以保留。 */
  readonly enabled: boolean;
  readonly widgetOf: WorkbenchWidgetLookup;
  readonly moduleAccess: (moduleId: string) => ModuleAccess;
}

/**
 * 「同步未完成」写闸门 —— 本文件与跨设备同步**唯一**的接触点。
 *
 * 为什么需要它：工作台的**全局 CAS 写**（保存整页布局 / 恢复备份 / 应用模板）提交的是
 * 「我看到的整页或整份集合」。跨设备同步还没确认完成（权威快照未发布，或还有变更页没取完）
 * 时提交，等于用一份可能不完整的本地集合覆盖服务端；**也绝不能**改用服务端最新 revision
 * 提交——那等于按一个本地并未见过的修订号批准写入。
 *
 * 为什么状态由外部**注册**：轮询与 `syncing` 的唯一持有者是 `WorkbenchView`
 * （它同时持有 `syncChangesApi`），而写入实现全在这里。因此本文件只暴露这一个入口，
 * 不重复实现第二套同步状态；未注册时默认为「可以写」（阶段 03 的行为完全不变）。
 */
let workbenchSyncGate: () => boolean = () => false;

/** 注册写闸门；返回注销函数（视图卸载时恢复为「可以写」）。 */
export function setWorkbenchSyncGate(gate: () => boolean): () => void {
  workbenchSyncGate = gate;
  return () => {
    if (workbenchSyncGate === gate) {
      workbenchSyncGate = () => false;
    }
  };
}

/** 被写闸门拒绝时的可见说明（绝不静默丢弃用户的操作）。 */
export const WORKBENCH_SYNCING_NOTICE =
  '正在同步其它设备的改动：在权威快照发布并确认没有更多变更之前，整体写入（保存布局 / 恢复备份 / 应用模板）会被拒绝，' +
  '以免用一份可能不完整的本地集合覆盖服务端。组件配置、隐藏、删除组件等行级操作不受影响。';

interface WriteOutcome<T> {
  readonly ok: boolean;
  readonly stale: boolean;
  readonly conflict: boolean;
  readonly message: string;
  readonly data: T | null;
}

export function useWorkbench(options: UseWorkbenchOptions): WorkbenchController {
  const { api } = options;
  const [state, setState] = useState<WorkbenchState>(INITIAL_STATE);
  /**
   * 状态的**同步镜像**。
   * 异步动作（保存、写实例、切页）必须在「刚刚写下的状态」之上继续计算，
   * 而 `setState` 的更新函数不能在事件回调里被同步读取；用一个 ref 镜像既避免陈旧闭包，
   * 也不在渲染期产生副作用（StrictMode 下安全）。
   */
  const ref = useRef<WorkbenchState>(INITIAL_STATE);
  const update = useCallback((mutate: (current: WorkbenchState) => WorkbenchState): void => {
    const next = mutate(ref.current);
    ref.current = next;
    setState(next);
  }, []);

  /**
   * **同步未完成**时的全局 CAS 写闸门（见 `setWorkbenchSyncGate`）：拒绝提交并给出可见提示。
   *
   * 只拦「整体写入」（保存整页布局 / 恢复备份 / 应用模板）：它们提交的是工作空间级
   * `expectedRevision` 或整页矩形集合。行级写（组件配置 / 隐藏 / 删除组件 / 页面改名等）
   * 用的是**行修订** CAS，与集合完整性无关，因此不受影响。
   *
   * 返回 `true` 表示「已拒绝」——调用方必须立刻返回，什么都不发。
   */
  const rejectGlobalWriteWhileSyncing = useCallback((): boolean => {
    if (!workbenchSyncGate()) {
      return false;
    }
    update((current) => ({ ...current, notice: WORKBENCH_SYNCING_NOTICE }));
    return true;
  }, [update]);

  const mountedRef = useRef(true);
  const loadedRef = useRef(false);
  const widgetOfRef = useRef(options.widgetOf);
  const moduleAccessRef = useRef(options.moduleAccess);

  useEffect(() => {
    widgetOfRef.current = options.widgetOf;
    moduleAccessRef.current = options.moduleAccess;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // 会话切换 / 卸载：此后所有在途响应都必须被丢弃。
      mountedRef.current = false;
    };
  }, []);

  const constraintOfInstance = useCallback((instanceId: string): WidgetSizeConstraint | null => {
    const current = ref.current;
    const pageId = current.activePageId;
    if (pageId === null) {
      return null;
    }
    const instance = (current.instances[pageId] ?? []).find((candidate) => candidate.id === instanceId);
    if (instance === undefined) {
      return null;
    }
    return widgetOfRef.current(instance.widgetType)?.constraint ?? null;
  }, []);

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  const loadPage = useCallback(
    async (pageId: string): Promise<void> => {
      const [layoutResult, instanceResult] = await Promise.all([
        api.readLayouts(pageId),
        api.listInstances(pageId),
      ]);
      if (!mountedRef.current) {
        return;
      }
      if (!layoutResult.ok || !instanceResult.ok) {
        const failure = layoutResult.ok ? instanceResult : layoutResult;
        const message = failure.ok ? '未知错误' : `${failure.error.message}（${failure.error.code}）`;
        update((current) => ({ ...current, error: `加载页面内容失败：${message}` }));
        return;
      }
      const instances = instanceResult.data.instances;
      update((current) => {
        const layouts = { ...current.layouts };
        for (const layout of layoutResult.data.layouts) {
          layouts[layoutKey(pageId, layout.breakpoint)] = layout;
        }
        const nextInstances = { ...current.instances, [pageId]: instances };
        // 已有草稿时补齐/清理矩形：矩形集合必须**恰好**覆盖该页面全部实例，
        // 否则整页保存会被服务端以 422 拒绝（服务端只拒绝，不替用户补位置）。
        const drafts = { ...current.drafts };
        for (const breakpoint of LAYOUT_BREAKPOINTS) {
          const key = layoutKey(pageId, breakpoint);
          const draft = drafts[key];
          if (draft === undefined) {
            continue;
          }
          drafts[key] = {
            ...draft,
            rects: coveringRects({
              instances,
              rects: draft.rects,
              breakpoint,
              widgetOf: widgetOfRef.current,
            }),
          };
        }
        return { ...current, layouts, instances: nextInstances, drafts, error: null };
      });
    },
    [api, update],
  );

  const loadSnapshot = useCallback(
    async (select?: { readonly pageId?: string }): Promise<void> => {
      update((current) => ({
        ...current,
        // 已经渲染出内容后不再回到「加载中」：否则每次写入后的刷新都会让整页闪一下。
        status: current.snapshot === null ? 'loading' : current.status,
        error: null,
      }));
      const result = await api.readSnapshot();
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        update((current) => ({
          ...current,
          status: 'error',
          error: `加载工作台失败：${result.error.message}（${result.error.code}）`,
        }));
        return;
      }
      const snapshot = result.data;
      const wanted = select?.pageId ?? ref.current.activePageId;
      const kept =
        wanted !== null && wanted !== undefined && snapshot.pages.some((page) => page.id === wanted)
          ? wanted
          : (snapshot.defaultPageId ?? snapshot.pages[0]?.id ?? null);
      update((current) => ({ ...current, status: 'ready', snapshot, activePageId: kept, error: null }));
      if (kept !== null) {
        await loadPage(kept);
      }
    },
    [api, loadPage, update],
  );

  useEffect(() => {
    if (!options.enabled || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void loadSnapshot();
  }, [options.enabled, loadSnapshot]);

  const reload = useCallback(async (): Promise<void> => {
    await loadSnapshot();
  }, [loadSnapshot]);

  // -------------------------------------------------------------------------
  // 草稿：写入 / 撤销 / 放弃
  // -------------------------------------------------------------------------

  const activeKey = useCallback((): string | null => {
    const current = ref.current;
    return current.activePageId === null ? null : layoutKey(current.activePageId, current.activeBreakpoint);
  }, []);

  /** 当前断点的「完整矩形集合」（草稿优先，否则服务端快照 + 缺位自动补位）。 */
  const currentRects = useCallback((): GridRect[] => {
    const current = ref.current;
    const pageId = current.activePageId;
    if (pageId === null) {
      return [];
    }
    const key = layoutKey(pageId, current.activeBreakpoint);
    const draft = current.drafts[key];
    if (draft !== undefined) {
      return [...draft.rects];
    }
    return coveringRects({
      instances: current.instances[pageId] ?? [],
      rects: current.layouts[key]?.rects ?? [],
      breakpoint: current.activeBreakpoint,
      widgetOf: widgetOfRef.current,
    });
  }, []);

  const isDirty = useCallback((): boolean => {
    const current = ref.current;
    const pageId = current.activePageId;
    if (pageId === null) {
      return false;
    }
    const key = layoutKey(pageId, current.activeBreakpoint);
    const draft = current.drafts[key];
    if (draft === undefined) {
      return false;
    }
    return !rectsEqual(draft.rects, current.layouts[key]?.rects ?? []);
  }, []);

  /** 写入草稿。`baseRevision` 在草稿**第一次偏离**服务端快照时固定下来。 */
  const commitDraft = useCallback(
    (rects: readonly GridRect[]): void => {
      const current = ref.current;
      const pageId = current.activePageId;
      if (pageId === null) {
        return;
      }
      const breakpoint = current.activeBreakpoint;
      const key = layoutKey(pageId, breakpoint);
      const persisted = current.layouts[key]?.rects ?? [];
      const existing = current.drafts[key];
      update((state2) => {
        const drafts = { ...state2.drafts };
        if (rectsEqual(rects, persisted)) {
          delete drafts[key];
          return { ...state2, drafts };
        }
        drafts[key] = {
          rects: [...rects],
          baseRevision: existing?.baseRevision ?? state2.layouts[key]?.revision ?? 0,
          operationId: existing?.operationId ?? newOperationId(),
        };
        return { ...state2, drafts };
      });
    },
    [update],
  );

  const setDraftRects = useCallback(
    (rects: readonly GridRect[]): void => {
      const current = ref.current;
      if (current.activePageId === null || !current.editing) {
        // 非编辑状态下的布局事件（RGL 初始化时的同步）不产生草稿。
        return;
      }
      const breakpoint = current.activeBreakpoint;
      const key = layoutKey(current.activePageId, breakpoint);
      const instanceById = new Map(
        (current.instances[current.activePageId] ?? []).map((instance) => [instance.id, instance]),
      );
      // 缩放不做碰撞消解，因此这里把「本地能看、保存必被拒」的重叠就地消解掉。
      const resolved = resolveOverlaps({
        breakpoint,
        rects,
        constraintsOfInstance: constraintOfInstance,
        instanceById,
        widgetOf: widgetOfRef.current,
      });
      const draft = current.drafts[key];
      if (draft !== undefined && rectsEqual(draft.rects, resolved)) {
        return;
      }
      if (draft === undefined && rectsEqual(current.layouts[key]?.rects ?? [], resolved)) {
        return;
      }
      commitDraft(resolved);
    },
    [commitDraft, constraintOfInstance],
  );

  const undo = useCallback((): void => {
    const current = ref.current;
    const key = activeKey();
    if (key === null) {
      return;
    }
    const baseline = current.editBaseline;
    if (baseline === null) {
      return;
    }
    commitDraft(baseline);
    update((state2) => ({
      ...state2,
      notice: '已回到本次编辑开始时的布局（草稿已撤销，服务端未改动）。',
      error: null,
    }));
  }, [activeKey, commitDraft, update]);

  const discardDraft = useCallback((): void => {
    const key = activeKey();
    update((current) => {
      const drafts = { ...current.drafts };
      if (key !== null) {
        delete drafts[key];
      }
      return {
        ...current,
        drafts,
        conflict: null,
        notice: key === null ? current.notice : '已放弃当前断点的草稿（服务端布局未改动）。',
      };
    });
  }, [activeKey, update]);

  // -------------------------------------------------------------------------
  // 保存（含 409 冲突与修订围栏）
  // -------------------------------------------------------------------------

  const saveActive = useCallback(async (): Promise<SaveOutcome> => {
    // 同步未完成时拒绝**整体写**（见 `setWorkbenchSyncGate`）：草稿保留，用户可稍后重试。
    if (rejectGlobalWriteWhileSyncing()) {
      return { ok: false, reason: 'stale' };
    }
    const current = ref.current;
    const pageId = current.activePageId;
    if (pageId === null) {
      update((state2) => ({ ...state2, error: '当前没有页面，无法保存布局。' }));
      return { ok: false, reason: 'no-page' };
    }
    const breakpoint = current.activeBreakpoint;
    const key = layoutKey(pageId, breakpoint);
    const persisted = current.layouts[key];
    const draft = current.drafts[key];
    if (draft === undefined || rectsEqual(draft.rects, persisted?.rects ?? [])) {
      update((state2) => ({ ...state2, notice: '当前断点没有未保存的改动。', error: null }));
      return { ok: true, saved: false };
    }

    // 提交前用**服务端同一份**规则自检：不合法就不发请求，直接说明原因（不发注定被拒的请求）。
    const validation = validateRectsWith({
      breakpoint,
      rects: draft.rects,
      constraintsOfInstance: constraintOfInstance,
    });
    if (!validation.ok) {
      const first = validation.violations[0];
      update((state2) => ({
        ...state2,
        error: `布局不合法，未提交：${first?.detail ?? '未知原因'}`,
      }));
      return { ok: false, reason: 'invalid' };
    }

    update((state2) => ({ ...state2, busy: true, error: null, notice: null }));
    const result = await api.saveLayout(pageId, {
      breakpoint,
      baseRevision: draft.baseRevision,
      rects: [...draft.rects],
      operationId: draft.operationId,
    });
    if (!mountedRef.current) {
      return { ok: false, reason: 'stale' };
    }
    if (!result.ok) {
      if (result.error.code === 'conflict') {
        update((state2) => ({
          ...state2,
          busy: false,
          error: `保存被拒绝：${result.error.message}`,
          conflict: {
            pageId,
            breakpoint,
            code: result.error.code,
            message: result.error.message,
            localRects: [...draft.rects],
            serverRects: null,
            serverRevision: null,
            comparison: null,
          },
        }));
        return { ok: false, reason: 'conflict' };
      }
      update((state2) => ({
        ...state2,
        busy: false,
        error: `保存失败：${result.error.message}（${result.error.code}）`,
      }));
      return { ok: false, reason: 'error' };
    }

    const known = ref.current.layouts[key]?.revision ?? 0;
    if (result.data.layout.revision < known) {
      // 修订围栏：更早的写响应不得采纳（否则会用陈旧布局覆盖已知的新状态）。
      update((state2) => ({
        ...state2,
        busy: false,
        notice: '服务端返回了更早的布局修订，已忽略该响应。',
      }));
      return { ok: false, reason: 'stale' };
    }

    const saved = result.data.layout;
    update((state2) => {
      const drafts = { ...state2.drafts };
      delete drafts[key];
      return {
        ...state2,
        busy: false,
        layouts: { ...state2.layouts, [key]: saved },
        drafts,
        conflict: null,
        editBaseline: saved.rects,
        notice: `已保存 ${BREAKPOINT_LABELS[breakpoint]} 布局（服务端修订 ${String(saved.revision)}）。`,
        error: null,
      };
    });
    return { ok: true, saved: true };
  }, [api, constraintOfInstance, rejectGlobalWriteWhileSyncing, update]);

  const save = useCallback(async (): Promise<void> => {
    await saveActive();
  }, [saveActive]);

  // -------------------------------------------------------------------------
  // 切换意图与未保存确认横幅
  // -------------------------------------------------------------------------

  const completeIntent = useCallback(
    async (intent: PendingIntent): Promise<void> => {
      switch (intent.kind) {
        case 'switch-page': {
          update((current) => ({
            ...current,
            activePageId: intent.pageId,
            conflict: null,
            error: null,
            notice: null,
          }));
          if (ref.current.instances[intent.pageId] === undefined) {
            await loadPage(intent.pageId);
          }
          return;
        }
        case 'switch-breakpoint': {
          update((current) => ({
            ...current,
            activeBreakpoint: intent.breakpoint,
            conflict: null,
            notice: null,
          }));
          return;
        }
        case 'exit-edit': {
          update((current) => ({ ...current, editing: false, editBaseline: null }));
          return;
        }
        case 'discard-draft': {
          return;
        }
      }
    },
    [loadPage, update],
  );

  const request = useCallback(
    (intent: PendingIntent): void => {
      const current = ref.current;
      if (isDirty()) {
        update((state2) => ({
          ...state2,
          prompt: {
            intent,
            breakpoint: current.activeBreakpoint,
            detail: `${BREAKPOINT_LABELS[current.activeBreakpoint]}断点有未保存的布局改动。请选择：保存后继续、放弃草稿后继续，或取消并留在当前断点。`,
          },
        }));
        return;
      }
      void completeIntent(intent);
    },
    [completeIntent, isDirty, update],
  );

  const resolvePrompt = useCallback(
    async (choice: PromptChoice): Promise<void> => {
      const prompt = ref.current.prompt;
      if (prompt === null) {
        return;
      }
      if (choice === 'cancel') {
        update((state2) => ({ ...state2, prompt: null, notice: '已取消，草稿保留在本地。' }));
        return;
      }
      if (choice === 'discard') {
        discardDraft();
      } else {
        const outcome = await saveActive();
        // 保存没成功（冲突/校验/网络）时**不**继续切换：先让用户处理冲突。
        if (!outcome.ok) {
          update((state2) => ({ ...state2, prompt: null }));
          return;
        }
      }
      update((state2) => ({ ...state2, prompt: null }));
      await completeIntent(prompt.intent);
    },
    [completeIntent, discardDraft, saveActive, update],
  );

  const setActivePage = useCallback(
    (pageId: string): void => {
      if (ref.current.activePageId === pageId) {
        return;
      }
      request({ kind: 'switch-page', pageId });
    },
    [request],
  );

  const setBreakpoint = useCallback(
    (breakpoint: LayoutBreakpoint): void => {
      if (ref.current.activeBreakpoint === breakpoint) {
        return;
      }
      request({ kind: 'switch-breakpoint', breakpoint });
    },
    [request],
  );

  const toggleEditing = useCallback((): void => {
    const current = ref.current;
    if (current.editing) {
      request({ kind: 'exit-edit' });
      return;
    }
    update((state2) => ({ ...state2, editing: true, editBaseline: currentRects(), notice: null }));
  }, [currentRects, request, update]);

  const requestDiscardDraft = useCallback((): void => {
    if (!isDirty()) {
      update((state2) => ({ ...state2, notice: '当前断点没有草稿可放弃。' }));
      return;
    }
    request({ kind: 'discard-draft' });
  }, [isDirty, request, update]);

  // -------------------------------------------------------------------------
  // 键盘（非拖拽）移动 / 缩放
  // -------------------------------------------------------------------------

  const candidateRect = useCallback(
    (instanceId: string, action: RectAction): GridRect | null => {
      const rects = currentRects();
      const rect = rects.find((candidate) => candidate.i === instanceId);
      return rect === undefined ? null : moveRect(rect, action);
    },
    [currentRects],
  );

  /** 一次键盘动作的完整计划（矩形集合 + 该实例的最终矩形）；null 表示按钮必须禁用。 */
  const planAction = useCallback(
    (instanceId: string, action: RectAction) => {
      const target = candidateRect(instanceId, action);
      if (target === null) {
        return null;
      }
      const current = ref.current;
      const pageId = current.activePageId;
      if (pageId === null) {
        return null;
      }
      const instanceById = new Map(
        (current.instances[pageId] ?? []).map((instance) => [instance.id, instance]),
      );
      return planRectAction({
        breakpoint: current.activeBreakpoint,
        rects: currentRects(),
        instanceId,
        target,
        constraintsOfInstance: constraintOfInstance,
        instanceById,
        widgetOf: widgetOfRef.current,
      });
    },
    [candidateRect, constraintOfInstance, currentRects],
  );

  const canMoveInstance = useCallback(
    (instanceId: string, action: RectAction): boolean => planAction(instanceId, action) !== null,
    [planAction],
  );

  const moveInstance = useCallback(
    (instanceId: string, action: RectAction): void => {
      const plan = planAction(instanceId, action);
      if (plan === null) {
        // 理论上按钮已禁用；这里再挡一次，保证「能点的按钮一定不会被服务端拒绝」。
        update((state2) => ({ ...state2, notice: '该操作超出边界或尺寸约束，已忽略。' }));
        return;
      }
      commitDraft(plan.rects);
    },
    [commitDraft, planAction, update],
  );

  const resetInstance = useCallback(
    (instanceId: string): void => {
      const current = ref.current;
      const pageId = current.activePageId;
      if (pageId === null) {
        return;
      }
      const instance = (current.instances[pageId] ?? []).find((candidate) => candidate.id === instanceId);
      if (instance === undefined) {
        return;
      }
      const rects = currentRects();
      const others = rects.filter((rect) => rect.i !== instanceId);
      const next = rects.map((rect) =>
        rect.i === instanceId
          ? resetRect({
              instanceId,
              widgetType: instance.widgetType,
              breakpoint: current.activeBreakpoint,
              others,
              widgetOf: widgetOfRef.current,
            })
          : rect,
      );
      commitDraft(next);
      update((state2) => ({ ...state2, notice: '已把该组件重置为默认尺寸与空位（草稿，需保存）。' }));
    },
    [commitDraft, currentRects, update],
  );

  const resetPage = useCallback((): void => {
    const current = ref.current;
    const pageId = current.activePageId;
    if (pageId === null) {
      return;
    }
    const next = autoFlowRectsFor({
      instances: current.instances[pageId] ?? [],
      breakpoint: current.activeBreakpoint,
      widgetOf: widgetOfRef.current,
    });
    commitDraft(next);
    update((state2) => ({
      ...state2,
      notice: '已按默认尺寸重新排布整页（草稿，需保存；服务端未改动）。',
    }));
  }, [commitDraft, update]);

  // -------------------------------------------------------------------------
  // 实例写入
  // -------------------------------------------------------------------------

  const performWrite = useCallback(
    async <T,>(call: () => Promise<ApiResult<T>>): Promise<WriteOutcome<T>> => {
      update((current) => ({ ...current, busy: true }));
      const result = await call();
      if (!mountedRef.current) {
        return { ok: false, stale: true, conflict: false, message: '会话已切换，结果已丢弃。', data: null };
      }
      update((current) => ({ ...current, busy: false }));
      if (!result.ok) {
        return {
          ok: false,
          stale: false,
          conflict: result.error.code === 'conflict',
          message: `${result.error.message}（${result.error.code}）`,
          data: null,
        };
      }
      return { ok: true, stale: false, conflict: false, message: '', data: result.data };
    },
    [update],
  );

  const refreshActivePage = useCallback(async (): Promise<void> => {
    const pageId = ref.current.activePageId;
    if (pageId !== null) {
      await loadPage(pageId);
    }
  }, [loadPage]);

  const addWidget = useCallback(
    async (widgetType: string): Promise<void> => {
      const pageId = ref.current.activePageId;
      if (pageId === null) {
        update((current) => ({ ...current, error: '当前没有页面，无法添加组件。' }));
        return;
      }
      const outcome = await performWrite(() =>
        api.addInstance(pageId, { widgetType, operationId: newOperationId() }),
      );
      if (!outcome.ok) {
        // 冲突（409）最常见的原因是「该组件所属模块还没启用」，因此额外补一句可执行的提示。
        // 这里刻意写成独立语句而不是嵌套三元（S3358）：两种情况的文案来源不同。
        let failureMessage = `添加组件失败：${outcome.message}`;
        if (outcome.conflict) {
          failureMessage += ' 提示：该组件所属模块可能未启用，请先在「模块管理」里启用该模块。';
        }
        update((current) => ({
          ...current,
          error: outcome.stale ? outcome.message : failureMessage,
        }));
        return;
      }
      await refreshActivePage();
      update((current) => ({
        ...current,
        notice: `已添加组件 ${widgetType}（服务端已为三个断点生成初始位置）。`,
        error: null,
      }));
    },
    [api, performWrite, refreshActivePage, update],
  );

  const updateWidgetConfig = useCallback(
    async (instanceId: string, config: unknown): Promise<void> => {
      const pageId = ref.current.activePageId;
      const instance = (pageId === null ? [] : (ref.current.instances[pageId] ?? [])).find(
        (candidate) => candidate.id === instanceId,
      );
      if (instance === undefined) {
        return;
      }
      const outcome = await performWrite(() =>
        api.updateInstance(instanceId, {
          expectedRevision: instance.revision,
          config,
          operationId: newOperationId(),
        }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `保存组件配置失败：${outcome.message}` }));
        return;
      }
      await refreshActivePage();
      update((current) => ({ ...current, notice: '组件配置已保存（只影响这一个实例）。', error: null }));
    },
    [api, performWrite, refreshActivePage, update],
  );

  const setWidgetHidden = useCallback(
    async (instanceId: string, hidden: boolean): Promise<void> => {
      const pageId = ref.current.activePageId;
      const instance = (pageId === null ? [] : (ref.current.instances[pageId] ?? [])).find(
        (candidate) => candidate.id === instanceId,
      );
      if (instance === undefined) {
        return;
      }
      const outcome = await performWrite(() =>
        api.updateInstance(instanceId, {
          expectedRevision: instance.revision,
          hidden,
          operationId: newOperationId(),
        }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `切换显示状态失败：${outcome.message}` }));
        return;
      }
      await refreshActivePage();
      update((current) => ({
        ...current,
        notice: hidden
          ? '组件已隐藏：只影响页面表现，模块状态与个人数据没有变化。'
          : '组件已恢复显示。',
        error: null,
      }));
    },
    [api, performWrite, refreshActivePage, update],
  );

  const duplicateWidget = useCallback(
    async (instanceId: string): Promise<void> => {
      const outcome = await performWrite(() =>
        api.duplicateInstance(instanceId, { operationId: newOperationId() }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `复制组件失败：${outcome.message}` }));
        return;
      }
      await refreshActivePage();
      update((current) => ({ ...current, notice: '已复制该组件（新实例有独立配置与初始位置）。', error: null }));
    },
    [api, performWrite, refreshActivePage, update],
  );

  const removeWidget = useCallback(
    async (instanceId: string): Promise<void> => {
      const pageId = ref.current.activePageId;
      const instance = (pageId === null ? [] : (ref.current.instances[pageId] ?? [])).find(
        (candidate) => candidate.id === instanceId,
      );
      if (instance === undefined) {
        return;
      }
      const outcome = await performWrite(() =>
        api.deleteInstance(instanceId, {
          expectedRevision: instance.revision,
          operationId: newOperationId(),
        }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `移除组件失败：${outcome.message}` }));
        return;
      }
      await refreshActivePage();
      update((current) => ({
        ...current,
        notice: '已移除该组件实例（不影响模块状态与个人数据）。',
        error: null,
      }));
    },
    [api, performWrite, refreshActivePage, update],
  );

  // -------------------------------------------------------------------------
  // 页面
  // -------------------------------------------------------------------------

  const afterPageWrite = useCallback(
    async (selectPageId?: string): Promise<void> => {
      await loadSnapshot(selectPageId === undefined ? {} : { pageId: selectPageId });
    },
    [loadSnapshot],
  );

  const createPage = useCallback(
    async (name: string, templateId?: WorkbenchTemplateId): Promise<void> => {
      const outcome = await performWrite(() =>
        api.createPage({
          name,
          ...(templateId === undefined ? {} : { templateId }),
          operationId: newOperationId(),
        }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `新建页面失败：${outcome.message}` }));
        return;
      }
      const skipped = outcome.data?.skipped ?? [];
      if (isDirty()) {
        // 有草稿时不自动跳页，避免「切页」绕过未保存确认。
        await afterPageWrite();
      } else {
        await afterPageWrite(outcome.data?.page.id);
      }
      update((current) => ({
        ...current,
        notice:
          skipped.length === 0
            ? `已新建页面「${name}」。`
            : `已新建页面「${name}」，但有 ${String(skipped.length)} 个组件被跳过：${skipped
                .map((item) => `${item.widgetType}（${item.detail}）`)
                .join('；')}`,
      }));
    },
    [afterPageWrite, api, isDirty, performWrite, update],
  );

  const renamePage = useCallback(
    async (pageId: string, name: string): Promise<void> => {
      const page = (ref.current.snapshot?.pages ?? []).find((candidate) => candidate.id === pageId);
      if (page === undefined) {
        return;
      }
      const outcome = await performWrite(() =>
        api.updatePage(pageId, {
          expectedRevision: page.revision,
          name,
          operationId: newOperationId(),
        }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `重命名失败：${outcome.message}` }));
        return;
      }
      await afterPageWrite();
      update((current) => ({ ...current, notice: `页面已重命名为「${name}」。`, error: null }));
    },
    [afterPageWrite, api, performWrite, update],
  );

  const setDefaultPage = useCallback(
    async (pageId: string): Promise<void> => {
      const page = (ref.current.snapshot?.pages ?? []).find((candidate) => candidate.id === pageId);
      if (page === undefined) {
        return;
      }
      const outcome = await performWrite(() =>
        api.updatePage(pageId, {
          expectedRevision: page.revision,
          isDefault: true,
          operationId: newOperationId(),
        }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `设为默认页失败：${outcome.message}` }));
        return;
      }
      await afterPageWrite();
      update((current) => ({ ...current, notice: `已把「${page.name}」设为默认页。`, error: null }));
    },
    [afterPageWrite, api, performWrite, update],
  );

  const movePageOrder = useCallback(
    async (pageId: string, direction: -1 | 1): Promise<void> => {
      const pages = ref.current.snapshot?.pages ?? [];
      const ordered = [...pages].sort((a, b) => a.sortOrder - b.sortOrder);
      const index = ordered.findIndex((candidate) => candidate.id === pageId);
      const neighbor = index < 0 ? undefined : ordered[index + direction];
      const page = index < 0 ? undefined : ordered[index];
      if (page === undefined || neighbor === undefined) {
        update((current) => ({ ...current, notice: '已经在端点，无法继续调整顺序。' }));
        return;
      }
      // 顺序调整必须是「两个页面互换 sortOrder」：只改一个会留下重复值。
      const first = await performWrite(() =>
        api.updatePage(page.id, {
          expectedRevision: page.revision,
          sortOrder: neighbor.sortOrder,
          operationId: newOperationId(),
        }),
      );
      const second = await performWrite(() =>
        api.updatePage(neighbor.id, {
          expectedRevision: neighbor.revision,
          sortOrder: page.sortOrder,
          operationId: newOperationId(),
        }),
      );
      await afterPageWrite();
      // 两个页面必须都写成功才算「顺序已调整」；失败的那一半逐条列出原因。
      // 刻意用独立语句而不是嵌套三元（S3358）：这里同时要拼文案与决定是否清空 error。
      const reordered = first.ok && second.ok;
      const failureText = [first, second]
        .filter((item) => !item.ok)
        .map((item) => item.message)
        .join('');
      const notice = reordered
        ? `已调整「${page.name}」的顺序。`
        : `顺序调整未完全成功（${failureText}）；已重新载入服务端顺序。`;
      update((current) => ({
        ...current,
        notice,
        error: reordered ? null : current.error,
      }));
    },
    [afterPageWrite, api, performWrite, update],
  );

  const deletePage = useCallback(
    async (pageId: string): Promise<void> => {
      const page = (ref.current.snapshot?.pages ?? []).find((candidate) => candidate.id === pageId);
      if (page === undefined) {
        return;
      }
      const outcome = await performWrite(() =>
        api.deletePage(pageId, { expectedRevision: page.revision, operationId: newOperationId() }),
      );
      if (!outcome.ok) {
        update((current) => ({ ...current, error: `删除页面失败：${outcome.message}` }));
        return;
      }
      const deletedId = outcome.data?.deletedPageId ?? pageId;
      update((current) => {
        const drafts = { ...current.drafts };
        for (const breakpoint of LAYOUT_BREAKPOINTS) {
          delete drafts[layoutKey(pageId, breakpoint)];
        }
        return { ...current, drafts, lastDeletedPageId: deletedId };
      });
      await afterPageWrite();
      update((current) => ({
        ...current,
        notice:
          outcome.data?.notice ??
          `已删除页面「${page.name}」；实例与布局以墓碑保留，可用「恢复页面」整体恢复。`,
        error: null,
      }));
    },
    [afterPageWrite, api, performWrite, update],
  );

  const restoreDeletedPage = useCallback(async (): Promise<void> => {
    const pageId = ref.current.lastDeletedPageId;
    if (pageId === null) {
      update((current) => ({ ...current, notice: '本次会话还没有可恢复的已删除页面。' }));
      return;
    }
    const outcome = await performWrite(() => api.restorePage(pageId, { operationId: newOperationId() }));
    if (!outcome.ok) {
      update((current) => ({ ...current, error: `恢复页面失败：${outcome.message}` }));
      return;
    }
    await afterPageWrite();
    update((current) => ({
      ...current,
      notice: `已恢复页面「${outcome.data?.page.name ?? pageId}」及其内容。`,
      lastDeletedPageId: null,
      error: null,
    }));
  }, [afterPageWrite, api, performWrite, update]);

  // -------------------------------------------------------------------------
  // 模板
  // -------------------------------------------------------------------------

  const loadTemplates = useCallback(async (): Promise<void> => {
    const result = await api.listTemplates();
    if (!mountedRef.current) {
      return;
    }
    if (!result.ok) {
      update((current) => ({ ...current, error: `加载模板目录失败：${result.error.message}` }));
      return;
    }
    update((current) => ({
      ...current,
      templates: result.data.templates,
      error: null,
    }));
  }, [api, update]);

  const applyTemplate = useCallback(
    async (input: {
      readonly templateId: WorkbenchTemplateId;
      readonly mode: 'new_page' | 'replace_page' | 'reset_workspace';
      readonly pageName?: string;
    }): Promise<void> => {
      // 模板会整体重建页面 / 实例 / 布局：属于全局写，同步未完成时拒绝。
      if (rejectGlobalWriteWhileSyncing()) {
        return;
      }
      const current = ref.current;
      const page = current.activePageId === null
        ? undefined
        : (current.snapshot?.pages ?? []).find((candidate) => candidate.id === current.activePageId);
      const outcome = await performWrite(() =>
        api.applyTemplate({
          templateId: input.templateId,
          mode: input.mode,
          ...(input.pageName === undefined ? {} : { pageName: input.pageName }),
          ...(input.mode === 'replace_page' && page !== undefined
            ? { pageId: page.id, expectedRevision: page.revision }
            : {}),
          operationId: newOperationId(),
        }),
      );
      if (!outcome.ok) {
        update((state2) => ({ ...state2, error: `应用模板失败：${outcome.message}` }));
        return;
      }
      // 模板会重建页面/实例/布局：所有草稿的基准修订都已失效，必须清空（不能带着旧基准保存）。
      update((state2) => ({ ...state2, drafts: {}, conflict: null, editing: false, editBaseline: null }));
      await afterPageWrite();
      const skipped = outcome.data?.skipped ?? [];
      update((state2) => ({
        ...state2,
        notice:
          skipped.length === 0
            ? `已应用模板「${input.templateId}」（${input.mode}）。`
            : `已应用模板「${input.templateId}」，但跳过 ${String(skipped.length)} 个组件：${skipped
                .map((item) => `${item.widgetType}（${item.detail}）`)
                .join('；')}`,
        error: null,
      }));
    },
    [afterPageWrite, api, performWrite, rejectGlobalWriteWhileSyncing, update],
  );

  // -------------------------------------------------------------------------
  // 备份 / 导入 / 恢复
  // -------------------------------------------------------------------------

  const loadBackups = useCallback(async (): Promise<void> => {
    const result = await api.listBackups();
    if (!mountedRef.current) {
      return;
    }
    if (!result.ok) {
      update((current) => ({ ...current, error: `加载可恢复备份失败：${result.error.message}` }));
      return;
    }
    update((current) => ({ ...current, backups: result.data.backups, error: null }));
  }, [api, update]);

  /**
   * 导出：成功后**同时**做两件事——
   * (1) 触发一次真实文件下载（Blob + createObjectURL + 带 download 的 <a>），
   * (2) 把序列化文本渲染到只读元素里（人眼核对 + 断言）。
   */
  const exportBackup = useCallback(async (): Promise<void> => {
    const result = await api.exportBackup();
    if (!mountedRef.current) {
      return;
    }
    if (!result.ok) {
      update((current) => ({
        ...current,
        error: `导出失败：${result.error.message}（${result.error.code}）`,
        exportedJson: null,
      }));
      return;
    }
    const text = JSON.stringify(result.data.backup, null, 2);
    // 文件名里的标识段取自工作空间 ID（拿不到时退回导出时刻）：
    // 只影响文件名，**不**参与鉴权；备份文档本身不含任何工作空间标识。
    const profile = await api.readProfile();
    const label = profile.ok ? fileSafeLabel(profile.data.id) : null;
    triggerJsonDownload(`ff14-hub-workbench-${label ?? exportStamp()}.json`, text);
    update((current) => ({
      ...current,
      exportedJson: text,
      backupSize: { byteLength: result.data.byteLength, maxBytes: result.data.maxBytes },
      notice: `已导出工作台备份（${String(result.data.byteLength)} 字节，上限 ${String(result.data.maxBytes)} 字节）。`,
      error: null,
    }));
  }, [api, update]);

  const previewImport = useCallback(
    async (document: unknown, mode: WorkbenchImportMode): Promise<void> => {
      const result = await api.previewImport({ mode, document });
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        update((current) => ({
          ...current,
          importPreview: null,
          error: `导入预览失败：${result.error.message}（${result.error.code}）`,
        }));
        return;
      }
      update((current) => ({
        ...current,
        importPreview: { mode, document, preview: result.data.preview },
        notice: result.data.preview.importable
          ? '预览完成：内容可以被导入，但**尚未写入任何数据**。'
          : '预览完成：备份内容存在问题，未执行任何写入。',
        error: null,
      }));
    },
    [api, update],
  );

  const discardImportPreview = useCallback((): void => {
    update((current) => {
      if (current.importPreview === null) {
        return current;
      }
      return {
        ...current,
        importPreview: null,
        notice: '导入模式或所选文件已改变：上一次预览的令牌已失效，请重新预览后再确认导入。',
      };
    });
  }, [update]);

  const confirmImport = useCallback(async (): Promise<void> => {
    const pending = ref.current.importPreview;
    if (pending === null) {
      update((current) => ({ ...current, notice: '请先选择备份文件并完成预览。' }));
      return;
    }
    if (!pending.preview.importable) {
      update((current) => ({ ...current, error: '备份内容存在问题，未执行任何写入。' }));
      return;
    }
    const outcome = await performWrite(() =>
      api.applyImport({
        mode: pending.mode,
        document: pending.document,
        previewRevision: pending.preview.previewRevision,
        // 原样回显预览令牌：服务端会重算比对，过期即 409；**不**自动重试，也**不**自行编造 token。
        previewToken: pending.preview.previewToken,
        confirm: true,
        operationId: newOperationId(),
      }),
    );
    if (!outcome.ok) {
      update((current) => ({
        ...current,
        error: outcome.conflict
          ? '预览已过期（工作台或相关模块在预览之后发生了变化），请重新预览后再确认导入；旧令牌已丢弃，不会自动重试。'
          : `导入失败：${outcome.message}`,
        // 令牌已作废：连预览结果一起丢掉，避免用户对着过期的影响范围再点一次「确认」。
        importPreview: outcome.conflict ? null : current.importPreview,
      }));
      return;
    }
    update((current) => ({ ...current, drafts: {}, conflict: null }));
    await afterPageWrite();
    const counts = outcome.data?.result.counts;
    update((current) => ({
      ...current,
      importPreview: null,
      notice:
        counts === undefined
          ? '导入已完成。'
          : `导入已完成：新增页面 ${String(counts.pagesNew)}、替换 ${String(counts.pagesReplaced)}、跳过 ${String(
              counts.pagesSkipped,
            )}；新增组件 ${String(counts.instancesNew)}、替换 ${String(counts.instancesReplaced)}。`,
      error: null,
    }));
  }, [afterPageWrite, api, performWrite, update]);

  const cancelImport = useCallback((): void => {
    update((current) => ({ ...current, importPreview: null, notice: '已取消导入，未写入任何数据。' }));
  }, [update]);

  const restoreBackup = useCallback(
    async (backupId: string): Promise<void> => {
      /**
       * 恢复是**全局 CAS 写**（`expectedRevision` = 整份工作台 revision）：
       * 同步未完成时拒绝，绝不用一份可能不完整的本地状态去恢复。
       */
      if (rejectGlobalWriteWhileSyncing()) {
        return;
      }
      /**
       * 恢复的准入条件：**用户点击「恢复」时**的工作台 revision。
       *
       * 拿不到（还没有快照）时先向服务端重新读一次，而不是用猜测值提交——
       * 服务端在同一事务里比对它，因此一个「旧的」恢复请求不会静默覆盖刚发生的跨设备变更。
       */
      if (ref.current.snapshot === null) {
        await loadSnapshot();
        if (!mountedRef.current) {
          return;
        }
      }
      const expectedRevision = ref.current.snapshot?.revision;
      if (expectedRevision === undefined) {
        update((current) => ({
          ...current,
          error: '还没有读到工作台 revision，无法安全执行恢复；请先重新载入工作台。',
        }));
        return;
      }
      const outcome = await performWrite(() =>
        api.restoreBackup(backupId, { operationId: newOperationId(), expectedRevision }),
      );
      if (!outcome.ok) {
        update((current) => ({
          ...current,
          // 409 = 工作台在「看到备份列表」之后变过：必须重新读取列表（与 revision）再决定，
          // 绝不自动重试——那正是「用旧快照覆盖新数据」的入口。
          error: outcome.conflict ? '工作台已变化，请重新读取备份列表' : `恢复备份失败：${outcome.message}`,
        }));
        return;
      }
      update((current) => ({ ...current, drafts: {}, conflict: null }));
      await afterPageWrite();
      await loadBackups();
      update((current) => ({
        ...current,
        notice: outcome.data?.notice ?? '已恢复到该备份的状态。',
        error: null,
      }));
    },
    [afterPageWrite, api, loadBackups, loadSnapshot, performWrite, rejectGlobalWriteWhileSyncing, update],
  );

  // -------------------------------------------------------------------------
  // 冲突三出口
  // -------------------------------------------------------------------------

  const readServerLayout = useCallback(
    async (pageId: string, breakpoint: LayoutBreakpoint) => {
      const result = await api.readLayouts(pageId);
      if (!mountedRef.current || !result.ok) {
        return null;
      }
      return result.data.layouts.find((layout) => layout.breakpoint === breakpoint) ?? null;
    },
    [api],
  );

  const conflictReload = useCallback(async (): Promise<void> => {
    const conflict = ref.current.conflict;
    if (conflict === null) {
      return;
    }
    const key = layoutKey(conflict.pageId, conflict.breakpoint);
    update((current) => {
      const drafts = { ...current.drafts };
      delete drafts[key];
      return {
        ...current,
        drafts,
        conflict: null,
        notice: '已丢弃本地草稿，改为采用服务端布局。',
        error: null,
      };
    });
    await loadPage(conflict.pageId);
  }, [loadPage, update]);

  const conflictCompare = useCallback(async (): Promise<void> => {
    const conflict = ref.current.conflict;
    if (conflict === null) {
      return;
    }
    const layout = await readServerLayout(conflict.pageId, conflict.breakpoint);
    const instanceMap = new Map(
      (ref.current.instances[conflict.pageId] ?? []).map((instance) => [instance.id, instance]),
    );
    const comparison = diffRects(conflict.localRects, layout?.rects ?? [], instanceMap);
    update((current) => ({
      ...current,
      conflict:
        current.conflict === null
          ? null
          : {
              ...current.conflict,
              serverRects: layout?.rects ?? [],
              serverRevision: layout?.revision ?? 0,
              comparison,
            },
    }));
  }, [readServerLayout, update]);

  const conflictResubmit = useCallback(async (): Promise<void> => {
    const conflict = ref.current.conflict;
    if (conflict === null) {
      return;
    }
    const layout = await readServerLayout(conflict.pageId, conflict.breakpoint);
    if (!mountedRef.current) {
      return;
    }
    const key = layoutKey(conflict.pageId, conflict.breakpoint);
    const serverRevision = layout?.revision ?? 0;
    // 保留本地草稿（绝不回滚成服务端值），只把基准换成服务端**最新**修订。
    update((current) => {
      const drafts = { ...current.drafts };
      const draft = drafts[key];
      if (draft !== undefined) {
        drafts[key] = { ...draft, baseRevision: serverRevision };
      }
      return {
        ...current,
        drafts,
        layouts: layout === null ? current.layouts : { ...current.layouts, [key]: layout },
        conflict: null,
        notice: `已采用服务端最新修订 ${String(serverRevision)} 作为新的基准，正在重新提交本地草稿。`,
        error: null,
      };
    });
    await saveActive();
  }, [readServerLayout, saveActive, update]);

  const setNotice = useCallback(
    (notice: string | null): void => {
      update((current) => ({ ...current, notice }));
    },
    [update],
  );

  // -------------------------------------------------------------------------
  // 派生值
  // -------------------------------------------------------------------------

  const pages = state.snapshot?.pages ?? [];
  const limits: WorkbenchLimits = state.snapshot?.limits ?? {
    maxPages: 0,
    maxWidgetsPerPage: 0,
    maxWidgetConfigBytes: 0,
  };
  const activePage = pages.find((page) => page.id === state.activePageId) ?? null;

  const dirtyBreakpoints = useMemo(() => {
    const result: Record<LayoutBreakpoint, boolean> = { desktop: false, tablet: false, mobile: false };
    if (state.activePageId === null) {
      return result;
    }
    for (const breakpoint of LAYOUT_BREAKPOINTS) {
      const key = layoutKey(state.activePageId, breakpoint);
      const draft = state.drafts[key];
      if (draft !== undefined && !rectsEqual(draft.rects, state.layouts[key]?.rects ?? [])) {
        result[breakpoint] = true;
      }
    }
    return result;
  }, [state.activePageId, state.drafts, state.layouts]);

  const key = state.activePageId === null ? null : layoutKey(state.activePageId, state.activeBreakpoint);
  const draft = key === null ? undefined : state.drafts[key];
  const persisted = key === null ? undefined : state.layouts[key];
  // 引用稳定：`?? []` 每次渲染都会造一个新数组，会让下游 useMemo 依赖每轮都变。
  const instances = useMemo(
    () => (state.activePageId === null ? [] : (state.instances[state.activePageId] ?? [])),
    [state.activePageId, state.instances],
  );
  const rects: readonly GridRect[] =
    draft?.rects ??
    coveringRects({
      instances,
      rects: persisted?.rects ?? [],
      breakpoint: state.activeBreakpoint,
      widgetOf: options.widgetOf,
    });
  const dirty = draft !== undefined && !rectsEqual(draft.rects, persisted?.rects ?? []);

  /**
   * 「离开页面」的浏览器级兜底：草稿还在时阻止静默关闭标签页。
   * 应用内切换（切页 / 切断点 / 退出编辑）走的是可视确认横幅，
   * 浏览器级无法自绘界面，因此只做标准的 beforeunload 拦截。
   *
   * 只调用 `event.preventDefault()`：HTML 规范把「被取消的 beforeunload」当作
   * 「可能丢失未保存改动」，现代浏览器据此显示确认对话框。
   * 已废弃的 `event.returnValue = ''` 写法不再使用（它只是旧版浏览器的等价手段）。
   */
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') {
      return;
    }
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [dirty]);
  const instanceById = useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance])),
    [instances],
  );
  const gridLayouts = useMemo(() => {
    const out = {} as Record<LayoutBreakpoint, readonly LayoutItem[]>;
    for (const breakpoint of LAYOUT_BREAKPOINTS) {
      if (breakpoint === state.activeBreakpoint && draft !== undefined) {
        out[breakpoint] = toLayoutItems(draft.rects, instanceById, options.widgetOf);
        continue;
      }
      const key2 = state.activePageId === null ? null : layoutKey(state.activePageId, breakpoint);
      out[breakpoint] = toLayoutItems(
        coveringRects({
          instances,
          rects: key2 === null ? [] : (state.layouts[key2]?.rects ?? []),
          breakpoint,
          widgetOf: options.widgetOf,
        }),
        instanceById,
        options.widgetOf,
      );
    }
    return out;
  }, [
    draft,
    instanceById,
    instances,
    options.widgetOf,
    state.activeBreakpoint,
    state.activePageId,
    state.layouts,
  ]);

  return {
    status: state.status,
    busy: state.busy,
    error: state.error,
    notice: state.notice,
    pages,
    limits,
    activePage,
    activePageId: state.activePageId,
    activeBreakpoint: state.activeBreakpoint,
    editing: state.editing,
    dirty,
    dirtyBreakpoints,
    instances,
    rects,
    persistedRects: persisted?.rects ?? [],
    gridLayouts,
    conflict: state.conflict,
    prompt: state.prompt,
    templates: state.templates,
    backups: state.backups,
    backupSize: state.backupSize,
    exportedJson: state.exportedJson,
    importPreview: state.importPreview,
    lastDeletedPageId: state.lastDeletedPageId,
    widgetOf: options.widgetOf,
    moduleAccess: (moduleId) => moduleAccessRef.current(moduleId),
    reload,
    setActivePage,
    setBreakpoint,
    toggleEditing,
    requestDiscardDraft,
    resolvePrompt,
    setDraftRects,
    moveInstance,
    canMoveInstance,
    save,
    undo,
    resetInstance,
    resetPage,
    addWidget,
    updateWidgetConfig,
    setWidgetHidden,
    duplicateWidget,
    removeWidget,
    createPage,
    renamePage,
    setDefaultPage,
    movePageOrder,
    deletePage,
    restoreDeletedPage,
    loadTemplates,
    applyTemplate,
    loadBackups,
    exportBackup,
    previewImport,
    discardImportPreview,
    confirmImport,
    cancelImport,
    restoreBackup,
    conflictReload,
    conflictCompare,
    conflictResubmit,
    setNotice,
  };
}

/**
 * 触发一次真实文件下载。
 * 在没有 `URL.createObjectURL` 的环境（例如 jsdom）里**不抛异常**：
 * 文本仍然会被渲染到 `backup-export-output`，因此人眼与断言都还能核对内容。
 */
export function triggerJsonDownload(filename: string, text: string): boolean {
  try {
    if (typeof URL.createObjectURL !== 'function') {
      return false;
    }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // 立即 revoke 会让部分浏览器取消下载；延后释放。
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 备份文件名里的标识段。
 *
 * 首选工作空间 ID（`GET /me/profile` 的 `id`），这样文件名形如
 * `ff14-hub-workbench-3f2a…json`，人眼能对上「这是哪个工作空间的备份」。
 * 备份文档本身**只**含工作台配置（页面 / 实例 / 布局），不含工作空间标识或凭证。
 * 拿不到工作空间 ID 时退回导出时刻（UTC），文件名同样稳定可读。
 */
function fileSafeLabel(value: string): string | null {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length === 0 ? null : cleaned;
}

function exportStamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}
