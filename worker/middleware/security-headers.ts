/**
 * 安全响应头与 CSP（HUB-004，规划 9.2）。
 *
 * 设计边界：
 * - 由 Worker 的顶层 fetch 统一施加，覆盖**所有**响应（含 500/404/静态资源），
 *   而不是只在 /api/* 上生效——否则同域静态页会缺少 CSP。
 * - CSP 刻意保持严格但可用：脚本只允许同源；样式允许 inline（React 内联样式需要），
 *   不用 `unsafe-eval`。开发环境不注入 upgrade-insecure-requests，避免本地 http 调试被升级破坏。
 * - 这里不涉及 XSS 清理策略本身：禁止把外站内容不经清理写入 innerHTML 是代码级约束（规划 9.2）。
 */
import type { EnvironmentName } from '../env';

/** 与请求无关的固定安全头。 */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // 阶段 01 不需要相机/麦克风/定位等任何能力，全部显式关闭。
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=(), serial=()',
};

/** 构造 CSP。`frame-ancestors 'none'` 与 X-Frame-Options: DENY 双重禁止被嵌入。 */
export function buildContentSecurityPolicy(environment: EnvironmentName): string {
  const directives: string[] = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // 仅图片可访问 HTTPS 站点；脚本、网络请求依然保持同源。图片请求无 Referer。
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    // HUB-012（ADR-0004 D10）：PWA 需要同域 manifest 与 Service Worker。
    // 这两条是**最小放行**——只允许同源的 `/manifest.webmanifest` 与 `/sw.js`，
    // 不涉及 `script-src`；任何人都不得为了「让 PWA 生效」而放宽 script-src 或加入 unsafe-eval。
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (environment === 'production' || environment === 'preview') {
    directives.push('upgrade-insecure-requests');
  }
  return directives.join('; ');
}

export interface SecurityHeaderOptions {
  readonly environment: EnvironmentName;
  /** 是否为 /api/* 响应。API 响应禁止被任何中间层缓存。 */
  readonly isApi: boolean;
  /** 是否启用 HSTS。仅在确定由 HTTPS 提供服务时设置。 */
  readonly enableHsts: boolean;
}

/**
 * 返回一个带安全头的**新** Response。
 * 不原地修改 `response.headers`：来自 `fetch()`（静态资源绑定）的 Response 头可能是不可变的。
 */
export function withSecurityHeaders(response: Response, options: SecurityHeaderOptions): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', buildContentSecurityPolicy(options.environment));
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (options.enableHsts) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (options.isApi) {
    headers.set('Cache-Control', 'no-store');
  }

  // 204/304 不允许携带响应体，构造时必须传 null。
  const status = response.status;
  const bodyAllowed = status !== 204 && status !== 304;
  return new Response(bodyAllowed ? response.body : null, {
    status,
    statusText: response.statusText,
    headers,
  });
}
