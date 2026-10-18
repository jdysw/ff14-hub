/**
 * 页面管理（阶段 03 / HUB-046）。
 *
 * 覆盖：新建 / 改名 / 顺序调整 / 切换 / 删除 / 设为默认页 / 恢复已删除页面。
 * - 破坏性动作（删除）先要一次确认，不直接执行。
 * - 顺序调整是**非拖拽**的（上移 / 下移按钮），因此键盘与触屏都能完成。
 * - **零页面**时渲染 `empty-recovery` 面板：这是与 App Shell 一样**永久可达**的恢复入口
 *   （删除最后一个页面是合法状态，而不是把用户困在空屏）。
 */
import type { WorkspacePage } from '@ff14-hub/shared';
import { useState } from 'react';
import type { WorkbenchController } from './use-workbench';

export interface PageManagerProps {
  readonly state: WorkbenchController;
  /** 零页面时「应用模板」把用户带到模板面板（模板面板本身常驻，见 TemplatePicker）。 */
  readonly onRequestTemplates: () => void;
}

type FormMode = 'create' | 'rename';

interface FormState {
  readonly mode: FormMode;
  readonly value: string;
}

export function PageManager(props: PageManagerProps) {
  const { state } = props;
  const [form, setForm] = useState<FormState | null>(null);
  const [deleting, setDeleting] = useState(false);
  const pages = state.pages;

  function submitForm(): void {
    if (form === null) {
      return;
    }
    const name = form.value.trim();
    if (name.length === 0) {
      state.setNotice('页面名称不能为空。');
      return;
    }
    setForm(null);
    if (form.mode === 'create') {
      void state.createPage(name);
      return;
    }
    const page = state.activePage;
    if (page !== null) {
      void state.renamePage(page.id, name);
    }
  }

  if (pages.length === 0) {
    return (
      <section className="panel panel--empty workbench__recovery" data-testid="empty-recovery" role="status">
        <h3 className="subsection-title">当前没有页面（合法状态）</h3>
        <p className="panel__muted">
          删除最后一个页面不会让工作台失效：可以立刻新建页面，或用模板恢复。
          页面切换、组件库、设置、导入 / 恢复与设备入口始终保留在 App Shell 中，不依赖页面内容。
        </p>
        {form === null ? (
          <div className="workbench__toolbar-group">
            <button
              type="button"
              className="button"
              data-testid="page-add"
              onClick={() => {
                setForm({ mode: 'create', value: '' });
              }}
            >
              新建页面
            </button>
            <button
              type="button"
              className="button button--secondary"
              data-testid="empty-recovery-template"
              onClick={props.onRequestTemplates}
            >
              应用模板
            </button>
            <button
              type="button"
              className="button button--secondary"
              data-testid="page-restore"
              disabled={state.lastDeletedPageId === null}
              title={
                state.lastDeletedPageId === null
                  ? '本次会话还没有可恢复的已删除页面'
                  : '把最近删除的页面（连同内容）恢复回来'
              }
              onClick={() => {
                void state.restoreDeletedPage();
              }}
            >
              恢复页面
            </button>
          </div>
        ) : (
          <PageNameForm form={form} onChange={setForm} onSubmit={submitForm} onCancel={() => { setForm(null); }} />
        )}
      </section>
    );
  }

  const page: WorkspacePage | null = state.activePage;

  return (
    <section className="workbench__pages" aria-label="页面管理">
      <nav className="workbench__tabs" aria-label="页面切换">
        {pages.map((candidate) => {
          const active = candidate.id === state.activePageId;
          return (
            <button
              key={candidate.id}
              type="button"
              className={active ? 'workbench__tab workbench__tab--active' : 'workbench__tab'}
              data-testid="page-tab"
              data-page-id={candidate.id}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                state.setActivePage(candidate.id);
              }}
            >
              <span className="workbench__tab-name">{candidate.name}</span>
              {candidate.isDefault ? <span className="tag tag--muted">默认</span> : null}
            </button>
          );
        })}
      </nav>

      {/* 分组语义用原生 <fieldset> + <legend>（S6819），legend 视觉隐藏但可被读屏读取。 */}
      <fieldset className="workbench__toolbar-group">
        <legend className="visually-hidden">页面操作</legend>
        <button
          type="button"
          className="button button--small"
          data-testid="page-add"
          disabled={state.busy}
          onClick={() => {
            setForm({ mode: 'create', value: '' });
          }}
        >
          新建页面
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="page-rename"
          disabled={page === null || state.busy}
          onClick={() => {
            setForm({ mode: 'rename', value: page?.name ?? '' });
          }}
        >
          重命名
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="page-set-default"
          disabled={page === null || page.isDefault || state.busy}
          title={page?.isDefault === true ? '当前页面已经是默认页' : '把当前页面设为默认页'}
          onClick={() => {
            if (page !== null) {
              void state.setDefaultPage(page.id);
            }
          }}
        >
          设为默认页
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="page-move-up"
          disabled={page === null || state.busy}
          title="在页签里前移一位（非拖拽）"
          onClick={() => {
            if (page !== null) {
              void state.movePageOrder(page.id, -1);
            }
          }}
        >
          上移
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="page-move-down"
          disabled={page === null || state.busy}
          title="在页签里后移一位（非拖拽）"
          onClick={() => {
            if (page !== null) {
              void state.movePageOrder(page.id, 1);
            }
          }}
        >
          下移
        </button>
        <button
          type="button"
          className="button button--small button--danger"
          data-testid="page-delete"
          disabled={page === null || state.busy}
          onClick={() => {
            setDeleting(true);
          }}
        >
          删除页面
        </button>
        <button
          type="button"
          className="button button--small button--secondary"
          data-testid="page-restore"
          disabled={state.lastDeletedPageId === null || state.busy}
          title={
            state.lastDeletedPageId === null
              ? '本次会话还没有可恢复的已删除页面'
              : '把最近删除的页面（连同内容）恢复回来'
          }
          onClick={() => {
            void state.restoreDeletedPage();
          }}
        >
          恢复页面
        </button>
      </fieldset>

      {pages.length >= state.limits.maxPages && state.limits.maxPages > 0 ? (
        // 与工具栏的分组同理：`role="status"` 用原生 `<output>` 表达（S6819），
        // `.notice` 自带 display/margin，视觉与原来的 <p> 一致。
        <output className="notice notice--warn">页面数量已达上限（{state.limits.maxPages} 个）。</output>
      ) : null}

      {form === null ? null : (
        <PageNameForm form={form} onChange={setForm} onSubmit={submitForm} onCancel={() => { setForm(null); }} />
      )}

      {deleting && page !== null ? (
        <div className="workbench__confirm" role="alertdialog" aria-label="确认删除页面" data-testid="page-delete-confirm-panel">
          <p>
            确认删除页面「{page.name}」？删除是<strong>墓碑</strong>：实例与布局会保留，之后可以用「恢复页面」整体恢复。
          </p>
          <div className="workbench__toolbar-group">
            <button
              type="button"
              className="button button--danger"
              data-testid="page-delete-confirm"
              onClick={() => {
                setDeleting(false);
                void state.deletePage(page.id);
              }}
            >
              确认删除
            </button>
            <button
              type="button"
              className="button button--secondary"
              data-testid="page-delete-cancel"
              onClick={() => {
                setDeleting(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface PageNameFormProps {
  readonly form: FormState;
  readonly onChange: (form: FormState) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

function PageNameForm(props: PageNameFormProps) {
  const label = props.form.mode === 'create' ? '新页面名称' : '页面新名称';
  const confirmTestId = props.form.mode === 'create' ? 'page-create-confirm' : 'page-rename-confirm';
  return (
    <form
      className="workbench__page-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <label className="field">
        <span className="field__label">{label}</span>
        <input
          className="field__input"
          data-testid="page-name-input"
          value={props.form.value}
          maxLength={60}
          onChange={(event) => {
            props.onChange({ mode: props.form.mode, value: event.target.value });
          }}
        />
      </label>
      <div className="workbench__toolbar-group">
        <button type="submit" className="button" data-testid={confirmTestId}>
          确认
        </button>
        <button type="button" className="button button--secondary" data-testid="page-form-cancel" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
