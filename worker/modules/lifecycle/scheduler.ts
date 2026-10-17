/**
 * 生命周期端口实现（HUB-050）。
 *
 * 诚实性声明：
 * - `createInMemoryScheduledTaskStore` 是**端口替身**，`persistent: false` 明示它不持久化。
 *   阶段 05 会把它换成 `notification_jobs` 表（规划 5.2）并接入真实派发。
 * - 本文件**不**注册任何 Cron、不创建任何远程定时任务、不假装已有通知能力。
 *   它只实现两件真实且可被测试的事：① 调度门禁受模块启停状态约束；② 停用/卸载会取消已排队任务。
 * - `createNoopInstanceStore` 同理：阶段 02 还没有持久页面/实例表，
 *   服务端只能通过端口请求「当前 Host」清理实例；真实清理由浏览器内的 Host 完成。
 */
import type {
  CancelTasksResult,
  ModuleInstanceStore,
  ModuleSchedulerPort,
  ModuleStatusReader,
  ScheduleDecision,
  ScheduledTask,
  ScheduledTaskStore,
} from '../ports';

function taskId(workspaceId: string, moduleId: string, taskKey: string): string {
  return `${workspaceId}\u0000${moduleId}\u0000${taskKey}`;
}

/** 内存任务存储（测试与本地演示用）。key 唯一即「同一任务重复排程幂等」。 */
export function createInMemoryScheduledTaskStore(): ScheduledTaskStore {
  const tasks = new Map<string, ScheduledTask>();

  return {
    persistent: false,
    insert: (task) => {
      const key = taskId(task.workspaceId, task.moduleId, task.taskKey);
      if (tasks.has(key)) {
        return Promise.resolve(false);
      }
      tasks.set(key, task);
      return Promise.resolve(true);
    },
    find: (input) => Promise.resolve(tasks.get(taskId(input.workspaceId, input.moduleId, input.taskKey)) ?? null),
    deleteByKey: (input) => {
      const key = taskId(input.workspaceId, input.moduleId, input.taskKey);
      return Promise.resolve(tasks.delete(key) ? 1 : 0);
    },
    deleteAllForModule: (input) => {
      let removed = 0;
      for (const [key, task] of tasks) {
        if (task.workspaceId === input.workspaceId && task.moduleId === input.moduleId) {
          tasks.delete(key);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
    listByModule: (input) =>
      Promise.resolve(
        [...tasks.values()]
          .filter((task) => task.workspaceId === input.workspaceId && task.moduleId === input.moduleId)
          .sort((a, b) => a.runAt - b.runAt),
      ),
  };
}

export interface ModuleSchedulerDeps {
  readonly store: ScheduledTaskStore;
  /**
   * 模块有效状态读取器。`schedule` 用它**自己**判定门禁，而不是信任调用方传进来的状态，
   * 因此调用方无法通过传参绕过「未启用不得排程」。
   */
  readonly readModuleStatus: ModuleStatusReader;
}

/** 构造调度端口。 */
export function createModuleScheduler(deps: ModuleSchedulerDeps): ModuleSchedulerPort {
  return {
    schedule: async (input): Promise<ScheduleDecision> => {
      if (!Number.isInteger(input.runAt) || input.runAt < 0) {
        return { ok: false, reason: 'invalid_run_at' };
      }
      const status = await deps.readModuleStatus({ workspaceId: input.workspaceId, moduleId: input.moduleId });
      if (status !== 'enabled') {
        // 未启用 / 已停用 / 已卸载 / 未安装：一律拒绝排入后台行为。
        return { ok: false, reason: 'module_inactive' };
      }
      const task: ScheduledTask = {
        taskKey: input.taskKey,
        moduleId: input.moduleId,
        workspaceId: input.workspaceId,
        runAt: input.runAt,
        createdAt: Date.now(),
      };
      const inserted = await deps.store.insert(task);
      if (!inserted) {
        const existing = await deps.store.find({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          taskKey: input.taskKey,
        });
        // 同一 taskKey 重复排程是幂等成功，不视为错误。
        return { ok: true, task: existing ?? task, duplicate: true };
      }
      return { ok: true, task, duplicate: false };
    },

    cancel: async (input): Promise<CancelTasksResult> => ({
      cancelled: await deps.store.deleteByKey(input),
    }),

    cancelAllForModule: async (input): Promise<CancelTasksResult> => ({
      // 刻意不检查模块状态：取消必须永远可做，否则停用后无法清理已排队任务。
      cancelled: await deps.store.deleteAllForModule({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
      }),
    }),

    listPending: (input) => deps.store.listByModule(input),
  };
}

/**
 * 默认实例清理端口：阶段 02 没有持久实例表，因此服务端只能「请求清理」而不能自己清。
 * `persistent: false` 让调用方可以据此在响应里如实报告，而不是假装删除了什么。
 */
export function createNoopInstanceStore(): ModuleInstanceStore {
  return {
    persistent: false,
    removeInstancesForModule: () => Promise.resolve({ removed: 0 }),
    countInstancesForModule: () => Promise.resolve(0),
  };
}
