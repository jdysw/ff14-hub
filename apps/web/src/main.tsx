import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { registerServiceWorker } from './app/pwa/register-service-worker';
import './styles.css';
import './app/shell/home.css';
import './app/local/modern-ui.css';
import './app/local/modern-content.css';
import './app/local/modern-components.css';
import './app/pvp/pvp-panel.css';
import './app/local/field-guide.css';

const container = document.getElementById('root');
if (container === null) {
  // 明确失败而不是静默无输出，方便定位部署产物问题。
  throw new Error('找不到 #root 挂载点，前端产物可能损坏。');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 追加：安全注册 Service Worker（HUB-012 / ADR-0004 D10）。
// - 注册是「增强」而不是渲染前提：`registerServiceWorker()` 在任何情况下都不抛错，
//   不支持 / 被拒 / 隐私模式下只返回结构化结果，因此这里不需要 try/catch，
//   也不会阻塞上面的首屏渲染。
// - 更新激活一律由页面在用户确认后进行（存在未保存草稿时会被拒绝），
//   这里不会触发任何自动重载。
void registerServiceWorker();

