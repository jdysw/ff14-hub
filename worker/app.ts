/**
 * Hono 应用装配（HUB-002 / HUB-004）。
 *
 * 中间件与路由顺序（顺序本身就是安全边界，调整前请先想清楚）：
 *   1. requestId      —— 最先执行，保证任何响应都能被追踪
 *   2. runtimeConfig  —— 绑定/变量校验，失败即脱敏 500
 *   3. writeGuard     —— 仅 /api/v1/* 的写方法：Origin / Content-Type / 体积 / JSON 解析
 *   4. /api/v1 路由   —— health（公开）、me（认证后仍未实现）、__test__（默认不可达）
 *   5. /api/*         —— 未知 API 路径 → 结构化 404（绝不回退到 SPA HTML）
 *   6. *              —— 静态资源 + SPA 回退
 *
 * 注意：安全响应头不在这里施加，而是在 Worker 顶层 fetch 统一施加，
 * 这样 500/404/静态资源三类响应都不会遗漏 CSP。
 */
import { API_V1_PREFIX } from '@ff14-hub/shared';
import { Hono } from 'hono';
import { createApiV1 } from './api/v1';
import { apiNotFound, registerErrorHandlers } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import { runtimeConfig } from './middleware/runtime-config';
import { writeGuard } from './middleware/write-guard';
import { serveStaticAssets } from './static-assets';
import type { AppBindings } from './types';

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', requestId());
  app.use('*', runtimeConfig());
  app.use(`${API_V1_PREFIX}/*`, writeGuard());

  app.route(API_V1_PREFIX, createApiV1());

  // 未知 API 路径必须是 JSON 404：把 /api/* 回退成 index.html 会让客户端拿到 200 HTML，
  // 这既破坏契约，也容易掩盖路径拼写错误。
  app.all('/api/*', (c) => apiNotFound(c));

  // 其余全部交给静态资源（含 SPA 回退）。
  app.all('*', serveStaticAssets);

  registerErrorHandlers(app);
  return app;
}
