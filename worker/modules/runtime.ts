/**
 * 模块运行时装配（HUB-043 / HUB-050 的组合点）。
 *
 * 为什么按 D1 绑定缓存：
 * - 调度端口背后的任务存储目前是**内存替身**（`persistent: false`），
 *   它必须跨请求存活才能让「停用会取消已排队任务」这条语义真实可观测，
 *   因此以 D1 绑定为键、每个 isolate 一份运行时。
 * - 换成持久实现（阶段 05）后，这个缓存可以原样保留，不改变任何调用点。
 *
 * 已知限制（不隐瞒）：
 * - 内存任务存储会随 isolate 回收而丢失，所以**不能**当成真实调度系统使用；
 *   本阶段也没有注册任何 Cron，`wrangler.jsonc` 的 `triggers.crons` 仍为空。
 * - 实例清理端口是 no-op 替身：阶段 02 没有持久页面/实例表，
 *   真实清理由浏览器内的 Host 实例表完成（见 apps/web 的 InstanceStore）。
 */
import type { ModuleSchedulerPort } from './ports';
import { createModuleLifecycle, type ModuleLifecycle } from './lifecycle/module-lifecycle';
import { createInMemoryScheduledTaskStore, createModuleScheduler, createNoopInstanceStore } from './lifecycle/scheduler';
import { readEffectiveModuleStatus } from './lifecycle/workspace-modules';
import { builtinModuleRegistry } from './registry/builtin-modules';
import type { ModuleRegistry } from './registry/module-registry';

export interface ModuleRuntime {
  readonly registry: ModuleRegistry;
  readonly lifecycle: ModuleLifecycle;
  readonly scheduler: ModuleSchedulerPort;
}

const runtimes = new WeakMap<D1Database, ModuleRuntime>();

/** 显式构造一份运行时（测试可注入自定义 store / instanceStore）。 */
export function createModuleRuntime(db: D1Database): ModuleRuntime {
  const scheduledTasks = createInMemoryScheduledTaskStore();
  const scheduler = createModuleScheduler({
    store: scheduledTasks,
    // 门禁自己查库：调用方无法通过传参绕过「未启用不得排程」。
    readModuleStatus: ({ workspaceId, moduleId }) => readEffectiveModuleStatus(db, workspaceId, moduleId),
  });
  const lifecycle = createModuleLifecycle({
    db,
    registry: builtinModuleRegistry,
    instanceStore: createNoopInstanceStore(),
    scheduler,
  });
  return { registry: builtinModuleRegistry, lifecycle, scheduler };
}

/** 取（或首次构造）该 D1 绑定的运行时。 */
export function getModuleRuntime(db: D1Database): ModuleRuntime {
  const existing = runtimes.get(db);
  if (existing !== undefined) {
    return existing;
  }
  const created = createModuleRuntime(db);
  runtimes.set(db, created);
  return created;
}
