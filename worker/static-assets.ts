/**
 * 静态资源回退（ADR-001：前端与 API 同域）。
 *
 * 行为边界：
 * - 只有非 `/api/*` 请求会走到这里；`/api/*` 由显式路由与结构化 404 处理。
 * - SPA 回退由 wrangler 的 `assets.not_found_handling = "single-page-application"` 完成，
 *   这里不做任何路径重写，避免在前端路由之外再造一套规则。
 * - `ASSETS` 绑定只在 wrangler dev/deploy 运行时存在；Workers 测试与纯单测中缺失时，
 *   返回结构化 404 而不是抛异常——保证绑定缺失不会变成 500。
 * - HUB-012 追加：对 PWA 必需的三类路径**覆写响应头**（Service Worker / manifest / 图标）。
 *   仍然先调用 `env.ASSETS.fetch(request)`，只包一层 `new Response(body, { headers })`，
 *   因此 SPA 回退与既有静态资源语义完全不变。
 */
import { DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import { errorResponse, requestIdOf } from './middleware/error-handler';
import type { AppContext } from './types';

/** Service Worker 的固定路径（与 apps/web/src/app/pwa/register-service-worker.ts 一致）。 */
export const SERVICE_WORKER_PATH = '/sw.js';
/** Web App Manifest 的固定路径（与 apps/web/index.html 的 <link rel="manifest"> 一致）。 */
export const MANIFEST_PATH = '/manifest.webmanifest';
/** 图标目录前缀（manifest 与 apple-touch-icon 都指向这里）。 */
export const ICONS_PATH_PREFIX = '/icons/';

/**
 * PWA 路径的响应头覆写表；`null` 表示「这条路径没有特殊要求，保持资源层原样」。
 *
 * 为什么需要覆写：
 * - `/sw.js` 必须 `no-store`：SW 脚本被 HTTP 缓存住会让「更新」永远发现不了；
 *   `Service-Worker-Allowed: /` 允许脚本从根作用域控制整个站点；
 *   MIME 必须明确是 JS，否则 `nosniff` 下浏览器拒绝注册。
 * - `/manifest.webmanifest` 需要 `application/manifest+json`，且要能被重新验证（不用长缓存，
 *   否则装了新图标/新名称后用户长时间看不到）。
 * - `/icons/*` 是内容不变的文件名，可以长缓存 + immutable。
 */
function pwaHeaderOverrides(pathname: string): Record<string, string> | null {
  if (pathname === SERVICE_WORKER_PATH) {
    return {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    };
  }
  if (pathname === MANIFEST_PATH) {
    return {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
    };
  }
  if (pathname.startsWith(ICONS_PATH_PREFIX)) {
    const overrides: Record<string, string> = {
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (pathname.endsWith('.png')) {
      overrides['Content-Type'] = 'image/png';
    }
    return overrides;
  }
  return null;
}

/**
 * 是否应该覆写这条响应的头。
 *
 * 只有 200 且资源层**没有**把它变成 HTML 时才覆写：
 * `not_found_handling = single-page-application` 会把缺失的路径回退成 index.html，
 * 若给那份 HTML 贴上 `application/javascript`，浏览器会把 HTML 当脚本解析——
 * 与其伪装成脚本，不如原样返回，让注册显式失败。
 */
function shouldOverride(response: Response): boolean {
  if (response.status !== 200) {
    return false;
  }
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase();
  return !contentType.startsWith('text/html');
}

export async function serveStaticAssets(c: AppContext): Promise<Response> {
  const assets = c.env.ASSETS;
  if (assets === undefined) {
    return errorResponse('not_found', DEFAULT_ERROR_MESSAGE.not_found, requestIdOf(c));
  }
  const response = await assets.fetch(c.req.raw);

  const overrides = pwaHeaderOverrides(new URL(c.req.url).pathname);
  if (overrides === null || !shouldOverride(response)) {
    return response;
  }

  // 不原地改 `response.headers`（来自 ASSETS 的 Response 头可能不可变），而是构造新响应。
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(overrides)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
