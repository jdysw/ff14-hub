/**
 * 工作台前端测试的共用夹具。
 *
 * 为什么单独一个文件：`workbench-behaviour.spec.tsx` 与 `workbench-layout.spec.tsx`
 * 都需要同一份「契约数据形状」与构造器；复制两份会被静态分析判为重复代码，
 * 而且两份容易漂移（改了一处忘了另一处）。
 *
 * 这些夹具只做**形状转换**，不包含任何断言或业务判断。
 */
import {
  BUILTIN_MODULE_MANIFESTS,
  type ModuleDescriptor,
  type WidgetInstance,
  type WorkspacePage,
} from '@ff14-hub/shared';

/** 与 `GET /modules/catalog` 的服务端映射同形的模块描述。 */
export const DESCRIPTORS: readonly ModuleDescriptor[] = BUILTIN_MODULE_MANIFESTS.map((manifest) => ({
  id: manifest.id,
  version: manifest.version,
  displayName: manifest.displayName,
  capabilities: [...manifest.capabilities],
  widgets: manifest.widgets.map((widget) => ({ ...widget })),
  routes: (manifest.routes ?? []).map((route) => ({ ...route })),
  settingsSchemaVersion: manifest.settingsSchemaVersion,
}));

export function page(id: string, name: string, overrides: Partial<WorkspacePage> = {}): WorkspacePage {
  return {
    id,
    name,
    slug: id,
    isDefault: false,
    sortOrder: 0,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function instance(
  id: string,
  widgetType: string,
  pageId: string,
  overrides: Partial<WidgetInstance> = {},
): WidgetInstance {
  return {
    id,
    pageId,
    moduleId: 'demo.basics',
    widgetType,
    config: { step: 1, label: '演示计数', initDelayMs: 0 },
    configVersion: 1,
    hidden: false,
    revision: 1,
    createdRevision: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}
