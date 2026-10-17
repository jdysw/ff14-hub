/**
 * 结构化 App Shell。
 *
 * 布局分区：
 * - header      品牌与阶段标识
 * - SystemBar   永久保留的系统级入口（不可由用户移除），阶段 02 起可切换验收视图
 * - main        内容区：概览 / 模块管理 / 组件验收 / 会话凭证
 * - footer      安全提示
 *
 * 关键边界：
 * - **不**引入前端路由，**不**实现拖拽/缩放/多页面布局（阶段 03）。
 * - 内容区包在渲染错误边界里：某个视图（或 Host 内部）抛错时，SystemBar 与 Shell 仍然存活，
 *   用户可以切走或重试，而不是整页白屏。
 * - Widget 实例只存在于本页内存（阶段 02 无持久实例表）；模块卸载时由这里清理实例，
 *   与服务端 `ModuleInstanceStore` 端口的语义保持一致。
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ModuleMutationResponse } from '@ff14-hub/shared';
import { createApiClient } from '../../lib/api-client';
import { RenderErrorBoundary, errorMessageOf } from '../../lib/RenderErrorBoundary';
import { applyModuleMutationToHost } from '../modules/apply-module-mutation';
import { createModulesApi } from '../modules/modules-api';
import { ModuleManagerPanel } from '../modules/ModuleManagerPanel';
import { createSessionCredentialStore } from '../modules/session-credentials';
import { useModuleState } from '../modules/use-module-state';
import { builtinWidgetLookup } from '../widgets/component-registry';
import { createWidgetInstanceStore } from '../widgets/instance-store';
import { WidgetAcceptancePanel } from '../widgets/WidgetAcceptancePanel';
import { HealthPanel } from './HealthPanel';
import { SessionCredentialPanel } from './SessionCredentialPanel';
import { StageNotice } from './StageNotice';
import { SystemBar } from './SystemBar';
import type { ShellView } from './shell-view';

function ShellRegion(props: { readonly children: React.ReactNode }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (failure !== null) {
    return (
      <section className="panel" role="alert">
        <h2>该区域渲染失败，Shell 仍在运行</h2>
        <p className="panel__muted">
          错误已被隔离，未影响系统级入口与其他视图。原始信息：<code>{failure}</code>
        </p>
        <button
          type="button"
          className="button button--small"
          onClick={() => {
            setFailure(null);
            setAttempt((current) => current + 1);
          }}
        >
          重试
        </button>
      </section>
    );
  }

  return (
    <RenderErrorBoundary
      key={attempt}
      onError={(error) => {
        setFailure(errorMessageOf(error));
      }}
    >
      {props.children}
    </RenderErrorBoundary>
  );
}

export function AppShell() {
  const [credentialStore] = useState(createSessionCredentialStore);
  const [instanceStore] = useState(() => createWidgetInstanceStore({ lookup: builtinWidgetLookup }));
  const [view, setView] = useState<ShellView>('overview');
  const [instanceNotice, setInstanceNotice] = useState<string | null>(null);

  const api = useMemo(
    () => createModulesApi(createApiClient({ getToken: () => credentialStore.get() })),
    [credentialStore],
  );
  const token = useSyncExternalStore(credentialStore.subscribe, credentialStore.get);
  const moduleState = useModuleState(api, token);

  /**
   * 模块变更后的 Host 侧联动（语义集中定义在 apply-module-mutation.ts）：
   * 卸载 → 移除该模块的全部实例；停用 → 实例保留但降级显示。
   */
  function handleModuleMutated(moduleId: string, response: ModuleMutationResponse): void {
    const effect = applyModuleMutationToHost(instanceStore, moduleId, response);
    setInstanceNotice(effect.notice);
  }

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            FF
          </span>
          <div>
            <h1 className="brand__title">FF14 Hub</h1>
            <p className="brand__subtitle">个人导航与模块化工作台 · 国服优先</p>
          </div>
        </div>
        <p className="shell__stage">阶段 02 · 模块系统（HUB-043 / 044 / 050）</p>
      </header>

      <SystemBar
        currentView={view}
        onSelectView={(next) => {
          setView(next);
        }}
      />

      <main className="shell__main">
        {instanceNotice !== null ? (
          <p className="notice notice--ok" role="status">
            {instanceNotice}
          </p>
        ) : null}

        <ShellRegion>
          {view === 'overview' ? (
            <>
              <StageNotice />
              <HealthPanel />
            </>
          ) : null}

          {view === 'modules' ? (
            <ModuleManagerPanel
              moduleState={moduleState}
              hasCredential={token !== null}
              onMutated={handleModuleMutated}
              onRequestCredential={() => {
                setView('credentials');
              }}
            />
          ) : null}

          {view === 'widgets' ? (
            <WidgetAcceptancePanel moduleState={moduleState} store={instanceStore} />
          ) : null}

          {view === 'credentials' ? (
            <SessionCredentialPanel
              store={credentialStore}
              onSaved={() => {
                setView('modules');
              }}
            />
          ) : null}
        </ShellRegion>
      </main>

      <footer className="shell__footer">
        <p>
          凭证说明：设备 Token 只通过 <code>Authorization</code> 头传递，不出现在 URL 中；
          本页把它保存在**会话内存**里，不写入浏览器存储、不记录到日志、不回显内容。
        </p>
      </footer>
    </div>
  );
}
