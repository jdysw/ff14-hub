/**
 * 工作台里的单个组件卡片（阶段 03 / HUB-045 · HUB-046）。
 *
 * 复用边界（不重复造轮子）：
 * - 组件内容由**既有的 `WidgetHost`** 渲染：配置版本检查、显式迁移、
 *   每实例错误边界、加载/空/错误卡片、权限与模块门禁降级全部沿用阶段 02 的实现。
 * - 本卡片只负责「实例外壳」：拖动把手、实例级操作（配置 / 隐藏 / 复制 / 移除 / 重置），
 *   以及**不依赖拖拽**的键盘移动与缩放按钮。
 *
 * 键盘替代（硬要求）：8 个方向/尺寸按钮全部在卡片内部，且每个按钮在
 * 「越界 / 低于最小尺寸 / 超过最大尺寸 / 与其它组件重叠」时禁用——
 * 判定用的是共享契约里**与保存路径同一份**的 `validateLayoutRects`，
 * 因此「按钮可点」蕴含「保存不会被服务端拒绝」。
 */
import { MODULE_STATUS_LABELS, type GridRect, type LayoutBreakpoint, type WidgetInstance } from '@ff14-hub/shared';
import {
  forwardRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
} from 'react';
import { resolveWidgetConfig, widgetComponentRegistry } from '../widgets/component-registry';
import { WidgetHost } from '../widgets/WidgetHost';
import type { ModuleAccess } from '../widgets/types';
import { BREAKPOINT_LABELS, RECT_ACTIONS, type RectAction, type WorkbenchWidgetMeta } from './workbench-model';

export interface WidgetCardProps {
  readonly instance: WidgetInstance;
  readonly meta: WorkbenchWidgetMeta | null;
  readonly rect: GridRect;
  readonly breakpoint: LayoutBreakpoint;
  readonly editing: boolean;
  /** Host 需要的访问判定（模块门禁 + 服务端授予的能力）。 */
  readonly accessOf: (moduleId: string) => ModuleAccess;
  readonly disabled: boolean;
  readonly canMove: (action: RectAction) => boolean;
  readonly onMove: (action: RectAction) => void;
  readonly onReset: () => void;
  readonly onToggleHidden: (hidden: boolean) => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
  readonly onConfigure: (config: unknown) => void;
  /**
   * 由 react-grid-layout 注入：定位样式与类名，以及它追加的缩放手柄。
   *
   * 为什么本卡片**直接**充当网格项（而不是再套一层 div）：react-resizable 会把缩放手柄
   * 追加到「被克隆的那一层」内部，因此手柄只有在卡片自身是网格项时才落在卡片里面；
   * 套一层 wrapper 会让手柄成为卡片的兄弟节点，卡片作用域内的定位/命中都会落空。
   */
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
  /**
   * react-draggable 通过 `cloneElement(child, { onMouseDown, onMouseUp, onTouchEnd })`
   * 注入到**子元素**上的事件处理器。
   *
   * **必须原样转发到根节点**：DraggableCore 的拖动入口就是一个 React `onMouseDown` 属性，
   * 由 RGL 克隆到它的子元素上。如果子元素是组件而组件不把这三个属性转给 DOM，
   * 拖动会**静默失效**——不报错、不触发 `onDragStart`、类名里永远不会出现
   * `react-draggable-dragging`，表现就是「按着把手拖不动」。
   * 缩放不受影响：那个手柄是 react-resizable 自己创建并直接绑定 ref 的 DOM 元素。
   */
  readonly onMouseDown?: MouseEventHandler<HTMLElement> | undefined;
  readonly onMouseUp?: MouseEventHandler<HTMLElement> | undefined;
  readonly onTouchEnd?: TouchEventHandler<HTMLElement> | undefined;
}

/** 服务端实例 → Widget Host 需要的实例形状（只做字段改名，不改语义）。 */
function toHostInstance(instance: WidgetInstance) {
  return {
    instanceId: instance.id,
    moduleId: instance.moduleId,
    widgetId: instance.widgetType,
    config: instance.config,
    configVersion: instance.configVersion,
    hidden: instance.hidden,
  };
}

export const WidgetCard = forwardRef<HTMLElement, WidgetCardProps>(function WidgetCard(props, ref) {
  const { instance, meta, rect, breakpoint, editing } = props;
  const [configOpen, setConfigOpen] = useState(false);
  const title = meta?.displayName ?? instance.widgetType;
  const access = props.accessOf(instance.moduleId);

  return (
    <article
      // react-grid-layout 传入的 ref：react-draggable 用它定位节点，不能丢。
      ref={ref}
      // react-draggable 注入的拖动入口：必须落在真正的 DOM 节点上，否则拖动会静默失效。
      onMouseDown={props.onMouseDown}
      onMouseUp={props.onMouseUp}
      onTouchEnd={props.onTouchEnd}
      className={[
        'widget-card',
        instance.hidden ? 'widget-card--hidden' : null,
        props.className ?? null,
      ]
        .filter((value): value is string => value !== null)
        .join(' ')}
      style={props.style}
      data-testid="widget-card"
      data-instance-id={instance.id}
      data-widget-type={instance.widgetType}
      data-hidden={instance.hidden ? 'true' : 'false'}
      aria-label={`组件卡片：${title}`}
    >
      <header className="widget-card__header">
        {/*
          拖动把手是带 `role="button"` 的 `div` 而不是 `<button>`：
          表单控件在部分浏览器/交互下会吞掉拖动起点（并且 disabled 语义会影响命中）。
          键盘可达性不依赖它——每张卡片内部都有 8 个方向 / 尺寸按钮。
        */}
        <div
          className="widget-card__drag-handle"
          data-testid="widget-card__drag-handle"
          role="button"
          tabIndex={-1}
          aria-disabled={!editing}
          aria-label={`拖动「${title}」（键盘用户可用下方的方向与尺寸按钮）`}
          title={editing ? '按住拖动（也可用下方按钮）' : '进入编辑模式后可拖动'}
        >
          <span aria-hidden="true">⠿</span>
        </div>
        <div className="widget-card__heading">
          <h3 className="widget-card__title">{title}</h3>
          <p className="widget-card__meta">
            <code>{instance.widgetType}</code>
            <span className="tag">{instance.moduleId}</span>
            <span className="tag">模块{MODULE_STATUS_LABELS[access.status]}</span>
            <span className="tag">
              {BREAKPOINT_LABELS[breakpoint]} {rect.w}×{rect.h} @({rect.x}, {rect.y})
            </span>
            {instance.hidden ? <span className="tag tag--muted">已隐藏</span> : null}
          </p>
        </div>
      </header>

      <div className="widget-card__actions" role="group" aria-label={`「${title}」实例操作`}>
        <button
          type="button"
          className="button button--small"
          data-testid="widget-configure"
          aria-expanded={configOpen}
          disabled={props.disabled}
          onClick={() => {
            setConfigOpen((open) => !open);
          }}
        >
          配置
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="widget-hide"
          aria-pressed={instance.hidden}
          disabled={props.disabled}
          onClick={() => {
            props.onToggleHidden(!instance.hidden);
          }}
        >
          {instance.hidden ? '显示' : '隐藏'}
        </button>
        <button
          type="button"
          className="button button--small"
          data-testid="widget-duplicate"
          disabled={props.disabled}
          onClick={() => {
            props.onDuplicate();
          }}
        >
          复制
        </button>
        <button
          type="button"
          className="button button--small button--danger"
          data-testid="widget-remove"
          disabled={props.disabled}
          onClick={() => {
            props.onRemove();
          }}
        >
          移除
        </button>
        <button
          type="button"
          className="button button--small button--secondary"
          data-testid="widget-reset"
          disabled={props.disabled || !editing}
          title={editing ? '重置为默认尺寸并重新找空位（草稿，需保存）' : '请先进入编辑模式'}
          onClick={() => {
            props.onReset();
          }}
        >
          重置
        </button>
      </div>

      <div
        className="widget-card__actions widget-card__actions--move"
        role="group"
        aria-label={`「${title}」位置与尺寸（无需拖拽）`}
      >
        {RECT_ACTIONS.map((spec) => {
          const allowed = editing && props.canMove(spec.action);
          return (
            <button
              key={spec.action}
              type="button"
              className="button button--small"
              data-testid={spec.testId}
              aria-label={`${spec.label}「${title}」`}
              disabled={!allowed}
              title={
                !editing
                  ? '请先进入编辑模式'
                  : allowed
                    ? `${spec.label}（键盘替代拖拽）`
                    : '该操作会越界、超出尺寸约束，或与其它组件重叠'
              }
              onClick={() => {
                props.onMove(spec.action);
              }}
            >
              {spec.label}
            </button>
          );
        })}
      </div>

      {configOpen ? (
        <WidgetConfigEditor
          instance={instance}
          onApply={(config) => {
            setConfigOpen(false);
            props.onConfigure(config);
          }}
          onCancel={() => {
            setConfigOpen(false);
          }}
        />
      ) : null}

      <div className="widget-card__body">
        {instance.hidden ? (
          <p className="panel__muted">
            该实例已隐藏：不执行组件，但<strong>保留网格位置</strong>，因此隐藏不会在布局里留下缺口。
          </p>
        ) : (
          <WidgetHost instances={[toHostInstance(instance)]} access={props.accessOf} />
        )}
      </div>

      {/* react-resizable 注入的右下角缩放手柄：必须是本元素的直接子节点。 */}
      {props.children}
    </article>
  );
});

interface WidgetConfigEditorProps {
  readonly instance: WidgetInstance;
  readonly onApply: (config: unknown) => void;
  readonly onCancel: () => void;
}

/** 逐实例配置编辑器：先做**显式迁移 + Schema 校验**，不通过就不提交。 */
function WidgetConfigEditor(props: WidgetConfigEditorProps) {
  const [draft, setDraft] = useState(() => JSON.stringify(props.instance.config ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="widget-card__config">
      <label className="field">
        <span className="field__label">
          <code>{props.instance.widgetType}</code> 的配置 JSON（当前配置版本 {props.instance.configVersion}）
        </span>
        <textarea
          className="field__input field__input--code"
          data-testid="widget-config-input"
          rows={3}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      </label>
      {error === null ? null : (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <div className="widget-card__actions">
        <button
          type="button"
          className="button button--small"
          data-testid="widget-config-apply"
          onClick={() => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(draft);
            } catch {
              setError('配置不是合法的 JSON，未提交。');
              return;
            }
            const resolution = resolveWidgetConfig(
              widgetComponentRegistry,
              props.instance.widgetType,
              parsed,
              props.instance.configVersion,
            );
            if (!resolution.ok) {
              setError(`配置未通过校验（${resolution.reason}）：${resolution.detail}`);
              return;
            }
            setError(null);
            props.onApply(resolution.config);
          }}
        >
          应用配置
        </button>
        <button
          type="button"
          className="button button--small button--secondary"
          data-testid="widget-config-cancel"
          onClick={props.onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}
