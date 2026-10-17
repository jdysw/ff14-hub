/**
 * `/api/v1/me/*`（私有端点，HUB-006 已实现）。
 *
 * 安全前提：
 * - 整棵子树先经过 `deviceAuth()`；未授权一律 401（由认证中间件保证）。
 * - 作用域只能取自 `c.get('workspaceId')`（认证结果），**绝不**接受客户端提交的 workspace id。
 *   因此拿 A 工作空间的凭证操作 B 工作空间的设备只会得到 404。
 * - 列表响应只包含 `deviceSummarySchema` 的字段，绝不返回 `token_hash` 或恢复密钥摘要。
 * - 撤销立即生效：认证中间件每个请求都查库，没有进程内令牌缓存，
 *   所以被撤销设备的下一次请求就会 401，无需等待缓存过期。
 */
import { ApiError, DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import { Hono } from 'hono';
import { getWorkspaceProfile, listDevices, revokeDevice } from '../../modules/identity/devices';
import { deviceAuth } from '../../middleware/auth';
import { methodNotAllowed } from '../../middleware/error-handler';
import { noContent, noStoreJson } from '../../lib/response';
import type { AppBindings } from '../../types';

export const meRoutes = new Hono<AppBindings>();

// 整个 /me/* 子树必须先通过设备认证；挂载顺序保证 401 优先于 405。
meRoutes.use('*', deviceAuth());

/** GET /me/profile —— 当前工作空间的非敏感配置。 */
meRoutes.get('/profile', async (c) => {
  const profile = await getWorkspaceProfile(c.env.DB, c.get('workspaceId'));
  if (profile === null) {
    // 认证通过却查不到工作空间：数据被破坏或作用域不一致。按 404 处理，不泄露内部原因。
    throw new ApiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, 'workspace_missing');
  }
  return noStoreJson(c, profile);
});

/** GET /me/devices —— 列出本工作空间设备（不含 token_hash）。 */
meRoutes.get('/devices', async (c) => {
  const devices = await listDevices(c.env.DB, c.get('workspaceId'), c.get('deviceId'));
  return noStoreJson(c, { devices });
});

/** DELETE /me/devices/:id —— 撤销设备并立即使其配对失效。 */
meRoutes.delete('/devices/:id', async (c) => {
  const outcome = await revokeDevice(c.env.DB, {
    workspaceId: c.get('workspaceId'),
    deviceId: c.req.param('id'),
    actingDeviceId: c.get('deviceId'),
  });
  if (!outcome.ok) {
    throw new ApiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, 'device_not_in_workspace');
  }
  // 幂等：对已撤销的设备再次调用同样返回 204。
  return noContent(c);
});

// 其他方法：结构化 405（同样先经过认证）。
meRoutes.all('*', methodNotAllowed(['GET', 'DELETE']));
