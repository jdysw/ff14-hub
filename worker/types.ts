/** Hono 上下文仅承载现行 API 请求作用域与通知设备认证信息。 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppConfig, Env } from './env';

export interface AppVariables {
  /** 每个请求的唯一 ID，用于关联日志与错误响应。 */
  requestId: string;
  /** 校验后的运行时配置（不含凭证值）。 */
  config: AppConfig;
  /** 由 write-guard 解析后的 JSON 请求体；未解析时为 undefined。 */
  jsonBody: unknown;
  /** 独立通知 Token 验证后的设备 ID。 */
  deviceId: string;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };

export type AppContext = Context<AppBindings>;

export type AppMiddleware = MiddlewareHandler<AppBindings>;
