import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * 本地开发站只有 Vite 静态服务，动态公开数据需要读取已部署的正式站。
 * 仅允许匿名 GET 的**精确白名单**，不转发 Authorization、Cookie、写入或管理员接口。
 * 此插件仅在 Vite dev server 生效，不进入生产构建，也不连接生产 D1。
 */
const DEV_PUBLIC_ORIGIN = 'https://ff14.zhixia.uk';
const DEV_PUBLIC_ROUTES = new Set([
  '/api/v1/events/calendar',
  '/api/v1/events/calendar.ics',
  '/api/v1/navigation/catalog',
  '/api/v1/site',
  '/api/v1/site/data',
  '/api/v1/health',
  '/api/v1/widgets/v1/summary',
]);

function devPublicApiReadOnly(): Plugin {
  return {
    name: 'ff14-hub-public-api-readonly',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/v1/')) return next();
        // 默认拒绝所有未列明的 API；尤其不能把管理/个人写操作送往生产环境。
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET');
          res.end(JSON.stringify({error:'local_dev_api_read_only'}));
          return;
        }
        if (!DEV_PUBLIC_ROUTES.has(url.pathname)) {
          res.statusCode = 404;
          res.end(JSON.stringify({error:'local_dev_api_unavailable'}));
          return;
        }
        void (async () => {
          try {
            const remote = await fetch(new URL(url.pathname + url.search, DEV_PUBLIC_ORIGIN), {
              method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error',
              signal: AbortSignal.timeout(15_000),
            });
            const length = Number(remote.headers.get('content-length') ?? 0);
            if (length > 8_000_000) throw new Error('public_response_too_large');
            const bytes = Buffer.from(await remote.arrayBuffer());
            if (bytes.byteLength > 8_000_000) throw new Error('public_response_too_large');
            res.statusCode = remote.status;
            res.setHeader('Content-Type', remote.headers.get('content-type') ?? 'application/json; charset=utf-8');
            res.end(bytes);
          } catch {
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({error:'dev_public_api_unavailable'}));
          }
        })();
      });
    },
  };
}

/**
 * 前端构建配置。
 *
 * 部署边界（ADR-001）：产物只输出到 dist/，由 Cloudflare Workers 的静态资源绑定同域提供；
 * 构建期不需要任何密钥，也不读取 .dev.vars。
 * 本轮不接入 Tailwind / shadcn-ui（按规划 4.1，属于后续 UI 阶段）。
 */
export default defineConfig({
  plugins: [react(), devPublicApiReadOnly()],
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
