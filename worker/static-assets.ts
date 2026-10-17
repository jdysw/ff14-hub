/**
 * 静态资源回退（ADR-001：前端与 API 同域）。
 *
 * 行为边界：
 * - 只有非 `/api/*` 请求会走到这里；`/api/*` 由显式路由与结构化 404 处理。
 * - SPA 回退由 wrangler 的 `assets.not_found_handling = "single-page-application"` 完成，
 *   这里不做任何路径重写，避免在前端路由之外再造一套规则。
 * - `ASSETS` 绑定只在 wrangler dev/deploy 运行时存在；Workers 测试与纯单测中缺失时，
 *   返回结构化 404 而不是抛异常——保证绑定缺失不会变成 500。
 */
import { DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import { errorResponse, requestIdOf } from './middleware/error-handler';
import type { AppContext } from './types';

export async function serveStaticAssets(c: AppContext): Promise<Response> {
  const assets = c.env.ASSETS;
  if (assets === undefined) {
    return errorResponse('not_found', DEFAULT_ERROR_MESSAGE.not_found, requestIdOf(c));
  }
  return assets.fetch(c.req.raw);
}
