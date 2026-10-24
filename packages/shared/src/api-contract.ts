/** 当前 Worker 公开路径与基础请求/健康契约，不包含已退役的设备工作空间 API。 */
import {z} from 'zod';
export const API_V1_PREFIX='/api/v1' as const;
export const REQUEST_ID_HEADER='X-Request-Id' as const;
export const API_ROUTES={
  health:`${API_V1_PREFIX}/health`,
  navCatalog:`${API_V1_PREFIX}/navigation/catalog`,
  publicEvents:`${API_V1_PREFIX}/events`,
  fish:`${API_V1_PREFIX}/fish`,
  fishWindows:`${API_V1_PREFIX}/fish/windows`,
  calendar:`${API_V1_PREFIX}/events/calendar`,
  site:`${API_V1_PREFIX}/site`,
  siteData:`${API_V1_PREFIX}/site/data`,
  admin:`${API_V1_PREFIX}/admin`,
  localNotifications:`${API_V1_PREFIX}/local-notifications`,
  mobileWidgets:`${API_V1_PREFIX}/widgets/v1/summary`,
} as const;
export const SERVICE_NAME='ff14-hub' as const;
export const SERVICE_VERSION='0.0.0' as const;
export const healthResponseSchema=z.object({
  status:z.enum(['ok','degraded']),
  service:z.literal(SERVICE_NAME),
  version:z.string().min(1),
  environment:z.string().min(1),
  database:z.enum(['ok','unavailable']),
  nowUtcMs:z.number().int().nonnegative(),
});
export type HealthResponse=z.infer<typeof healthResponseSchema>;
export const MAX_JSON_BODY_BYTES=64*1024;
export const WRITE_METHODS=['POST','PUT','PATCH','DELETE'] as const;
export type WriteMethod=(typeof WRITE_METHODS)[number];
export function isWriteMethod(method:string):method is WriteMethod{
  return (WRITE_METHODS as readonly string[]).includes(method.toUpperCase());
}
