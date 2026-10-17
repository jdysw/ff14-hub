/**
 * Shell 的视图标识。
 * 刻意**不**引入前端路由：阶段 02 只需要在几个验收视图之间切换，
 * 真实的多页面工作台与导航属于阶段 03–04（INV-01 / INV-02）。
 */
export type ShellView = 'overview' | 'modules' | 'widgets' | 'credentials';

export const SHELL_VIEW_TITLES: Readonly<Record<ShellView, string>> = {
  overview: '工作台概览',
  modules: '模块管理',
  widgets: '组件验收',
  credentials: '会话凭证',
};
