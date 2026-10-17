/**
 * 编辑工具栏（阶段 03 / HUB-046）。
 *
 * 它把「草稿 / 已保存」这件事做成**可见事实**：
 * - `dirty-indicator` 显示当前断点是否有未保存改动（由真实矩形比较得出，不是「点过按钮」）；
 * - `breakpoint-dirty-indicator` 逐断点显示，因此「桌面改了、手机没改」一眼可见；
 * - `breakpoint-switch` 是**手动**断点切换（不依赖容器宽度），切走时会弹未保存确认横幅。
 *
 * 所有控件都是原生 `<button>`：键盘可达、可被无障碍树描述、可被端到端测试直接点击。
 */
import type { LayoutBreakpoint } from '@ff14-hub/shared';
import { BREAKPOINT_LABELS } from './workbench-model';
import type { WorkbenchController } from './use-workbench';

export interface EditToolbarProps {
  readonly state: WorkbenchController;
}

const BREAKPOINTS: readonly LayoutBreakpoint[] = ['desktop', 'tablet', 'mobile'];

export function EditToolbar(props: EditToolbarProps) {
  const { state } = props;
  const hasDraft = state.dirty;
  const canEdit = state.activePageId !== null;

  return (
    <div className="workbench__toolbar" data-testid="edit-toolbar">
      <div className="workbench__toolbar-group" role="group" aria-label="编辑模式">
        <button
          type="button"
          className="button"
          data-testid="edit-toggle"
          aria-pressed={state.editing}
          disabled={!canEdit}
          onClick={() => {
            state.toggleEditing();
          }}
        >
          {state.editing ? '退出编辑' : '进入编辑'}
        </button>
        <button
          type="button"
          className="button"
          data-testid="save-layout"
          disabled={!hasDraft || state.busy}
          title={hasDraft ? '把当前断点的草稿提交到服务端' : '当前断点没有未保存的改动'}
          onClick={() => {
            void state.save();
          }}
        >
          保存
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="undo-layout"
          disabled={!state.editing}
          title="回到本次编辑开始时的持久布局"
          onClick={() => {
            state.undo();
          }}
        >
          撤销
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="discard-layout"
          disabled={!hasDraft}
          title="放弃当前断点的草稿（会先确认）"
          onClick={() => {
            state.requestDiscardDraft();
          }}
        >
          放弃草稿
        </button>
        <button
          type="button"
          className="button button--secondary"
          data-testid="page-reset"
          disabled={!state.editing}
          title="按默认尺寸重新排布整页（草稿，需保存）"
          onClick={() => {
            state.resetPage();
          }}
        >
          重置整页
        </button>
      </div>

      <div className="workbench__toolbar-group" role="group" aria-label="断点切换">
        {BREAKPOINTS.map((breakpoint) => {
          const active = state.activeBreakpoint === breakpoint;
          return (
            <button
              key={breakpoint}
              type="button"
              className={active ? 'button button--small button--active' : 'button button--small'}
              data-testid="breakpoint-switch"
              data-breakpoint={breakpoint}
              aria-pressed={active}
              onClick={() => {
                state.setBreakpoint(breakpoint);
              }}
            >
              {BREAKPOINT_LABELS[breakpoint]}
            </button>
          );
        })}
      </div>

      {/*
        脏标记只在**确实有未保存改动**时可见（用 `hidden` 而不是不渲染：
        这样端到端测试的 `toBeVisible()` / `toBeHidden()` 与无障碍树都能得到确定答案）。
      */}
      <p
        className="workbench__status"
        data-testid="dirty-indicator"
        data-dirty={state.dirty ? 'true' : 'false'}
        hidden={!state.dirty}
        role="status"
      >
        {state.dirty ? '当前断点有未保存的改动（草稿在本地）' : '当前断点与服务端一致'}
      </p>

      <p
        className="workbench__status"
        data-testid="breakpoint-dirty-indicator"
        hidden={!state.dirty}
        role="status"
      >
        {BREAKPOINTS.map((breakpoint) => (
          <span key={breakpoint} className="workbench__status-item" data-breakpoint={breakpoint}>
            {BREAKPOINT_LABELS[breakpoint]}：
            {state.dirtyBreakpoints[breakpoint] ? '有未保存改动' : '已保存'}
          </span>
        ))}
      </p>

      {state.editing ? (
        <p className="panel__muted">
          编辑模式：可以拖动卡片把手移动、拖动右下角缩放；也可以完全不用鼠标——
          每张卡片内部都有「上移 / 下移 / 左移 / 右移 / 加宽 / 缩窄 / 增高 / 降低」按钮，
          按钮会在越界、超出尺寸约束或与其它组件重叠时自动禁用。
        </p>
      ) : null}
    </div>
  );
}
