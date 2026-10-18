/**
 * 工作台主视图（阶段 03 / HUB-045 · HUB-046 · HUB-049 · HUB-054）。
 *
 * 分区（全部常驻，**不靠折叠藏起来**，这样端到端测试与屏幕阅读器都能直接找到）：
 *   页面管理 → 编辑工具栏 → 布局网格 → 组件库 → 模板 → 备份/导入/恢复
 *
 * 关键约束：
 * - 本视图是**纯展示**：全部状态与动作来自 `useWorkbench`（状态在会话作用域里，
 *   普通视图切换只是不渲染本组件，草稿因此得以保留）。
 * - 渲染错误被外层 `ShellRegion` 的错误边界隔离：本视图抛错不会带走 SystemBar 与其他视图。
 * - 未保存确认用**可视横幅**（`unsaved-banner`），不是 `window.confirm`。
 * - 冲突（409）横幅保留本地草稿，并提供「重新载入 / 比较 / 重新提交」三个显式出口。
 */
import {
  BREAKPOINT_COLUMNS,
  LAYOUT_BREAKPOINTS,
  type LayoutBreakpoint,
  type SyncChange,
} from '@ff14-hub/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModuleDataPort } from '../widgets/types';
import { registerPrivateDraftSource } from '../pwa/draft-registry';
import type { SyncChangesApi } from '../nav/nav-api';
import { useSyncChangesPoller } from '../nav/use-nav';
import { BackupPanel } from './BackupPanel';
import { EditToolbar } from './EditToolbar';
import { LayoutGrid } from './LayoutGrid';
import { PageManager } from './PageManager';
import { TemplatePicker } from './TemplatePicker';
import { WidgetCard } from './WidgetCard';
import { WidgetLibrary } from './WidgetLibrary';
import { BREAKPOINT_LABELS } from './workbench-model';
import type { WorkbenchController } from './use-workbench';

export interface WorkbenchViewProps {
  readonly state: WorkbenchController;
  /**
   * 模块数据端口（阶段 04）：由应用层构造并持有凭证，这里只做**透传**到卡片与 Host。
   * 卡片与本视图都不会把它存进 state。
   */
  readonly dataPortFor?: ((moduleId: string) => ModuleDataPort | undefined) | undefined;
  /**
   * 跨设备变更的 API（HUB-051）。未注入时**不做任何轮询**（因此阶段 03 的行为不变）。
   */
  readonly syncChangesApi?: SyncChangesApi | undefined;
  /** 轮询间隔（毫秒）；测试可注入更短的值。 */
  readonly syncIntervalMs?: number | undefined;
}

/** 该变更是否可能影响**当前页面**（页面本身 / 本页的实例 / 本页布局）。 */
function touchesActivePage(change: SyncChange, activePageId: string, instanceIds: ReadonlySet<string>): boolean {
  if (change.entityType === 'page') {
    return change.entityId === activePageId;
  }
  if (change.entityType === 'widget') {
    return instanceIds.has(change.entityId);
  }
  if (change.entityType === 'layout') {
    // 布局实体的 ID 由服务端定义（页面 + 断点）。服务端没有把「哪个页面」单独给出来，
    // 因此这里刻意**保守**：一律视为与当前页相关。代价是最多多刷新一次，
    // 而漏掉本页的布局变化会让用户看到过期布局——两者相比后者严重得多。
    return true;
  }
  return false;
}

/**
 * 已知的该实体修订号（用于「避免无谓刷新」）。
 *
 * 拿不到就返回 null：调用方会退化为「每个 (实体, 修订) 只刷新一次」的去重。
 */
function knownRevisionOf(change: SyncChange, state: WorkbenchController): number | null {
  if (change.entityType === 'page') {
    return state.pages.find((page) => page.id === change.entityId)?.revision ?? null;
  }
  if (change.entityType === 'widget') {
    return state.instances.find((instance) => instance.id === change.entityId)?.revision ?? null;
  }
  return null;
}

export function WorkbenchView(props: WorkbenchViewProps) {
  const { state } = props;
  const { dataPortFor, syncChangesApi, syncIntervalMs } = props;

  /**
   * 跨设备变更提示（只读文本，不参与布局计算的任何一步）。
   *
   * 语义刻意限定为**提示**：编辑态下它替代「自动刷新」，因为刷新会覆盖草稿，
   * 而那正是阶段 03 明确不允许的（用户没点保存，草稿就不能被动过）。
   */
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);

  /**
   * 已处理的 `(实体, 修订)` 集合：避免同一条变更在每次轮询里都触发一次刷新。
   * 放在 ref 里而不是 state：它是去重簿记，不需要触发渲染。
   */
  const handledRef = useRef(new Set<string>());

  /** 同步回调里需要读**最新**状态，但它本身要保持引用稳定（否则轮询定时器会被反复重建）。 */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  /**
   * 把「是否有未保存草稿」登记给 PWA 更新提示（HUB-012）。
   *
   * 判定口径：布局脏（`dirty`，来自真实坐标比较）或存在未决冲突（`conflict`，本地草稿还在）。
   * 两者都意味着「现在重载页面会丢用户的东西」，因此都必须让 Service Worker 更新等一等。
   */
  useEffect(
    () => registerPrivateDraftSource(() => stateRef.current.dirty || stateRef.current.conflict !== null),
    [],
  );

  const onSyncChanges = useCallback((changes: readonly SyncChange[]): void => {
    const current = stateRef.current;
    const activePageId = current.activePageId;
    if (activePageId === null) {
      return;
    }
    const instanceIds = new Set(current.instances.map((instance) => instance.id));
    const relevant = changes.filter((change) => touchesActivePage(change, activePageId, instanceIds));
    if (relevant.length === 0) {
      return;
    }
    const fresh = relevant.filter((change) => {
      const known = knownRevisionOf(change, current);
      if (known !== null && change.revision <= known) {
        // 修订号不比已知的新：这次刷新不会有任何新信息。
        return false;
      }
      const key = `${change.entityType}:${change.entityId}:${String(change.revision)}`;
      if (handledRef.current.has(key)) {
        return false;
      }
      handledRef.current.add(key);
      return true;
    });
    if (fresh.length === 0) {
      return;
    }
    if (current.editing) {
      setRemoteNotice(
        `其它设备也改动了当前页面（${String(fresh.length)} 项）。你的布局草稿已保留，本视图**不会**自动刷新或覆盖草稿；` +
          '要取服务端版本请先退出编辑并重新载入。',
      );
      return;
    }
    setRemoteNotice(null);
    void current.reload();
  }, []);

  useSyncChangesPoller({
    enabled: syncChangesApi !== undefined,
    ...(syncChangesApi === undefined ? {} : { api: syncChangesApi }),
    ...(syncIntervalMs === undefined ? {} : { intervalMs: syncIntervalMs }),
    onChanges: (changes) => {
      onSyncChanges(changes);
    },
  });

  /**
   * `layouts` 必须是**引用稳定**的对象。
   *
   * react-grid-layout 的 `layouts` 是一个受控 prop：每次渲染都新建对象字面量会让它每轮都
   * 做一次「props 布局 ↔ 内部布局」同步，与 `autoSize` 的容器高度测量叠加后可能形成
   * 渲染 → 测量 → 渲染的回环（真实现象：网格高度与下方内容持续抖动，元素永远不稳定）。
   * 因此这里按「三个断点的引用」记忆化，而不是让调用处每次渲染新建字面量。
   */
  const gridLayouts = state.gridLayouts;
  const layouts = useMemo(
    () => ({
      desktop: gridLayouts.desktop,
      tablet: gridLayouts.tablet,
      mobile: gridLayouts.mobile,
    }),
    [gridLayouts.desktop, gridLayouts.tablet, gridLayouts.mobile],
  );


  /**
   * 进入编辑模式时把网格带进视野。
   *
   * 为什么这是**功能**而不是测试便利：工作台视图上方还有页面管理、工具栏等区域，
   * 在 720px 高的窗口里网格（以及每张卡片右下角的缩放手柄）可能在折叠线以下。
   * 进入编辑模式的意图就是「改布局」，因此把网格滚到可见区是必要的可达性处理；
   * 否则用户（以及任何基于真实鼠标坐标的自动化）会按在空白处而以为「拖不动」。
   */
  useEffect(() => {
    if (!state.editing) {
      return;
    }
    const node = document.getElementById('workbench-grid');
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'start' });
    }
  }, [state.editing]);

  function focusTemplates(): void {
    const node = document.getElementById('workbench-templates');
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
    state.setNotice('请在「模板（可自由修改的起点）」面板里选择模板，然后点「确认应用模板」。');
  }

  return (
    <section
      className="panel workbench"
      data-testid="workbench-view"
      data-breakpoint={state.activeBreakpoint}
      aria-labelledby="workbench-title"
    >
      <h2 id="workbench-title">自定义工作台</h2>
      <p className="panel__muted">
        布局按「页面 × 断点」独立保存（桌面 12 列 / 平板 8 列 / 手机 4 列），各自有独立修订号；
        因此手机上的拖动不会让桌面端的保存失效。草稿只存在本地内存，只有点「保存」才会提交。
      </p>

      {state.error === null ? null : (
        <p className="notice notice--error" data-testid="workbench-error" role="alert">
          {state.error}
        </p>
      )}
      {state.notice === null ? null : (
        <p className="notice notice--ok" data-testid="workbench-notice" role="status">
          {state.notice}
        </p>
      )}

      {state.prompt === null ? null : (
        <div className="workbench__banner workbench__banner--warn" data-testid="unsaved-banner" role="alertdialog" aria-label="未保存的布局改动">
          <p className="workbench__banner-title">有未保存的布局改动</p>
          <p className="panel__muted">{state.prompt.detail}</p>
          <div className="workbench__toolbar-group">
            <button
              type="button"
              className="button"
              data-testid="unsaved-save"
              disabled={state.busy}
              onClick={() => {
                void state.resolvePrompt('save');
              }}
            >
              保存并继续
            </button>
            <button
              type="button"
              className="button button--danger"
              data-testid="unsaved-discard"
              disabled={state.busy}
              onClick={() => {
                void state.resolvePrompt('discard');
              }}
            >
              放弃草稿并继续
            </button>
            <button
              type="button"
              className="button button--secondary"
              data-testid="unsaved-cancel"
              onClick={() => {
                void state.resolvePrompt('cancel');
              }}
            >
              取消（保留草稿）
            </button>
          </div>
        </div>
      )}

      {state.conflict === null ? null : (
        <div className="workbench__banner workbench__banner--error" data-testid="conflict-banner" role="alertdialog" aria-label="保存冲突">
          <p className="workbench__banner-title">
            保存被拒绝：{BREAKPOINT_LABELS[state.conflict.breakpoint]}布局已被其他设备修改
          </p>
          <p className="panel__muted">
            服务端返回：{state.conflict.message}（{state.conflict.code}）。
            <strong>你的本地草稿仍然保留</strong>，不会被自动覆盖，也不会被自动重试。
          </p>
          <div className="workbench__toolbar-group">
            <button
              type="button"
              className="button button--secondary"
              data-testid="conflict-reload"
              onClick={() => {
                void state.conflictReload();
              }}
            >
              重新载入（丢弃草稿，取服务端）
            </button>
            <button
              type="button"
              className="button button--secondary"
              data-testid="conflict-compare"
              onClick={() => {
                void state.conflictCompare();
              }}
            >
              比较（本地与服务端的差异）
            </button>
            <button
              type="button"
              className="button"
              data-testid="conflict-resubmit"
              disabled={state.busy}
              onClick={() => {
                void state.conflictResubmit();
              }}
            >
              重新提交（用服务端最新修订）
            </button>
          </div>
          {state.conflict.comparison === null ? null : (
            <ul className="workbench__list" data-testid="conflict-comparison">
              {state.conflict.comparison.map((line) => (
                <li key={line} className="workbench__list-item">
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
          {state.conflict.serverRevision === null ? null : (
            <p className="workbench__status">
              服务端当前修订：<code>{state.conflict.serverRevision}</code>
              （本地草稿：{state.conflict.localRects.length} 个矩形，服务端：
              {state.conflict.serverRects?.length ?? 0} 个矩形）
            </p>
          )}
        </div>
      )}

      {remoteNotice === null ? null : (
        <p className="notice notice--warn" data-testid="workbench-remote-notice" role="status">
          {remoteNotice}
        </p>
      )}

      {state.status === 'loading' ? (
        <p className="panel__muted" role="status">
          正在加载工作台…
        </p>
      ) : null}

      {state.status === 'error' ? (
        <div className="workbench__toolbar-group">
          <button
            type="button"
            className="button"
            data-testid="workbench-retry"
            onClick={() => {
              void state.reload();
            }}
          >
            重试
          </button>
        </div>
      ) : null}

      <PageManager state={state} onRequestTemplates={focusTemplates} />

      {state.pages.length === 0 ? null : (
        <>
          <EditToolbar state={state} />

          {state.instances.length === 0 ? (
            <p className="panel__muted" data-testid="empty-page">
              当前页面没有任何组件（这是合法状态）。系统级入口——页面切换、组件库、设置、导入 /
              恢复与设备管理——始终保留在 App Shell，不受页面内容影响。
            </p>
          ) : null}

          <div className="workbench__grid-wrap" id="workbench-grid">
            <LayoutGrid
              breakpoint={state.activeBreakpoint}
              editing={state.editing}
              layouts={layouts}
              onDraftChange={state.setDraftRects}
            >
              {state.instances.map((instance) => {
                const rect = state.rects.find((candidate) => candidate.i === instance.id) ?? {
                  i: instance.id,
                  x: 0,
                  y: 0,
                  w: 1,
                  h: 1,
                };
                return (
                  <WidgetCard
                    key={instance.id}
                    instance={instance}
                    meta={state.widgetOf(instance.widgetType)}
                    rect={rect}
                    breakpoint={state.activeBreakpoint}
                    editing={state.editing}
                    accessOf={state.moduleAccess}
                    dataPortFor={dataPortFor}
                    disabled={state.busy}
                    canMove={(action) => state.canMoveInstance(instance.id, action)}
                    onMove={(action) => {
                      state.moveInstance(instance.id, action);
                    }}
                    onReset={() => {
                      state.resetInstance(instance.id);
                    }}
                    onToggleHidden={(hidden) => {
                      void state.setWidgetHidden(instance.id, hidden);
                    }}
                    onDuplicate={() => {
                      void state.duplicateWidget(instance.id);
                    }}
                    onRemove={() => {
                      void state.removeWidget(instance.id);
                    }}
                    onConfigure={(config) => {
                      void state.updateWidgetConfig(instance.id, config);
                    }}
                  />
                );
              })}
            </LayoutGrid>
          </div>

          <p className="workbench__status" data-testid="layout-summary">
            当前断点：{BREAKPOINT_LABELS[state.activeBreakpoint]}
            （{BREAKPOINT_COLUMNS[state.activeBreakpoint]} 列） · 组件 {state.instances.length} 个 ·
            服务端 <code>{state.persistedRects.length}</code> 个矩形 / 本地草稿{' '}
            <code>{state.rects.length}</code> 个矩形 ·{state.dirty ? ' 草稿未保存' : ' 与服务端一致'}
          </p>
        </>
      )}

      <WidgetLibrary state={state} />
      <TemplatePicker state={state} />
      <BackupPanel state={state} />
    </section>
  );
}

/** 断点清单（供测试与后续扩展引用）。 */
export const WORKBENCH_BREAKPOINTS: readonly LayoutBreakpoint[] = LAYOUT_BREAKPOINTS;
