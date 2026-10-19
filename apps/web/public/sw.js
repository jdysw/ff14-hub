/*
 * FF14 Hub Service Worker（HUB-012 / ADR-0004 D10）——纯静态、无第三方依赖、无构建步骤。
 *
 * 只做三件事，仅此三件：
 *   1. 缓存**公开**静态资源与白名单公开目录（缓存名带版本号）；
 *   2. 离线回退（导航断网时给出缓存里的应用外壳；公开目录回退到上次的缓存副本）；
 *   3. 更新生命周期：install 只预缓存；**绝不**自动 `skipWaiting`——
 *      必须等页面通过 postMessage 明确确认后才激活，避免用户正在编辑草稿时被无提示重载。
 *
 * 隐私边界（硬约束，与 apps/web/src/app/pwa/cache-policy.ts 一一对应）：
 *   任何带 Authorization 的请求/响应、`/api/v1/me/*`、设备凭证、备份、个人活动、
 *   个人导航**一律不缓存**；非 GET、跨域、非 http(s)、非白名单路径一律不缓存。
 *   判断是「默认拒绝」：白名单是封闭枚举，不认识的路径/内容类型都不缓存。
 *
 * 为什么规则以明文 JSON 内联在这里：
 *   SW 是经典脚本，不能 import TS 模块；本项目又刻意不给它加构建步骤。
 *   因此下面的 `CACHE_POLICY_JSON` 是 `cache-policy.ts` 中 `CACHE_POLICY` 的
 *   **逐字节相同**副本（`JSON.stringify(CACHE_POLICY)`），
 *   `apps/web/test/pwa.spec.ts` 会同时做「字符串相等」与「行为等价」两组断言，
 *   任何一侧改动都会立刻让测试失败——清单不可能悄悄漂移。
 *
 * 注册与更新提示在 apps/web/src/app/pwa/register-service-worker.ts（页面侧）。
 */
'use strict';

/* --- BEGIN CACHE POLICY MIRROR（与 apps/web/src/app/pwa/cache-policy.ts 的 CACHE_POLICY 逐字节相同） --- */
const CACHE_POLICY_JSON =
  '{"version":"v1","cacheNamePrefix":"ff14-hub-public","offlineFallbackPath":"/index.html","cacheableStatus":200,"publicStaticExactPaths":["/","/index.html","/manifest.webmanifest","/favicon.svg"],"publicStaticPathPrefixes":["/assets/","/icons/"],"publicApiPaths":["/api/v1/health","/api/v1/modules/catalog","/api/v1/navigation/catalog","/api/v1/events"],"privatePathPrefixes":["/api/v1/me/","/api/v1/me"],"cacheableResponseContentTypes":["text/html","text/css","text/plain","text/javascript","application/javascript","application/json","application/manifest+json","image/","font/"],"sensitiveResponseContentTypes":["application/x-pem-file","application/pkcs8","application/x-pkcs12","application/pgp-keys","application/octet-stream","multipart/form-data","application/x-www-form-urlencoded"],"forbiddenCacheControlDirectives":["no-store","private"]}';
/* --- END CACHE POLICY MIRROR --- */

const CACHE_POLICY = JSON.parse(CACHE_POLICY_JSON);
const PUBLIC_CACHE_NAME = CACHE_POLICY.cacheNamePrefix + '-' + CACHE_POLICY.version;

/** 页面确认更新时发来的消息类型（页面侧同名常量，见 register-service-worker.ts）。 */
const SKIP_WAITING_MESSAGE = 'FF14_HUB_SKIP_WAITING';

/** 预缓存清单：直接复用策略里的公开静态精确路径，不另写一份。 */
function publicShellPaths() {
  return CACHE_POLICY.publicStaticExactPaths.slice();
}

function normalizeContentType(value) {
  if (typeof value !== 'string' || value === '') {
    return '';
  }
  return value.split(';')[0].trim().toLowerCase();
}

function matchesAnyPrefix(value, prefixes) {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function isNonPublicCacheName(name) {
  return name !== PUBLIC_CACHE_NAME;
}

/**
 * 与 cache-policy.ts 的 `shouldCacheRequest` 完全同构。
 * 入参：{ url, method, hasAuthorizationHeader, appOrigin }
 */
function shouldCacheRequest(request) {
  if (String(request.method).toUpperCase() !== 'GET') {
    return false;
  }
  if (request.hasAuthorizationHeader === true) {
    return false;
  }
  const appOrigin = request.appOrigin;
  if (typeof appOrigin !== 'string' || appOrigin.trim() === '') {
    return false;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  let expected;
  try {
    expected = new URL(appOrigin);
  } catch {
    return false;
  }
  if (url.origin !== expected.origin) {
    return false;
  }

  const pathname = url.pathname;
  if (matchesAnyPrefix(pathname, CACHE_POLICY.privatePathPrefixes)) {
    return false;
  }
  if (CACHE_POLICY.publicStaticExactPaths.indexOf(pathname) !== -1) {
    return true;
  }
  if (matchesAnyPrefix(pathname, CACHE_POLICY.publicStaticPathPrefixes)) {
    return true;
  }
  return CACHE_POLICY.publicApiPaths.indexOf(pathname) !== -1;
}

/**
 * 与 cache-policy.ts 的 `shouldCacheResponse` 完全同构。
 * 入参：{ status, contentType, cacheControl }
 */
function shouldCacheResponse(response) {
  if (response.status !== CACHE_POLICY.cacheableStatus) {
    return false;
  }
  const cacheControl = typeof response.cacheControl === 'string' ? response.cacheControl.toLowerCase() : '';
  for (const directive of CACHE_POLICY.forbiddenCacheControlDirectives) {
    if (cacheControl.indexOf(directive) !== -1) {
      return false;
    }
  }
  const contentType = normalizeContentType(response.contentType);
  if (contentType === '') {
    return false;
  }
  if (matchesAnyPrefix(contentType, CACHE_POLICY.sensitiveResponseContentTypes)) {
    return false;
  }
  return matchesAnyPrefix(contentType, CACHE_POLICY.cacheableResponseContentTypes);
}

/** 把真实的 Request/Response 描述成策略函数认识的纯数据。 */
function describeRequest(request) {
  return {
    url: request.url,
    method: request.method,
    hasAuthorizationHeader: request.headers.has('Authorization'),
    appOrigin: self.location.origin,
  };
}

function describeResponse(response) {
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type'),
    cacheControl: response.headers.get('Cache-Control'),
  };
}

function isPublicApiPath(pathname) {
  return CACHE_POLICY.publicApiPaths.indexOf(pathname) !== -1;
}

/**
 * 只有同时通过请求与响应策略才写入缓存。
 * 预缓存路径也走这里——「路径来自常量」不是绕过响应检查的理由。
 */
async function putIfPolicyAllows(cache, request, response) {
  if (!shouldCacheRequest(describeRequest(request))) {
    return false;
  }
  if (!shouldCacheResponse(describeResponse(response))) {
    return false;
  }
  await cache.put(request, response);
  return true;
}

/** install 阶段的预缓存：单个资源失败不影响整体安装（install 失败会让 PWA 一直停在旧版本）。 */
async function precachePublicShell() {
  const cache = await caches.open(PUBLIC_CACHE_NAME);
  await Promise.all(
    publicShellPaths().map(async (path) => {
      try {
        const request = new Request(new URL(path, self.location.origin).toString(), {
          method: 'GET',
          credentials: 'omit',
        });
        const response = await fetch(request);
        await putIfPolicyAllows(cache, request, response.clone());
      } catch {
        // 预缓存是「尽力而为」：缺一个图标不该让 SW 装不上。
      }
    }),
  );
}

/**
 * 公开请求的处理策略。
 * - 公开目录数据（JSON）：网络优先，失败回退缓存副本——离线时仍能看到上次的公开目录。
 * - 首页 HTML（/、/index.html）：在线网络优先，离线才使用旧外壳，避免持久显示过期的前端。
 * - 其它指纹静态资源：缓存优先，命中后后台刷新（不阻塞响应）。
 */
async function respondWithPublicStrategy(request) {
  const cache = await caches.open(PUBLIC_CACHE_NAME);
  const cached = await cache.match(request);
  const pathname = new URL(request.url).pathname;

  // 首页 HTML 不是带哈希的不可变资源，必须网络优先。
  // 缓存优先会令发布后用户持续读到上个版本的首页（例如旧的「连接工作空间」提示）。
  if (isPublicApiPath(pathname) || pathname === '/' || pathname === '/index.html') {
    try {
      const response = await fetch(request);
      await putIfPolicyAllows(cache, request, response.clone());
      return response;
    } catch (error) {
      if (cached !== undefined) {
        return cached;
      }
      throw error;
    }
  }

  if (cached !== undefined) {
    // 后台刷新：用的是同一份策略，失败就保持旧副本（离线场景下这是常态）。
    fetch(request)
      .then((response) => putIfPolicyAllows(cache, request, response.clone()))
      .catch(() => undefined);
    return cached;
  }

  const response = await fetch(request);
  await putIfPolicyAllows(cache, request, response.clone());
  return response;
}

/** 导航请求（页面路由）断网时的回退：返回缓存里的应用外壳。 */
async function respondWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(PUBLIC_CACHE_NAME);
    const shell = await cache.match(CACHE_POLICY.offlineFallbackPath);
    if (shell !== undefined) {
      return shell;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 生命周期：install / activate / fetch / message（仅此四类事件，没有别的副作用）
// ---------------------------------------------------------------------------

/**
 * 页面请求「把当前这版资源补进缓存」的消息类型。
 *
 * 为什么需要它：`install` 时能预缓存的只有非指纹资源（`/`、`/index.html`、
 * `/manifest.webmanifest`、`/favicon.svg`）；`/assets/*` 带内容哈希，**SW 在首次安装时
 * 根本不知道这一版的文件名**。结果就是「首访后立刻离线 → 外壳在、JS 不在 → 白屏」。
 * 因此页面受控后把当前文档真实加载过的资源清单发过来，由 SW 逐条按**同一份策略**过滤后缓存。
 */
const CACHE_URLS_MESSAGE = 'FF14_HUB_CACHE_URLS';

/** 上限：一次最多补多少条（防止畸形消息把缓存打爆）。 */
const CACHE_URLS_LIMIT = 80;

self.addEventListener('install', (event) => {
  // 刻意**不**在这里调用 skipWaiting()：更新必须由用户在页面上确认，
  // 否则一次自动激活加一次自动重载会丢掉正在编辑的草稿（D10）。
  event.waitUntil(precachePublicShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清理旧版本（含任何非当前公开缓存名）：默认安全，不认识的名字一律删除。
      const names = await caches.keys();
      await Promise.all(names.filter(isNonPublicCacheName).map((name) => caches.delete(name)));
      // 让当前页面立刻受控，避免「首次访问必须刷新一次才有离线能力」。
      // 这只是接管请求，不会重载页面，因此不会打断编辑。
      if (self.clients !== undefined && typeof self.clients.claim === 'function') {
        await self.clients.claim();
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (shouldCacheRequest(describeRequest(request))) {
    event.respondWith(respondWithPublicStrategy(request));
    return;
  }
  // 只有导航请求才做离线回退；写请求（POST/PUT/PATCH/DELETE）一律交给浏览器，
  // SW 绝不介入私有数据的读写，离线时它们会正常失败而不是「假装成功」。
  if (request.method === 'GET' && request.mode === 'navigate') {
    event.respondWith(respondWithOfflineFallback(request));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === null || typeof data !== 'object') {
    return;
  }
  if (data.type === SKIP_WAITING_MESSAGE) {
    // 到这里说明页面已经**明确确认**（用户点了「立即更新」且没有未保存草稿）。
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (data.type === CACHE_URLS_MESSAGE) {
    event.waitUntil(cacheReportedUrls(data.urls));
  }
});

/**
 * 把页面报上来的资源补进公开缓存。
 *
 * 安全边界（与 fetch 路径**同一份**策略，不是第二套）：
 * - 只接受字符串、只接受同源 http(s)、最多 `CACHE_URLS_LIMIT` 条；
 * - 每条都要先过 `shouldCacheRequest`（默认拒绝：会挡掉 `/api/v1/me/*`、带 Authorization、
 *   非白名单路径等），响应再过 `shouldCacheResponse`（非 200 / no-store / 敏感类型都拒绝）；
 * - 任何一条失败只记录，不影响其它条目，也不抛错给页面。
 */
async function cacheReportedUrls(urls) {
  if (!Array.isArray(urls)) {
    return;
  }
  const cache = await caches.open(PUBLIC_CACHE_NAME);
  const seen = new Set();
  let handled = 0;
  for (const raw of urls) {
    if (handled >= CACHE_URLS_LIMIT) {
      return;
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
      continue;
    }
    let url;
    try {
      url = new URL(raw, self.location.origin);
    } catch {
      continue;
    }
    if (url.origin !== self.location.origin || seen.has(url.pathname + url.search)) {
      continue;
    }
    seen.add(url.pathname + url.search);
    handled += 1;
    const request = new Request(url.toString(), { method: 'GET', credentials: 'same-origin' });
    if (!shouldCacheRequest(describeRequest(request))) {
      continue;
    }
    try {
      const response = await fetch(request);
      await putIfPolicyAllows(cache, request, response);
    } catch {
      // 单个资源失败（离线、404）不影响其它资源；这里刻意不抛出。
    }
  }
}

/**
 * 仅供单测读取的自检出口：SW 全局作用域之外不可见，不改变任何生产行为。
 * 测试用它来验证「sw.js 内的判断与 cache-policy.ts 完全一致」。
 */
self.__FF14_HUB_SW__ = {
  CACHE_POLICY,
  CACHE_POLICY_JSON,
  PUBLIC_CACHE_NAME,
  SKIP_WAITING_MESSAGE,
  isNonPublicCacheName,
  shouldCacheRequest,
  shouldCacheResponse,
};
self.addEventListener('push', (event) => {
  let message = {};
  try { const parsed = event.data?.json(); message = parsed !== null && typeof parsed === 'object' ? parsed : {}; } catch { /* Empty or malformed payload uses safe text. */ }
  const text = (value, fallback, limit) => typeof value === 'string' ? value.slice(0, limit) : fallback;
  event.waitUntil(self.registration.showNotification(text(message.title, 'FF14 Hub 提醒', 80), {
    body: text(message.body, '请打开提醒管理查看。', 200),
    tag: text(message.tag, 'ff14-hub-reminder', 100),
    data: { url: '/?view=reminders' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Never navigate to a URL supplied by the push payload.
  event.waitUntil(self.clients.openWindow('/?view=reminders'));
});
