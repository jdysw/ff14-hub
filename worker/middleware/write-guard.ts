/**
 * 写请求守卫（HUB-004）：Origin / Content-Type / 体积上限 / JSON 解析。
 *
 * 明确的安全边界（这是**纵深防御**，不是身份认证；认证由各路由的鉴权中间件负责）：
 * 1) Origin：若请求携带 Origin，则必须等于同源或落在 ALLOWED_ORIGINS 白名单内，否则 403。
 *    Origin 缺失时不拒绝——理由：本项目身份凭证走 Authorization 头，不是 ambient credential（Cookie），
 *    因此缺少 Origin 不构成 CSRF 通道；而 Tampermonkey 等非浏览器客户端也可能不带 Origin。
 *    通配符 "*" 在白名单解析阶段就被丢弃。
 * 2) Content-Type：带请求体的写请求必须是 application/json（或 +json），否则 415。
 *    这一条阻断了 HTML 表单与 fetch「简单请求」路径上的 CSRF 尝试。
 * 3) 体积：Content-Length 超过上限直接 413；同时**按实际读取字节数**再判一次，
 *    因为 Content-Length 可能缺失或撒谎（chunked 传输）。
 * 4) 解析后的 JSON 写入 `c.set('jsonBody', ...)`。注意：请求体在此已被消费，
 *    下游处理器必须读取 context 中的值，不得再调用 c.req.json()。
 */
import { ApiError, DEFAULT_ERROR_MESSAGE, MAX_JSON_BODY_BYTES, isWriteMethod } from '@ff14-hub/shared';
import type { AppMiddleware } from '../types';

/** 判断是否为 JSON 媒体类型（含 application/problem+json 这类 +json 后缀）。 */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const mediaType = (value.split(';')[0] ?? '').trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/** Origin 是否被允许：同源，或显式白名单项。 */
export function isAllowedOrigin(origin: string, requestUrl: string, allowed: readonly string[]): boolean {
  if (allowed.includes(origin)) {
    return true;
  }
  try {
    return new URL(origin).origin === new URL(requestUrl).origin;
  } catch {
    // 无法解析的 Origin 一律视为不允许（不猜测、不放行）。
    return false;
  }
}

export type BodyReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_large' };

/**
 * 按上限读取请求体。
 * 超过上限立刻取消流，避免继续为超大体分配内存。
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<BodyReadResult> {
  // 显式固定 reader 的元素类型：workers-types 下 getReader() 的泛型参数会被推断为 any，
  // 不固定会让后续每一处 chunk 访问都变成不安全操作。
  const reader = request.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

export function writeGuard(): AppMiddleware {
  return async (c, next) => {
    if (!isWriteMethod(c.req.method)) {
      await next();
      return;
    }

    const config = c.get('config');

    // (1) Origin 校验
    const origin = c.req.header('Origin');
    if (origin !== undefined && origin.trim().length > 0 && !isAllowedOrigin(origin, c.req.url, config.allowedOrigins)) {
      throw new ApiError('forbidden', DEFAULT_ERROR_MESSAGE.forbidden, `origin_rejected:${origin}`);
    }

    // (2) Content-Length 预检
    const contentLengthHeader = c.req.header('Content-Length');
    let declaredLength: number | undefined;
    if (contentLengthHeader !== undefined) {
      const parsed = Number.parseInt(contentLengthHeader, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new ApiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, 'invalid_content_length');
      }
      declaredLength = parsed;
      if (parsed > MAX_JSON_BODY_BYTES) {
        throw new ApiError('payload_too_large', DEFAULT_ERROR_MESSAGE.payload_too_large);
      }
    }

    const hasBody = c.req.raw.body !== null && (declaredLength === undefined || declaredLength > 0);
    if (!hasBody) {
      c.set('jsonBody', undefined);
      await next();
      return;
    }

    // (3) Content-Type 校验：必须 JSON
    if (!isJsonContentType(c.req.header('Content-Type'))) {
      throw new ApiError('unsupported_media_type', DEFAULT_ERROR_MESSAGE.unsupported_media_type);
    }

    // (4) 实际读取并按真实字节数再次限流
    const read = await readBodyWithLimit(c.req.raw, MAX_JSON_BODY_BYTES);
    if (!read.ok) {
      throw new ApiError('payload_too_large', DEFAULT_ERROR_MESSAGE.payload_too_large);
    }

    // (5) 解析 JSON；语法错误属于 400（形状合法但语义不合法才用 422）
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      throw new ApiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, 'invalid_json_syntax');
    }

    c.set('jsonBody', parsedBody);
    await next();
  };
}
