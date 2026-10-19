/**
 * `/api/v1` 路由装配。
 *
 * 路由组：
 * - health      公开就绪探针
 * - modules     公开模块目录（HUB-043，只含非敏感元数据）
 * - identity    身份四端点（阶段 01）
 * - me          私有骨架 + 模块状态/生命周期（HUB-050）+ 工作台（阶段 03）
 *               + 导航 / 个人活动 / 同步水位（阶段 04）
 * - navigation  公开推荐目录（阶段 04，只读参考数据）
 * - events      公开活动列表（阶段 04，只读参考数据；个人活动在 /me 子树）
 * - __test__    仅测试可达的自检路由（默认不可达）
 */
import { Hono } from 'hono';
import type { AppBindings } from '../../types';
import { publicEventRoutes } from './events';
import { adminRoutes, publicSiteRoutes } from './admin';
import { fishRoutes } from './fish';
import { healthRoutes } from './health';
import { identityRoutes } from './identity';
import { meRoutes } from './me';
import { moduleRoutes } from './modules';
import { navigationRoutes } from './navigation';
import { createTestRoutes } from './test-routes';

export function createApiV1(): Hono<AppBindings> {
  const v1 = new Hono<AppBindings>();
  v1.route('/', healthRoutes);
  v1.route('/modules', moduleRoutes);
  // 阶段 04：公开推荐目录与公开活动列表（都只有只读参考数据，匿名可读）。
  v1.route('/navigation', navigationRoutes);
  v1.route('/events', publicEventRoutes);
  v1.route('/site', publicSiteRoutes);
  v1.route('/admin', adminRoutes);
  v1.route('/fish', fishRoutes);
  v1.route('/identity', identityRoutes);
  v1.route('/me', meRoutes);
  v1.route('/__test__', createTestRoutes());
  return v1;
}
