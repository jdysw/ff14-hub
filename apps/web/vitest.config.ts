import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 前端测试配置（阶段 02 起包含 React 组件测试）。
 *
 * 环境选择：
 * - 默认 `node`：现有的 api-client 契约测试在 Node 下运行即可。
 * - 需要 DOM 的组件测试在文件顶部用 `// @vitest-environment jsdom` 显式声明，
 *   避免把整个包切到 jsdom 而影响既有测试的行为。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.{ts,tsx}'],
    passWithNoTests: false,
  },
});
