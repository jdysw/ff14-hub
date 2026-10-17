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
 *
 * fence（复核要求）：任务带 `createdRevision`，取消时按 `upToRevision` 过滤。
 * 一个被取代的旧执行者传入的是它自己的准入 revision，因此删不掉 restore 之后登记的新任务。
 * 这就是「租约到期 ≠ 旧执行者已停止」的应对方式。
 */
import type { ModuleSupportedAction } from '@ff14-hub/shared';
import type {
  CancelTasksResult,
  ModuleInstanceStore,
  ModuleSchedulerPort,
  ModuleScopedScheduler,
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
        if (
          task.workspaceId === input.workspaceId &&
          task.moduleId === input.moduleId &&
          // fence：只删这一代及更早登记的任务。
          task.createdRevision <= input.upToRevision
        ) {
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
   * 模块门禁状态 + revision 读取器。`schedule` 用它**自己**判定门禁，而不是信任调用方传参；
   * revision 会写进任务，作为将来取消时的 fence。
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
      // 始终读一次「门禁状态 + revision」：即使 selfInit 豁免门禁判断，也需要 revision 打 fence。
      const current = await deps.readModuleStatus({ workspaceId: input.workspaceId, moduleId: input.moduleId });
      // selfInit 是平台内部专用通道（由作用域闭包 + 数据库核对后设置），模块无法伪造。
      if (input.selfInit !== true && current.status !== 'enabled') {
        // 未启用 / 已停用 / 已卸载 / 未安装 / 待完成收尾：一律拒绝排入后台行为。
        return { ok: false, reason: 'module_inactive' };
      }
      const task: ScheduledTask = {
        taskKey: input.taskKey,
        moduleId: input.moduleId,
        workspaceId: input.workspaceId,
        runAt: input.runAt,
        createdAt: Date.now(),
        createdRevision: current.revision,
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
      // 但**必须**带 revision fence：被取代的旧执行者不能删掉新一代任务。
      cancelled: await deps.store.deleteAllForModule({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        upToRevision: input.upToRevision,
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

export interface ModuleScopedSchedulerDeps {
  /** 由平台注入的**已认证**作用域，模块代码无法更改它。 */
  readonly workspaceId: string;
  readonly moduleId: string;
  /** 平台内部管理端口；绝不暴露给模块。 */
  readonly management: ModuleSchedulerPort;
  /**
   * 注册表对本模块 `scheduled:own` 的**授予**结果。
   * 由服务用 `registry.hasCapability()` 计算，因此 Manifest 里写没写不影响这里的结论。
   */
  readonly canSchedule: boolean;
  /**
   * 本次 handler 正在执行的动作与准入 revision（非启用/恢复时为 null）。
   * 只有「模块正在完成自己的启用/恢复初始化」才可能获得门禁豁免。
   */
  readonly ownInit: { readonly action: ModuleSupportedAction; readonly revision: number } | null;
  /** 读取当前待完成操作（作用域已绑定）。用于**用数据库事实**核对豁免是否成立。 */
  readonly readPendingOperation: () => Promise<{ readonly action: ModuleSupportedAction; readonly revision: number } | null>;
}

/**
 * 构造交给模块 handler 的调度视图：作用域闭包绑定 + 能力门禁 + 受核对的初始化豁免。
 *
 * 运行时防伪：委派入参**只**由闭包构造，调用者额外传入的 workspaceId / moduleId 一律被丢弃
 * （TS 类型上也不接受），因此「伪造别的模块/工作空间」既不合法也不生效。
 *
 * 初始化豁免（唯一的越门禁入口）必须同时满足：
 * 1. 模块被授予 `scheduled:own`；
 * 2. 正在执行的是它自己的 enable / restore 动作；
 * 3. 数据库里确实存在与该动作、该 revision 完全一致的待完成操作。
 */
export function createModuleScopedScheduler(deps: ModuleScopedSchedulerDeps): ModuleScopedScheduler {
  return {
    schedule: async (input): Promise<ScheduleDecision> => {
      if (!deps.canSchedule) {
        return { ok: false, reason: 'capability_not_granted' };
      }
      let selfInit = false;
      if (deps.ownInit !== null) {
        const pending = await deps.readPendingOperation();
        selfInit =
          pending !== null &&
          pending.action === deps.ownInit.action &&
          pending.revision === deps.ownInit.revision;
      }
      return await deps.management.schedule({
        workspaceId: deps.workspaceId,
        moduleId: deps.moduleId,
        taskKey: input.taskKey,
        runAt: input.runAt,
        ...(selfInit ? { selfInit: true } : {}),
      });
    },
    cancel: async (input): Promise<CancelTasksResult> =>
      await deps.management.cancel({
        workspaceId: deps.workspaceId,
        moduleId: deps.moduleId,
        taskKey: input.taskKey,
      }),
    listPending: async (): Promise<readonly ScheduledTask[]> =>
      await deps.management.listPending({
        workspaceId: deps.workspaceId,
        moduleId: deps.moduleId,
      }),
  };
}
