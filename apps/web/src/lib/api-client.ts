/**
 * API 客户端（HUB-004 契约在前端的唯一入口）。
 *
 * 安全前提（规划 6.3 / 9.2）：
 * - 设备 Token **只**通过 Authorization 头传递：绝不放进 URL query、绝不打进日志或分析系统。
 * - 阶段 01 不读取、不保存任何 Token（`getToken` 恒为空）；HUB-006 起改由 IndexedDB 提供，
 *   不使用 localStorage（降低 XSS 直接窃取凭证的收益，并配合严格 CSP）。
 * - 后端错误体已被服务端脱敏；这里对**非契约形状**的响应做兜底，
 *   不回显原始响应文本——否则服务端/中间层返回的 HTML 错误页会变成注入源。
 */
import { API_V1_PREFIX, REQUEST_ID_HEADER, type ApiErrorBody, type HealthResponse } from '@ff14-hub/shared';

export interface ApiClientOptions {
  /** API 基地址。默认空字符串，表示**同源**（ADR-001）。 */
  readonly baseUrl?: string;
  /** 设备凭证提供者。阶段 01 恒返回 null。 */
  readonly getToken?: () => string | null | Promise<string | null>;
  /** 便于测试注入；默认使用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: ApiErrorBody };

/** 网络层失败（未拿到任何 HTTP 响应）时的状态码约定。 */
export const NETWORK_FAILURE_STATUS = 0;

const NETWORK_FAILURE_ERROR: ApiErrorBody = {
  code: 'internal_error',
  message: '网络请求失败，请检查网络后重试。',
  requestId: 'client-network',
};

const MALFORMED_ERROR: ApiErrorBody = {
  code: 'internal_error',
  message: '服务器返回了无法识别的错误响应。',
  requestId: 'client-malformed',
};

const API_ERROR_CODES: readonly string[] = [
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
  'internal_error',
];

/**
 * 拼接 API 地址。
 * 只接受以 `/` 开头的路径，避免把外部绝对地址当成 API 目标（防误用与 SSRF 面扩大）。
 */
export function buildApiUrl(path: string, baseUrl = ''): string {
  if (!path.startsWith('/')) {
    throw new Error(`API 路径必须以 / 开头：${path}`);
  }
  if (baseUrl === '') {
    return path;
  }
  if (!baseUrl.startsWith('https://') && !baseUrl.startsWith('http://')) {
    throw new Error(`API baseUrl 必须是 http(s) 绝对地址：${baseUrl}`);
  }
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * 只接受符合共享契约的错误体；其余一律降级为固定文案。
 *
 * 阶段 04 起**保留 `details`**（可选）：并发冲突的结构化信息（`details.conflict`）必须能到达界面，
 * 否则界面只能解析文案来判断「服务器上是第几版」。`details` 本身由服务端保证只含可安全回显的字段，
 * 因此这里原样透传；不是对象时一律丢弃（避免把任意响应体当作结构化数据使用）。
 */
export function normalizeApiError(payload: unknown): ApiErrorBody {
  if (payload === null || typeof payload !== 'object') {
    return MALFORMED_ERROR;
  }
  const candidate = payload as Record<string, unknown>;
  const code = candidate['code'];
  const message = candidate['message'];
  const requestId = candidate['requestId'];
  if (
    typeof code === 'string' &&
    API_ERROR_CODES.includes(code) &&
    typeof message === 'string' &&
    message.length > 0 &&
    typeof requestId === 'string' &&
    requestId.length > 0
  ) {
    const details = candidate['details'];
    const hasDetails = typeof details === 'object' && details !== null;
    return {
      code: code as ApiErrorBody['code'],
      message,
      requestId,
      ...(hasDetails ? { details } : {}),
    };
  }
  return MALFORMED_ERROR;
}

export interface ApiClient {
  request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>>;
  health(): Promise<ApiResult<HealthResponse>>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? '';
  const doFetch = options.fetchImpl ?? fetch;

  async function resolveToken(): Promise<string | null> {
    if (options.getToken === undefined) {
      return null;
    }
    return await options.getToken();
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const url = buildApiUrl(path, baseUrl);
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();

    const token = await resolveToken();
    if (token !== null && token.length > 0) {
      // 只走请求头；绝不追加到 URL。
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await doFetch(url, { ...init, method, headers });
    } catch {
      return { ok: false, status: NETWORK_FAILURE_STATUS, error: NETWORK_FAILURE_ERROR };
    }

    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      const normalized = normalizeApiError(payload);
      const headerRequestId = response.headers.get(REQUEST_ID_HEADER);
      return {
        ok: false,
        status: response.status,
        error: headerRequestId !== null ? { ...normalized, requestId: headerRequestId } : normalized,
      };
    }

    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data };
  }

  return {
    request,
    health: () => request<HealthResponse>(`${API_V1_PREFIX}/health`),
  };
}
