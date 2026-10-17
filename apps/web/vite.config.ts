import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 前端构建配置。
 *
 * 部署边界（ADR-001）：产物只输出到 dist/，由 Cloudflare Workers 的静态资源绑定同域提供；
 * 构建期不需要任何密钥，也不读取 .dev.vars。
 * 本轮不接入 Tailwind / shadcn-ui（按规划 4.1，属于后续 UI 阶段）。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 与 tsconfig 的 target 保持一致，避免 tsc 与 esbuild/rolldown 语义漂移。
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
