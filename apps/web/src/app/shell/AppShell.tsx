/**
 * 结构化 App Shell。
 *
 * 布局分区：
 * - header      品牌与阶段标识
 * - NavEntryBar 「个人导航」系统级入口（阶段 04），与 SystemBar 里的「自定义工作台」同级
 * - SystemBar   永久保留的系统级入口（不可由用户移除），阶段 02 起可切换验收视图
 * - main        内容区：概览 / 导航 / 工作台 / 模块管理 / 组件验收 / 会话凭证
 * - footer      安全提示
 *
 * 关键边界：
 * - **不**引入前端路由，**不**实现拖拽/缩放/多页面布局（阶段 03 起由工作台视图负责）。
 * - 内容区包在渲染错误边界里：某个视图（或 Host 内部）抛错时，NavEntryBar / SystemBar
 *   与 Shell 仍然存活。
 * - **会话隔离**：模块/组件/导航/工作台视图放在以 `session.generation` 为 key 的
 *   `SessionWorkbench` 里。凭证身份一变（切换或清除），整棵会话子树**同步**重挂：
 *   旧会话的私有状态、Host 实例与提示立刻消失，不等任何网络返回。
 * - 明文凭证只交给 API 客户端内部读取；Shell 只使用 `{ generation, authenticated }` 快照，
 *   并把它以 `getToken` **回调**的形式交给需要发请求的层（导航状态、模块数据端口）。
 *   因此凭证本身不会出现在任何 props / state / URL / 日志里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModuleMutationResponse } from '@ff14-hub/shared';
import { createApiClient } from '../../lib/api-client';
import { RenderErrorBoundary, errorMessageOf } from '../../lib/RenderErrorBoundary';
import { applyModuleMutationToHost } from '../modules/apply-module-mutation';
import { createModulesApi, type ModulesApi } from '../modules/modules-api';
import { ModuleManagerPanel } from '../modules/ModuleManagerPanel';
import { createSessionCredentialStore, useSession } from '../modules/session-credentials';
import { moduleAccessFrom, useModuleState } from '../modules/use-module-state';
import { NavView } from '../nav/NavView';
import { FishingPage } from '../fish/FishingPanel';
import { FISH_MODULE_ID } from '@ff14-hub/shared';
import { REMINDER_MODULE_ID } from '@ff14-hub/shared';
import { ReminderPage } from '../reminders/ReminderPanel';
import { createNavTransport, createSyncChangesApi, type SyncChangesApi } from '../nav/nav-api';
import { useNav } from '../nav/use-nav';
import { builtinWidgetLookup } from '../widgets/component-registry';
import { createWidgetInstanceStore } from '../widgets/instance-store';
import {
  createModuleDataPort,
  MODULE_PORT_FACTORIES,
  type ModulePortContext,
} from '../widgets/module-data-ports';
import type { ModuleAccess, ModuleDataPort } from '../widgets/types';
import { WidgetAcceptancePanel } from '../widgets/WidgetAcceptancePanel';
import { createWorkbenchApi, type WorkbenchApi } from '../workbench/workbench-api';
import { useWorkbench } from '../workbench/use-workbench';
import { createWidgetLookup } from '../workbench/widget-lookup';
import { WorkbenchView } from '../workbench/WorkbenchView';
import { PwaStatusBar } from '../pwa/PwaStatusBar';
import { clearPrivateCaches } from '../pwa/register-service-worker';
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
  readonly workbenchApi: WorkbenchApi;
  /** 跨设备变更 API（与导航/工作台共用同一份凭证装配）。 */
  readonly syncChangesApi: SyncChangesApi;
  /** 只读取凭证的回调；凭证本身绝不出现在 props 里。 */
  readonly getToken: () => string | null;
  readonly onUnauthorized: () => void;
  readonly authenticated: boolean;
  readonly view: ShellView;
  readonly onRequestCredential: () => void;
}

/**
 * 会话作用域的模块/组件/导航/工作台视图。
 *
 * 生命周期：它**在整个会话期间保持挂载**，只在凭证代际变化时（外层 `key={generation}`）重挂。
 * 切到概览或会话凭证视图时只是不再渲染这些面板 —— 实例存储、模块状态快照、
 * 导航状态以及**工作台草稿**都还在，因此「改布局 → 去概览 → 回来」不会丢东西；
 * 只有切换/清除凭证才会清空（这是阶段 03「切断点/切页面不丢草稿」的实现基础）。
 */
function SessionWorkbench(props: SessionWorkbenchProps) {
  const { getToken, onUnauthorized } = props;
  const [instanceStore] = useState(() => createWidgetInstanceStore({ lookup: builtinWidgetLookup }));
  const [instanceNotice, setInstanceNotice] = useState<string | null>(null);
  const moduleState = useModuleState(props.api, props.authenticated);
  const showsModuleViews = props.view === 'modules' || props.view === 'widgets';

  /**
   * 工作台状态**挂在这一层**（而不是 `WorkbenchView` 内部）：
   * 视图只是不渲染，状态与草稿因此跨视图切换保留；凭证代际变化时随本组件一起被丢弃。
   */
  const widgetOf = useMemo(() => createWidgetLookup(moduleState.catalog), [moduleState.catalog]);
  const moduleAccess = useMemo(
    () => moduleAccessFrom(moduleState.catalog, moduleState.statuses),
    [moduleState.catalog, moduleState.statuses],
  );
  const workbench = useWorkbench({
    api: props.workbenchApi,
    enabled: props.view === 'workbench',
    widgetOf,
    moduleAccess,
  });

  /**
   * 导航状态同样挂在这一层：切走视图不会丢筛选条件与编辑中的草稿。
   * `enabled` 控制「进入导航视图时首次加载」，而不是「离开就清空」。
   */
  const nav = useNav({
    getToken,
    enabled: props.view === 'nav',
    onUnauthorized,
    syncApi: props.syncChangesApi,
  });

  /**
   * 模块数据端口（阶段 04）。
   *
   * 三条纪律：
   * - 端口**在这里**用「读取凭证的回调」现场构造，Token 只作为局部变量被 `createModuleDataPort`
   *   立即消费，绝不写进 state / props / URL / 日志。
   * - 只给**注册了端口工厂**的模块返回端口；其余模块返回 undefined，组件因此走「无端口降级」
   *   而不是拿到一个空端口语焉不详（见 `WidgetRuntimeProps.data`）。
   * - `moduleAccess` 通过 ref 读取最新值：端口每次 `call` 前都会复检门禁，
   *   因此「模块正在卸载」期间不可能绕过生命周期 fence。
   */
  const moduleAccessRef = useRef(moduleAccess);
  useEffect(() => {
    moduleAccessRef.current = moduleAccess;
  });

  const dataPortFor = useCallback(
    (moduleId: string): ModuleDataPort | undefined => {
      if (!Object.hasOwn(MODULE_PORT_FACTORIES, moduleId)) {
        return undefined;
      }
      const context: ModulePortContext = {
        token: getToken() ?? '',
        apiBaseUrl: '',
        moduleAccess: (id: string): ModuleAccess => moduleAccessRef.current(id),
        onUnauthorized,
      };
      return createModuleDataPort({ moduleId, context });
    },
    [getToken, onUnauthorized],
  );

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
        <WidgetAcceptancePanel
          moduleState={moduleState}
          store={instanceStore}
          dataPortFor={dataPortFor}
        />
      ) : null}

      {props.view === 'nav' ? <NavView state={nav} /> : null}
      {props.view === 'fishing' ? <FishingPage dataPortFor={dataPortFor} status={moduleAccess(FISH_MODULE_ID).status}/> : null}
      {props.view === 'reminders' ? <ReminderPage dataPortFor={dataPortFor} status={moduleAccess(REMINDER_MODULE_ID).status}/> : null}

      {props.view === 'workbench' ? (
        <WorkbenchView
          state={workbench}
          dataPortFor={dataPortFor}
          syncChangesApi={props.syncChangesApi}
        />
      ) : null}
    </>
  );
}

/**
 * 「个人导航」系统级入口。
 *
 * 为什么它是 AppShell 里的一小段、而不是 SystemBar 的一项：
 * `SystemBar.tsx` 的 `SYSTEM_ENTRIES` 属于阶段 02 的既有实现，本阶段不改那个文件，
 * 因此把新入口渲染在与它**同级**的位置（同一个 `<nav>` 语义、同样的按钮样式），
 * 并保持所有既有入口原样可用（不改、不移除任何一个）。
 */
function NavEntryBar(props: { readonly active: boolean; readonly onOpen: () => void }) {
  return (
    <nav className="system-bar system-bar--nav" aria-label="导航入口（不可移除）">
      <ul className="system-bar__list">
        <li>
          <button
            type="button"
            className={
              props.active ? 'system-bar__item system-bar__item--active' : 'system-bar__item system-bar__item--enabled'
            }
            aria-current={props.active ? 'page' : undefined}
            data-testid="nav-entry"
            onClick={props.onOpen}
          >
            <span className="system-bar__label">个人导航</span>
            <span className="system-bar__hint">个人链接、分组、推荐目录导入与导出</span>
            <span className="system-bar__stage">阶段 04 / HUB-007 · 008 · 009 · 047 · 048</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

export function AppShell() {
  const [credentialStore] = useState(createSessionCredentialStore);
  const [view, setView] = useState<ShellView>(() => new URLSearchParams(window.location.search).get('view') === 'reminders' ? 'reminders' : 'overview');
  const session = useSession(credentialStore);

  const api = useMemo(
    () => createModulesApi(createApiClient({ getToken: () => credentialStore.get() })),
    [credentialStore],
  );
  const workbenchApi = useMemo(
    () => createWorkbenchApi(createApiClient({ getToken: () => credentialStore.get() })),
    [credentialStore],
  );
  /** 跨设备变更：导航与工作台布局共用同一个游标来源（同一个 API 对象）。 */
  const syncChangesApi = useMemo(
    () => createSyncChangesApi(createNavTransport({ getToken: () => credentialStore.get() })),
    [credentialStore],
  );
  /** 只读取凭证的回调（凭证本身不进 props）。 */
  const getToken = useCallback(() => credentialStore.get(), [credentialStore]);

  /**
   * 凭证失效的统一处理：清空会话内存凭证并把界面切回凭证视图。
   * 清空会推进会话代际 → `SessionWorkbench` 以新 key 重挂，旧会话的数据立即消失。
   */
  const handleUnauthorized = useCallback(() => {
    credentialStore.clear();
    setView('credentials');
  }, [credentialStore]);

  /**
   * 凭证代际变化 → 清理私有相关缓存（HUB-012 / ADR-0004 D10）。
   *
   * 为什么挂在「代际」而不是某个按钮上：保存新凭证、清除凭证、因 401 被动失效都会推进代际，
   * 而这三条路径都必须立即隔离旧工作空间。放在这里只有一个实现点，不会漏。
   * 清理只删「非当前公开缓存」，公开缓存按策略只含公开内容，因此保留它是安全的。
   */
  useEffect(() => {
    void clearPrivateCaches();
  }, [session.generation]);

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
        <p className="shell__stage">个人导航 · 天气窗口 · 钓鱼进度</p>
      </header>

      {/* 离线提示与「安全更新」入口：始终在 Shell 顶层，因此任何视图下都可见。 */}
      <PwaStatusBar />

      <NavEntryBar
        active={view === 'nav'}
        onOpen={() => {
          setView('nav');
        }}
      />

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
            切到概览 / 会话凭证视图时它只是不渲染内容，实例、导航状态与模块状态因此得以保留。
          */}
          <SessionWorkbench
            // 会话代际作为 key：凭证切换/清除时整棵会话子树同步重挂。
            key={session.generation}
            api={api}
            workbenchApi={workbenchApi}
            syncChangesApi={syncChangesApi}
            getToken={getToken}
            onUnauthorized={handleUnauthorized}
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
