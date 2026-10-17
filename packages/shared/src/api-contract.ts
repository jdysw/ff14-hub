/**
 * API 契约（规划 6 节）。统一前缀 /api/v1。
 *
 * 边界声明：
 * - 公开端点可以匿名访问；任何 `/me/*` 必须通过设备身份验证（Bearer 设备 Token）。
 * - 阶段 01 只实现 `GET /health` 与 `/me/profile`、`/me/devices` 的**受保护骨架**；
 *   身份流程（bootstrap/pairing/recover）与业务端点属于 HUB-006 与阶段 02+。
 * - 服务端返回体不得包含 token_hash / recovery_hash 等摘要，也不得包含 environment secrets。
 */
import { z } from 'zod';
import { REGIONS } from './identity';

/** API 版本前缀。路由与前端都从这里取值，避免硬编码漂移。 */
export const API_V1_PREFIX = '/api/v1' as const;

/** 请求 ID 的响应头与响应体字段名。 */
export const REQUEST_ID_HEADER = 'X-Request-Id' as const;

/** 阶段 01 端点路径常量。 */
export const API_ROUTES = {
  health: `${API_V1_PREFIX}/health`,
  meProfile: `${API_V1_PREFIX}/me/profile`,
  meDevices: `${API_V1_PREFIX}/me/devices`,
  meDeviceById: `${API_V1_PREFIX}/me/devices/:id`,
} as const;

/** 服务标识与版本，用于健康检查与 UA 判定。 */
export const SERVICE_NAME = 'ff14-hub' as const;
export const SERVICE_VERSION = '0.0.0' as const;

/**
 * 健康检查响应。
 * 刻意只暴露非敏感字段：不含绑定名、不含 D1 内容、不含任何密钥或密钥前缀。
 * `database` 是**就绪探针**的一部分：它能证明 D1 绑定在本次运行中真的可用，
 * 而不只是 Worker 进程还活着。D1 不可用时整体返回 503。
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal(SERVICE_NAME),
  version: z.string().min(1),
  environment: z.string().min(1),
  database: z.enum(['ok', 'unavailable']),
  /** UTC 毫秒时间戳，方便客户端校验时钟。 */
  nowUtcMs: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** 当前工作空间的非敏感配置（GET /me/profile）。 */
export const workspaceProfileSchema = z.object({
  id: z.string().min(1),
  region: z.enum(REGIONS),
  timezone: z.string().min(1),
  locale: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;

/**
 * 设备摘要（GET /me/devices）。
 * 只包含可安全展示的字段：**永远不含 token_hash**，撤销设备也只返回 revokedAt 时间戳。
 */
export const deviceSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
  /** 是否为发起本次请求的设备。 */
  current: z.boolean(),
});

export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const deviceListResponseSchema = z.object({
  devices: z.array(deviceSummarySchema),
});

export type DeviceListResponse = z.infer<typeof deviceListResponseSchema>;

/** 写请求允许的 JSON 体积上限（字节）。超限返回 413。 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/** 写方法集合：这些方法必须经过 Origin 与 Content-Type 校验。 */
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];

export function isWriteMethod(method: string): method is WriteMethod {
  return (WRITE_METHODS as readonly string[]).includes(method.toUpperCase());
}
