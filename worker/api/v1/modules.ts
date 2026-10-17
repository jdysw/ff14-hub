/**
 * `/api/v1/modules/*`（公开目录，HUB-043 / HUB-050）。
 *
 * 安全前提：
 * - 这一棵子树**匿名可读**，因此响应里只允许出现非敏感元数据：
 *   模块 ID、版本、展示名、能力名、Widget 定义、路由与设置版本。
 * - **不返回**任何 handler 名、不返回任何工作空间状态、不返回任何凭证或摘要。
 *   模块是否已启用属于个人状态，只在设备鉴权的 `/me/modules` 下暴露。
 */
import { Hono } from 'hono';
import { noStoreJson } from '../../lib/response';
import { methodNotAllowed } from '../../middleware/error-handler';
import { getModuleRuntime } from '../../modules/runtime';
import type { AppBindings } from '../../types';

export const moduleRoutes = new Hono<AppBindings>();

/** GET /modules/catalog —— 内置模块目录（匿名可读）。 */
moduleRoutes.get('/catalog', (c) => {
  const runtime = getModuleRuntime(c.env.DB);
  return noStoreJson(c, { modules: runtime.registry.list().map((module) => module.descriptor) });
});

// 只支持 GET：其他方法给结构化 405。
moduleRoutes.all('*', methodNotAllowed(['GET']));
