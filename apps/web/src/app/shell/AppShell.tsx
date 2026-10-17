import { HealthPanel } from './HealthPanel';
import { StageNotice } from './StageNotice';
import { SystemBar } from './SystemBar';

/**
 * 结构化 App Shell。
 *
 * 布局分区（后续阶段的落点，本轮只建立结构）：
 * - header   品牌与阶段标识
 * - SystemBar  永久保留的系统级入口（不可由用户移除）
 * - main     内容区：阶段说明 + API 连通性 + 未来的 Widget 容器
 * - footer   安全提示
 *
 * 刻意不做的事：不渲染任何业务 Widget、不提供拖拽/缩放、不实现前端路由。
 */
export function AppShell() {
  return (
    <div className="shell">
      <header className="shell__header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            FF
          </span>
          <div>
            <h1 className="brand__title">FF14 Hub</h1>
            <p className="brand__subtitle">个人导航与模块化工作台 · 国服优先</p>
          </div>
        </div>
        <p className="shell__stage">阶段 01 · 工程与身份基础</p>
      </header>

      <SystemBar />

      <main className="shell__main">
        <StageNotice />
        <HealthPanel />

        <section className="panel panel--empty" aria-labelledby="workbench-title">
          <h2 id="workbench-title">工作台区域（尚未实现）</h2>
          <p className="panel__muted">
            这里是将来的 Widget 实例容器。阶段 02 建立模块注册与 Widget Host，
            阶段 03 才会提供拖拽、缩放、隐藏与移除。本轮不渲染任何业务组件，
            以避免把未来的组件清单硬编码进首页（INV-12）。
          </p>
        </section>
      </main>

      <footer className="shell__footer">
        <p>
          凭证说明：设备 Token 只通过 <code>Authorization</code> 头传递，不出现在 URL 中；
          本页不显示、不记录任何凭证或恢复密钥。
        </p>
      </footer>
    </div>
  );
}
