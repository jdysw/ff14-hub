/**
 * 导航模块的可执行组件表（阶段 04 / HUB-010）。
 *
 * 为什么单独一个文件：组件注册表（`../widgets/component-registry.ts`）只做「契约 × 组件」的
 * 静态拼装，各模块的组件实现各自成文件，避免多个模块的实现挤在同一个对象字面量里。
 *
 * 硬约束：这里只允许静态映射（写死的键），绝不按不可信字符串动态 `import()` 或执行远程 JS；
 * 组件拿不到设备 Token，只能通过 Host 注入的 `data: ModuleDataPort` 访问本模块声明的操作。
 */
import type { ComponentType } from 'react';
import { NAV_WIDGET_IDS } from '@ff14-hub/shared';
import type { WidgetRuntimeProps } from '../widgets/types';
import { NavQuickLinksWidget } from './NavQuickLinksWidget';
import { NavSearchWidget } from './NavSearchWidget';

/** `widgetId → React 组件`。键必须与共享契约里的 NAV_WIDGET_IDS 一致。 */
export const navWidgetComponents: Readonly<Record<string, ComponentType<WidgetRuntimeProps>>> = {
  [NAV_WIDGET_IDS.quickLinks]: NavQuickLinksWidget,
  [NAV_WIDGET_IDS.search]: NavSearchWidget,
};
