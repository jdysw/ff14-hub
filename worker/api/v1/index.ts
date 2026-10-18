/**
 * `/api/v1` 路由装配。
 *
 * 路由组：
 * - health      公开就绪探针
 * - modules     公开模块目录（HUB-043，只含非敏感元数据）
 * - identity    身份四端点（阶段 01）
 * - me          私有骨架 + 模块状态/生命周期（HUB-050）+ 工作台（阶段 03）
 * - __test__    仅测试可达的自检路由（默认不可达）
 */
import { Hono } from 'hono';
import type { AppBindings } from '../../types';
import { healthRoutes } from './health';
import { identityRoutes } from './identity';
import { meRoutes } from './me';
import { moduleRoutes } from './modules';
import { createTestRoutes } from './test-routes';

export function createApiV1(): Hono<AppBindings> {
  const v1 = new Hono<AppBindings>();
  v1.route('/', healthRoutes);
  v1.route('/modules', moduleRoutes);
  v1.route('/identity', identityRoutes);
  v1.route('/me', meRoutes);
  v1.route('/__test__', createTestRoutes());
  return v1;
}
