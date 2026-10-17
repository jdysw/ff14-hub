/**
 * `/api/v1/me/*`（私有端点）——HUB-006 的**受保护契约骨架**。
 *
 * 本轮的边界（重要，不要误读为已完成）：
 * - 认证中间件（deviceAuth）已完整实现并生效：未授权一律 401。
 * - 处理器体尚未实现，已认证请求会得到 `501 not_implemented`。
 *   这是刻意的：完整身份功能属于 HUB-006，将在同一任务中替换这些处理器。
 * - 这样安排让「认证边界」在本轮就可以被真实测试（401 与「通过认证后才 501」都可断言），
 *   同时不把 HUB-006 的功能提前半实现。
 *
 * 安全前提：
 * - 作用域只能取自 `c.get('workspaceId')`（由认证中间件写入），绝不接受客户端传入的 workspace id。
 * - 未来实现时，响应体只能包含 deviceSummary / workspaceProfile 契约中的字段，
 *   绝不返回 token_hash、recovery_hash 或配对摘要。
 */
import { ApiError } from '@ff14-hub/shared';
import { Hono } from 'hono';
import { deviceAuth } from '../../middleware/auth';
import { methodNotAllowed } from '../../middleware/error-handler';
import type { AppBindings } from '../../types';

export const meRoutes = new Hono<AppBindings>();

// 整个 /me/* 子树必须先通过设备认证；挂载顺序保证 401 优先于 405/501。
meRoutes.use('*', deviceAuth());

/**
 * 未实现的统一出口：501，并明确说明它属于 HUB-006。
 * 这里刻意不是 500——「未实现」是确定的契约状态，不是故障。
 */
function identityPending(): never {
  throw new ApiError(
    'not_implemented',
    '该功能尚未在本次阶段实现（完整的单工作空间身份与设备管理由 HUB-006 在同一任务中实现）。',
    'identity_handler_pending',
  );
}

// GET /api/v1/me/profile —— 预留：返回当前工作空间非敏感配置
meRoutes.get('/profile', identityPending);
// GET /api/v1/me/devices —— 预留：列出当前工作空间设备（不含 token_hash）
meRoutes.get('/devices', identityPending);
// DELETE /api/v1/me/devices/:id —— 预留：撤销设备并立即生效
meRoutes.delete('/devices/:id', identityPending);

// 其他方法：结构化 405（同样先经过认证）。
meRoutes.all('*', methodNotAllowed(['GET', 'DELETE']));
