/** /api/v1：现行公开服务、站点管理员与独立设备提醒，无旧工作空间身份端点。 */
import { Hono } from 'hono';
import {localNotificationRoutes} from './local-notifications';
import type { AppBindings } from '../../types';
import { publicEventRoutes } from './events';
import { adminRoutes, publicSiteRoutes } from './admin';
import { fishRoutes } from './fish';
import {mobileWidgetRoutes} from './mobile-widgets';
import { healthRoutes } from './health';
import { navigationRoutes } from './navigation';
import { createTestRoutes } from './test-routes';

export function createApiV1(): Hono<AppBindings> {
  const v1 = new Hono<AppBindings>();
  v1.route('/', healthRoutes);
  // 阶段 04：公开推荐目录与公开活动列表（都只有只读参考数据，匿名可读）。
  v1.route('/navigation', navigationRoutes);
  v1.route('/events', publicEventRoutes);
  v1.route('/site', publicSiteRoutes);
  v1.route('/local-notifications',localNotificationRoutes);
  v1.route('/admin', adminRoutes);
  v1.route('/fish', fishRoutes);
  v1.route('/widgets',mobileWidgetRoutes);
  v1.route('/__test__', createTestRoutes());
  return v1;
}
