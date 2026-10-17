/**
 * 生命周期端口实现（HUB-050）。
 *
 * 诚实性声明：
 * - `createInMemoryScheduledTaskStore` 是**端口替身**，`persistent: false` 明示它不持久化。
 *   阶段 05 会把它换成 `notification_jobs` 表（规划 5.2）并接入真实派发。
 * - 本文件**不**注册任何 Cron、不创建任何远程定时任务、不假装已有通知能力。
 *
 * fence（复核要求）：任务带 `createdRevision`。
 * - 取消（单 key 与整模块）都按 revision 上界过滤，旧执行者删不掉 restore 之后登记的新任务。
 * - 模块作用域的 `schedule` 必须带 `expectedRevision`：写入前后各校验一次，
 *   `insert` 在途发生接管/restore 时按**旧代**撤销自己的插入，绝不触碰同 key 的新代任务。
 */
import type { ModuleSupportedAction } from '@ff14-hub/shared';
import type {
  CancelTasksResult,
  ModuleInstanceStore,
  ModuleSchedulerPort,
  ModuleScopedScheduler,
  ModuleStatusReader,
  ScopedCancelOutcome,
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
      const task = tasks.get(key);
      if (task === undefined) {
        return Promise.resolve(0);
      }
      // fence：只删这一代及更早登记的任务（未给上界时不限制，仅供平台内部使用）。
      if (input.upToRevision !== undefined && task.createdRevision > input.upToRevision) {
        return Promise.resolve(0);
      }
      tasks.delete(key);
      return Promise.resolve(1);
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
   * 模块门禁状态 + revision 读取器。`schedule` 用它**自己**判定门禁与执行代际，
   * 而不是信任调用方传参。
   */
  readonly readModuleStatus: ModuleStatusReader;
}

/** 构造调度端口（平台内部；带任意作用域）。 */
export function createModuleScheduler(deps: ModuleSchedulerDeps): ModuleSchedulerPort {
  async function currentRevision(workspaceId: string, moduleId: string): Promise<number> {
    const current = await deps.readModuleStatus({ workspaceId, moduleId });
    return current.revision;
  }

  return {
    schedule: async (input): Promise<ScheduleDecision> => {
      if (!Number.isInteger(input.runAt) || input.runAt < 0) {
        return { ok: false, reason: 'invalid_run_at' };
      }
      const current = await deps.readModuleStatus({ workspaceId: input.workspaceId, moduleId: input.moduleId });

      // 执行归属校验：调用者声明的代际必须等于当前代际。
      // 不相等意味着它已被接管 / restore / 状态写入换了代——绝不能把旧代任务标成新代。
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'execution_superseded' };
      }
      // selfInit 是平台内部专用通道（由作用域闭包 + 数据库核对后设置），模块无法伪造。
      if (input.selfInit !== true && current.status !== 'enabled') {
        return { ok: false, reason: 'module_inactive' };
      }

      const createdRevision = input.expectedRevision ?? current.revision;
      const task: ScheduledTask = {
        taskKey: input.taskKey,
        moduleId: input.moduleId,
        workspaceId: input.workspaceId,
        runAt: input.runAt,
        createdAt: Date.now(),
        createdRevision,
      };
      const inserted = await deps.store.insert(task);
      if (!inserted) {
        const existing = await deps.store.find({
          workspaceId: input.workspaceId,
          moduleId: input.moduleId,
          taskKey: input.taskKey,
        });
        // 同名任务属于**更新的代际**时，旧执行者不得把它当成自己的（更不得覆盖/删除）。
        if (
          existing !== null &&
          input.expectedRevision !== undefined &&
          existing.createdRevision > input.expectedRevision
        ) {
          return { ok: false, reason: 'execution_superseded' };
        }
        // 同一 taskKey 重复排程是幂等成功，不视为错误。
        return { ok: true, task: existing ?? task, duplicate: true };
      }

      // insert 在途可能发生接管 / restore：写入后再校验一次代际。
      if (input.expectedRevision !== undefined) {
        const after = await currentRevision(input.workspaceId, input.moduleId);
        if (after !== input.expectedRevision) {
          // 按**旧代**撤销自己的插入：`upToRevision = 旧代`，因此绝不会删到同 key 的新代任务。
          await deps.store.deleteByKey({
            workspaceId: input.workspaceId,
            moduleId: input.moduleId,
            taskKey: input.taskKey,
            upToRevision: input.expectedRevision,
          });
          return { ok: false, reason: 'execution_superseded' };
        }
      }
      return { ok: true, task, duplicate: false };
    },

    cancel: async (input): Promise<CancelTasksResult> => ({
      cancelled: await deps.store.deleteByKey({
        workspaceId: input.workspaceId,
        moduleId: input.moduleId,
        taskKey: input.taskKey,
        ...(input.upToRevision === undefined ? {} : { upToRevision: input.upToRevision }),
      }),
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
  /** 本次执行的归属：token + 准入 revision。所有**可变**调用都以它为权威。 */
  readonly execution: { readonly token: string; readonly admissionRevision: number };
  /** 执行权校验（服务层注入，读数据库）。每次可变调用前都会调用。 */
  readonly isExecutionCurrent: () => Promise<boolean>;
}

/**
 * 构造交给模块 handler 的调度视图：作用域闭包绑定 + 能力门禁 + 受核对的初始化豁免
 * + **执行归属绑定**。
 *
 * 关键点（复核要求）：handler 可能在 `await` 中跨过租约被别的重试取代。
 * 外围「等 handler 返回后再查 token」无法撤销它内部已经造成的副作用，
 * 因此**每一次可变调用**（schedule / cancel）都在调用前校验执行权，
 * 并把准入 revision 作为 fence 传给管理端口；过期调用一律 `execution_superseded`。
 *
 * 初始化豁免（唯一的越门禁入口）必须同时满足：
 * 1. 模块被授予 `scheduled:own`；2. 正在执行它自己的 enable / restore；
 * 3. 数据库里确实存在与该动作、该 revision 完全一致的待完成操作。
 */
export function createModuleScopedScheduler(deps: ModuleScopedSchedulerDeps): ModuleScopedScheduler {
  return {
    schedule: async (input): Promise<ScheduleDecision> => {
      if (!deps.canSchedule) {
        return { ok: false, reason: 'capability_not_granted' };
      }
      // 执行归属先校验：过期的执行者不得再改变任务集合。
      if (!(await deps.isExecutionCurrent())) {
        return { ok: false, reason: 'execution_superseded' };
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
        // 以本次准入 revision 为权威：既是执行归属 fence，也是新任务的代际标记。
        expectedRevision: deps.execution.admissionRevision,
        ...(selfInit ? { selfInit: true } : {}),
      });
    },
    cancel: async (input): Promise<ScopedCancelOutcome> => {
      // 取消同样是可变调用：过期执行者不能删任务（否则会删掉 restore 之后的同 key 新任务）。
      if (!(await deps.isExecutionCurrent())) {
        return { ok: false, reason: 'execution_superseded' };
      }
      const result = await deps.management.cancel({
        workspaceId: deps.workspaceId,
        moduleId: deps.moduleId,
        taskKey: input.taskKey,
        // revision 上界 fence：只删自己这一代及更早的任务。
        upToRevision: deps.execution.admissionRevision,
      });
      return { ok: true, cancelled: result.cancelled };
    },
    // 只读、且只作用于自己的模块，因此不设执行归属门禁（不改变任何状态）。
    listPending: async (): Promise<readonly ScheduledTask[]> =>
      await deps.management.listPending({
        workspaceId: deps.workspaceId,
        moduleId: deps.moduleId,
      }),
  };
}
