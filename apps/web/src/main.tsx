import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles.css';

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
