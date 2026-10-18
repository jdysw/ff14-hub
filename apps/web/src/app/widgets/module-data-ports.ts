/**
 * 模块数据端口注册表（阶段 04 / HUB-010）——**组件与凭证之间的唯一信道**。
 *
 * 为什么需要这一层（边界，硬约束）：
 * - Widget 组件**拿不到**设备 Token、拿不到 `fetch`、拿不到任意 API 路径。它只拿到一个
 *   `ModuleDataPort`，而端口只认识**该模块在静态表里声明过的操作名**。
 * - 因此「组件自己发一个请求到内网/别的模块/别的 workspace」这种路径在类型上就不存在：
 *   没有 URL 参数、没有 header 参数、没有 workspace 参数。
 * - 每个模块的操作表在各自目录里（`app/nav/nav-data-port.ts`、`app/events/events-data-port.ts`），
 *   这里只做「查找 + 门禁复检」。
 *
 * 门禁复检（为什么必须做）：
 * Host 已经在渲染前挡掉未启用/停用/卸载/正在切换（`transitioning`）的模块，但组件可能在
 * 渲染之后仍然发起调用（异步、延迟、重试）。端口在**每次调用前**再查一次模块门禁状态，
 * 于是「模块正在卸载」期间不可能绕过生命周期 fence 去读写数据。
 */
import type { ModuleDataPort } from './types';
import type { ModuleAccess } from './types';
import { isModuleUsableForRendering } from './instance-store';
import { EVENTS_MODULE_ID, NAV_MODULE_ID } from '@ff14-hub/shared';
import { eventsModulePortFactory } from '../events/events-data-port';
import { navModulePortFactory } from '../nav/nav-data-port';

/** 端口工厂拿到的上下文：只有这一层看得见凭证。 */
export interface ModulePortContext {
  /** 设备 Token。绝不允许透传给组件或写进日志/URL。 */
  readonly token: string;
  /** API 基地址（同域时为空串，表示用相对路径）。 */
  readonly apiBaseUrl: string;
  /**
   * 读取模块门禁状态。由应用注入（与服务端状态同源），端口每次调用前复检。
   * 刻意用函数而不是快照：模块状态可能在组件存活期间变化。
   */
  readonly moduleAccess: (moduleId: string) => ModuleAccess;
  /** 凭证失效时的统一处理（例如把会话切回未登录态并提示重新输入）。 */
  readonly onUnauthorized?: (() => void) | undefined;
}

/**
 * 单个操作的实现。输入是**未校验的 `unknown`**：操作实现必须自己用共享 Schema 校验
 * （绝不信任组件传来的形状），并且只返回可安全序列化的纯数据。
 */
export type ModulePortOperation = (input: unknown) => Promise<unknown>;

/** `操作名 → 实现`。键必须与组件调用的一致；未声明即为拒绝。 */
export type ModulePortOperationTable = Readonly<Record<string, ModulePortOperation>>;

/** 模块端口工厂：给定上下文，产出该模块允许的操作表。 */
export type ModulePortFactory = (context: ModulePortContext) => ModulePortOperationTable;

/** 组装出的调用表（模块 ID → 工厂）。未列出的模块没有端口（调用会被拒绝）。 */
export const MODULE_PORT_FACTORIES: Readonly<Record<string, ModulePortFactory>> = {
  [NAV_MODULE_ID]: navModulePortFactory,
  [EVENTS_MODULE_ID]: eventsModulePortFactory,
};

/**
 * 为某个模块实例构造数据端口。
 *
 * 拒绝语义（都抛错，绝不静默返回空数据——静默会让用户以为「本来就没有数据」）：
 * - 模块未注册端口 → 抛错说明该模块没有数据端口；
 * - 模块门禁不可渲染（停用/卸载/切换中）→ 抛错说明模块不可用；
 * - 操作名未声明 → 抛错列出可用的操作名。
 */
export function createModuleDataPort(input: {
  readonly moduleId: string;
  readonly context: ModulePortContext;
  readonly factories?: Readonly<Record<string, ModulePortFactory>>;
}): ModuleDataPort {
  const factories = input.factories ?? MODULE_PORT_FACTORIES;
  const factory = factories[input.moduleId];
  const operations: ModulePortOperationTable = factory === undefined ? {} : factory(input.context);
  return {
    moduleId: input.moduleId,
    operations: Object.keys(operations).sort((a, b) => a.localeCompare(b)),
    async call<T = unknown>(operation: string, input_?: unknown): Promise<T> {
      const access = input.context.moduleAccess(input.moduleId);
      if (!isModuleUsableForRendering(access.status)) {
        throw new Error(`模块 ${input.moduleId} 当前为「${access.status}」，该调用已被拒绝`);
      }
      if (!Object.hasOwn(operations, operation)) {
        const available = Object.keys(operations).sort((a, b) => a.localeCompare(b)).join('、');
        throw new Error(
          `模块 ${input.moduleId} 未声明操作「${operation}」` +
            (available.length === 0 ? '（该模块没有可用操作）' : `（可用：${available}）`),
        );
      }
      // Object.hasOwn 已保证存在；这里显式再取一次以满足「不信任字符串索引」的类型前提。
      const handler = operations[operation];
      if (handler === undefined) {
        throw new Error(`模块 ${input.moduleId} 的操作「${operation}」未实现`);
      }
      return (await handler(input_)) as T;
    },
  };
}
