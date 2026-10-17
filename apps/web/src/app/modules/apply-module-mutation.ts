/**
 * 模块变更 → 当前 Host 实例的联动（HUB-050 浏览器侧）。
 *
 * 为什么单独成文件：这是「模块状态」与「当前 Host 实例」之间唯一的连接点，
 * 语义必须精确且可被单独测试（AppShell 只负责调用它并展示结果）：
 *
 * - `uninstall`：移除该模块的**全部实例**，与服务端 `ModuleInstanceStore` 端口请求的清理一致。
 *   个人数据与模块设置保留（响应里的 `userDataRetained` 恒为 true）。
 * - `disable`：**实例保留**。停用只是让 Host 按状态渲染降级卡片（组件不执行），
 *   这样用户重新启用后实例还在，不会被静默丢弃。
 * - `enable` / `restore`：实例保留，重新启用后立即可用。
 * - `effect.pending` 为 true 时**如实追加**说明：状态已提交但收尾未完成，需要在模块管理中重试。
 *   调用方必须只在**当前会话**的结果上调用本函数（过期会话的结果会被 useModuleState 丢弃）。
 */
import { MODULE_STATUS_LABELS, type ModuleMutationResponse } from '@ff14-hub/shared';
import type { WidgetInstanceStore } from '../widgets/instance-store';

export interface ModuleMutationHostEffect {
  /** 本次从 Host 移除的实例数。 */
  readonly removedInstances: number;
  /** 面向用户的一句话说明。 */
  readonly notice: string;
}

export function applyModuleMutationToHost(
  store: WidgetInstanceStore,
  moduleId: string,
  response: ModuleMutationResponse,
): ModuleMutationHostEffect {
  const status = response.module.status;
  let removedInstances = 0;
  let notice: string;

  if (status === 'uninstalled') {
    removedInstances = store.removeInstancesForModule(moduleId);
    notice =
      `模块 ${moduleId} 已卸载：当前 Host 移除了 ${String(removedInstances)} 个实例，` +
      '个人数据与设置保留，可在模块管理中恢复。';
  } else if (status === 'disabled') {
    notice = `模块 ${moduleId} 已停用：实例保留但暂停执行（降级显示），重新启用后立即可用。`;
  } else {
    notice = `模块 ${moduleId} 状态已更新为「${MODULE_STATUS_LABELS[status]}」。`;
  }

  if (response.effect.pending) {
    // 状态已经提交，因此必须把「收尾未完成」如实说出来，而不是让调用方以为一切正常。
    notice +=
      ` 但收尾未完成（${response.effect.failure ?? '未知原因'}）；` +
      '个人数据与设置仍保留，可在模块管理中重试完成清理。';
  }

  return { removedInstances, notice };
}
