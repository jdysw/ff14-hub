/**
 * Widget Host（HUB-044）。
 *
 * 职责边界（docs/module-widget-boundaries.md 3.2）：
 * - Host 拥有**视图状态**：加载态 / 空态 / 错误卡片 / 重试 / 降级卡片。
 * - 组件只产出内容，通过 report* 通知 Host；它拿不到 D1、拿不到 Token、不决定权限。
 * - 每个实例有**独立**的状态与错误边界：一个实例坏掉不影响兄弟实例，也不影响 Shell。
 * - 权限不足、模块未启用 / 已卸载 → 安全降级卡片（**不执行**组件），而不是照常渲染。
 *
 * 配置链路：`resolveWidgetConfig` 做版本检查与**显式**迁移；迁移不可用或 Schema 不通过时
 * 不渲染组件，只显示配置错误卡片。
 */
import {
  MODULE_STATUS_HINTS,
  MODULE_STATUS_LABELS,
  type ModuleGateStatus,
} from '@ff14-hub/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RenderErrorBoundary, errorMessageOf } from '../../lib/RenderErrorBoundary';
import {
  resolveWidgetConfig,
  widgetComponentRegistry,
  type ConfigResolution,
  type WidgetComponentEntry,
  type WidgetComponentRegistry,
} from './component-registry';
import type { WidgetInstance } from './instance-store';
import { isModuleUsableForRendering } from './instance-store';
import type { ModuleAccess, WidgetErrorKind, WidgetPhase } from './types';

export interface WidgetHostProps {
  readonly instances: readonly WidgetInstance[];
  /** 访问判定：模块有效状态 + 服务端授予的能力。 */
  readonly access: (moduleId: string) => ModuleAccess;
  readonly registry?: WidgetComponentRegistry;
  /** 实例级操作：只影响该实例，**不改变模块状态**。 */
  readonly onRemoveInstance?: ((instanceId: string) => void) | undefined;
  readonly onToggleHidden?: ((instanceId: string, hidden: boolean) => void) | undefined;
  /** 组件一直不报告就绪时的兜底超时（毫秒）。 */
  readonly loadingTimeoutMs?: number | undefined;
}

const DEFAULT_LOADING_TIMEOUT_MS = 4000;

interface SlotState {
  readonly phase: WidgetPhase;
  readonly errorKind: WidgetErrorKind | null;
  readonly errorDetail: string;
  readonly retryToken: number;
  readonly renderFailed: boolean;
}

const INITIAL_SLOT_STATE: SlotState = {
  phase: 'loading',
  errorKind: null,
  errorDetail: '',
  retryToken: 0,
  renderFailed: false,
};

interface BlockedReason {
  readonly kind: 'ownership' | 'module' | 'permission' | 'config';
  readonly title: string;
  readonly detail: string;
}

function messageOf(error: unknown): string {
  return errorMessageOf(error);
}

/**
 * 错误卡片标题：三类错误必须能区分，否则用户无法判断该重试还是该改配置。
 * `render` 来自错误边界，`async` 来自组件上报，`timeout` 来自 Host 的兜底。
 */
function errorTitle(kind: WidgetErrorKind | null): string {
  switch (kind) {
    case 'async':
      return '组件异步加载失败';
    case 'timeout':
      return '组件加载超时';
    case 'config':
      return '组件配置错误';
    case 'render':
    case null:
      return '组件渲染失败';
  }
}

function StatusCard(props: {
  readonly kind: 'loading' | 'empty' | 'error';
  readonly title: string;
  readonly detail: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className={`widget-status widget-status--${props.kind}`} role={props.kind === 'error' ? 'alert' : 'status'}>
      <p className="widget-status__title">{props.title}</p>
      {props.detail.length > 0 ? <p className="widget-status__detail">{props.detail}</p> : null}
      {props.onRetry !== undefined ? (
        <button type="button" className="button button--small" onClick={props.onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

interface WidgetSlotProps {
  readonly instance: WidgetInstance;
  readonly entry: WidgetComponentEntry | null;
  readonly registry: WidgetComponentRegistry;
  readonly access: ModuleAccess;
  readonly loadingTimeoutMs: number;
  readonly onRemoveInstance?: ((instanceId: string) => void) | undefined;
  readonly onToggleHidden?: ((instanceId: string, hidden: boolean) => void) | undefined;
}

function WidgetSlot(props: WidgetSlotProps) {
  const { instance, entry, registry, access, loadingTimeoutMs } = props;
  const [state, setState] = useState<SlotState>(INITIAL_SLOT_STATE);

  /**
   * 配置解析必须**在 useMemo 内兜住异常**：
   * `resolveWidgetConfig` 会调用组件注册的迁移函数，而那是任意代码。
   * 如果让它抛出，异常发生在 WidgetSlot 自身的渲染中——而每实例的错误边界在下面只包住
   * `<Component/>`，于是它会一路冒到区域边界，连带打掉兄弟实例。
   * 因此这里把「迁移/校验抛错」降级成本实例的配置错误。
   */
  const resolution = useMemo<ConfigResolution>(() => {
    try {
      return resolveWidgetConfig(registry, instance.widgetId, instance.config, instance.configVersion);
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid_config',
        detail: `配置解析或迁移过程抛出异常：${errorMessageOf(error)}`,
      };
    }
    // retryToken 参与依赖：重试会重新做一次版本检查与迁移。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, instance.widgetId, instance.config, instance.configVersion, state.retryToken]);

  const moduleStatus: ModuleGateStatus = access.status;

  const blocked = useMemo<BlockedReason | null>(() => {
    // 归属校验必须最先做：Host 用 instance.moduleId 取访问判定，却用 widgetId 选组件条目。
    // 若两者不一致（伪造或损坏的实例），就会出现「借启用中的 A 模块执行已停用 B 模块的组件」。
    // 静态注册表的归属是权威，不一致时**拒绝执行**。
    if (entry !== null && entry.moduleId !== instance.moduleId) {
      return {
        kind: 'ownership',
        title: '实例归属不一致，已拒绝执行',
        detail:
          `静态注册表中 ${instance.widgetId} 属于模块 ${entry.moduleId}，` +
          `但该实例声称为 ${instance.moduleId}。以注册表为准，不执行该组件。`,
      };
    }
    if (!isModuleUsableForRendering(moduleStatus)) {
      // 未启用 / 已停用 / 已卸载 / 未安装 / 正在完成操作：安全降级，绝不执行组件。
      // 「能否渲染」这条规则只有一处实现（instance-store 的 isModuleUsableForRendering），
      // 避免 Host 与实例存储对同一策略给出不同答案。
      return {
        kind: 'module',
        title: `模块${MODULE_STATUS_LABELS[moduleStatus]}，该实例已暂停`,
        detail: MODULE_STATUS_HINTS[moduleStatus],
      };
    }
    if (entry !== null) {
      const missing = entry.requiredCapabilities.filter(
        (capability) => !access.grantedCapabilities.includes(capability),
      );
      if (missing.length > 0) {
        return {
          kind: 'permission',
          title: '权限不足，该实例未执行',
          detail: `缺少服务端授予的能力：${missing.join('、')}。声明能力不等于被授权。`,
        };
      }
    }
    if (!resolution.ok) {
      return {
        kind: 'config',
        title: resolution.reason === 'unsupported_widget' ? '不受支持的组件类型' : '配置无法使用',
        detail: resolution.detail,
      };
    }
    return null;
  }, [instance.moduleId, instance.widgetId, moduleStatus, entry, access.grantedCapabilities, resolution]);

  /**
   * 本次 attempt 的令牌。所有 report* 回调都绑定到创建它们时的 attempt：
   * 重试后旧 attempt 的迟到回调（旧定时器、未取消的 Promise）一律被忽略，
   * 不会把新 attempt 的 ready/empty/error 改写掉。
   */
  const attempt = state.retryToken;

  const reportReady = useCallback(() => {
    setState((current) =>
      current.renderFailed || current.retryToken !== attempt
        ? current
        : { ...current, phase: 'ready', errorKind: null, errorDetail: '' },
    );
  }, [attempt]);

  const reportEmpty = useCallback(() => {
    setState((current) =>
      current.retryToken !== attempt || current.renderFailed || current.phase === 'ready'
        ? current
        : { ...current, phase: 'empty' },
    );
  }, [attempt]);

  const reportAsyncError = useCallback(
    (error: unknown) => {
      setState((current) =>
        current.retryToken !== attempt || current.phase === 'error'
          ? current
          : { ...current, phase: 'error', errorKind: 'async', errorDetail: messageOf(error) },
      );
    },
    [attempt],
  );

  const handleRenderError = useCallback((error: unknown) => {
    setState((current) => ({
      ...current,
      phase: 'error',
      errorKind: 'render',
      errorDetail: messageOf(error),
      renderFailed: true,
    }));
  }, []);

  const retry = useCallback(() => {
    setState((current) => ({
      ...INITIAL_SLOT_STATE,
      retryToken: current.retryToken + 1,
    }));
  }, []);

  // 加载超时兜底：组件一直不报告就绪时也要给出可重试的错误态，而不是永久卡在加载中。
  useEffect(() => {
    if (blocked !== null || state.renderFailed || state.phase !== 'loading') {
      return;
    }
    const timer = setTimeout(() => {
      setState((current) =>
        current.phase === 'loading'
          ? {
              ...current,
              phase: 'error',
              errorKind: 'timeout',
              errorDetail: `组件未在 ${String(loadingTimeoutMs)} 毫秒内报告就绪`,
            }
          : current,
      );
    }, loadingTimeoutMs);
    return () => {
      clearTimeout(timer);
    };
  }, [blocked, state.renderFailed, state.phase, state.retryToken, loadingTimeoutMs]);

  const Component = entry?.Component;
  const title = entry?.displayName ?? instance.widgetId;

  return (
    <article
      className="widget-instance"
      data-testid="widget-instance"
      data-instance-id={instance.instanceId}
      data-widget-id={instance.widgetId}
      data-module-id={instance.moduleId}
      data-phase={blocked !== null ? `blocked:${blocked.kind}` : state.phase}
    >
      <header className="widget-instance__header">
        <h3 className="widget-instance__title">{title}</h3>
        <p className="widget-instance__meta">
          <span className="tag">{instance.moduleId}</span>
          <span className="tag">模块{MODULE_STATUS_LABELS[moduleStatus]}</span>
          {instance.hidden ? <span className="tag tag--muted">已隐藏</span> : null}
        </p>
        <div className="widget-instance__actions">
          {props.onToggleHidden !== undefined ? (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                props.onToggleHidden?.(instance.instanceId, !instance.hidden);
              }}
            >
              {instance.hidden ? '恢复显示' : '隐藏'}
            </button>
          ) : null}
          {props.onRemoveInstance !== undefined ? (
            <button
              type="button"
              className="button button--small button--danger"
              onClick={() => {
                props.onRemoveInstance?.(instance.instanceId);
              }}
            >
              移除实例
            </button>
          ) : null}
        </div>
      </header>

      {blocked !== null ? (
        <div className="widget-status widget-status--blocked" role="status" data-testid="widget-degraded">
          <p className="widget-status__title">{blocked.title}</p>
          <p className="widget-status__detail">{blocked.detail}</p>
          <p className="widget-status__detail widget-status__detail--muted">
            个人数据与模块状态不会因为实例降级而改变。
          </p>
        </div>
      ) : null}

      {blocked === null && resolution.ok ? (
        <>
          {state.phase === 'loading' ? (
            <StatusCard kind="loading" title="正在加载组件…" detail="等待组件报告就绪。" />
          ) : null}
          {state.phase === 'empty' ? (
            <StatusCard kind="empty" title="暂无内容" detail="组件报告本次没有可展示的内容。" onRetry={retry} />
          ) : null}
          {state.phase === 'error' ? (
            <StatusCard
              kind="error"
              title={errorTitle(state.errorKind)}
              detail={state.errorDetail}
              onRetry={retry}
            />
          ) : null}
          <div
            className={
              state.phase === 'ready' ? 'widget-instance__body' : 'widget-instance__body widget-instance__body--pending'
            }
          >
            {state.renderFailed || Component === undefined ? null : (
              <RenderErrorBoundary key={`${instance.instanceId}:${String(state.retryToken)}`} onError={handleRenderError}>
                <Component
                  instanceId={instance.instanceId}
                  moduleId={instance.moduleId}
                  widgetId={instance.widgetId}
                  config={resolution.config}
                  retryToken={state.retryToken}
                  reportReady={reportReady}
                  reportEmpty={reportEmpty}
                  reportAsyncError={reportAsyncError}
                />
              </RenderErrorBoundary>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
}

/**
 * Widget 实例列表容器。
 * 每个实例都在自己的错误边界与状态机里，因此兄弟实例之间、以及 Host 与 Shell 之间互相隔离。
 */
export function WidgetHost(props: WidgetHostProps) {
  const registry = props.registry ?? widgetComponentRegistry;
  const loadingTimeoutMs = props.loadingTimeoutMs ?? DEFAULT_LOADING_TIMEOUT_MS;
  const visible = props.instances.filter((instance) => !instance.hidden);

  if (visible.length === 0) {
    return (
      <section className="widget-host widget-host--empty" aria-label="Widget 实例区" data-testid="widget-host">
        <p className="panel__muted">
          当前没有可见的组件实例。请在上方「组件验收」里添加演示实例；已隐藏的实例可以从「已隐藏实例」区域恢复。
        </p>
      </section>
    );
  }

  return (
    <section className="widget-host" aria-label="Widget 实例区" data-testid="widget-host">
      {visible.map((instance) => (
        <WidgetSlot
          key={instance.instanceId}
          instance={instance}
          entry={registry.find(instance.widgetId)}
          registry={registry}
          access={props.access(instance.moduleId)}
          loadingTimeoutMs={loadingTimeoutMs}
          onRemoveInstance={props.onRemoveInstance}
          onToggleHidden={props.onToggleHidden}
        />
      ))}
    </section>
  );
}
