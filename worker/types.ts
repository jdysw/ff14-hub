/**
 * Hono 上下文类型与共享变量。
 *
 * 约定：
 * - 私有数据作用域**只能**来自认证中间件写入的 `workspaceId`，
 *   绝不接受客户端提交的 workspace id（规划 6.3：不能用客户端参数决定数据作用域）。
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppConfig, Env } from './env';

export interface AppVariables {
  /** 每个请求的唯一 ID，用于关联日志与错误响应。 */
  requestId: string;
  /** 校验后的运行时配置（不含凭证值）。 */
  config: AppConfig;
  /** 由 write-guard 解析后的 JSON 请求体；未解析时为 undefined。 */
  jsonBody: unknown;
  /** 认证后的工作空间 ID；仅由 deviceAuth 中间件写入。 */
  workspaceId: string;
  /** 认证后的设备 ID；仅由 deviceAuth 中间件写入。 */
  deviceId: string;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };

export type AppContext = Context<AppBindings>;

export type AppMiddleware = MiddlewareHandler<AppBindings>;
