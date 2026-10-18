/**
 * 内置模块的**服务端**注册（HUB-043）。
 *
 * 职责划分（刻意分离，避免「契约」与「可执行代码」混在一起）：
 * - Manifest 常量与 Widget 配置契约在 `@ff14-hub/shared`（纯契约，前后端共用）。
 * - **服务端**生命周期 handler 表与模块 Settings Schema 在本文件（服务端权威）。
 * - **前端**可执行组件映射在 apps/web/src/app/widgets/component-registry.ts。
 *
 * 当前注册的模块全部是 `demo.*` 演示模块（无游戏业务语义）。真实业务模块（ff14.fishing 等）
 * 属于阶段 04–05，届时只需在此追加注册，不改动注册表本身。
 *
 * handler 的安全边界：handler 只拿到 `ModuleLifecycleContext`
 * （workspaceId / moduleId / now / 受限服务端口），**拿不到** D1 绑定、设备 Token 或 env。
 */
import {
  BUILTIN_MODULE_MANIFESTS,
  DEMO_BASICS_MODULE_ID,
  DEMO_SOLO_MODULE_ID,
  EVENTS_MODULE_ID,
  FISH_MODULE_ID,
  REMINDER_MODULE_ID,
  NAV_MODULE_ID,
  type ModuleCapability,
} from '@ff14-hub/shared';
import { z } from 'zod';
import { logLine } from '../../lib/redact';
import type { ModuleLifecycleContext, ModuleLifecycleHandler } from '../ports';
import { buildModuleRegistryOrThrow, type ModuleRegistry, type ModuleRegistrationInput } from './module-registry';

/** 演示模块 `demo.basics` 的模块级设置：用于验证设置校验与版本化写入。 */
const demoBasicsSettingsSchema = z
  .object({
    greeting: z.string().min(1).max(40).default('你好'),
    announce: z.boolean().default(false),
  })
  .strict();

/**
 * 演示模块 `demo.solo` 不接受任何设置。
 * 这让我们可以断言「非法设置被拒绝」而不必依赖某个具体字段的取值范围。
 */
const demoSoloSettingsSchema = z.object({}).strict();

function logHandler(event: string, context: ModuleLifecycleContext, extra: Readonly<Record<string, string>> = {}): void {
  console.info(
    logLine('info', event, {
      workspaceId: context.workspaceId,
      moduleId: context.moduleId,
      ...extra,
    }),
  );
}

/** `demo.basics` 的静态 handler 表：键即 Manifest.lifecycle 中允许引用的名字。 */
const demoBasicsHandlerTable: Readonly<Record<string, ModuleLifecycleHandler>> = {
  'demo.basics.enable': (context) => {
    logHandler('module_handler_enable', context);
  },
  'demo.basics.disable': async (context) => {
    // 只读地观察该模块当前排队中的后台任务。
    // 「取消已排队任务」由**平台**在写库后统一执行（见 module-lifecycle.ts 第 2 阶段），
    // 模块代码不需要、也不应该依赖自己来完成这条平台级不变量。
    //
    // 注意调度视图是**闭包绑定作用域**的：这里没有、也不能传 workspaceId / moduleId。
    const pending = await context.services.scheduler.listPending();
    logHandler('module_handler_disable', context, { pendingTasks: String(pending.length) });
  },
  'demo.basics.uninstall': async (context) => {
    const pending = await context.services.scheduler.listPending();
    // 只读观察：这里**绝不**触碰个人数据，卸载不删除任何用户数据。
    logHandler('module_handler_uninstall', context, { pendingTasks: String(pending.length) });
  },
};

function manifestOf(moduleId: string): unknown {
  const found = BUILTIN_MODULE_MANIFESTS.find((manifest) => manifest.id === moduleId);
  if (found === undefined) {
    // 内置 Manifest 缺失属于构建期错误：宁可让启动失败，也不要上线一个半成品注册表。
    throw new Error(`内置模块 Manifest 缺失：${moduleId}`);
  }
  return found;
}

/** 演示模块刻意不申请任何能力（不为演示放宽权限面）。 */
const NO_CAPABILITIES: readonly ModuleCapability[] = [];

/**
 * 阶段 04 的真实业务模块设置：本阶段没有模块级设置项。
 * 用 `.strict()` 明确拒绝未知字段，而不是静默丢弃（宁可让用户看到「这个字段不支持」）。
 */
const noSettingsSchema = z.object({}).strict();

/**
 * 导航模块的生命周期 handler（服务端权威）。
 *
 * 这里**刻意只做可观测的日志**：启用/停用不搬动任何用户数据——导航链接属于用户，
 * 停用模块只是让它的组件与入口暂停（INV-04：停用 ≠ 删除）。卸载同理：个人导航数据保留，
 * 用户重新启用后立即回来。真正需要后台任务的模块（阶段 05 的提醒）才需要在这里取消任务。
 */
const navigationHandlerTable: Readonly<Record<string, ModuleLifecycleHandler>> = {
  'ff14.navigation.enable': (context) => {
    logHandler('module_handler_enable', context);
  },
  'ff14.navigation.disable': async (context) => {
    const pending = await context.services.scheduler.listPending();
    logHandler('module_handler_disable', context, { pendingTasks: String(pending.length) });
  },
  'ff14.navigation.uninstall': async (context) => {
    const pending = await context.services.scheduler.listPending();
    logHandler('module_handler_uninstall', context, { pendingTasks: String(pending.length) });
  },
};

/** 活动模块的生命周期 handler。语义同上：停用/卸载都不删除个人活动数据。 */
const eventsHandlerTable: Readonly<Record<string, ModuleLifecycleHandler>> = {
  'ff14.events.enable': (context) => {
    logHandler('module_handler_enable', context);
  },
  'ff14.events.disable': async (context) => {
    const pending = await context.services.scheduler.listPending();
    logHandler('module_handler_disable', context, { pendingTasks: String(pending.length) });
  },
  'ff14.events.uninstall': async (context) => {
    const pending = await context.services.scheduler.listPending();
    logHandler('module_handler_uninstall', context, { pendingTasks: String(pending.length) });
  },
};

/**
 * 授予的能力必须**显式列出**，且必须覆盖 Manifest 声明的全部能力
 * （注册表会校验「声明 ⊆ 授予」，缺一个就构建失败）。
 */
const NAVIGATION_CAPABILITIES: readonly ModuleCapability[] = ['storage:own', 'navigation:read-catalog'];
const EVENTS_CAPABILITIES: readonly ModuleCapability[] = ['storage:own'];

const REGISTRATIONS: readonly ModuleRegistrationInput[] = [
  { manifest:manifestOf(REMINDER_MODULE_ID),handlerTable:{},settingsSchema:noSettingsSchema,
    settingsSchemaVersion:1,grantedCapabilities:['storage:own','scheduled:own'] },
  { manifest: manifestOf(FISH_MODULE_ID), handlerTable: {}, settingsSchema: noSettingsSchema,
    settingsSchemaVersion: 1, grantedCapabilities: ['storage:own'] },
  {
    manifest: manifestOf(DEMO_BASICS_MODULE_ID),
    handlerTable: demoBasicsHandlerTable,
    settingsSchema: demoBasicsSettingsSchema,
    settingsSchemaVersion: 1,
    grantedCapabilities: NO_CAPABILITIES,
  },
  {
    manifest: manifestOf(DEMO_SOLO_MODULE_ID),
    // 刻意给空 handler 表：Manifest 也没有引用任何 handler，因此合法。
    handlerTable: {},
    settingsSchema: demoSoloSettingsSchema,
    settingsSchemaVersion: 1,
    grantedCapabilities: NO_CAPABILITIES,
  },
  // 阶段 04：真实业务模块（HUB-010 / HUB-011）。
  {
    manifest: manifestOf(NAV_MODULE_ID),
    handlerTable: navigationHandlerTable,
    settingsSchema: noSettingsSchema,
    settingsSchemaVersion: 1,
    grantedCapabilities: NAVIGATION_CAPABILITIES,
  },
  {
    manifest: manifestOf(EVENTS_MODULE_ID),
    handlerTable: eventsHandlerTable,
    settingsSchema: noSettingsSchema,
    settingsSchemaVersion: 1,
    grantedCapabilities: EVENTS_CAPABILITIES,
  },
];

/**
 * 进程级注册表。构建失败会直接抛异常（部署/启动期失败），而不是带着不完整注册表运行。
 */
export const builtinModuleRegistry: ModuleRegistry = buildModuleRegistryOrThrow(REGISTRATIONS);

/** 供测试断言「Manifest 引用的 handler 名确实等于静态表里的名字」。 */
export const BUILTIN_HANDLER_NAMES: readonly string[] = Object.keys(demoBasicsHandlerTable);
