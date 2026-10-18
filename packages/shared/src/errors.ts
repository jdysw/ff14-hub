/**
 * 统一 API 错误契约（规划 6 节）。
 *
 * 安全前提：
 * - 对外错误对象**只有** code / message / requestId 三个字段，绝不包含堆栈、SQL、绑定名、凭证或内部路径。
 * - message 面向调用方，只能写稳定、可公开的说明；详细原因只能写服务端日志，并且日志也要脱敏。
 * - 错误码是契约的一部分：新增码必须同步这里与 worker 的错误映射，不能只在路由里临时写字符串。
 */
import { z } from 'zod';

/** 所有对外可见的错误码。使用 snake_case，便于跨语言与前端判别。 */
export const API_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'validation_failed',
  'rate_limited',
  'conflict',
  'not_implemented',
  'service_unavailable',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 错误码 → HTTP 状态码的唯一映射。路由不得自行决定状态码。 */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  rate_limited: 429,
  conflict: 409,
  not_implemented: 501,
  service_unavailable: 503,
  internal_error: 500,
};

export const apiErrorBodySchema = z.object({
  code: z.enum(API_ERROR_CODES),
  message: z.string().min(1).max(500),
  requestId: z.string().min(1).max(128),
  /**
   * 可选的结构化细节（阶段 04 起）。
   *
   * 用途只有一个：让**并发冲突**可被客户端程序化处理（哪个实体、哪个字段、
   * 本地基数与服务器当前 revision、可选的处理方式），而不是逼客户端解析 message 文案。
   *
   * 硬约束：调用方必须只放「可安全回显」的字段——不得放凭证、Token、SQL、内部路径。
   * 省略时该键**不存在**于响应体（保持阶段 01–03 的既有响应形状不变）。
   */
  details: z.unknown().optional(),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/**
 * 服务端内部使用的错误类型。路由抛出它，由统一错误中间件转换成 ApiErrorBody。
 *
 * `logDetail` 只允许写入服务端日志，绝不进入响应体。
 * 为杜绝「顺手 JSON.stringify(error) 就泄露诊断细节」这类意外，它被实现为
 * **ES 私有字段**而不是普通类字段：私有字段不参与 JSON.stringify / 对象展开。
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** 可安全回显的结构化细节（见 `apiErrorBodySchema.details`）；undefined 时响应体不含该键。 */
  readonly details: unknown;
  readonly #logDetail: string | undefined;

  constructor(code: ApiErrorCode, message: string, logDetail?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = HTTP_STATUS_BY_ERROR_CODE[code];
    this.details = details;
    this.#logDetail = logDetail;
  }

  /** 内部诊断提示；不序列化到响应，通用错误处理器也不直接记录原文。 */
  get logDetail(): string | undefined {
    return this.#logDetail;
  }
}

/** 面向调用方的默认文案。刻意保持笼统，避免通过错误信息探测内部状态。 */
export const DEFAULT_ERROR_MESSAGE: Readonly<Record<ApiErrorCode, string>> = {
  bad_request: '请求无法处理。',
  unauthorized: '需要有效的设备凭证。',
  forbidden: '请求来源不被允许。',
  not_found: '资源不存在。',
  method_not_allowed: '该路径不支持此 HTTP 方法。',
  payload_too_large: '请求体超过允许大小。',
  unsupported_media_type: '请求体必须为 application/json。',
  validation_failed: '请求参数校验失败。',
  rate_limited: '请求过于频繁，请稍后重试。',
  conflict: '资源状态冲突。',
  not_implemented: '该功能尚未在本次阶段实现。',
  service_unavailable: '服务尚未完成部署配置，暂时不可用。',
  internal_error: '服务器内部错误。',
};
