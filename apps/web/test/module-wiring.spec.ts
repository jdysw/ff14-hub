/**
 * 模块变更 → Host 实例联动测试（HUB-050）。
 *
 * 这是「模块状态」与「当前 Host 实例」之间唯一的连接点，因此语义必须被单独钉住：
 * 卸载会移除全部实例（并保留个人数据），停用**不会**移除实例（只降级显示）。
 */
import type { ModuleMutationResponse, ModulePersistedStatus, WorkspaceModuleStatus } from '@ff14-hub/shared';
import { describe, expect, it } from 'vitest';
import { applyModuleMutationToHost } from '../src/app/modules/apply-module-mutation';
import { createWidgetInstanceStore, type WidgetLookup } from '../src/app/widgets/instance-store';

const lookup: WidgetLookup = (widgetId) =>
  widgetId === 'w' ? { moduleId: 'demo.basics', allowMultiple: true, configSchemaVersion: 1 } : null;

function statusOf(status: ModulePersistedStatus): WorkspaceModuleStatus {
  return {
    moduleId: 'demo.basics',
    status,
    settings: { greeting: '保留的设置' },
    settingsVersion: 1,
    revision: 3,
    installedAt: 1,
    enabledAt: status === 'enabled' ? 2 : null,
    disabledAt: status === 'disabled' ? 2 : null,
    uninstalledAt: status === 'uninstalled' ? 2 : null,
    updatedAt: 2,
  };
}

function mutation(status: ModulePersistedStatus): ModuleMutationResponse {
  return {
    module: statusOf(status),
    effect: {
      changed: true,
      instancesRemoved: 0,
      scheduledTasksCancelled: 0,
      handlersRun: [],
      // 契约级保证：生命周期操作不删除个人数据。
      userDataRetained: true,
      message: '服务端返回的说明',
    },
  };
}

function storeWithInstances(): ReturnType<typeof createWidgetInstanceStore> {
  let counter = 0;
  const store = createWidgetInstanceStore({
    lookup,
    nextId: () => {
      counter += 1;
      return `i${String(counter)}`;
    },
  });
  store.add({ widgetId: 'w' });
  store.add({ widgetId: 'w' });
  return store;
}

describe('模块变更对 Host 实例的影响', () => {
  it('卸载移除该模块的全部实例，并明确说明个人数据与设置保留', () => {
    const store = storeWithInstances();
    const effect = applyModuleMutationToHost(store, 'demo.basics', mutation('uninstalled'));
    expect(effect.removedInstances).toBe(2);
    expect(store.list()).toHaveLength(0);
    expect(effect.notice).toContain('移除了 2 个实例');
    expect(effect.notice).toContain('个人数据与设置保留');
    expect(effect.notice).toContain('恢复');
  });

  it('停用不移除实例（只降级显示），避免重新启用后实例丢失', () => {
    const store = storeWithInstances();
    const effect = applyModuleMutationToHost(store, 'demo.basics', mutation('disabled'));
    expect(effect.removedInstances).toBe(0);
    expect(store.list()).toHaveLength(2);
    expect(effect.notice).toContain('实例保留');
  });

  it('启用 / 恢复不移除任何实例', () => {
    for (const status of ['enabled', 'uninstalled'] as const) {
      const store = storeWithInstances();
      const effect = applyModuleMutationToHost(store, 'demo.basics', mutation(status));
      if (status === 'uninstalled') {
        expect(effect.removedInstances).toBe(2);
      } else {
        expect(effect.removedInstances).toBe(0);
        expect(store.list()).toHaveLength(2);
      }
    }
  });

  it('卸载只影响该模块的实例', () => {
    const store = storeWithInstances();
    const result = store.add({ widgetId: 'w' });
    expect(result.ok).toBe(true);
    applyModuleMutationToHost(store, 'other.module', mutation('uninstalled'));
    expect(store.list()).toHaveLength(3);
  });
});
