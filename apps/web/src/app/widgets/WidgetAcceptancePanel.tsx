/**
 * Widget 验收视图（HUB-044 / HUB-050 的可视化验收入口）。
 *
 * 它把「模块状态 ↔ Host 表现」的联动做成**可以直接观察的事实**：
 * - 只有**已启用**模块的组件类型才能添加实例（禁用状态下按钮不可用并给出原因）。
 * - 卸载模块后，Host 侧的实例被立即清理（与服务端 `ModuleInstanceStore` 端口语义一致）。
 * - 隐藏 / 移除只影响实例：界面会显示模块状态与 revision 没有变化。
 *
 * 诚实标注：这些组件是 `demo.*` 演示组件，**没有任何游戏业务语义**；
 * 实例只存在于本页内存（阶段 02 还没有持久实例表）。
 */
import { useSyncExternalStore, useState } from 'react';
import { MODULE_STATUS_LABELS } from '@ff14-hub/shared';
import { resolveWidgetConfig, widgetComponentRegistry } from '../widgets/component-registry';
import type { WidgetInstanceStore } from '../widgets/instance-store';
import { WidgetHost } from '../widgets/WidgetHost';
import { effectiveStatusOf, moduleAccessFrom, type ModuleState } from '../modules/use-module-state';

export interface WidgetAcceptancePanelProps {
  readonly moduleState: ModuleState;
  readonly store: WidgetInstanceStore;
  readonly loadingTimeoutMs?: number | undefined;
}

export function WidgetAcceptancePanel(props: WidgetAcceptancePanelProps) {
  const { moduleState, store } = props;
  const instances = useSyncExternalStore(store.subscribe, store.list);
  const [message, setMessage] = useState<string | null>(null);

  const hidden = instances.filter((instance) => instance.hidden);
  const widgets = widgetComponentRegistry.entries();

  function addInstance(widgetId: string): void {
    const entry = widgetComponentRegistry.find(widgetId);
    if (entry === null) {
      setMessage('该组件类型不在静态注册表中，拒绝创建实例（不做动态加载）。');
      return;
    }
    const result = store.add({
      widgetId,
      config: entry.defaultConfig,
      configVersion: entry.configSchemaVersion,
    });
    if (!result.ok) {
      setMessage(
        result.reason === 'single_instance_only'
          ? '该组件类型声明 allowMultiple=false，最多只能有一个实例。'
          : '该组件类型不受支持。',
      );
      return;
    }
    setMessage(`已添加一个实例：${entry.displayName}（默认配置，可在此实例内修改）。`);
  }

  function applyDraft(instanceId: string, widgetId: string, draft: string, version: number): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setMessage('配置不是合法 JSON，未应用。');
      return;
    }
    const resolution = resolveWidgetConfig(widgetComponentRegistry, widgetId, parsed, version);
    if (!resolution.ok) {
      setMessage(`配置未通过校验：${resolution.detail}`);
      return;
    }
    store.updateConfig(instanceId, resolution.config, version);
    setMessage(
      resolution.migratedFrom === null
        ? '配置已更新（仅影响这一个实例）。'
        : `配置已按显式迁移从版本 ${String(resolution.migratedFrom)} 升级。`,
    );
  }

  const access = moduleAccessFrom(moduleState.catalog, moduleState.statuses);

  return (
    <section className="panel" aria-labelledby="widgets-title">
      <h2 id="widgets-title">组件验收（演示组件）</h2>
      <p className="panel__muted">
        下列组件全部是 <code>demo.*</code> 演示组件，<strong>没有任何游戏业务数据</strong>，
        仅用于验证多实例配置隔离、加载/空/错误态、错误隔离与模块启停联动。
        实例只存在于本页内存：阶段 02 还没有持久实例表（阶段 03 接入）。
      </p>

      {message !== null ? (
        <p className="notice notice--ok" role="status">
          {message}
        </p>
      ) : null}

      <h3 className="subsection-title">可添加的组件类型</h3>
      <ul className="widget-picker">
        {widgets.map((entry) => {
          // 门禁状态：存在待完成操作时为 transitioning，因此不会被当成可添加/可执行。
          const status = effectiveStatusOf(moduleState.statuses, entry.moduleId);
          const enabled = status === 'enabled';
          const alreadySingle =
            !entry.allowMultiple && instances.some((instance) => instance.widgetId === entry.widgetId);
          return (
            <li key={entry.widgetId} className="widget-picker__item" data-widget-id={entry.widgetId}>
              <div>
                <p className="widget-picker__name">{entry.displayName}</p>
                <p className="widget-picker__meta">
                  <code>{entry.widgetId}</code> · 模块 <code>{entry.moduleId}</code>（
                  {MODULE_STATUS_LABELS[status]}） ·{' '}
                  {entry.allowMultiple ? '可多实例' : '单实例'} · 配置版本 {String(entry.configSchemaVersion)}
                </p>
              </div>
              <button
                type="button"
                className="button button--small"
                disabled={!enabled || alreadySingle}
                title={
                  !enabled
                    ? '模块未启用：请先在「模块管理」里启用该模块'
                    : alreadySingle
                      ? '单实例组件类型已有一个实例'
                      : '添加一个实例'
                }
                onClick={() => {
                  addInstance(entry.widgetId);
                }}
              >
                添加实例
              </button>
            </li>
          );
        })}
      </ul>

      <h3 className="subsection-title">实例列表（Host 渲染）</h3>
      <WidgetHost
        instances={instances}
        access={access}
        onRemoveInstance={(instanceId) => {
          store.remove(instanceId);
          setMessage('实例已移除。注意：这只是实例级操作，模块状态与个人数据没有变化。');
        }}
        onToggleHidden={(instanceId, isHidden) => {
          store.setHidden(instanceId, isHidden);
          setMessage(
            isHidden
              ? '实例已隐藏：只影响页面表现，模块状态、后台行为与个人数据都没有变化。'
              : '实例已恢复显示。',
          );
        }}
        loadingTimeoutMs={props.loadingTimeoutMs}
      />

      <h3 className="subsection-title">已隐藏实例（{String(hidden.length)}）</h3>
      {hidden.length === 0 ? (
        <p className="panel__muted">没有已隐藏的实例。</p>
      ) : (
        <ul className="hidden-instances">
          {hidden.map((instance) => (
            <li key={instance.instanceId} className="hidden-instances__item" data-instance-id={instance.instanceId}>
              <span>
                <code>{instance.widgetId}</code>（{instance.moduleId}）
              </span>
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  store.setHidden(instance.instanceId, false);
                  setMessage('实例已恢复显示。');
                }}
              >
                恢复显示
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="subsection-title">逐实例配置（验证互不串扰）</h3>
      <p className="panel__muted">
        每段配置只作用于对应实例。修改一个实例的步长后，另一个同类型实例的计数与配置都不受影响。
      </p>
      <ul className="instance-configs">
        {instances.map((instance) => (
          <InstanceConfigEditor
            key={instance.instanceId}
            instanceId={instance.instanceId}
            widgetId={instance.widgetId}
            config={instance.config}
            configVersion={instance.configVersion}
            onApply={applyDraft}
          />
        ))}
        {instances.length === 0 ? <li className="panel__muted">还没有实例。</li> : null}
      </ul>
    </section>
  );
}

interface InstanceConfigEditorProps {
  readonly instanceId: string;
  readonly widgetId: string;
  readonly config: unknown;
  readonly configVersion: number;
  readonly onApply: (instanceId: string, widgetId: string, draft: string, version: number) => void;
}

function InstanceConfigEditor(props: InstanceConfigEditorProps) {
  const [draft, setDraft] = useState(() => JSON.stringify(props.config ?? {}, null, 2));
  const [version, setVersion] = useState(props.configVersion);

  return (
    <li className="instance-config" data-instance-id={props.instanceId}>
      <label className="field">
        <span className="field__label">
          <code>{props.widgetId}</code> 实例 {props.instanceId} 的配置
        </span>
        <textarea
          className="field__input field__input--code"
          rows={3}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      </label>
      <div className="instance-config__row">
        <label className="field field--inline">
          <span className="field__label">配置版本</span>
          <input
            className="field__input field__input--small"
            type="number"
            min={0}
            value={version}
            onChange={(event) => {
              setVersion(Number.parseInt(event.target.value, 10) || 0);
            }}
          />
        </label>
        <button
          type="button"
          className="button button--small"
          onClick={() => {
            props.onApply(props.instanceId, props.widgetId, draft, version);
          }}
        >
          应用配置
        </button>
        <button
          type="button"
          className="button button--small button--secondary"
          onClick={() => {
            // 旧版本 + 旧形状：用于现场演示「显式迁移」这条链路。
            const legacy = { increment: 3 };
            setDraft(JSON.stringify(legacy, null, 2));
            setVersion(0);
            props.onApply(props.instanceId, props.widgetId, JSON.stringify(legacy), 0);
          }}
          title="把该实例的配置替换为版本 0 的旧形状，观察显式迁移"
        >
          模拟旧版配置
        </button>
      </div>
    </li>
  );
}
