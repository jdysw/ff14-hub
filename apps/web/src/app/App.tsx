import { AppShell } from './shell/AppShell';

/**
 * 应用顶层。
 *
 * 阶段 01 边界（明确不做的事）：
 * - 不引入前端路由，也不实现业务导航（INV-01 属于阶段 04）。
 * - 不实现工作台编辑器、拖拽或布局（INV-02 属于阶段 03）。
 * - 不实现 Module Registry / Widget Host 运行时（属于阶段 02）。
 * 这里只提供结构化的 App Shell：品牌区、系统级入口区、占位内容区。
 */
export function App() {
  return <AppShell />;
}
