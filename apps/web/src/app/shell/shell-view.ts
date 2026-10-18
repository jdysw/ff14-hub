/**
 * Shell 的视图标识。
 * 刻意**不**引入前端路由：阶段 02 只需要在几个验收视图之间切换，
 * 阶段 03 追加真实的「自定义工作台」视图（HUB-045 / 046 / 049 / 054）。
 */
export type ShellView = 'overview' | 'workbench' | 'modules' | 'widgets' | 'credentials';

export const SHELL_VIEW_TITLES: Readonly<Record<ShellView, string>> = {
  overview: '工作台概览',
  workbench: '自定义工作台',
  modules: '模块管理',
  widgets: '组件验收',
  credentials: '会话凭证',
};
