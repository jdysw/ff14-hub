/**
 * PWA 缓存策略（HUB-012 / ADR-0004 D10）——**纯函数**，无副作用、不读全局。
 *
 * 为什么单独一个模块：
 * - 缓存是否放行是隐私边界（D10「绝不缓存 Authorization / `/api/v1/me/*`」），
 *   必须可单测、可被 Service Worker 复用，而不是散落在 `sw.js` 的 if 里各写一份。
 * - `apps/web/public/sw.js` 只能以明文常量内联同一份清单（SW 无法 import TS 模块，
 *   且这里刻意不引入构建步骤）。因此本文件的 `CACHE_POLICY` 对象就是「唯一事实来源」，
 *   `sw.js` 里 `CACHE_POLICY_JSON` 必须是 `JSON.stringify(CACHE_POLICY)` 的**逐字节相同**副本，
 *   由 `apps/web/test/pwa.spec.ts` 的一致性断言把两侧钉死（改一侧必然让测试失败）。
 *
 * 两个硬约束：
 * 1. **默认拒绝**：任何一条判断不通过就不缓存；白名单是封闭枚举，不认识的路径/类型一律不缓存。
 * 2. 本文件不读写任何凭证：只接收调用方给出的 `hasAuthorizationHeader` 布尔值，
 *   绝不接触 token / Cookie / localStorage。
 */

/** 缓存名前缀（版本号单独拼接，便于 `activate` 按名字清理旧版本）。 */
export const CACHE_NAME_PREFIX = 'ff14-hub-public';

/** 缓存策略版本：清单语义变化时必须同步提升，从而让旧缓存被 `activate` 清掉。 */
export const CACHE_VERSION = 'v2';

/** 当前公开缓存名（`activate` 只保留这一个，其余名字一律删除）。 */
export const PUBLIC_CACHE_NAME = `${CACHE_NAME_PREFIX}-${CACHE_VERSION}`;

/** 只有 200 会被缓存：401/403/404/5xx 缓存下来只会把错误固化并泄露存在性。 */
export const CACHEABLE_STATUS = 200;

/** 精确匹配的公开静态资源（`/` 只匹配根路径本身，不会变成「前缀放行一切」）。 */
export const PUBLIC_STATIC_EXACT_PATHS: readonly string[] = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/fishing/catalog-cn.json',
  '/fishing/catalog-global.json',
];

/** 前缀匹配的公开静态资源目录。 */
export const PUBLIC_STATIC_PATH_PREFIXES: readonly string[] = ['/assets/', '/icons/'];

/** 白名单公开目录（无凭证的只读目录端点）；其余 API 一律不缓存。 */
export const PUBLIC_API_PATHS: readonly string[] = [
  '/api/v1/health',
  '/api/v1/modules/catalog',
  '/api/v1/navigation/catalog',
  '/api/v1/events',
];

/**
 * 私有路径前缀。`/api/v1/me/` 覆盖全部子路径（profile/devices/modules/pages/widgets/
 * workbench/navigation/events/sync…），`/api/v1/me` 覆盖不带斜杠的端点本身。
 * 前缀判定刻意比「带斜杠」稍宽（例如 `/api/v1/metadata` 也会被拒）——多拒是安全的，
 * 少拒才是漏洞，这与「默认拒绝」一致。
 */
export const PRIVATE_PATH_PREFIXES: readonly string[] = ['/api/v1/me/', '/api/v1/me'];

/** 可缓存的内容类型（闭合白名单）：只有公开静态资源与公开目录端点会产出这些类型。 */
export const CACHEABLE_RESPONSE_CONTENT_TYPES: readonly string[] = [
  'text/html',
  'text/css',
  'text/plain',
  'text/javascript',
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'image/',
  'font/',
];

/**
 * 敏感内容类型（显式拒绝，且优先于可缓存白名单判定）：
 * 私钥/证书容器、PGP 私钥、以及无法判断内容的二进制负载（备份导出可能落到这里）。
 */
export const SENSITIVE_RESPONSE_CONTENT_TYPES: readonly string[] = [
  'application/x-pem-file',
  'application/pkcs8',
  'application/x-pkcs12',
  'application/pgp-keys',
  'application/octet-stream',
  'multipart/form-data',
  'application/x-www-form-urlencoded',
];

/** 出现这些 `Cache-Control` 指令的响应一律不缓存（服务端已明确要求不落地）。 */
export const FORBIDDEN_CACHE_CONTROL_DIRECTIVES: readonly string[] = ['no-store', 'private'];

/** 离线时的回退文档（导航请求断网时用缓存里的应用外壳兜底）。 */
export const OFFLINE_FALLBACK_PATH = '/index.html';

export interface CachePolicySnapshot {
  readonly version: string;
  readonly cacheNamePrefix: string;
  readonly offlineFallbackPath: string;
  readonly cacheableStatus: number;
  readonly publicStaticExactPaths: readonly string[];
  readonly publicStaticPathPrefixes: readonly string[];
  readonly publicApiPaths: readonly string[];
  readonly privatePathPrefixes: readonly string[];
  readonly cacheableResponseContentTypes: readonly string[];
  readonly sensitiveResponseContentTypes: readonly string[];
  readonly forbiddenCacheControlDirectives: readonly string[];
}

/**
 * 唯一事实来源。**键顺序即 `JSON.stringify` 顺序**，必须与 `sw.js` 里的
 * `CACHE_POLICY_JSON` 完全一致（测试逐字节比对）。
 */
export const CACHE_POLICY: CachePolicySnapshot = {
  version: CACHE_VERSION,
  cacheNamePrefix: CACHE_NAME_PREFIX,
  offlineFallbackPath: OFFLINE_FALLBACK_PATH,
  cacheableStatus: CACHEABLE_STATUS,
  publicStaticExactPaths: PUBLIC_STATIC_EXACT_PATHS,
  publicStaticPathPrefixes: PUBLIC_STATIC_PATH_PREFIXES,
  publicApiPaths: PUBLIC_API_PATHS,
  privatePathPrefixes: PRIVATE_PATH_PREFIXES,
  cacheableResponseContentTypes: CACHEABLE_RESPONSE_CONTENT_TYPES,
  sensitiveResponseContentTypes: SENSITIVE_RESPONSE_CONTENT_TYPES,
  forbiddenCacheControlDirectives: FORBIDDEN_CACHE_CONTROL_DIRECTIVES,
};

/**
 * 请求判定输入。
 *
 * `appOrigin` 刻意必填（可为 null）：纯函数不能去读 `self.location`，
 * 而没有「应用自身的来源」就无法区分同域与跨域。传 null/空串表示「无法证明同域」，
 * 按默认拒绝处理。
 */
export interface CacheRequestDescriptor {
  readonly url: string;
  readonly method: string;
  readonly hasAuthorizationHeader: boolean;
  readonly appOrigin: string | null;
}

/** 响应判定输入。 */
export interface CacheResponseDescriptor {
  readonly status: number;
  readonly contentType: string | null;
  readonly cacheControl: string | null;
}

function normalizeContentType(contentType: string | null): string {
  if (contentType === null) {
    return '';
  }
  const [base] = contentType.split(';');
  return (base ?? '').trim().toLowerCase();
}

function matchesAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/** 路径是否属于「绝不缓存」的私有域。 */
export function isPrivatePath(pathname: string): boolean {
  return matchesAnyPrefix(pathname, PRIVATE_PATH_PREFIXES);
}

function isAllowedPublicPath(pathname: string): boolean {
  if (PUBLIC_STATIC_EXACT_PATHS.includes(pathname)) {
    return true;
  }
  if (matchesAnyPrefix(pathname, PUBLIC_STATIC_PATH_PREFIXES)) {
    return true;
  }
  return PUBLIC_API_PATHS.includes(pathname);
}

/**
 * 该请求是否允许进入缓存。任一条不满足即拒绝（默认拒绝）：
 * 非 GET、带 Authorization、非 http(s)、跨域、无法解析的 URL、私有路径、不在白名单。
 */
export function shouldCacheRequest(request: CacheRequestDescriptor): boolean {
  if (request.method.toUpperCase() !== 'GET') {
    return false;
  }
  if (request.hasAuthorizationHeader) {
    return false;
  }
  const appOrigin = request.appOrigin;
  if (appOrigin === null || appOrigin.trim() === '') {
    return false;
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  let expected: URL;
  try {
    expected = new URL(appOrigin);
  } catch {
    return false;
  }
  if (url.origin !== expected.origin) {
    return false;
  }

  const pathname = url.pathname;
  if (isPrivatePath(pathname)) {
    return false;
  }
  return isAllowedPublicPath(pathname);
}

/**
 * 该响应是否允许写入缓存。任一条不满足即拒绝：
 * 非 200、`Cache-Control` 含 no-store/private、缺失或不在白名单的内容类型、敏感内容类型。
 */
export function shouldCacheResponse(response: CacheResponseDescriptor): boolean {
  if (response.status !== CACHEABLE_STATUS) {
    return false;
  }
  const cacheControl = (response.cacheControl ?? '').toLowerCase();
  if (FORBIDDEN_CACHE_CONTROL_DIRECTIVES.some((directive) => cacheControl.includes(directive))) {
    return false;
  }
  const contentType = normalizeContentType(response.contentType);
  if (contentType === '') {
    return false;
  }
  if (matchesAnyPrefix(contentType, SENSITIVE_RESPONSE_CONTENT_TYPES)) {
    return false;
  }
  return matchesAnyPrefix(contentType, CACHEABLE_RESPONSE_CONTENT_TYPES);
}

/** 是否为当前的公开缓存。 */
export function isPublicCacheName(name: string): boolean {
  return name === PUBLIC_CACHE_NAME;
}

/**
 * 是否为「非公开」缓存名。
 *
 * 命名上刻意不说「私有」：我们无法枚举将来的缓存名，而判断必须默认安全——
 * 任何不是当前公开缓存的名字（历史版本、其它功能的缓存、旧版私有缓存）都算非公开。
 */
export function isNonPublicCacheName(name: string): boolean {
  return !isPublicCacheName(name);
}

/**
 * 从现存缓存名中选出要删除的那些。
 *
 * 用途有两个，语义一致：`activate` 清理旧版本，登出/切换凭证时清理私有相关缓存。
 * 当前公开缓存**始终保留**（它按策略只含公开内容，删掉只会让离线体验退化）。
 */
export function selectCachesToClear(existingCacheNames: readonly string[]): readonly string[] {
  return existingCacheNames.filter((name) => isNonPublicCacheName(name));
}
