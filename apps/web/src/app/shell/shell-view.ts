/**
 * Shell 的视图标识。
 * 刻意**不**引入前端路由：阶段 02 只需要在几个验收视图之间切换，
 * 阶段 03 追加真实的「自定义工作台」视图（HUB-045 / 046 / 049 / 054），
 * 阶段 04 追加真实的「个人导航」视图（HUB-007 / 008 / 009 / 047 / 048）。
 */
export type ShellView = 'home' | 'calendar' | 'admin' | 'settings' | 'overview' | 'nav' | 'workbench' | 'modules' | 'widgets' | 'credentials' | 'fishing' | 'reminders' | 'sync';

export const SHELL_VIEW_TITLES: Readonly<Record<ShellView, string>> = {
  home: '首页',
  calendar: '国服活动日历',
  settings: '设置',
  admin: '站点管理',
  overview: '工作台概览',
  fishing:'钓鱼手账',
  reminders:'提醒管理',
  sync:'数据同步',
  nav: '个人导航',
  workbench: '自定义工作台',
  modules: '模块管理',
  widgets: '组件验收',
  credentials: '会话凭证',
};

