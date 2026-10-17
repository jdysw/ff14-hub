/**
 * `/api/v1` 路由装配。
 *
 * 阶段 01 只有三个路由组：
 * - health      公开就绪探针
 * - me          私有骨架（已认证中间件已生效，处理器属 HUB-006）
 * - __test__    仅测试可达的自检路由（默认不可达）
 */
import { Hono } from 'hono';
import type { AppBindings } from '../../types';
import { healthRoutes } from './health';
import { meRoutes } from './me';
import { createTestRoutes } from './test-routes';

export function createApiV1(): Hono<AppBindings> {
  const v1 = new Hono<AppBindings>();
  v1.route('/', healthRoutes);
  v1.route('/me', meRoutes);
  v1.route('/__test__', createTestRoutes());
  return v1;
}
