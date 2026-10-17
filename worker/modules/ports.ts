/**
 * 模块运行时的**端口**定义（HUB-043 / HUB-050）。
 *
 * 为什么要有这一层：
 * - 生命周期服务需要触发「平台级副作用」——清除当前 Host 的 Widget 实例、取消已排队的后台任务。
 *   阶段 02 还没有持久页面/实例表，也还没有真实调度，因此这些能力被定义成**显式端口**：
 *   服务只依赖接口，替换实现不需要改语义。
 * - 阶段的诚实性：端口实现必须自报 `persistent`。阶段 02 的内存实现明确标注为替身，
 *   不会假装已经有持久实例表或分布式任务系统。
 *
 * 安全边界（INV：声明能力不等于被授权）：
 * - 交给模块代码的只有 `ModuleLifecycleContext`：workspaceId、moduleId、时间与**受限服务端口**。
 *   绝不包含 D1 绑定、设备 Token、恢复密钥、请求头或整个 `env`。
 * - 服务端口是**闭包绑定作用域**的视图（`ModuleScopedScheduler`）：调用者无法指定别的
 *   workspace / module，也无法绕过 `scheduled:own` 的授予检查。
 * - 平台使用的**内部管理端口**（`ModuleSchedulerPort` / `ModuleInstanceStore`）绝不交给模块代码。
 */
import type { ModuleEffectiveStatus, ModuleGateStatus, ModuleSupportedAction } from '@ff14-hub/shared';

/** 已排队的模块后台任务（阶段 02 的调度端口只实现状态约束与取消语义）。 */
export interface ScheduledTask {
  readonly taskKey: string;
  readonly moduleId: string;
  readonly workspaceId: string;
  readonly runAt: number;
  readonly createdAt: number;
}

/**
 * 调度被拒绝的原因。
 * - `module_inactive`：模块门禁状态不是 enabled（含待完成操作）→ 不得排入任何后台行为。
 *   这正是「停用暂停主动行为」与「待完成不被当成可运行」在代码里的落点。
 * - `capability_not_granted`：模块没有获得 `scheduled:own`，注册表的授予结果就是权威。
 * - `invalid_run_at`：执行时间非法。
 *
 * 注意 `cancel` / `cancelAllForModule` **没有**失败分支：取消必须永远可做，
 * 否则模块一旦停用就再也清理不掉已经排队的任务。
 */
export type ScheduleRejection = 'module_inactive' | 'capability_not_granted' | 'invalid_run_at';

export type ScheduleDecision =
  | { readonly ok: true; readonly task: ScheduledTask; readonly duplicate: boolean }
  | { readonly ok: false; readonly reason: ScheduleRejection };

export interface CancelTasksResult {
  /** 实际被取消（删除）的任务条数。 */
  readonly cancelled: number;
}

/**
 * 后台任务的持久化端口。
 * 阶段 02 只有内存实现（测试与本地演示用）；阶段 05 会换成 `notification_jobs` 表，
 * 并**仍然不**在本阶段注册任何 Cron 或假装已有通知能力。
 */
export interface ScheduledTaskStore {
  readonly persistent: boolean;
  /** 返回 false 表示 taskKey 已存在（同一任务的重复排程被判定为重复，语义为幂等成功）。 */
  insert(task: ScheduledTask): Promise<boolean>;
  find(input: { readonly workspaceId: string; readonly moduleId: string; readonly taskKey: string }): Promise<ScheduledTask | null>;
  deleteByKey(input: { readonly workspaceId: string; readonly moduleId: string; readonly taskKey: string }): Promise<number>;
  deleteAllForModule(input: { readonly workspaceId: string; readonly moduleId: string }): Promise<number>;
  listByModule(input: { readonly workspaceId: string; readonly moduleId: string }): Promise<readonly ScheduledTask[]>;
}

/**
 * **内部管理**调度端口：带任意作用域，只有平台代码（生命周期服务）能拿到。
 * 绝不把它交给模块 handler——否则 handler 就能操作别的工作空间/模块的任务。
 *
 * `schedule` 自己查门禁状态并在非 enabled 时拒绝，而不是信任调用方传来的状态参数。
 */
export interface ModuleSchedulerPort {
  schedule(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly taskKey: string;
    readonly runAt: number;
    /**
     * **平台内部专用**：仅当「模块正在完成它自己的启用/恢复初始化」且已由
     * `createModuleScopedScheduler` 用数据库事实核对过时才为 true。
     * 它是唯一能越过 `transitioning` 门禁的入口，模块代码拿不到管理端口、也无法伪造它。
     * 语义：登记自己的后台任务 ≠ 立刻执行；执行时的门禁由调度实现负责。
     */
    readonly selfInit?: boolean;
  }): Promise<ScheduleDecision>;
  cancel(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly taskKey: string;
  }): Promise<CancelTasksResult>;
  cancelAllForModule(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly reason: 'module_disabled' | 'module_uninstalled';
  }): Promise<CancelTasksResult>;
  listPending(input: { readonly workspaceId: string; readonly moduleId: string }): Promise<readonly ScheduledTask[]>;
}

/**
 * 交给模块代码的调度视图：**作用域已由闭包绑定**。
 *
 * - 入参里没有 workspaceId / moduleId，因此伪造作用域在类型上就不可表达；
 *   实现也会忽略调用者多传的任何作用域字段（只按闭包构造委派入参），运行时同样无效。
 * - `schedule` 在未获得 `scheduled:own` 时返回 `capability_not_granted`；
 *   授权判定来自注册表的授予集合，而不是 Manifest 的声明。
 * - `cancel` / `listPending` 只作用于自己的任务，属于收缩权限面的操作，不设能力门禁。
 */
export interface ModuleScopedScheduler {
  schedule(input: { readonly taskKey: string; readonly runAt: number }): Promise<ScheduleDecision>;
  cancel(input: { readonly taskKey: string }): Promise<CancelTasksResult>;
  listPending(): Promise<readonly ScheduledTask[]>;
}

/**
 * Widget 实例清理端口（平台内部使用，不交给模块）。
 * 卸载模块时服务端通过它要求「当前 Host」移除该模块的全部实例。
 *
 * 阶段 02 的 Host 实例只存在于浏览器内存中，因此服务端的默认实现是 no-op 替身
 * （`persistent: false`，`removed: 0`），文档里明确说明阶段 03 接入持久实例表后
 * 换成真实的 D1 实现。测试通过注入记录型替身来验证「卸载确实请求了清理」。
 */
export interface ModuleInstanceStore {
  /** false 表示当前没有持久实例表，清理只会作用于当前 Host 的内存实例。 */
  readonly persistent: boolean;
  removeInstancesForModule(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
    readonly reason: 'module_uninstalled';
  }): Promise<{ readonly removed: number }>;
  countInstancesForModule(input: {
    readonly workspaceId: string;
    readonly moduleId: string;
  }): Promise<number>;
}

/** 模块 handler 可用的受限服务。新增端口时必须先确认它不扩大模块的权限面。 */
export interface ModuleServicePorts {
  /** 作用域闭包绑定 + 能力门禁的调度视图。 */
  readonly scheduler: ModuleScopedScheduler;
}

/**
 * 生命周期 handler 的上下文。
 * 刻意保持最小：没有 db、没有 env、没有请求对象、没有设备标识。
 */
export interface ModuleLifecycleContext {
  readonly workspaceId: string;
  readonly moduleId: string;
  /** 本次操作的 UTC 毫秒时间戳（由服务注入，便于测试与审计对齐）。 */
  readonly now: number;
  readonly services: ModuleServicePorts;
}

/** 生命周期 handler：只允许是静态注册表里的函数，绝不接受字符串指定的远程代码。 */
export type ModuleLifecycleHandler = (context: ModuleLifecycleContext) => void | Promise<void>;

/** 记录本次生命周期操作实际发生的副作用，用于可解释的响应与测试断言。 */
export interface ModuleMutationEffect {
  readonly changed: boolean;
  readonly instancesRemoved: number;
  readonly scheduledTasksCancelled: number;
  readonly handlersRun: readonly string[];
}

/**
 * 模块的**门禁状态**读取器（在有效状态基础上叠加「是否有待完成操作」）。
 * 调度端口用它自己判定门禁，不依赖调用方传参。
 */
export type ModuleStatusReader = (input: {
  readonly workspaceId: string;
  readonly moduleId: string;
}) => Promise<ModuleGateStatus>;

/** 供需要「有效状态」而非门禁状态的地方做类型标注（例如迁移矩阵的输入）。 */
export type ModuleEffectiveStatusLike = ModuleEffectiveStatus;

/** 目标状态由动作唯一决定；服务端持久化时也按它写 `target_status`。 */
export function targetStatusForAction(action: ModuleSupportedAction): 'enabled' | 'disabled' | 'uninstalled' {
  switch (action) {
    case 'enable':
    case 'restore':
      return 'enabled';
    case 'disable':
      return 'disabled';
    case 'uninstall':
      return 'uninstalled';
  }
}
