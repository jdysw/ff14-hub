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
  type SyncEntityType,
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
import { setWorkbenchSyncGate, WORKBENCH_SYNCING_NOTICE, type WorkbenchController } from './use-workbench';

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

/**
 * 工作台关心的变更实体类型。
 *
 * 与导航**同一套协议**（日志只作失效信号、状态只由原子快照发布），但各自只关心自己那几类
 * 实体：别的设备改了一条导航链接不该让工作台重读快照，反之亦然。工作台按
 * 「页面 × 断点布局 × 组件实例」组织，因此这三类变化都可能影响当前页面。
 */
export const WORKBENCH_SYNC_ENTITY_TYPES: readonly SyncEntityType[] = ['page', 'widget', 'layout'];

/**
 * 权威快照刷新完成后的可见提示（可见、不静默）。
 *
 * 编辑态下必须**明确说明草稿还在**：刷新只替换服务端快照与布局基线，绝不写 `drafts`。
 */
function refreshedNotice(count: number, editing: boolean): string {
  const head =
    count > 0
      ? `已收到 ${String(count)} 条变更信号，并按服务端权威快照整体刷新工作台。`
      : '已按服务端权威快照整体刷新工作台。';
  return editing ? `${head}你的布局草稿仍然保留（不会被远端内容覆盖）。` : head;
}

export function WorkbenchView(props: WorkbenchViewProps) {
  const { state } = props;
  const { dataPortFor, syncChangesApi, syncIntervalMs } = props;

  /**
   * 跨设备变更提示（只读文本，不参与布局计算的任何一步）。
   *
   * 语义刻意限定为**提示**：编辑态下它明确说明「草稿已保留」——刷新只替换快照与服务端布局
   * 基线，**绝不**动 `drafts`（用户没点保存，草稿就不能被动过）。
   */
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);

  /**
   * 「同步未完成」：权威快照发布并确认没有更多变更之前为 true。
   *
   * 与导航同一套协议（见 `useSyncChangesPoller`）：这段时间里**全局 CAS 写**
   * （保存整页布局 / 恢复备份 / 应用模板）一律被拒绝（见下面的 `setWorkbenchSyncGate`），
   * 行级写（组件配置 / 隐藏 / 删除组件）不受影响。
   */
  const [syncing, setSyncing] = useState(false);

  /** 已收到但还没被权威快照消费掉的失效信号条数（只用于可见文案）。 */
  const pendingSignalsRef = useRef(0);

  /**
   * 本地**已经发布的**快照水位（只增不减）。
   *
   * 轮询器每轮开始会用它抬游标：同步路径发布过快照之后，不该把同一段变更再当一次新信号。
   */
  const publishedWatermarkRef = useRef(0);

  /** 同步回调里需要读**最新**状态，但它本身要保持引用稳定（否则轮询定时器会被反复重建）。 */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  /**
   * 把「同步中」登记给 `use-workbench` 的写闸门（本视图与同步协议唯一的对外接触点）。
   *
   * 为什么用 ref 转发：轮询与 `syncing` 的持有者只在本视图（它同时持有 `syncChangesApi`），
   * 而写入实现全在 `use-workbench` 里；`use-workbench.ts` 因此只增加**一个**入口
   * （`setWorkbenchSyncGate`），不引入第二套同步状态。没有注入 `syncChangesApi` 时
   * 轮询不启用、`syncing` 恒为 false，闸门因此恒为「可以写」（阶段 03 行为不变）。
   */
  const syncingRef = useRef(false);
  useEffect(() => {
    syncingRef.current = syncing;
  }, [syncing]);
  useEffect(() => setWorkbenchSyncGate(() => syncingRef.current), []);

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

  /**
   * 权威快照读取（**唯一**的状态发布路径）：整份替换本地状态并返回该快照的同步水位。
   *
   * `state.reload()` 会替换快照与当前页的服务端布局，但**不动 `drafts`**：
   * 因此「同步刷新把用户草稿清掉」在结构上不会发生（`loadPage` 只调整草稿的矩形覆盖，
   * 不改草稿内容与 `baseRevision`）。
   *
   * 水位取值（工作台与导航的**唯一**差别，理由必须写清）：`WorkbenchController` 不暴露快照对象，
   * 因此这里用轮询器给的日志下界 `knownWatermarkSeq`（排空到的最大 `seq`，含服务器在
   * `resetRequired` 里给出的水位）。
   *
   * 为什么这在工作台是**安全**的：工作台从不把变更逐条应用到本地状态（快照永远整份发布），
   * 所以「水位偏低」唯一的代价是多重读一次快照，**绝不会**跳过变更；而快照读取发生在排空
   * **之后**，其真实水位必然 ≥ 这个下界。导航侧则不同——那里必须用快照自带的水位
   * （`navSnapshotSchema.watermark` 是必填的）：只有「内容 + 水位同批读出」才能证明
   * 「这份内容已经包含到 seq ≤ 水位」，否则会出现 P1-A 那类竞态。
   *
   * 读取失败（`loadSnapshot` 把状态置为 error）时返回 `null`：轮询器据此**不发布状态、
   * 不推进游标、并保持「同步中」**。
   */
  const readAuthoritySnapshot = useCallback(
    async (knownWatermarkSeq: number): Promise<number | null> => {
      await stateRef.current.reload();
      if (stateRef.current.status === 'error') {
        return null;
      }
      const signals = pendingSignalsRef.current;
      pendingSignalsRef.current = 0;
      publishedWatermarkRef.current = Math.max(publishedWatermarkRef.current, knownWatermarkSeq);
      setRemoteNotice(refreshedNotice(signals, stateRef.current.editing));
      return publishedWatermarkRef.current;
    },
    [],
  );

  useSyncChangesPoller({
    enabled: syncChangesApi !== undefined,
    ...(syncChangesApi === undefined ? {} : { api: syncChangesApi }),
    ...(syncIntervalMs === undefined ? {} : { intervalMs: syncIntervalMs }),
    // 只有工作台实体的变更才是本视图的失效信号（导航的增删改不该让工作台重读快照）。
    relevantEntityTypes: WORKBENCH_SYNC_ENTITY_TYPES,
    readSnapshot: (knownWatermarkSeq) => readAuthoritySnapshot(knownWatermarkSeq),
    publishedWatermark: () => publishedWatermarkRef.current,
    onSyncingChange: (next) => {
      setSyncing(next);
      // 排空 / 刷新期间给出可见提示；排空完成时**只**清掉这一条，别的提示原样保留。
      setRemoteNotice((previous) =>
        next ? WORKBENCH_SYNCING_NOTICE : previous === WORKBENCH_SYNCING_NOTICE ? null : previous,
      );
    },
    onInvalidated: (changeCount) => {
      // 只记条数：**不**缓存 change 对象（它们的 payload 是当前内容，而日志条目是历史事件，
      // 缓存下来只会诱导「稍后重放」这条已被删除的错误路径）。
      pendingSignalsRef.current += changeCount;
    },
    onSettled: () => {
      setRemoteNotice((previous) => (previous === WORKBENCH_SYNCING_NOTICE ? null : previous));
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
      data-syncing={syncing ? 'true' : 'false'}
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
