/**
 * HUB-012（PWA / ADR-0004 D10）单测。
 *
 * 覆盖四块：
 * 1. `cache-policy.ts` 的每个拒绝分支与允许分支（默认拒绝，白名单封闭）。
 * 2. `sw.js` 与策略**一一对应**：JSON 清单逐字节相等 + 真实执行 sw.js 的行为等价断言，
 *    以及「install 不自动 skipWaiting」「fetch 不介入私有请求」这两条硬约束。
 * 3. `install-state.ts` 的离线 / 可安装 / 更新提示分支（不得暗示私有写已保存）。
 * 4. `register-service-worker.ts` 在没有 `navigator.serviceWorker` 时安全降级（不抛错、不阻塞渲染），
 *    以及「有草稿就不激活更新」与 `clearPrivateCaches()` 的缓存清理行为。
 */
// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_POLICY,
  PRIVATE_PATH_PREFIXES,
  PUBLIC_API_PATHS,
  PUBLIC_CACHE_NAME,
  PUBLIC_STATIC_EXACT_PATHS,
  PUBLIC_STATIC_PATH_PREFIXES,
  isNonPublicCacheName,
  isPublicCacheName,
  isPrivatePath,
  selectCachesToClear,
  shouldCacheRequest,
  shouldCacheResponse,
  type CacheRequestDescriptor,
  type CacheResponseDescriptor,
} from '../src/app/pwa/cache-policy';
import {
  OFFLINE_DISCLOSURE,
  resolveInstallState,
  resolveOfflineState,
  resolveUpdatePromptState,
} from '../src/app/pwa/install-state';
import {
  SERVICE_WORKER_URL,
  SKIP_WAITING_MESSAGE,
  clearPrivateCaches,
  getServiceWorkerHandle,
  observeOfflineState,
  registerServiceWorker,
} from '../src/app/pwa/register-service-worker';

afterEach(() => {
  // 清理本用例装的 self / caches / fetch stub，并丢弃它加载的 sw.js 模块实例，
  // 保证下一个用例从一个干净的模块注册表开始（不残留任何事件处理器）。
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 读取真实产物：apps/web/public/sw.js
//
// 这里读到的源码文本**只用于「文本级」断言**（内联 JSON 逐字节相等、不出现手写 API 路径）。
// 行为断言一律走 loadServiceWorker() 的动态 import，不再把源码字符串交给动态求值。
// ---------------------------------------------------------------------------

const SW_CANDIDATES = [join(process.cwd(), 'public', 'sw.js'), join(process.cwd(), 'apps', 'web', 'public', 'sw.js')];
const swPath = SW_CANDIDATES.find((candidate) => existsSync(candidate));
if (swPath === undefined) {
  throw new Error(`找不到 sw.js，已尝试：${SW_CANDIDATES.join(' / ')}`);
}
const SW_SOURCE = readFileSync(swPath, 'utf8');

const APP_ORIGIN = 'https://ff14-hub.test';

function requestDescriptor(path: string, overrides: Partial<CacheRequestDescriptor> = {}): CacheRequestDescriptor {
  return {
    url: `${APP_ORIGIN}${path}`,
    method: 'GET',
    hasAuthorizationHeader: false,
    appOrigin: APP_ORIGIN,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 请求放行判断
// ---------------------------------------------------------------------------

describe('cache-policy：shouldCacheRequest 允许清单（默认拒绝里唯一的开口）', () => {
  it.each([...PUBLIC_STATIC_EXACT_PATHS])('允许公开静态精确路径 %s', (path) => {
    expect(shouldCacheRequest(requestDescriptor(path))).toBe(true);
  });

  it.each(PUBLIC_STATIC_PATH_PREFIXES.map((prefix) => `${prefix}example-file.js`))(
    '允许公开静态前缀路径 %s',
    (path) => {
      expect(shouldCacheRequest(requestDescriptor(path))).toBe(true);
    },
  );

  it.each([...PUBLIC_API_PATHS])('允许白名单公开目录 %s', (path) => {
    expect(shouldCacheRequest(requestDescriptor(path))).toBe(true);
  });

  it('白名单公开目录带查询串时仍按 pathname 判定', () => {
    expect(shouldCacheRequest(requestDescriptor('/api/v1/events?since=0&limit=20'))).toBe(true);
  });
});

describe('cache-policy：shouldCacheRequest 拒绝清单', () => {
  it('拒绝任何带 Authorization 的请求（公开路径也不例外）', () => {
    for (const path of ['/', '/assets/app.js', ...PUBLIC_API_PATHS]) {
      expect(shouldCacheRequest(requestDescriptor(path, { hasAuthorizationHeader: true })), path).toBe(false);
    }
  });

  it.each([
    ...PRIVATE_PATH_PREFIXES,
    '/api/v1/me/profile',
    '/api/v1/me/devices',
    '/api/v1/me/modules',
    '/api/v1/me/pages',
    '/api/v1/me/widgets',
    '/api/v1/me/workbench',
    '/api/v1/me/navigation',
    '/api/v1/me/events',
    '/api/v1/me/sync',
    '/api/v1/me/sync/changes?since=0',
  ])('拒绝私有路径 %s', (path) => {
    expect(shouldCacheRequest(requestDescriptor(path))).toBe(false);
    expect(isPrivatePath(new URL(`${APP_ORIGIN}${path}`).pathname)).toBe(true);
  });

  it('私有前缀清单必须显式包含 /api/v1/me/（含全部子路径）', () => {
    expect(PRIVATE_PATH_PREFIXES).toContain('/api/v1/me/');
    expect(PRIVATE_PATH_PREFIXES).toContain('/api/v1/me');
  });

  it('前缀判定刻意偏严：/api/v1/metadata 之类也被拒（多拒是安全的）', () => {
    expect(shouldCacheRequest(requestDescriptor('/api/v1/metadata'))).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('只允许 GET：拒绝 %s', (method) => {
    expect(shouldCacheRequest(requestDescriptor('/assets/app.js', { method }))).toBe(false);
  });

  it('方法大小写不敏感：小写 get 仍是 GET', () => {
    expect(shouldCacheRequest(requestDescriptor('/assets/app.js', { method: 'get' }))).toBe(true);
  });

  it('拒绝跨域请求', () => {
    expect(shouldCacheRequest(requestDescriptor('/assets/app.js', { url: 'https://evil.example/assets/app.js' }))).toBe(
      false,
    );
    // 同 host 但协议不同（https → http）同样算跨域。
    expect(shouldCacheRequest(requestDescriptor('/', { url: `http://ff14-hub.test/` }))).toBe(false);
  });

  it.each(['file:///etc/passwd', 'chrome-extension://abcdef/page.html', 'data:text/html,hi', 'blob:https://x/y'])(
    '拒绝非 http(s) 协议 %s',
    (url) => {
      expect(shouldCacheRequest(requestDescriptor('/', { url }))).toBe(false);
    },
  );

  it('拒绝无法解析的 URL 与缺失/空的 appOrigin（无法证明同域即拒绝）', () => {
    expect(shouldCacheRequest(requestDescriptor('/', { url: 'not-a-url' }))).toBe(false);
    expect(shouldCacheRequest(requestDescriptor('/', { appOrigin: null }))).toBe(false);
    expect(shouldCacheRequest(requestDescriptor('/', { appOrigin: '' }))).toBe(false);
    expect(shouldCacheRequest(requestDescriptor('/', { appOrigin: '   ' }))).toBe(false);
    expect(shouldCacheRequest(requestDescriptor('/', { appOrigin: 'not-an-origin' }))).toBe(false);
  });

  it.each([
    '/api/v1/identity/bootstrap',
    '/api/v1/identity/pairing',
    '/api/v1/unknown',
    '/workbench',
    '/settings/backup',
    '/assets/../api/v1/me/profile',
  ])('拒绝不在白名单的路径 %s', (path) => {
    expect(shouldCacheRequest(requestDescriptor(path))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 响应放行判断
// ---------------------------------------------------------------------------

describe('cache-policy：shouldCacheResponse', () => {
  it.each(['text/html', 'text/css', 'application/javascript; charset=utf-8', 'application/json', 'application/manifest+json', 'image/png', 'font/woff2'])(
    '允许公开内容类型 %s',
    (contentType) => {
      expect(shouldCacheResponse({ status: 200, contentType, cacheControl: null })).toBe(true);
    },
  );

  it.each([201, 204, 206, 301, 302, 304, 400, 401, 403, 404, 409, 500, 503])('拒绝非 200 状态 %s', (status) => {
    expect(shouldCacheResponse({ status, contentType: 'text/html', cacheControl: null })).toBe(false);
  });

  it.each(['no-store', 'no-store, max-age=0', 'private', 'private, max-age=600', 'PRIVATE'])(
    '拒绝服务端要求不落地的 Cache-Control：%s',
    (cacheControl) => {
      expect(shouldCacheResponse({ status: 200, contentType: 'text/html', cacheControl })).toBe(false);
    },
  );

  it('允许普通的可缓存指令', () => {
    expect(shouldCacheResponse({ status: 200, contentType: 'text/html', cacheControl: 'public, max-age=60' })).toBe(true);
    expect(shouldCacheResponse({ status: 200, contentType: 'image/png', cacheControl: 'max-age=86400' })).toBe(true);
  });

  it.each([
    'application/octet-stream',
    'application/x-pem-file',
    'application/pkcs8',
    'application/x-pkcs12',
    'application/pgp-keys',
    'multipart/form-data',
    'application/x-www-form-urlencoded',
  ])('拒绝敏感内容类型 %s', (contentType) => {
    expect(shouldCacheResponse({ status: 200, contentType, cacheControl: null })).toBe(false);
  });

  it.each([null, '', '   ', 'application/zip', 'text/event-stream', 'video/mp4'])(
    '拒绝缺失或未知（封闭白名单外）的内容类型：%s',
    (contentType) => {
      expect(shouldCacheResponse({ status: 200, contentType, cacheControl: null })).toBe(false);
    },
  );
});

describe('cache-policy：缓存名与清理选择', () => {
  it('公开缓存名带版本号', () => {
    expect(PUBLIC_CACHE_NAME).toBe('ff14-hub-public-v2');
    expect(isPublicCacheName('ff14-hub-public-v2')).toBe(true);
    expect(isPublicCacheName('ff14-hub-public-v0')).toBe(false);
    expect(isNonPublicCacheName('ff14-hub-private')).toBe(true);
  });

  it('selectCachesToClear 只保留当前公开缓存', () => {
    const existing = ['ff14-hub-public-v2', 'ff14-hub-public-v0', 'ff14-hub-private', 'ff14-hub-me'];
    expect(selectCachesToClear(existing)).toEqual(['ff14-hub-public-v0', 'ff14-hub-private', 'ff14-hub-me']);
    expect(selectCachesToClear([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. sw.js 与策略的一致性（文本 + 真实执行）
//
// 为什么不再把 sw.js 源码交给 vm 动态求值：
// ① 安全热点：把源码字符串交给 vm 执行属于「动态执行代码」（SonarCloud S1523），
//    质量门要求新代码 0 Security Hotspots；改成模块 import 后没有任何字符串求值。
// ② 语义更接近真实：浏览器装载 Service Worker 本来就是「把 sw.js 当脚本执行、在全局作用域里
//    读写 self / caches / fetch」。这里直接执行真实产物，比自造一套 vm 沙箱更接近 worker 语义。
// ③ 每个用例独立模块实例：每次加载前 vi.resetModules() + 递增查询串，让 sw.js 在每个用例里
//    重新执行一次；事件处理器只挂到**该用例自己的** self stub 上，用例之间不会串台。
// ---------------------------------------------------------------------------

interface SwApi {
  readonly CACHE_POLICY: unknown;
  readonly CACHE_POLICY_JSON: string;
  readonly PUBLIC_CACHE_NAME: string;
  readonly SKIP_WAITING_MESSAGE: string;
  readonly isNonPublicCacheName: (name: string) => boolean;
  readonly shouldCacheRequest: (request: CacheRequestDescriptor) => boolean;
  readonly shouldCacheResponse: (response: CacheResponseDescriptor) => boolean;
}

interface SwSandbox {
  readonly notifications: {title:string;options:Record<string,unknown>}[];
  readonly openedUrls: string[];
  readonly sw: SwApi;
  readonly handlers: Map<string, ((event: unknown) => void)[]>;
  readonly deletedCaches: string[];
  readonly cacheKeys: string[];
  readonly skipWaitingCalls: () => number;
  readonly claimCalls: () => number;
  readonly hasAuthorization: (authorization: boolean) => Headers;
}

/**
 * sw.js 在 worker 全局作用域里真正会触碰的成员。
 * 只声明这些：location.origin、addEventListener、clients.claim、skipWaiting，
 * 以及它执行时自己挂上去的自检出口 `__FF14_HUB_SW__`。
 */
interface SwGlobalScope {
  readonly location: { readonly origin: string };
  addEventListener(type: string, handler: (event: unknown) => void): void;
  readonly clients: { claim: () => Promise<void>;openWindow:(url:string)=>Promise<void> };
  readonly registration:{showNotification:(title:string,options:Record<string,unknown>)=>Promise<void>};
  skipWaiting(): Promise<void>;
  __FF14_HUB_SW__?: SwApi;
}

/** 递增计数器：给每次模块加载一个唯一查询串（配合 vi.resetModules 拿到全新实例）。 */
let swModuleLoadCounter = 0;

/** 把真实的 sw.js 当模块执行，取出它自己的判断函数与事件处理器。 */
async function loadServiceWorker(): Promise<SwSandbox> {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const notifications:{title:string;options:Record<string,unknown>}[]=[];const openedUrls:string[]=[];
  const deletedCaches: string[] = [];
  const cacheKeys = ['ff14-hub-public-v2', 'ff14-hub-public-v0', 'ff14-hub-private'];
  let skipWaitingCalls = 0;
  let claimCalls = 0;

  const cacheStub = {
    match: () => Promise.resolve(undefined),
    put: () => Promise.resolve(undefined),
  };
  const cachesStub = {
    open: () => Promise.resolve(cacheStub),
    keys: () => Promise.resolve([...cacheKeys]),
    delete: (name: string) => {
      deletedCaches.push(name);
      return Promise.resolve(true);
    },
  };

  const selfStub: SwGlobalScope = {
    location: { origin: APP_ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const list = handlers.get(type);
      if (list === undefined) {
        handlers.set(type, [handler]);
        return;
      }
      list.push(handler);
    },
    clients: {
      openWindow:(url:string)=>{openedUrls.push(url);return Promise.resolve();},
      claim: () => {
        claimCalls += 1;
        return Promise.resolve();
      },
    },
    registration:{showNotification:(title:string,options:Record<string,unknown>)=>{notifications.push({title,options});return Promise.resolve();}},
    skipWaiting: () => {
      skipWaitingCalls += 1;
      return Promise.resolve();
    },
  };

  // 先把受控 stub 装成全局，再执行 sw.js——它一执行就会读 self / caches / fetch。
  // 这里刻意不真的发网络请求：fetch 是纯 stub。
  vi.stubGlobal('self', selfStub);
  vi.stubGlobal('caches', cachesStub);
  vi.stubGlobal(
    'fetch',
    () => Promise.resolve(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/html' } })),
  );

  // 路径相对本测试文件，因此与进程 cwd 无关；唯一查询串 + resetModules 保证是全新实例。
  // 用带查询串的说明符是为了让 Vite/Vitest 的模块缓存也不复用同一个实例（否则 handler 会串台）。
  swModuleLoadCounter += 1;
  vi.resetModules();
  const moduleSpecifier = `../public/sw.js?test-case=${String(swModuleLoadCounter)}`;
  await import(/* @vite-ignore */ moduleSpecifier);

  const sw = selfStub.__FF14_HUB_SW__;
  if (sw === undefined) {
    throw new Error('sw.js 没有暴露自检出口 __FF14_HUB_SW__');
  }

  return {
    notifications,openedUrls,
    sw,
    handlers,
    deletedCaches,
    cacheKeys,
    skipWaitingCalls: () => skipWaitingCalls,
    claimCalls: () => claimCalls,
    hasAuthorization: (authorization: boolean) => {
      const headers = new Headers();
      if (authorization) {
        // 只需要「有 Authorization 头」这个事实来验证缓存策略；值本身无意义，
        // 因此刻意用明显的占位文本（不是任何真实凭证，也不像高熵密钥）。
        headers.set('Authorization', 'Bearer placeholder');
      }
      return headers;
    },
  };
}

function handlerOf(sandbox: SwSandbox, type: string): (event: unknown) => void {
  const handler = sandbox.handlers.get(type)?.[0];
  if (handler === undefined) {
    throw new Error(`sw.js 没有注册 ${type} 处理器`);
  }
  return handler;
}

/** 只注册 install/activate/fetch/message 四类事件——「只做三件事」的可执行断言。 */
function registeredEventTypes(sandbox: SwSandbox): string[] {
  return [...sandbox.handlers.keys()].sort((a, b) => a.localeCompare(b));
}

describe('sw.js：与 cache-policy.ts 一一对应', () => {
  it('内联的 CACHE_POLICY_JSON 与 CACHE_POLICY 逐字节相同', () => {
    const match = /const CACHE_POLICY_JSON =\s*\n?\s*'([^']*)'/.exec(SW_SOURCE);
    expect(match, 'sw.js 里找不到 CACHE_POLICY_JSON').not.toBeNull();
    const inlineJson = match?.[1] ?? '';
    expect(inlineJson).toBe(JSON.stringify(CACHE_POLICY));
  });

  it('sw.js 报告的白名单与 TypeScript 侧完全相同', async () => {
    const sandbox = await loadServiceWorker();
    expect(sandbox.sw.CACHE_POLICY).toEqual(JSON.parse(JSON.stringify(CACHE_POLICY)));
    expect(sandbox.sw.PUBLIC_CACHE_NAME).toBe(PUBLIC_CACHE_NAME);
    expect(sandbox.sw.SKIP_WAITING_MESSAGE).toBe(SKIP_WAITING_MESSAGE);
    expect(sandbox.sw.isNonPublicCacheName('ff14-hub-public-v0')).toBe(true);
    expect(sandbox.sw.isNonPublicCacheName(PUBLIC_CACHE_NAME)).toBe(false);
  });

  it('sw.js 明文包含 /api/v1/me/ 拒绝前缀，且代码里不再出现其它 API 路径字面量', () => {
    expect(SW_SOURCE).toContain('/api/v1/me/');
    const policyJsonMatch = /const CACHE_POLICY_JSON =\s*\n?\s*'([^']*)'/.exec(SW_SOURCE);
    const code = SW_SOURCE.replace(policyJsonMatch?.[1] ?? '', '');
    const apiLiterals = [...code.matchAll(/'(\/api\/[^']*)'/g)].map((found) => found[1]);
    // 所有 API 路径都必须来自那一份清单；代码里手写路径就可能绕过策略。
    expect(apiLiterals).toEqual([]);
  });

  it('只注册缓存、显式更新和推送所需的事件', async () => {
    expect(registeredEventTypes(await loadServiceWorker())).toEqual(['activate', 'fetch', 'install', 'message','notificationclick','push']);
  });
  it('空推送安全回退，通知点击始终进入同源提醒视图',async()=>{
    const sandbox=await loadServiceWorker();let pending=Promise.resolve();
    handlerOf(sandbox,'push')({data:{json:()=>null},waitUntil:(promise:Promise<void>)=>{pending=promise;}});await pending;
    expect(sandbox.notifications[0]?.title).toBe('FF14 Hub 提醒');
    handlerOf(sandbox,'push')({data:{json:()=>({title:'t'.repeat(200),body:'b'.repeat(500),url:'https://evil.test'})},waitUntil:(promise:Promise<void>)=>{pending=promise;}});await pending;
    expect(sandbox.notifications[1]?.title).toHaveLength(80);
    expect(sandbox.notifications[1]?.options['body']).toHaveLength(200);
    handlerOf(sandbox,'notificationclick')({notification:{close:()=>undefined,data:{url:'https://evil.test'}},waitUntil:(promise:Promise<void>)=>{pending=promise;}});await pending;
    expect(sandbox.openedUrls).toEqual(['/?view=notifications']);
  });

  it('对同一批请求/响应输入，sw.js 的判断与 TypeScript 侧逐条一致', async () => {
    const sandbox = await loadServiceWorker();
    const requests: CacheRequestDescriptor[] = [
      requestDescriptor('/'),
      requestDescriptor('/index.html'),
      requestDescriptor('/manifest.webmanifest'),
      requestDescriptor('/favicon.svg'),
      requestDescriptor('/assets/app.js'),
      requestDescriptor('/icons/icon-192.png'),
      ...PUBLIC_API_PATHS.map((path) => requestDescriptor(path)),
      requestDescriptor('/api/v1/me/profile'),
      requestDescriptor('/api/v1/me/sync?since=0'),
      requestDescriptor('/api/v1/metadata'),
      requestDescriptor('/api/v1/identity/bootstrap'),
      requestDescriptor('/assets/app.js', { hasAuthorizationHeader: true }),
      requestDescriptor('/assets/app.js', { method: 'POST' }),
      requestDescriptor('/assets/app.js', { url: 'https://evil.example/assets/app.js' }),
      requestDescriptor('/assets/app.js', { url: 'file:///etc/passwd' }),
      requestDescriptor('/assets/app.js', { appOrigin: null }),
      requestDescriptor('/assets/app.js', { url: 'not-a-url' }),
      requestDescriptor('/workbench'),
    ];
    for (const descriptor of requests) {
      expect(sandbox.sw.shouldCacheRequest(descriptor), JSON.stringify(descriptor)).toBe(shouldCacheRequest(descriptor));
    }

    const responses: CacheResponseDescriptor[] = [
      { status: 200, contentType: 'text/html', cacheControl: null },
      { status: 200, contentType: 'application/json; charset=utf-8', cacheControl: 'max-age=60' },
      { status: 200, contentType: 'image/png', cacheControl: null },
      { status: 200, contentType: 'application/octet-stream', cacheControl: null },
      { status: 200, contentType: 'application/x-pem-file', cacheControl: null },
      { status: 200, contentType: 'application/zip', cacheControl: null },
      { status: 200, contentType: null, cacheControl: null },
      { status: 200, contentType: 'text/html', cacheControl: 'no-store' },
      { status: 200, contentType: 'text/html', cacheControl: 'private' },
      { status: 304, contentType: 'text/html', cacheControl: null },
      { status: 401, contentType: 'application/json', cacheControl: null },
      { status: 500, contentType: 'text/html', cacheControl: null },
    ];
    for (const descriptor of responses) {
      expect(sandbox.sw.shouldCacheResponse(descriptor), JSON.stringify(descriptor)).toBe(
        shouldCacheResponse(descriptor),
      );
    }
  });

  it('activate 清理一切非当前公开缓存（含旧版本），并接管当前页面', async () => {
    const sandbox = await loadServiceWorker();
    const waited: Promise<unknown>[] = [];
    handlerOf(sandbox, 'activate')({
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
    });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(sandbox.deletedCaches).toEqual(['ff14-hub-public-v0', 'ff14-hub-private']);
    expect(sandbox.claimCalls()).toBe(1);
  });

  it('install 预缓存时不调用 skipWaiting（更新必须由页面确认）', async () => {
    const sandbox = await loadServiceWorker();
    const waited: Promise<unknown>[] = [];
    handlerOf(sandbox, 'install')({
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
    });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(sandbox.skipWaitingCalls()).toBe(0);
  });

  it('message 收到页面的 SKIP_WAITING 通知后才 skipWaiting', async () => {
    const sandbox = await loadServiceWorker();
    let waited = false;
    handlerOf(sandbox, 'message')({ data: { type: '别的消息' }, waitUntil: () => undefined });
    expect(sandbox.skipWaitingCalls()).toBe(0);

    handlerOf(sandbox, 'message')({
      data: { type: SKIP_WAITING_MESSAGE },
      waitUntil: () => {
        waited = true;
      },
    });
    expect(sandbox.skipWaitingCalls()).toBe(1);
    expect(waited).toBe(true);
  });

  it('fetch 只接管公开资源与导航请求，绝不介入私有/写请求', async () => {
    const sandbox = await loadServiceWorker();
    const fetchHandler = handlerOf(sandbox, 'fetch');

    async function dispatch(url: string, init: { method?: string; authorization?: boolean; mode?: string }) {
      const headers = sandbox.hasAuthorization(init.authorization === true);
      const captured: Promise<unknown>[] = [];
      const event = {
        request: {
          url,
          method: init.method ?? 'GET',
          mode: init.mode ?? 'no-cors',
          headers,
        },
        respondWith: (value: unknown) => {
          captured.push(Promise.resolve(value));
        },
      };
      fetchHandler(event);
      await Promise.all(captured);
      return captured.length > 0;
    }

    expect(await dispatch(`${APP_ORIGIN}/assets/app.js`, {})).toBe(true);
    expect(await dispatch(`${APP_ORIGIN}/`, {})).toBe(true);
    expect(await dispatch(`${APP_ORIGIN}/api/v1/events`, {})).toBe(true);
    // 导航到未列入白名单的 SPA 路由：只做离线回退，不进入缓存。
    expect(await dispatch(`${APP_ORIGIN}/workbench`, { mode: 'navigate' })).toBe(true);

    expect(await dispatch(`${APP_ORIGIN}/api/v1/me/profile`, {})).toBe(false);
    expect(await dispatch(`${APP_ORIGIN}/api/v1/me/sync/changes`, {})).toBe(false);
    expect(await dispatch(`${APP_ORIGIN}/api/v1/identity/bootstrap`, {})).toBe(false);
    expect(await dispatch(`${APP_ORIGIN}/assets/app.js`, { authorization: true })).toBe(false);
    expect(await dispatch(`${APP_ORIGIN}/api/v1/health`, { method: 'POST' })).toBe(false);
    expect(await dispatch(`${APP_ORIGIN}/api/v1/me/workbench`, { method: 'PUT' })).toBe(false);
  });
});


describe('sw.js：首页 HTML 更新策略', () => {
  it('在线优先读取最新首页而不是缓存的旧工作空间页面；离线仍能回退', async () => {
    const sandbox = await loadServiceWorker();
    const cached = new Response('旧版首页：连接工作空间', { headers: { 'Content-Type': 'text/html' } });
    const cache = {
      match: vi.fn(() => Promise.resolve(cached.clone())),
      put: vi.fn(() => Promise.resolve()),
    };
    vi.stubGlobal('caches', { open: () => Promise.resolve(cache) });
    const live = vi.fn(() => Promise.resolve(new Response('新版首页：进入钓鱼中心', {
      headers: { 'Content-Type': 'text/html' },
    })));
    vi.stubGlobal('fetch', live);
    const visit = async (pathname: string): Promise<string> => {
      const results: Promise<Response>[] = [];
      handlerOf(sandbox, 'fetch')({
        request: { url: APP_ORIGIN + pathname, method: 'GET', mode: 'navigate', headers: new Headers() },
        respondWith: (response: Promise<Response>) => { results.push(response); },
      });
      expect(results).toHaveLength(1);
      return (await results[0]!.then(r => r.text()));
    };
    expect(await visit('/')).toContain('新版首页');
    expect(await visit('/index.html')).toContain('新版首页');
    expect(live).toHaveBeenCalledTimes(2);
    live.mockRejectedValueOnce(new Error('offline'));
    expect(await visit('/')).toContain('旧版首页');
  });
});

// ---------------------------------------------------------------------------
// 4. 离线 / 可安装 / 更新提示状态
// ---------------------------------------------------------------------------

describe('install-state：resolveOfflineState', () => {
  it('在线：明确说明私有修改会保存', () => {
    const state = resolveOfflineState({ online: true, hasPrivateDraft: false });
    expect(state.status).toBe('online');
    expect(state.offline).toBe(false);
    expect(state.privateWritesPersisted).toBe(true);
    expect(state.draftAtRisk).toBe(false);
  });

  it('离线且无草稿：给出公开内容的降级说明，且不声称私有写已保存', () => {
    const state = resolveOfflineState({ online: false, hasPrivateDraft: false });
    expect(state.status).toBe('offline');
    expect(state.offline).toBe(true);
    expect(state.privateWritesPersisted).toBe(false);
    expect(state.draftAtRisk).toBe(false);
    expect(state.message).toBe(OFFLINE_DISCLOSURE);
    expect(state.message).toContain('私有修改不会在离线时持久化到服务端');
    expect(state.detail).toContain('缓存的公开内容');
  });

  it('离线且有未保存草稿：明确标记草稿风险', () => {
    const state = resolveOfflineState({ online: false, hasPrivateDraft: true });
    expect(state.status).toBe('offline-unsaved-draft');
    expect(state.privateWritesPersisted).toBe(false);
    expect(state.draftAtRisk).toBe(true);
    expect(state.message).toBe(OFFLINE_DISCLOSURE);
    expect(state.detail).toContain('恢复网络后');
  });

  it('任何离线分支都不得出现「已保存/已同步」之类的措辞', () => {
    for (const hasPrivateDraft of [false, true]) {
      const state = resolveOfflineState({ online: false, hasPrivateDraft });
      expect(`${state.message}${state.detail}`).not.toMatch(/已(保存|同步|提交)/);
    }
  });
});

describe('install-state：resolveInstallState', () => {
  const base = { hasServiceWorkerSupport: true, hasManifestLink: true, installPromptAvailable: true, isStandalone: false };

  it('独立窗口运行即视为已安装', () => {
    const state = resolveInstallState({ ...base, isStandalone: true });
    expect(state.status).toBe('installed');
    expect(state.canPromptInstall).toBe(false);
  });

  it('缺 Service Worker 或 manifest 时诚实报告不支持安装', () => {
    const noSw = resolveInstallState({ ...base, hasServiceWorkerSupport: false });
    expect(noSw.status).toBe('unsupported');
    expect(noSw.detail).toContain('Service Worker');

    const noManifest = resolveInstallState({ ...base, hasManifestLink: false });
    expect(noManifest.status).toBe('unsupported');
    expect(noManifest.detail).toContain('manifest');

    const neither = resolveInstallState({ ...base, hasServiceWorkerSupport: false, hasManifestLink: false });
    expect(neither.status).toBe('unsupported');
    expect(neither.detail).toContain('Service Worker');
    expect(neither.detail).toContain('manifest');
  });

  it('两者齐备时可安装；浏览器是否已给出安装入口只影响提示方式', () => {
    const promptable = resolveInstallState(base);
    expect(promptable.status).toBe('installable');
    expect(promptable.canPromptInstall).toBe(true);

    const ios = resolveInstallState({ ...base, installPromptAvailable: false });
    expect(ios.status).toBe('installable');
    expect(ios.canPromptInstall).toBe(false);
    expect(ios.detail).toContain('添加到主屏幕');
  });
});

describe('install-state：resolveUpdatePromptState（不打断编辑）', () => {
  it('没有更新时不显示提示', () => {
    const state = resolveUpdatePromptState({ updateReady: false, hasPrivateDraft: false });
    expect(state.visible).toBe(false);
    expect(state.canActivateNow).toBe(false);
  });

  it('有未保存草稿时提示可见但拒绝此时激活', () => {
    const state = resolveUpdatePromptState({ updateReady: true, hasPrivateDraft: true });
    expect(state.visible).toBe(true);
    expect(state.canActivateNow).toBe(false);
    expect(state.detail).toContain('草稿');
  });

  it('没有草稿时允许用户确认后激活', () => {
    const state = resolveUpdatePromptState({ updateReady: true, hasPrivateDraft: false });
    expect(state.visible).toBe(true);
    expect(state.canActivateNow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. 注册逻辑：安全降级 / 更新确认 / 私有缓存清理
// ---------------------------------------------------------------------------

interface FakeRegistration {
  readonly waiting: unknown;
  readonly installing: unknown;
  readonly addEventListener: (type: string, handler: () => void) => void;
}

function fakeContainer(options: {
  readonly registration: FakeRegistration;
  readonly controller?: unknown;
}): Record<string, unknown> {
  return {
    controller: options.controller ?? null,
    register: () => Promise.resolve(options.registration),
    addEventListener: () => undefined,
  };
}

describe('register-service-worker：安全降级（不抛错、不阻塞渲染）', () => {
  it('navigator 上没有 serviceWorker 时返回 unsupported', async () => {
    vi.stubGlobal('navigator', {});
    const handle = await registerServiceWorker();
    expect(handle.registration.status).toBe('unsupported');
    expect(handle.registration.registration).toBeNull();
    expect(handle.registration.reason).not.toBeNull();
    expect(handle.getPendingUpdate()).toBeNull();
    await expect(handle.applyPendingUpdate({ hasPrivateDraft: false })).resolves.toBe('no_pending_update');
  });

  it('navigator 本身缺失时也不抛错', async () => {
    vi.stubGlobal('navigator', undefined);
    const handle = await registerServiceWorker();
    expect(handle.registration.status).toBe('unsupported');
  });

  it('serviceWorker 存在但不是有效容器时按不支持处理', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { notARegisterFunction: true } });
    const handle = await registerServiceWorker();
    expect(handle.registration.status).toBe('unsupported');
  });

  it('register() 被拒时降级为 failed，而不是把异常抛给调用方', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: null,
        register: () => Promise.reject(new Error('SecurityError: 被策略拒绝')),
        addEventListener: () => undefined,
      },
    });
    const handle = await registerServiceWorker();
    expect(handle.registration.status).toBe('failed');
    expect(handle.registration.reason).toContain('SecurityError');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('register-service-worker：更新确认与草稿保护', () => {
  function stubWithWaitingWorker(postMessage: (message: unknown) => void) {
    const worker = { postMessage, state: 'installed' };
    const registration: FakeRegistration = {
      waiting: worker,
      installing: null,
      addEventListener: () => undefined,
    };
    vi.stubGlobal('navigator', {
      serviceWorker: fakeContainer({ registration, controller: { state: 'activated' } }),
    });
    return worker;
  }

  it('已注册并处于受控状态时，waiting worker 会作为待激活更新暴露出来', async () => {
    const postMessage = vi.fn();
    stubWithWaitingWorker(postMessage);
    const handle = await registerServiceWorker();
    expect(handle.registration.status).toBe('registered');
    expect(handle.getPendingUpdate()).not.toBeNull();
  });

  it('有未保存草稿时拒绝激活，且不发送任何消息', async () => {
    const postMessage = vi.fn();
    stubWithWaitingWorker(postMessage);
    const handle = await registerServiceWorker();
    await expect(handle.applyPendingUpdate({ hasPrivateDraft: true })).resolves.toBe('blocked_by_draft');
    expect(postMessage).not.toHaveBeenCalled();
    // 更新仍然挂着：保存草稿后还能继续。
    expect(handle.getPendingUpdate()).not.toBeNull();
  });

  it('没有草稿时用户确认才 postMessage，由 SW 自己 skipWaiting', async () => {
    const postMessage = vi.fn();
    stubWithWaitingWorker(postMessage);
    const handle = await registerServiceWorker();
    await expect(handle.applyPendingUpdate({ hasPrivateDraft: false })).resolves.toBe('activated');
    expect(postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING_MESSAGE });
  });

  it('subscribe 会立刻回放当前状态', async () => {
    const postMessage = vi.fn();
    stubWithWaitingWorker(postMessage);
    const handle = await registerServiceWorker();
    const seen: boolean[] = [];
    const unsubscribe = handle.subscribe((snapshot) => {
      seen.push(snapshot.updateReady);
    });
    expect(seen).toEqual([true]);
    unsubscribe();
  });

  it('注册后可以从模块取到同一个句柄（Shell 侧不用自己再注册一次）', async () => {
    const postMessage = vi.fn();
    stubWithWaitingWorker(postMessage);
    const handle = await registerServiceWorker();
    expect(getServiceWorkerHandle()).toBe(handle);
    expect(getServiceWorkerHandle()?.getPendingUpdate()).not.toBeNull();
  });

  it('注册时使用 /sw.js 且不做 HTTP 缓存判断', async () => {
    const registerCalls: unknown[] = [];
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: null,
        register: (url: string, options: unknown) => {
          registerCalls.push([url, options]);
          return Promise.resolve({ waiting: null, installing: null, addEventListener: () => undefined });
        },
        addEventListener: () => undefined,
      },
    });
    await registerServiceWorker();
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]).toEqual([SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' }]);
  });
});

describe('register-service-worker：clearPrivateCaches', () => {
  it('删除一切非当前公开缓存，保留公开缓存', async () => {
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve([PUBLIC_CACHE_NAME, 'ff14-hub-public-v0', 'ff14-hub-private', 'legacy']),
      delete: (name: string) => {
        deleted.push(name);
        return Promise.resolve(true);
      },
    });
    const result = await clearPrivateCaches();
    expect(result.supported).toBe(true);
    expect(result.deleted).toEqual(['ff14-hub-public-v0', 'ff14-hub-private', 'legacy']);
    expect(result.kept).toEqual([PUBLIC_CACHE_NAME]);
    expect(deleted).toEqual(result.deleted);
  });

  it('没有 CacheStorage 时返回 supported=false 而不抛错', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(clearPrivateCaches()).resolves.toEqual({ supported: false, deleted: [], kept: [] });
  });

  it('CacheStorage 报错时同样不抛错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('caches', {
      keys: () => Promise.reject(new Error('存储不可用')),
      delete: () => Promise.resolve(true),
    });
    await expect(clearPrivateCaches()).resolves.toEqual({ supported: false, deleted: [], kept: [] });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('register-service-worker：observeOfflineState', () => {
  it('立即回放一次当前状态，并在 online/offline 事件上重新计算', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const states: string[] = [];
    const unsubscribe = observeOfflineState({
      hasPrivateDraft: () => false,
      onChange: (state) => {
        states.push(state.status);
      },
    });
    expect(states).toEqual(['online']);

    vi.stubGlobal('navigator', { onLine: false });
    globalThis.dispatchEvent(new Event('offline'));
    expect(states).toEqual(['online', 'offline']);

    unsubscribe();
    globalThis.dispatchEvent(new Event('offline'));
    expect(states).toEqual(['online', 'offline']);
  });

  it('探测不到 onLine 时按在线处理，不谎报离线', () => {
    vi.stubGlobal('navigator', {});
    const states: string[] = [];
    observeOfflineState({
      hasPrivateDraft: () => false,
      onChange: (state) => {
        states.push(state.status);
      },
    });
    expect(states).toEqual(['online']);
  });
});

// ---------------------------------------------------------------------------
// 6. 产物契约：manifest / 图标 / 窄屏不溢出
// ---------------------------------------------------------------------------

function publicFile(relative: string): string | undefined {
  const candidates = [join(process.cwd(), 'public', relative), join(process.cwd(), 'apps', 'web', 'public', relative)];
  return candidates.find((candidate) => existsSync(candidate));
}

describe('PWA 产物契约', () => {
  it('manifest 可被 JSON.parse，且含 start_url=/ 与 zh-CN', () => {
    const path = publicFile('manifest.webmanifest');
    expect(path, '找不到 manifest.webmanifest').toBeDefined();
    const manifest = JSON.parse(readFileSync(path ?? '', 'utf8')) as Record<string, unknown>;
    expect(manifest['start_url']).toBe('/');
    expect(manifest['display']).toBe('standalone');
    expect(manifest['lang']).toBe('zh-CN');
    expect(manifest['name']).toBeTruthy();
    expect(manifest['short_name']).toBeTruthy();
    expect(manifest['background_color']).toBeTruthy();
    expect(manifest['theme_color']).toBeTruthy();
    expect(String(manifest['description'])).not.toBe('');
  });

  it('manifest 引用的每个图标文件都真实存在', () => {
    const manifestPath = publicFile('manifest.webmanifest');
    const manifest = JSON.parse(readFileSync(manifestPath ?? '', 'utf8')) as {
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    for (const icon of manifest.icons) {
      expect(publicFile(icon.src.replace(/^\//, '')), icon.src).toBeDefined();
    }
    expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable')).toBe(true);
  });

  it('index.html 声明 manifest / theme-color / apple-touch-icon 且保留既有 viewport', () => {
    const htmlPath = publicFile('../index.html') ?? join(process.cwd(), 'index.html');
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('href="/icons/apple-touch-icon.png"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
  });
});
