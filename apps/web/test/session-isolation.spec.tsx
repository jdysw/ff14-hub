/**
 * 会话隔离回归（P1）：凭证切换/清除后，旧会话的私有数据、Host 实例与在途响应都不得越过边界。
 *
 * 三个层次：
 * 1. **凭证存储**：`generation` 语义与「快照不含明文凭证」。
 * 2. **useModuleState**：卸载后迟到的写响应必须被判定为 stale，且不得写入状态或触发联动。
 * 3. **AppShell 集成**：用受控的 fetch 替身让旧会话的 GET 成功「晚到」，
 *    断言切换/退出时旧私有状态**立即**消失、且旧响应回来后也不会复活。
 */
// @vitest-environment jsdom
import {
  API_ROUTES,
  type ModuleMutationResponse,
  type WorkspaceModuleStatus,
} from '@ff14-hub/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/app/shell/AppShell';
import { createModulesApi } from '../src/app/modules/modules-api';
import { createSessionCredentialStore, type SessionSnapshot } from '../src/app/modules/session-credentials';
import { useModuleState, type ModuleState } from '../src/app/modules/use-module-state';
import type { ApiResult } from '../src/lib/api-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly settled: () => boolean;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((res) => {
    resolve = (value) => {
      done = true;
      res(value);
    };
  });
  return { promise, resolve, settled: () => done };
}

/** 让挂起的 Promise 链（含 response.json()）跑完。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
}

// ---------------------------------------------------------------------------
// 1. 会话凭证存储
// ---------------------------------------------------------------------------

describe('会话凭证存储的代际语义', () => {
  it('快照只含代际与是否已认证，**不含明文凭证**', () => {
    const store = createSessionCredentialStore();
    store.set('ffh_dev_secret_value');
    const snapshot: SessionSnapshot = store.getSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['authenticated', 'generation']);
    expect(JSON.stringify(snapshot)).not.toContain('ffh_dev_secret_value');
    // 明文只能经由 get() 交给 API 客户端内部。
    expect(store.get()).toBe('ffh_dev_secret_value');
  });

  it('凭证身份真正变化时才推进代际（重复保存同一个凭证不清空当前会话）', () => {
    const store = createSessionCredentialStore();
    expect(store.getSnapshot()).toEqual({ generation: 0, authenticated: false });

    store.set('token-a');
    expect(store.getSnapshot()).toEqual({ generation: 1, authenticated: true });
    const first = store.getSnapshot();

    store.set('token-a');
    // 同一个凭证：不推进代际，快照引用也不变（useSyncExternalStore 依赖这一点）。
    expect(store.getSnapshot()).toBe(first);

    store.set('token-b');
    expect(store.getSnapshot()).toEqual({ generation: 2, authenticated: true });

    store.clear();
    expect(store.getSnapshot()).toEqual({ generation: 3, authenticated: false });

    store.clear();
    // 已经是匿名：再清一次不推进代际。
    expect(store.getSnapshot()).toEqual({ generation: 3, authenticated: false });
  });
});

// ---------------------------------------------------------------------------
// 2. useModuleState：旧会话的迟到写响应
// ---------------------------------------------------------------------------

describe('useModuleState 的会话隔离', () => {
  it('卸载后迟到的写响应被判为 stale：不写状态、不触发 Host 联动', async () => {
    const pending = defer<ApiResult<ModuleMutationResponse>>();
    const captured: { mutate: ModuleState['mutate'] | null } = { mutate: null };

    const api = createModulesApi({
      request: <T,>(path: string): Promise<ApiResult<T>> => {
        // 注意顺序：先判具体路径，否则 /me/modules/:id 会被列表分支吞掉。
        if (path === API_ROUTES.meModules) {
          return Promise.resolve({ ok: true, status: 200, data: { modules: [] } as unknown as T });
        }
        if (path.startsWith(`${API_ROUTES.meModules}/`)) {
          return pending.promise as unknown as Promise<ApiResult<T>>;
        }
        return Promise.resolve({ ok: true, status: 200, data: { modules: [] } as unknown as T });
      },
    });

    function Harness() {
      const state = useModuleState(api, true);
      captured.mutate = state.mutate;
      return <p>状态：{state.loading ? '加载中' : String(Object.keys(state.statuses).length)}</p>;
    }

    const { unmount } = render(<Harness />);
    await screen.findByText(/状态：/);

    const mutate = captured.mutate;
    if (mutate === null) {
      throw new Error('未捕获到 mutate');
    }
    const mutation = mutate('demo.basics', { action: 'disable', expectedRevision: 1 });
    // 会话切换：Hook 随会话子树一起卸载。
    unmount();
    pending.resolve({
      ok: true,
      status: 200,
      data: {
        module: {
          moduleId: 'demo.basics',
          status: 'disabled',
          settings: {},
          settingsVersion: 1,
          revision: 2,
          installedAt: 1,
          enabledAt: null,
          disabledAt: 2,
          uninstalledAt: null,
          updatedAt: 2,
          pendingOperation: null,
        },
        effect: {
          changed: true,
          instancesRemoved: 0,
          scheduledTasksCancelled: 0,
          handlersRun: [],
          userDataRetained: true,
          pending: false,
          failure: null,
          message: '模块已停用。',
        },
      },
    });

    await expect(mutation).resolves.toMatchObject({ ok: false, stale: true });
  });
});

// ---------------------------------------------------------------------------
// 3. AppShell 集成：旧会话的 GET 晚到
// ---------------------------------------------------------------------------

const CATALOG_BODY = {
  modules: [
    {
      id: 'demo.basics',
      version: '1.0.0',
      displayName: '演示·基础组件集（无游戏业务语义）',
      capabilities: [],
      widgets: [
        {
          id: 'demo-counter',
          moduleId: 'demo.basics',
          displayName: '演示计数（可多实例）',
          allowMultiple: true,
          defaultSize: { w: 4, h: 3 },
          minSize: { w: 2, h: 2 },
          configSchemaVersion: 1,
        },
      ],
      routes: [],
      settingsSchemaVersion: 1,
    },
  ],
};

const OLD_SESSION_GREETING = '旧会话的设置';

function privateModulesBody(status: WorkspaceModuleStatus['status']): { modules: WorkspaceModuleStatus[] } {
  return {
    modules: [
      {
        moduleId: 'demo.basics',
        status,
        settings: { greeting: OLD_SESSION_GREETING },
        settingsVersion: 1,
        revision: 3,
        installedAt: 1,
        enabledAt: status === 'enabled' ? 2 : null,
        disabledAt: status === 'disabled' ? 2 : null,
        uninstalledAt: status === 'uninstalled' ? 2 : null,
        updatedAt: 2,
        pendingOperation: null,
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchRouter {
  /** 下一次 `/me/modules` 请求是否挂起，由测试决定何时 resolve。 */
  deferNextPrivateGet: boolean;
  readonly pendingPrivateGets: Deferred<Response>[];
  privateGetCount: number;
}

function installFetchRouter(): FetchRouter {
  const router: FetchRouter = { deferNextPrivateGet: false, pendingPrivateGets: [], privateGetCount: 0 };
  vi.stubGlobal('fetch', (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    if (path === API_ROUTES.health) {
      return Promise.resolve(
        jsonResponse({
          status: 'ok',
          service: 'ff14-hub',
          version: '0.0.0',
          environment: 'test',
          database: 'ok',
          nowUtcMs: 1,
        }),
      );
    }
    if (path === API_ROUTES.moduleCatalog) {
      return Promise.resolve(jsonResponse(CATALOG_BODY));
    }
    if (path === API_ROUTES.meModules) {
      router.privateGetCount += 1;
      if (router.deferNextPrivateGet) {
        router.deferNextPrivateGet = false;
        const pending = defer<Response>();
        router.pendingPrivateGets.push(pending);
        return pending.promise;
      }
      return Promise.resolve(jsonResponse(privateModulesBody('enabled')));
    }
    return Promise.resolve(jsonResponse({ code: 'not_found', message: '资源不存在。', requestId: 'test' }, 404));
  });
  return router;
}

function moduleCard(): HTMLElement {
  const card = document.querySelector('[data-testid="module-card"][data-module-id="demo.basics"]');
  if (card === null) {
    throw new Error('找不到模块卡片');
  }
  return card as HTMLElement;
}

function elementFor(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`找不到元素：${selector}`);
  }
  return element as HTMLElement;
}

async function openModules(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^模块管理/ }));
  await screen.findByTestId('module-card');
}

async function saveCredential(user: ReturnType<typeof userEvent.setup>, token: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^会话凭证/ }));
  const field = await screen.findByLabelText('设备令牌（Bearer）');
  await user.clear(field);
  await user.type(field, token);
  await user.click(screen.getByRole('button', { name: '保存到会话内存' }));
}

describe('AppShell 会话隔离', () => {
  let router: FetchRouter;

  beforeEach(() => {
    router = installFetchRouter();
  });

  it('旧会话的私有 GET 晚到时不会复活：清除凭证后立刻隐藏旧私有状态', async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await openModules(user);
    await waitFor(() => {
      expect(moduleCard().getAttribute('data-status')).toBe('not_installed');
    });

    // 保存凭证：让这一次私有 GET 挂起，模拟「旧会话的响应还没回来」。
    router.deferNextPrivateGet = true;
    await saveCredential(user, 'ffh_dev_old_session');
    expect(router.privateGetCount).toBe(1);
    await waitFor(() => {
      expect(moduleCard().getAttribute('data-status')).toBe('not_installed');
    });

    // 清除凭证（退出）→ 立刻隔离：私有状态立即为空。
    await user.click(screen.getByRole('button', { name: /^会话凭证/ }));
    await user.click(screen.getByRole('button', { name: '清除凭证' }));
    await openModules(user);
    await waitFor(() => {
      expect(moduleCard().getAttribute('data-status')).toBe('not_installed');
    });

    // 旧会话的 GET 现在才成功返回：必须被丢弃，不得让旧私有状态复活。
    for (const pending of router.pendingPrivateGets) {
      pending.resolve(jsonResponse(privateModulesBody('enabled')));
    }
    await flush();
    expect(moduleCard().getAttribute('data-status')).toBe('not_installed');
    expect(within(moduleCard()).queryByText(OLD_SESSION_GREETING)).toBeNull();
    // 也没有因为这次晚到而发起新的私有请求。
    expect(router.privateGetCount).toBe(1);

    // 正向对照：同一份响应在**当前**会话里确实会驱动出 enabled，
    // 说明上面的「没复活」不是因为替身没生效。
    await saveCredential(user, 'ffh_dev_new_session');
    await waitFor(() => {
      expect(moduleCard().getAttribute('data-status')).toBe('enabled');
    });
  });

  it('切换凭证会立刻清空旧会话的 Host 实例（新会话从空开始）', async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await saveCredential(user, 'ffh_dev_first');
    await waitFor(() => {
      expect(moduleCard().getAttribute('data-status')).toBe('enabled');
    });

    // 在旧会话里添加一个实例。
    await user.click(screen.getByRole('button', { name: /^组件验收/ }));
    await screen.findByTestId('widget-host');
    await user.click(within(elementFor('[data-widget-id="demo-counter"]')).getByRole('button', { name: '添加实例' }));
    expect(screen.getAllByTestId('widget-instance')).toHaveLength(1);

    // 切换凭证（不同 token → 代际推进 → 会话子树重挂）。
    await saveCredential(user, 'ffh_dev_second');
    await waitFor(() => {
      expect(moduleCard().getAttribute('data-status')).toBe('enabled');
    });

    // 回到组件验收：旧会话的实例不得残留。
    await user.click(screen.getByRole('button', { name: /^组件验收/ }));
    await screen.findByTestId('widget-host');
    expect(screen.queryAllByTestId('widget-instance')).toHaveLength(0);
    expect(screen.getByText(/当前没有可见的组件实例/)).toBeDefined();
  });
});
