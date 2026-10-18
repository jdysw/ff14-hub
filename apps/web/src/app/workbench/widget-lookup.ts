/**
 * 组件元数据查表（工作台视图用）。
 *
 * 为什么需要它：键盘移动 / 缩放按钮必须在**本地**判断「这一步会不会被服务端拒绝」，
 * 而尺寸约束的权威来源是模块 Manifest（`GET /modules/catalog` 里的 `minSize` / `maxSize`）。
 * 共享契约的 `validateLayoutRects` 是唯一判定实现，本文件只负责把约束喂给它。
 *
 * 保守回退：如果目录还没拿到（例如目录接口失败），已注册组件用**注册表默认尺寸**作为最小尺寸。
 * `minSize <= defaultSize` 是 Manifest 的硬约束，因此这个回退只会更严格，
 * 绝不会出现「按钮可点但保存被服务端拒绝」。
 */
import type { ModuleDescriptor, WidgetDefinition, WidgetSizeConstraint } from '@ff14-hub/shared';
import { widgetComponentRegistry } from '../widgets/component-registry';
import type { WorkbenchWidgetLookup, WorkbenchWidgetMeta } from './workbench-model';

function constraintOfDefinition(definition: WidgetDefinition): WidgetSizeConstraint {
  return {
    minW: definition.minSize.w,
    minH: definition.minSize.h,
    maxW: definition.maxSize?.w ?? null,
    maxH: definition.maxSize?.h ?? null,
  };
}

/**
 * 构造「组件类型 → 元数据」的查表函数。
 * 条目来源：公开模块目录（尺寸约束的权威）+ 静态组件注册表（可执行组件的权威）。
 * 两者都没有 → 返回 null，界面显示「不受支持的组件类型」降级卡片，**不执行**任何组件。
 */
export function createWidgetLookup(catalog: readonly ModuleDescriptor[] = []): WorkbenchWidgetLookup {
  const definitions = new Map<string, WidgetDefinition>();
  for (const module of catalog) {
    for (const widget of module.widgets) {
      definitions.set(widget.id, widget);
    }
  }
  return (widgetType: string): WorkbenchWidgetMeta | null => {
    const entry = widgetComponentRegistry.find(widgetType);
    const definition = definitions.get(widgetType);
    if (entry === null && definition === undefined) {
      return null;
    }
    const defaultSize = definition?.defaultSize ?? entry?.defaultSize ?? { w: 3, h: 3 };
    return {
      displayName: entry?.displayName ?? definition?.displayName ?? widgetType,
      moduleId: entry?.moduleId ?? definition?.moduleId ?? 'unknown',
      defaultSize,
      constraint:
        definition === undefined
          ? { minW: defaultSize.w, minH: defaultSize.h, maxW: null, maxH: null }
          : constraintOfDefinition(definition),
    };
  };
}
