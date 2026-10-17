/**
 * 阶段说明面板。
 *
 * 作用是把「当前什么都没有」这件事说清楚，避免把骨架误读为功能缺失或已完成的业务页面。
 * 内容与 docs/FF14_Hub_AI_Development_Plan.md 的路线图保持一致。
 */
export function StageNotice() {
  return (
    <section className="panel" aria-labelledby="stage-title">
      <h2 id="stage-title">当前阶段</h2>
      <p>
        <strong>阶段 02 · HUB-043 / HUB-044 / HUB-050</strong>
        （Module Registry 静态注册、Widget Host 与实例隔离、模块生命周期与数据策略）
      </p>
      <p className="panel__muted">
        阶段 01 的工程底座与设备身份系统已经合并入 <code>main</code>。
        本阶段提供的是**模块运行时**：内置可信模块的注册表、基于静态组件映射的 Widget Host、
        以及模块启停 / 卸载 / 恢复的持久状态与契约。
        界面上出现的组件全部是 <code>demo.*</code> 演示组件，<strong>没有游戏业务数据</strong>。
      </p>
      <ul className="roadmap">
        <li>阶段 03 · 自定义工作台（持久页面、拖拽布局、备份恢复）</li>
        <li>阶段 04 · 自由导航与首页</li>
        <li>阶段 05 · 鱼类 / 活动 / 提醒（含真实持久调度）</li>
        <li>阶段 06 · 鱼糕 WebDAV 同步与发布</li>
      </ul>
      <p className="panel__muted">
        明确未做：清数据（purge）被显式拒绝（501）；没有 Cron、没有 Web Push、没有真实游戏导航；
        多页面与布局编辑不在本阶段。
      </p>
    </section>
  );
}
