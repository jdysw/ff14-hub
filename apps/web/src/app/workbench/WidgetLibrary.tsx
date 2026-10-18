/**
 * 组件库（阶段 03 / HUB-045）。
 *
 * 只列出**静态注册表**里真实存在的组件类型（`widgetComponentRegistry.entries()`），
 * 并且**永不**按不可信字符串动态 `import()` 或执行远程 JS。
 *
 * 模块未启用时的处理：按钮仍然可点，因为「失败原因必须来自服务端」——
 * 服务端会以 409 返回 `module_not_ready`，界面把服务端文案原样展示，
 * 并补一句「请先在模块管理里启用」。提前把按钮禁用会让用户看不到真实原因。
 */
import { MODULE_STATUS_LABELS } from '@ff14-hub/shared';
import { widgetComponentRegistry } from '../widgets/component-registry';
import type { WorkbenchController } from './use-workbench';

export interface WidgetLibraryProps {
  readonly state: WorkbenchController;
}

export function WidgetLibrary(props: WidgetLibraryProps) {
  const { state } = props;
  const entries = widgetComponentRegistry.entries();
  const disabled = state.activePageId === null || state.busy;

  return (
    <section className="workbench__panel" aria-labelledby="workbench-widget-library-title">
      <h3 className="subsection-title" id="workbench-widget-library-title">
        组件库（已注册的组件类型）
      </h3>
      <p className="panel__muted">
        这些是<strong>静态注册表</strong>里的组件类型，全部为 <code>demo.*</code> 演示组件，
        不含任何游戏业务数据。真实导航 / 钓鱼 / 高难模块属于阶段 04–05。
      </p>
      <ul className="workbench__list" data-testid="widget-library">
        {entries.map((entry) => {
          const access = state.moduleAccess(entry.moduleId);
          const meta = state.widgetOf(entry.widgetId);
          const constraint = meta?.constraint;
          return (
            <li key={entry.widgetId} className="workbench__list-item" data-testid="widget-library-item" data-widget-type={entry.widgetId}>
              <div className="workbench__list-main">
                <p className="workbench__list-title">{entry.displayName}</p>
                <p className="workbench__list-meta">
                  <code>{entry.widgetId}</code>
                  <span className="tag">{entry.moduleId}</span>
                  <span className={access.status === 'enabled' ? 'tag tag--status' : 'tag tag--warn'}>
                    模块{MODULE_STATUS_LABELS[access.status]}
                  </span>
                  <span className="tag">{entry.allowMultiple ? '可多实例' : '单实例'}</span>
                  {constraint === undefined ? null : (
                    <span className="tag">
                      最小 {constraint.minW}×{constraint.minH}
                      {constraint.maxW === null ? '' : ` · 最大 ${constraint.maxW}×${String(constraint.maxH ?? '∞')}`}
                    </span>
                  )}
                </p>
                {access.status === 'enabled' ? null : (
                  <p className="workbench__list-hint">
                    提示：添加该组件需要模块处于「已启用」；请先在 SystemBar 的「模块管理」里启用 <code>{entry.moduleId}</code>。
                  </p>
                )}
              </div>
              <button
                type="button"
                className="button button--small"
                data-testid="widget-add"
                data-widget-type={entry.widgetId}
                aria-label={`添加组件：${entry.displayName}`}
                disabled={disabled}
                onClick={() => {
                  void state.addWidget(entry.widgetId);
                }}
              >
                添加
              </button>
            </li>
          );
        })}
      </ul>
      <p className="panel__muted">
        当前页面组件上限：{state.limits.maxWidgetsPerPage} 个；本页已有 {state.instances.length} 个。
      </p>
    </section>
  );
}
