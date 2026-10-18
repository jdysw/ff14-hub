import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 前端测试配置（阶段 02 起包含 React 组件测试）。
 *
 * 环境选择：
 * - 默认 `node`：现有的 api-client 契约测试在 Node 下运行即可。
 * - 需要 DOM 的组件测试在文件顶部用 `// @vitest-environment jsdom` 显式声明，
 *   避免把整个包切到 jsdom 而影响既有测试的行为。
 *
 * 超时选择（阶段 04 起）：
 * - vitest 默认单测超时是 5 秒。本包含多个「渲染整个 App Shell + 真实交互」的用例
 *   （工作台布局编辑、会话隔离、导航视图），在 2 核 CI runner 上并行时计算量很大，
 *   5 秒会因为**机器忙**而不是因为断言失败变红——那是假失败，反而掩盖真正的回归。
 * - 因此单测/钩子超时放宽到 20 秒。这不跳过任何断言、不放宽任何检查：
 *   断言失败仍然是失败，只是「机器太慢」不再被误报成失败。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.{ts,tsx}'],
    passWithNoTests: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
