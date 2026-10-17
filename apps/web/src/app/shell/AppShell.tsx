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
 * - 内容区包在渲染错误边界里：某个视图（或 Host 内部）抛错时，SystemBar 与 Shell 仍然存活。
 * - **会话隔离**：模块/组件视图放在以 `session.generation` 为 key 的 `SessionWorkbench` 里。
 *   凭证身份一变（切换或清除），整棵会话子树**同步**重挂：
 *   旧会话的私有状态、Host 实例与提示立刻消失，不等任何网络返回；
 *   旧会话在途的 GET/写响应由 `useModuleState` 的 mounted 判定丢弃，也不会触发 Host 副作用。
 * - 明文凭证只交给 API 客户端内部读取；Shell 只使用 `{ generation, authenticated }` 快照。
 */
import { useMemo, useState } from 'react';
import type { ModuleMutationResponse } from '@ff14-hub/shared';
import { createApiClient } from '../../lib/api-client';
import { RenderErrorBoundary, errorMessageOf } from '../../lib/RenderErrorBoundary';
import { applyModuleMutationToHost } from '../modules/apply-module-mutation';
import { createModulesApi, type ModulesApi } from '../modules/modules-api';
import { ModuleManagerPanel } from '../modules/ModuleManagerPanel';
import { createSessionCredentialStore, useSession } from '../modules/session-credentials';
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

interface SessionWorkbenchProps {
  readonly api: ModulesApi;
  readonly authenticated: boolean;
  readonly view: ShellView;
  readonly onRequestCredential: () => void;
}

/**
 * 会话作用域的模块/组件视图。
 *
 * 生命周期：它**在整个会话期间保持挂载**，只在凭证代际变化时（外层 `key={generation}`）重挂。
 * 切到概览或会话凭证视图时只是不再渲染模块/组件面板 —— 实例存储与模块状态快照都还在，
 * 因此「添加实例并改配置 → 去概览 → 回来」不会丢东西；只有切换/清除凭证才会清空。
 */
function SessionWorkbench(props: SessionWorkbenchProps) {
  const [instanceStore] = useState(() => createWidgetInstanceStore({ lookup: builtinWidgetLookup }));
  const [instanceNotice, setInstanceNotice] = useState<string | null>(null);
  const moduleState = useModuleState(props.api, props.authenticated);
  const showsModuleViews = props.view === 'modules' || props.view === 'widgets';

  /**
   * 模块变更后的 Host 侧联动（语义集中定义在 apply-module-mutation.ts）：
   * 卸载 → 移除该模块的全部实例；停用 → 实例保留但降级显示。
   * 注意：过期会话/过期 revision 的结果根本走不到这里
   * （useModuleState 会返回 stale 并让面板跳过回调）。
   */
  function handleModuleMutated(moduleId: string, response: ModuleMutationResponse): void {
    const effect = applyModuleMutationToHost(instanceStore, moduleId, response);
    setInstanceNotice(effect.notice);
  }

  return (
    <>
      {showsModuleViews && instanceNotice !== null ? (
        <p className="notice notice--ok" role="status">
          {instanceNotice}
        </p>
      ) : null}

      {showsModuleViews && props.view === 'modules' ? (
        <ModuleManagerPanel
          moduleState={moduleState}
          hasCredential={props.authenticated}
          onMutated={handleModuleMutated}
          onRequestCredential={props.onRequestCredential}
        />
      ) : null}

      {showsModuleViews && props.view === 'widgets' ? (
        <WidgetAcceptancePanel moduleState={moduleState} store={instanceStore} />
      ) : null}
    </>
  );
}

export function AppShell() {
  const [credentialStore] = useState(createSessionCredentialStore);
  const [view, setView] = useState<ShellView>('overview');
  const session = useSession(credentialStore);

  const api = useMemo(
    () => createModulesApi(createApiClient({ getToken: () => credentialStore.get() })),
    [credentialStore],
  );

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
        <ShellRegion>
          {/*
            会话作用域容器**始终挂载**（只按 generation 重挂）。
            切到概览 / 会话凭证视图时它只是不渲染内容，实例与模块状态因此得以保留。
          */}
          <SessionWorkbench
            // 会话代际作为 key：凭证切换/清除时整棵会话子树同步重挂。
            key={session.generation}
            api={api}
            authenticated={session.authenticated}
            view={view}
            onRequestCredential={() => {
              setView('credentials');
            }}
          />

          {view === 'overview' ? (
            <>
              <StageNotice />
              <HealthPanel />
            </>
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
          本页把它保存在**会话内存**里，不写入浏览器存储、不记录到日志、不回显内容，
          也不放进组件的 props/state。切换或清除凭证会立即清空当前会话的私有数据与组件实例。
        </p>
      </footer>
    </div>
  );
}
