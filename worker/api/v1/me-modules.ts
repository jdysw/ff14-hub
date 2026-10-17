/**
 * `/api/v1/me/modules*`（设备鉴权，HUB-050）。
 *
 * 安全前提：
 * - 这些路由挂载在 `meRoutes` 之下，因此整棵子树先经过 `deviceAuth()`；未授权一律 401。
 * - 作用域**只**来自 `c.get('workspaceId')`（认证结果），绝不接受客户端提交的 workspace id。
 * - 写操作先经 `validateJsonBody`（严格 Schema，多余字段直接拒绝），再做业务校验。
 * - `purge`（清数据）在本阶段**显式拒绝**：返回 501 与可读原因，并明确说明没有删除任何数据。
 *   绝不静默删除、也不假装成功。
 */
import {
  ApiError,
  DEFAULT_ERROR_MESSAGE,
  PURGE_UNSUPPORTED_MESSAGE,
  moduleMutationRequestSchema,
} from '@ff14-hub/shared';
// 这里只把 Hono 当作类型使用（路由注册进传入的实例），因此是 import type。
import type { Hono } from 'hono';
import { noStoreJson } from '../../lib/response';
import { parsedJsonBody, validateJsonBody } from '../../middleware/validation';
import { getModuleRuntime } from '../../modules/runtime';
import type { MutationRejection } from '../../modules/lifecycle/module-lifecycle';
import type { AppBindings } from '../../types';

/** 把服务层拒绝原因映射成统一错误契约。刻意不把内部细节放进对外 message。 */
function mutationError(reason: MutationRejection, detail: string): ApiError {
  switch (reason) {
    case 'module_unknown':
      return new ApiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, detail);
    case 'purge_unsupported':
      return new ApiError('not_implemented', PURGE_UNSUPPORTED_MESSAGE, detail);
    case 'status_conflict':
    case 'revision_conflict':
    case 'settings_version_mismatch':
      return new ApiError('conflict', `${DEFAULT_ERROR_MESSAGE.conflict}（${detail}）`, detail);
    case 'settings_invalid':
      return new ApiError('validation_failed', `${DEFAULT_ERROR_MESSAGE.validation_failed}（${detail}）`, detail);
    case 'settings_too_large':
      return new ApiError('payload_too_large', DEFAULT_ERROR_MESSAGE.payload_too_large, detail);
    case 'handler_failed':
    case 'side_effect_failed':
    case 'persist_failed':
      // 这三类是服务端内部故障：对外只给统一文案，细节只写服务端日志。
      return new ApiError('internal_error', DEFAULT_ERROR_MESSAGE.internal_error, detail);
  }
}

/** 在 /me 子树里注册模块路由（扁平注册，避免子应用路由优先级带来的歧义）。 */
export function registerMeModuleRoutes(me: Hono<AppBindings>): void {
  /** GET /me/modules —— 本工作空间的模块有效状态集合（含未安装的派生状态）。 */
  me.get('/modules', async (c) => {
    const runtime = getModuleRuntime(c.env.DB);
    const modules = await runtime.lifecycle.listStatuses(c.get('workspaceId'));
    return noStoreJson(c, { modules });
  });

  /** GET /me/modules/:id —— 单个模块状态；未注册的模块返回 404。 */
  me.get('/modules/:id', async (c) => {
    const moduleId = c.req.param('id');
    const runtime = getModuleRuntime(c.env.DB);
    if (runtime.registry.get(moduleId) === undefined) {
      throw new ApiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, 'module_not_registered');
    }
    const status = await runtime.lifecycle.readStatus(c.get('workspaceId'), moduleId);
    return noStoreJson(c, { module: status });
  });

  /**
   * PATCH /me/modules/:id —— 生命周期变更 / 设置写入。
   * 必须携带 `expectedRevision`（防静默覆盖）；revision 不匹配返回 409。
   */
  me.patch('/modules/:id', validateJsonBody(moduleMutationRequestSchema), async (c) => {
    const moduleId = c.req.param('id');
    const request = parsedJsonBody(c, moduleMutationRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.lifecycle.mutate({
      workspaceId: c.get('workspaceId'),
      moduleId,
      request,
    });
    if (!outcome.ok) {
      throw mutationError(outcome.reason, outcome.detail);
    }
    return noStoreJson(c, { module: outcome.module, effect: outcome.effect });
  });

  /**
   * POST /me/modules/:id/purge —— 清数据入口。
   *
   * 本阶段**不实现**清数据，但必须显式拒绝而不是静默删除：
   * 清数据与卸载是两种语义，且必须先在服务端完成备份并由用户二次确认。
   * 这里连「模块是否存在」都不区分地返回 501 —— 避免通过状态码探测注册表内容。
   */
  me.post('/modules/:id/purge', () => {
    throw new ApiError('not_implemented', PURGE_UNSUPPORTED_MESSAGE, 'purge_unsupported');
  });
}
