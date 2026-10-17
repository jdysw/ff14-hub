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
        <strong>阶段 01 · HUB-001 ～ HUB-005</strong>
        （Core 工程、Worker/API 基础、D1 迁移、认证中间件、CI 与测试基础）
      </p>
      <p className="panel__muted">
        本页只是结构化的 App Shell，用于验证同域静态资源与 API 调用链。导航、鱼类工作台、
        布局编辑器与通知调度均未实现，也不在本轮范围内。
      </p>
      <ul className="roadmap">
        <li>阶段 02 · Module Registry 与 Widget Host</li>
        <li>阶段 03 · 自定义工作台（多页面、拖拽布局、备份恢复）</li>
        <li>阶段 04 · 自由导航与首页</li>
        <li>阶段 05 · 鱼类 / 活动 / 提醒</li>
        <li>阶段 06 · 鱼糕 WebDAV 同步与发布</li>
      </ul>
    </section>
  );
}
