/**
 * Module Registry（HUB-043）：**内置可信模块**的静态注册与发现。
 *
 * 立场（INV-12 / 规划 4.3）：
 * - 这里是唯一决定「哪些模块存在、它声明什么、它被允许用什么能力」的地方。
 *   所有输入都经过 Zod 校验，任何不合规的注册都会**拒绝并给出诊断码**，不会静默降级。
 * - 唯一性：模块 ID 全局唯一；Widget **类型** ID 全局唯一（跨模块）；
 *   路由 `path` 与 `viewId` 唯一。注意「引用唯一」与「实例可重复」是两件事。
 * - 能力是**权限面**：Manifest 里声明的能力必须同时落在白名单与注册表授予集合内。
 *   声明能力 ≠ 被授权，服务端授权不因 Manifest 声明而放宽。
 * - 生命周期 handler 只能来自**静态 handler 表**；Manifest 里引用不存在的 handler 名即注册失败。
 *   前端可执行组件映射**不在这里**（它是 apps/web 的静态表），二者刻意分离，
 *   因此不存在「按客户端字符串动态加载/执行远程 JS」的入口。
 */
import {
  MODULE_CAPABILITIES,
  validateModuleManifest,
  type ModuleCapability,
  type ModuleDescriptor,
  type ModuleManifest,
  type WidgetDefinition,
} from '@ff14-hub/shared';
import type { ZodType } from 'zod';
import { describeIssues } from '../../lib/zod-issues';
import type { ModuleLifecycleHandler } from '../ports';

export type RegistryDiagnosticCode =
  | 'manifest_invalid'
  | 'duplicate_module_id'
  | 'duplicate_widget_id'
  | 'duplicate_route_path'
  | 'duplicate_route_view'
  | 'missing_lifecycle_handler'
  | 'settings_schema_version_invalid'
  | 'settings_schema_version_mismatch'
  | 'settings_schema_rejects_empty'
  | 'capability_not_whitelisted'
  | 'capability_not_granted';

export interface RegistryDiagnostic {
  readonly code: RegistryDiagnosticCode;
  /** 能定位到模块时给出模块 ID，否则为 null（例如 Manifest 形状非法、连 id 都读不出）。 */
  readonly moduleId: string | null;
  readonly detail: string;
}

/** 一条注册输入。`manifest` 故意是 `unknown`：注册表必须自己校验，不能靠调用方的类型声明。 */
export interface ModuleRegistrationInput {
  readonly manifest: unknown;
  /** 静态 handler 表：Manifest 的 lifecycle 名只能在这里查找。 */
  readonly handlerTable: Readonly<Record<string, ModuleLifecycleHandler>>;
  /** 模块设置的 Zod Schema（服务端权威，前端不得代替它做校验）。 */
  readonly settingsSchema: ZodType;
  /** 该 Schema 的版本；必须与 Manifest.settingsSchemaVersion 一致，防止两处漂移。 */
  readonly settingsSchemaVersion: number;
  /** 服务端为本模块授予的能力集合（白名单子集）。 */
  readonly grantedCapabilities: readonly ModuleCapability[];
}

export interface RegisteredModule {
  readonly manifest: ModuleManifest;
  /** 对外公开的描述（不含 handler 名等内部细节）。 */
  readonly descriptor: ModuleDescriptor;
  readonly settingsSchema: ZodType;
  readonly settingsSchemaVersion: number;
  readonly grantedCapabilities: readonly ModuleCapability[];
  readonly handlers: Readonly<Record<string, ModuleLifecycleHandler>>;
}

export type SettingsValidation =
  | { readonly ok: true; readonly settings: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface ModuleRegistry {
  list(): readonly RegisteredModule[];
  get(moduleId: string): RegisteredModule | undefined;
  /** 按 Widget 类型 ID 查找；不存在返回 undefined（调用方必须显式处理，不得猜）。 */
  findWidget(widgetId: string): { readonly module: RegisteredModule; readonly widget: WidgetDefinition } | undefined;
  /** 服务端授权查询：Manifest 声明了什么并不影响这里的结论。 */
  hasCapability(moduleId: string, capability: ModuleCapability): boolean;
  validateSettings(moduleId: string, settings: unknown): SettingsValidation;
}

export type RegistryBuild =
  | { readonly ok: true; readonly registry: ModuleRegistry }
  | { readonly ok: false; readonly diagnostics: readonly RegistryDiagnostic[] };

function readCandidateId(manifest: unknown): string | null {
  if (typeof manifest === 'object' && manifest !== null) {
    const id = (manifest as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }
  return null;
}

function toDescriptor(manifest: ModuleManifest): ModuleDescriptor {
  return {
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    capabilities: [...manifest.capabilities],
    widgets: manifest.widgets.map((widget) => ({ ...widget })),
    routes: (manifest.routes ?? []).map((route) => ({ ...route })),
    settingsSchemaVersion: manifest.settingsSchemaVersion,
  };
}

/**
 * 校验并构建注册表。任一条注册不合法都会被拒绝并返回**全部**诊断，
 * 便于一次看清所有问题，而不是修一个报一个。
 */
export function buildModuleRegistry(inputs: readonly ModuleRegistrationInput[]): RegistryBuild {
  const diagnostics: RegistryDiagnostic[] = [];
  const modules: RegisteredModule[] = [];
  const widgetOwners = new Map<string, string>();
  const routePaths = new Map<string, string>();
  const routeViews = new Map<string, string>();

  for (const input of inputs) {
    const validated = validateModuleManifest(input.manifest);
    if (!validated.ok) {
      for (const issue of validated.issues) {
        diagnostics.push({
          code: 'manifest_invalid',
          moduleId: readCandidateId(input.manifest),
          detail: issue,
        });
      }
      continue;
    }

    const manifest = validated.manifest;
    if (modules.some((registered) => registered.manifest.id === manifest.id)) {
      diagnostics.push({
        code: 'duplicate_module_id',
        moduleId: manifest.id,
        detail: `模块 ID 重复：${manifest.id}`,
      });
      continue;
    }

    // --- 能力：白名单 + 授予集合（服务端权威） --------------------------------
    let capabilityOk = true;
    for (const granted of input.grantedCapabilities) {
      if (!(MODULE_CAPABILITIES as readonly string[]).includes(granted)) {
        diagnostics.push({
          code: 'capability_not_whitelisted',
          moduleId: manifest.id,
          detail: `授予能力不在白名单内：${granted}`,
        });
        capabilityOk = false;
      }
    }
    const grantedSet = new Set(input.grantedCapabilities);
    for (const declared of manifest.capabilities) {
      if (!grantedSet.has(declared)) {
        diagnostics.push({
          code: 'capability_not_granted',
          moduleId: manifest.id,
          detail: `Manifest 声明了未被授予的能力：${declared}`,
        });
        capabilityOk = false;
      }
    }
    if (!capabilityOk) {
      continue;
    }

    // --- Widget 类型 ID 全局唯一（同 Manifest 内 + 跨 Manifest）------------------
    // 同 Manifest 内的重复由 Manifest Schema 的 superRefine 把关；这里再做一次**局部**检查，
    // 因为跨模块的 Map 是「循环结束后才填」的，单靠它发现不了同一个 Manifest 内部的重复。
    let widgetOk = true;
    const localWidgetIds = new Set<string>();
    for (const widget of manifest.widgets) {
      if (localWidgetIds.has(widget.id)) {
        diagnostics.push({
          code: 'duplicate_widget_id',
          moduleId: manifest.id,
          detail: `同一模块内 Widget 类型 ID 重复：${widget.id}`,
        });
        widgetOk = false;
      }
      const owner = widgetOwners.get(widget.id);
      if (owner !== undefined) {
        diagnostics.push({
          code: 'duplicate_widget_id',
          moduleId: manifest.id,
          detail: `Widget 类型 ID 已被模块 ${owner} 占用：${widget.id}`,
        });
        widgetOk = false;
      }
      localWidgetIds.add(widget.id);
    }
    if (!widgetOk) {
      continue;
    }

    // --- 路由唯一（同 Manifest 内 + 跨 Manifest）-----------------------------
    let routeOk = true;
    const localRoutePaths = new Set<string>();
    const localRouteViews = new Set<string>();
    for (const route of manifest.routes ?? []) {
      if (localRoutePaths.has(route.path)) {
        diagnostics.push({
          code: 'duplicate_route_path',
          moduleId: manifest.id,
          detail: `同一模块内路由 path 重复：${route.path}`,
        });
        routeOk = false;
      }
      if (localRouteViews.has(route.viewId)) {
        diagnostics.push({
          code: 'duplicate_route_view',
          moduleId: manifest.id,
          detail: `同一模块内路由 viewId 重复：${route.viewId}`,
        });
        routeOk = false;
      }
      const pathOwner = routePaths.get(route.path);
      if (pathOwner !== undefined) {
        diagnostics.push({
          code: 'duplicate_route_path',
          moduleId: manifest.id,
          detail: `路由 path 已被模块 ${pathOwner} 占用：${route.path}`,
        });
        routeOk = false;
      }
      const viewOwner = routeViews.get(route.viewId);
      if (viewOwner !== undefined) {
        diagnostics.push({
          code: 'duplicate_route_view',
          moduleId: manifest.id,
          detail: `路由 viewId 已被模块 ${viewOwner} 占用：${route.viewId}`,
        });
        routeOk = false;
      }
      localRoutePaths.add(route.path);
      localRouteViews.add(route.viewId);
    }
    if (!routeOk) {
      continue;
    }

    // --- 生命周期 handler 必须存在于静态表 ------------------------------------
    const referencedHandlers = [
      manifest.lifecycle.onEnable,
      manifest.lifecycle.onDisable,
      manifest.lifecycle.onUninstall,
    ].filter((name): name is string => name !== undefined);
    let handlerOk = true;
    for (const name of referencedHandlers) {
      // Object.hasOwn：不能把 Object.prototype 上的成员（如 'constructor'）当成已注册的 handler。
      const candidate = Object.hasOwn(input.handlerTable, name) ? input.handlerTable[name] : undefined;
      if (typeof candidate !== 'function') {
        diagnostics.push({
          code: 'missing_lifecycle_handler',
          moduleId: manifest.id,
          detail: `生命周期 handler 未在静态注册表中定义：${name}`,
        });
        handlerOk = false;
      }
    }
    if (!handlerOk) {
      continue;
    }

    // --- 设置 Schema 版本与「空设置必须合法」 ---------------------------------
    if (!Number.isInteger(input.settingsSchemaVersion) || input.settingsSchemaVersion < 0) {
      diagnostics.push({
        code: 'settings_schema_version_invalid',
        moduleId: manifest.id,
        detail: `settingsSchemaVersion 必须是非负整数，收到：${String(input.settingsSchemaVersion)}`,
      });
      continue;
    }
    if (input.settingsSchemaVersion !== manifest.settingsSchemaVersion) {
      diagnostics.push({
        code: 'settings_schema_version_mismatch',
        moduleId: manifest.id,
        detail:
          `注册表声明的 settingsSchemaVersion=${input.settingsSchemaVersion} ` +
          `与 Manifest 的 ${manifest.settingsSchemaVersion} 不一致`,
      });
      continue;
    }
    const emptyProbe = input.settingsSchema.safeParse({});
    if (!emptyProbe.success) {
      diagnostics.push({
        code: 'settings_schema_rejects_empty',
        moduleId: manifest.id,
        detail: 'Settings Schema 必须接受空对象，否则模块无法在不提供设置时启用',
      });
      continue;
    }

    const registered: RegisteredModule = {
      manifest,
      descriptor: toDescriptor(manifest),
      settingsSchema: input.settingsSchema,
      settingsSchemaVersion: input.settingsSchemaVersion,
      grantedCapabilities: [...new Set(input.grantedCapabilities)],
      handlers: { ...input.handlerTable },
    };
    modules.push(registered);
    for (const widget of manifest.widgets) {
      widgetOwners.set(widget.id, manifest.id);
    }
    for (const route of manifest.routes ?? []) {
      routePaths.set(route.path, manifest.id);
      routeViews.set(route.viewId, manifest.id);
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const byId = new Map(modules.map((module) => [module.manifest.id, module]));

  return {
    ok: true,
    registry: {
      list: () => modules,
      get: (moduleId) => byId.get(moduleId),
      findWidget: (widgetId) => {
        for (const module of modules) {
          const widget = module.manifest.widgets.find((candidate) => candidate.id === widgetId);
          if (widget !== undefined) {
            return { module, widget };
          }
        }
        return undefined;
      },
      hasCapability: (moduleId, capability) => byId.get(moduleId)?.grantedCapabilities.includes(capability) ?? false,
      validateSettings: (moduleId, settings) => {
        const module = byId.get(moduleId);
        if (module === undefined) {
          return { ok: false, issues: ['模块未注册'] };
        }
        const parsed = module.settingsSchema.safeParse(settings);
        if (!parsed.success) {
          // 只回字段路径与问题类别，绝不回显设置值（模块设置将来可能含口令类字段）。
          return { ok: false, issues: [describeIssues(parsed.error.issues)] };
        }
        const value: unknown = parsed.data;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { ok: false, issues: ['settings 必须是一个对象'] };
        }
        return { ok: true, settings: value as Record<string, unknown> };
      },
    },
  };
}

/** 重启期构建注册表：失败时必须让部署失败，而不是带着半个注册表上线。 */
export function buildModuleRegistryOrThrow(inputs: readonly ModuleRegistrationInput[]): ModuleRegistry {
  const build = buildModuleRegistry(inputs);
  if (!build.ok) {
    const summary = build.diagnostics.map((item) => `${item.code}@${item.moduleId ?? '<unknown>'}: ${item.detail}`);
    throw new Error(`模块注册表构建失败：\n${summary.join('\n')}`);
  }
  return build.registry;
}
