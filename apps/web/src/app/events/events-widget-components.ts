/**
 * 活动模块的可执行组件表（阶段 04 / HUB-011）。
 *
 * 与导航组件表同理：静态映射、不做动态加载、组件只通过 Host 注入的
 * `data: ModuleDataPort` 访问本模块声明的操作。
 *
 * 键取自共享常量 `EVENTS_WIDGET_IDS`（而不是字符串字面量）：这样 Manifest 里的
 * `widgets[].id`、配置契约、端口调用与这里的映射不可能各自漂移；写错键名会直接编译失败。
 */
import { EVENTS_WIDGET_IDS } from '@ff14-hub/shared';
import type { ComponentType } from 'react';
import { EventsManageWidget } from './EventsManageWidget';
import { EventsCalendarWidget } from './EventsCalendarWidget';
import { EventsUpcomingWidget } from './EventsUpcomingWidget';
import type { WidgetRuntimeProps } from '../widgets/types';

/** `widgetId → React 组件`。键必须与共享契约里的 EVENTS_WIDGET_IDS 一致。 */
export const eventsWidgetComponents: Readonly<Record<string, ComponentType<WidgetRuntimeProps>>> = {
  [EVENTS_WIDGET_IDS.upcoming]: EventsUpcomingWidget,
  [EVENTS_WIDGET_IDS.manage]: EventsManageWidget,
  [EVENTS_WIDGET_IDS.calendar]: EventsCalendarWidget,
};
