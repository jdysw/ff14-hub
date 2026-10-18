/**
 * 模块管理界面测试（HUB-050，jsdom + React Testing Library）。
 *
 * 用真实的 `useModuleState` 钩子 + 注入的 API 替身，验证界面与契约的接线：
 * 匿名只看目录、变更必须带 expectedRevision、冲突提示、设置保存、清数据被显式拒绝。
 */
// @vitest-environment jsdom
import {
  BUILTIN_MODULE_MANIFESTS,
  DEMO_BASICS_MODULE_ID,
  DEMO_SOLO_MODULE_ID,
  type ApiErrorBody,
  type ModuleDescriptor,
  type ModuleEffectiveStatus,
  type ModuleMutationRequest,
  type ModuleMutationResponse,
  type WorkspaceModuleStatus,
} from '@ff14-hub/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleManagerPanel } from '../src/app/modules/ModuleManagerPanel';
import type { ModulesApi } from '../src/app/modules/modules-api';
import { useModuleState } from '../src/app/modules/use-module-state';
import type { ApiResult } from '../src/lib/api-client';

afterEach(() => {
  cleanup();
});

const descriptors: ModuleDescriptor[] = BUILTIN_MODULE_MANIFESTS.map((manifest) => ({
  id: manifest.id,
  version: manifest.version,
  displayName: manifest.displayName,
  capabilities: [...manifest.capabilities],
  widgets: manifest.widgets.map((widget) => ({ ...widget })),
  routes: (manifest.routes ?? []).map((route) => ({ ...route })),
  settingsSchemaVersion: manifest.settingsSchemaVersion,
}));

function statusOf(
  moduleId: string,
  status: ModuleEffectiveStatus,
  overrides: Partial<WorkspaceModuleStatus> = {},
): WorkspaceModuleStatus {
  return {
    moduleId,
    status,
    settings: {},
    settingsVersion: 1,
    revision: 0,
    installedAt: null,
    enabledAt: null,
    disabledAt: null,
    uninstalledAt: null,
    updatedAt: null,
    pendingOperation: null,
    ...overrides,
  };
}

function mutationOf(
  module: WorkspaceModuleStatus,
  message: string,
  options: { readonly pending?: boolean; readonly failure?: string | null } = {},
): ModuleMutationResponse {
  return {
    module,
    effect: {
      changed: true,
      instancesRemoved: 0,
      scheduledTasksCancelled: 0,
      handlersRun: [],
      userDataRetained: true,
      pending: options.pending ?? false,
      failure: options.failure ?? null,
      message,
    },
  };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, status: 200, data };
}

function failure(code: ApiErrorBody['code'], status: number, message: string): ApiResult<never> {
  return { ok: false, status, error: { code, message, requestId: 'req-test' } };
}

interface FakeApiOptions {
  readonly statuses?: readonly WorkspaceModuleStatus[];
  readonly mutate?: (moduleId: string, request: ModuleMutationRequest) => ApiResult<ModuleMutationResponse>;
}

function fakeApi(options: FakeApiOptions = {}) {
  const mutateCalls: { moduleId: string; request: ModuleMutationRequest }[] = [];
  const listMine = vi.fn(() => Promise.resolve(ok({ modules: [...(options.statuses ?? [])] })));
  const api: ModulesApi = {
    catalog: () => Promise.resolve(ok({ modules: descriptors })),
    listMine,
    readModule: (moduleId) =>
      Promise.resolve(ok({ module: statusOf(moduleId, 'not_installed') })),
    mutate: (moduleId, request) => {
      mutateCalls.push({ moduleId, request });
      if (options.mutate !== undefined) {
        return Promise.resolve(options.mutate(moduleId, request));
      }
      if (request.action === 'purge') {
        // 忠实模拟服务端：清数据在本阶段被显式拒绝，且没有删除任何数据。
        return Promise.resolve(
          failure('not_implemented', 501, '本阶段不支持清除模块数据（purge）。本次请求没有删除任何数据。'),
        );
      }
      return Promise.resolve(
        ok(mutationOf(statusOf(moduleId, 'enabled', { revision: 1 }), '模块已启用。')),
      );
    },
    purge: () => Promise.resolve(failure('not_implemented', 501, '本阶段不支持清除模块数据。')),
  };
  return { api, mutateCalls, listMine };
}

function Harness(props: {
  readonly api: ModulesApi;
  readonly token: string | null;
  readonly onMutated?: ((moduleId: string, response: ModuleMutationResponse) => void) | undefined;
}) {
  // 与 AppShell 一致：Hook 只接收是否已认证的布尔值，**不接收明文凭证**。
  const moduleState = useModuleState(props.api, props.token !== null);
  return (
    <ModuleManagerPanel
      moduleState={moduleState}
      hasCredential={props.token !== null}
      onMutated={props.onMutated}
      onRequestCredential={() => undefined}
    />
  );
}

function cardFor(moduleId: string): HTMLElement {
  const card = document.querySelector(`[data-testid="module-card"][data-module-id="${moduleId}"]`);
  if (card === null) {
    throw new Error(`找不到模块卡片：${moduleId}`);
  }
  return card as HTMLElement;
}

describe('模块管理界面', () => {
  it('匿名时目录可读、状态不可写：变更按钮不可用并给出原因', async () => {
    const { api, listMine } = fakeApi();
    render(<Harness api={api} token={null} />);

    expect(await screen.findByText('模块管理')).toBeDefined();
    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID)).toBeDefined();
    });
    expect(screen.getByText(/尚未保存设备凭证/)).toBeDefined();
    // 匿名状态下不去请求私有状态。
    expect(listMine).not.toHaveBeenCalled();
    for (const button of within(cardFor(DEMO_BASICS_MODULE_ID)).getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('有凭证时加载真实状态，并在启用后显示服务端返回的说明', async () => {
    const user = userEvent.setup();
    const onMutated = vi.fn();
    const { api, mutateCalls } = fakeApi();
    render(<Harness api={api} token="ffh_dev_test" onMutated={onMutated} />);

    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('not_installed');
    });

    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByRole('button', { name: '启用' }));

    await waitFor(() => {
      expect(mutateCalls).toEqual([
        { moduleId: DEMO_BASICS_MODULE_ID, request: { action: 'enable', expectedRevision: 0 } },
      ]);
    });
    // 状态就地更新为服务端返回的结果。
    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('enabled');
    });
    expect(screen.getByText('模块已启用。')).toBeDefined();
    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  it('409 冲突时给出可读提示并重新拉取状态（防静默覆盖的界面表现）', async () => {
    const user = userEvent.setup();
    const { api, listMine } = fakeApi({
      statuses: [statusOf(DEMO_BASICS_MODULE_ID, 'disabled', { revision: 5 })],
      mutate: () => failure('conflict', 409, '资源状态冲突。'),
    });
    render(<Harness api={api} token="ffh_dev_test" />);

    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('disabled');
    });
    expect(listMine).toHaveBeenCalledTimes(1);

    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByRole('button', { name: '启用' }));

    expect(await screen.findByText(/操作被拒绝/)).toBeDefined();
    // 冲突后必须重新加载，否则用户会一直基于过期 revision 重试。
    await waitFor(() => {
      expect(listMine).toHaveBeenCalledTimes(2);
    });
  });

  it('清数据按钮调用 purge 路径并显示「被明确拒绝」，而不是假装成功', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({ statuses: [statusOf(DEMO_BASICS_MODULE_ID, 'enabled', { revision: 1 })] });
    render(<Harness api={api} token="ffh_dev_test" />);

    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('enabled');
    });
    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByRole('button', { name: /清数据/ }));

    expect(await screen.findByText(/清数据被明确拒绝/)).toBeDefined();
    // 状态没有被改成别的东西。
    expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('enabled');
  });

  it('保存设置时提交 settings、settingsVersion 与 expectedRevision', async () => {
    const user = userEvent.setup();
    const { api, mutateCalls } = fakeApi({
      statuses: [
        statusOf(DEMO_BASICS_MODULE_ID, 'enabled', { revision: 7, settings: { greeting: '旧' }, settingsVersion: 1 }),
      ],
    });
    render(<Harness api={api} token="ffh_dev_test" />);

    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('enabled');
    });

    // 设置编辑器在 <details> 里：先像真实用户那样展开它。
    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByText('模块设置（JSON）与版本'));

    const textarea = screen.getByLabelText(`设置 JSON（${descriptors[0]?.displayName ?? ''}）`);
    fireEvent.change(textarea, { target: { value: '{"greeting":"早上好"}' } });
    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByRole('button', { name: '保存设置' }));

    await waitFor(() => {
      expect(mutateCalls).toHaveLength(1);
    });
    expect(mutateCalls[0]?.moduleId).toBe(DEMO_BASICS_MODULE_ID);
    expect(mutateCalls[0]?.request.settings).toEqual({ greeting: '早上好' });
    expect(mutateCalls[0]?.request.expectedRevision).toBe(7);
    expect(mutateCalls[0]?.request.settingsVersion).toBe(1);
  });

  it('非法 JSON 不会提交，并给出可读提示', async () => {
    const user = userEvent.setup();
    const { api, mutateCalls } = fakeApi({
      statuses: [statusOf(DEMO_BASICS_MODULE_ID, 'enabled', { revision: 2 })],
    });
    render(<Harness api={api} token="ffh_dev_test" />);

    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('enabled');
    });
    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByText('模块设置（JSON）与版本'));
    fireEvent.change(screen.getByLabelText(`设置 JSON（${descriptors[0]?.displayName ?? ''}）`), {
      target: { value: '{不是 JSON' },
    });
    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByRole('button', { name: '保存设置' }));

    expect(await screen.findByText('设置不是合法的 JSON，未提交。')).toBeDefined();
    expect(mutateCalls).toHaveLength(0);
  });

  it('设置版本落后于组件契约时给出可见提示', async () => {
    const { api } = fakeApi({
      statuses: [statusOf(DEMO_SOLO_MODULE_ID, 'enabled', { revision: 1, settingsVersion: 0 })],
    });
    render(<Harness api={api} token="ffh_dev_test" />);

    await waitFor(() => {
      expect(cardFor(DEMO_SOLO_MODULE_ID).getAttribute('data-status')).toBe('enabled');
    });
    expect(within(cardFor(DEMO_SOLO_MODULE_ID)).getByText('设置版本 0')).toBeDefined();
  });

  it('目录加载失败时显示错误而不是静默空列表', async () => {
    const api: ModulesApi = {
      catalog: () => Promise.resolve(failure('internal_error', 500, '服务器内部错误。')),
      listMine: () => Promise.resolve(ok({ modules: [] })),
      readModule: () => Promise.resolve(failure('not_found', 404, '资源不存在。')),
      mutate: () => Promise.resolve(failure('internal_error', 500, '服务器内部错误。')),
      purge: () => Promise.resolve(failure('not_implemented', 501, '本阶段不支持。')),
    };
    render(<Harness api={api} token={null} />);
    expect(await screen.findByText(/加载模块目录失败/)).toBeDefined();
  });

  it('待完成操作如实展示（门禁为「正在完成操作」），并提供同动作、同 revision 的重试入口', async () => {
    const user = userEvent.setup();
    const onMutated = vi.fn();
    const pendingStatus = statusOf(DEMO_BASICS_MODULE_ID, 'uninstalled', {
      revision: 2,
      pendingOperation: {
        action: 'uninstall',
        revision: 2,
        targetStatus: 'uninstalled',
        startedAt: 1,
        attempts: 1,
        lastError: '平台清理失败（Error）',
      },
    });
    const { api, mutateCalls } = fakeApi({
      statuses: [pendingStatus],
      mutate: () =>
        ok(
          mutationOf(
            statusOf(DEMO_BASICS_MODULE_ID, 'uninstalled', { revision: 3 }),
            '上一次操作的收尾已完成：移除 2 个当前实例、取消 1 项待执行任务；个人数据与设置保留。',
          ),
        ),
    });
    render(<Harness api={api} token="ffh_dev_test" onMutated={onMutated} />);

    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('transitioning');
    });
    const card = cardFor(DEMO_BASICS_MODULE_ID);
    expect(card.getAttribute('data-pending')).toBe('uninstall');
    expect(within(card).getByTestId('module-pending-notice').textContent).toContain('平台清理失败');
    // 其他动作必然被服务端 409，因此界面上不提供。
    expect(within(card).queryByRole('button', { name: '启用' })).toBeNull();
    expect(within(card).queryByRole('button', { name: '恢复' })).toBeNull();

    await user.click(within(card).getByRole('button', { name: '重试完成收尾' }));

    await waitFor(() => {
      expect(mutateCalls).toEqual([
        { moduleId: DEMO_BASICS_MODULE_ID, request: { action: 'uninstall', expectedRevision: 2 } },
      ]);
    });
    expect(await screen.findByText(/收尾已完成/)).toBeDefined();
    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('uninstalled');
    });
    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  it('会话切换导致的过期结果：不提示、不触发 Host 联动', async () => {
    const user = userEvent.setup();
    const onMutated = vi.fn();
    const resolver: { resolve: ((value: ApiResult<ModuleMutationResponse>) => void) | null } = { resolve: null };
    const deferred = new Promise<ApiResult<ModuleMutationResponse>>((resolve) => {
      resolver.resolve = resolve;
    });
    const mutate = vi.fn(() => deferred);
    const api: ModulesApi = {
      catalog: () => Promise.resolve(ok({ modules: descriptors })),
      listMine: () =>
        Promise.resolve(ok({ modules: [statusOf(DEMO_BASICS_MODULE_ID, 'enabled', { revision: 1 })] })),
      readModule: () => Promise.resolve(ok({ module: statusOf(DEMO_BASICS_MODULE_ID, 'enabled') })),
      mutate,
      purge: () => Promise.resolve(failure('not_implemented', 501, '本阶段不支持。')),
    };
    const { unmount } = render(<Harness api={api} token="ffh_dev_test" onMutated={onMutated} />);
    await waitFor(() => {
      expect(cardFor(DEMO_BASICS_MODULE_ID).getAttribute('data-status')).toBe('enabled');
    });

    await user.click(within(cardFor(DEMO_BASICS_MODULE_ID)).getByRole('button', { name: '停用' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    // 会话切换：AppShell 会以新的 generation 重挂整棵会话子树。
    unmount();
    resolver.resolve?.(
      ok(mutationOf(statusOf(DEMO_BASICS_MODULE_ID, 'disabled', { revision: 2 }), '模块已停用。')),
    );
    await deferred;

    expect(onMutated).not.toHaveBeenCalled();
  });
});
