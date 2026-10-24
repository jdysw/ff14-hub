// @vitest-environment jsdom
/**
 * 「把当前这版资源补进缓存」的测试（HUB-012 复核修正）。
 *
 * 缺陷背景：`install` 只能预缓存非指纹资源，`/assets/*` 带内容哈希、SW 在安装时不知道文件名，
 * 于是「首次访问后立刻离线」会白屏（外壳在、JS 不在）。
 * 修法是页面在受控后把**已经真实加载过**的同源资源清单交给 SW，由 SW 逐条按同一份策略过滤后缓存。
 *
 * 这里断言的是**边界**，不是实现：
 * - 页面侧：只收集同源、且通过公开缓存策略的资源（跨域、`/api/v1/me/*` 一律不收集）；
 * - SW 侧：即使页面报了私有 URL，SW 也必须拒绝（策略是安全边界，页面过滤只是优化）；
 * - 没有受控 SW 时不发任何消息（不制造无意义的 postMessage）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_URLS_MESSAGE,
  SERVICE_WORKER_URL,
  collectLoadedAssetUrls,
  registerServiceWorker,
  reportLoadedAssetsToServiceWorker,
  resetServiceWorkerHandleForTests,
} from '../src/app/pwa/register-service-worker';

/** 页面侧用 jsdom 的真实 origin（`location.origin` 在 jsdom 里不可改写，实现按它判同源）。 */
const APP_ORIGIN = window.location.origin;
/** SW 沙箱里 `self.location.origin` 由我们自己给定，因此用一个独立常量。 */
const SW_ORIGIN = 'https://ff14-hub.test';

afterEach(() => {
  resetServiceWorkerHandleForTests();
  // 清理本用例装的 self / caches / fetch stub，并丢弃它加载的 sw.js 模块实例：
  // 下一个用例拿到全新的模块与全新的处理器，互不影响。
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 页面侧：收集清单
// ---------------------------------------------------------------------------

function stubPerformance(entries: readonly { readonly name: string; readonly initiatorType: string }[]): void {
  Object.defineProperty(globalThis, 'performance', {
    value: { getEntriesByType: (type: string) => (type === 'resource' ? entries : []) },
    configurable: true,
  });
}

describe('collectLoadedAssetUrls', () => {
  it('只收集同源且通过公开策略的资源', () => {
    stubPerformance([
      { name: `${APP_ORIGIN}/assets/index-abc123.js`, initiatorType: 'script' },
      { name: `${APP_ORIGIN}/assets/index-abc123.css`, initiatorType: 'link' },
      { name: `${APP_ORIGIN}/icons/icon-192.png`, initiatorType: 'img' },
      // 私有接口：绝不进缓存清单（即使它是同源的 fetch 条目）。
      { name: `${APP_ORIGIN}/api/v1/me/navigation`, initiatorType: 'fetch' },
      { name: `${APP_ORIGIN}/api/v1/me/workbench`, initiatorType: 'fetch' },
      // 公开目录可以缓存。
      { name: `${APP_ORIGIN}/api/v1/navigation/catalog`, initiatorType: 'fetch' },
      // 跨域：不收集。
      { name: 'https://cdn.example.com/lib.js', initiatorType: 'script' },
      // 无关类型：不收集。
      { name: `${APP_ORIGIN}/api/v1/health`, initiatorType: 'beacon' },
    ]);

    const urls = collectLoadedAssetUrls();
    expect(urls).toContain(`${APP_ORIGIN}/assets/index-abc123.js`);
    expect(urls).toContain(`${APP_ORIGIN}/assets/index-abc123.css`);
    expect(urls).toContain(`${APP_ORIGIN}/icons/icon-192.png`);
    expect(urls).toContain(`${APP_ORIGIN}/api/v1/navigation/catalog`);
    expect(urls.some((url) => url.includes('/api/v1/me/'))).toBe(false);
    expect(urls.some((url) => url.includes('cdn.example.com'))).toBe(false);
    expect(urls.some((url) => url.includes('/api/v1/health'))).toBe(false);
  });

  it('没有 performance 支持时返回空清单（安全降级，不抛错）', () => {
    Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true });
    expect(collectLoadedAssetUrls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 页面侧：上报（只在受控时发一次）
// ---------------------------------------------------------------------------

describe('reportLoadedAssetsToServiceWorker', () => {
  it('没有受控 Service Worker 时不发送任何消息', () => {
    const container = { controller: null, register: vi.fn(), addEventListener: vi.fn() };
    Object.defineProperty(window.navigator, 'serviceWorker', { value: container, configurable: true });
    stubPerformance([{ name: `${APP_ORIGIN}/assets/index-abc123.js`, initiatorType: 'script' }]);
    // 直接调用：控制器为空 → 什么都不该发生（用不抛错来断言「静默」）。
    expect(() => {
      reportLoadedAssetsToServiceWorker();
    }).not.toThrow();
  });

  it('受控时把清单按消息发出去，且消息里只有 URL 字符串', async () => {
    const postMessage = vi.fn();
    const container = {
      controller: { postMessage },
      register: vi.fn(() => Promise.resolve({ waiting: null, installing: null, scope: '/', addEventListener: vi.fn() })),
      addEventListener: vi.fn(),
    };
    Object.defineProperty(window.navigator, 'serviceWorker', { value: container, configurable: true });
    stubPerformance([
      { name: `${APP_ORIGIN}/assets/index-abc123.js`, initiatorType: 'script' },
      { name: `${APP_ORIGIN}/api/v1/me/profile`, initiatorType: 'fetch' },
    ]);

    await registerServiceWorker();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const message = postMessage.mock.calls[0]?.[0] as { type: string; urls: readonly string[] };
    expect(message.type).toBe(CACHE_URLS_MESSAGE);
    expect(message.urls).toEqual([`${APP_ORIGIN}/assets/index-abc123.js`]);
    // 消息里只有 URL：没有任何令牌、workspace 字段或页面数据。
    expect(Object.keys(message).sort((a, b) => a.localeCompare(b))).toEqual(['type', 'urls']);
    expect(SERVICE_WORKER_URL).toBe('/sw.js');
  });
});

// ---------------------------------------------------------------------------
// SW 侧：即使被报了私有 URL，也必须拒绝缓存
//
// 为什么不再把 sw.js 源码交给 vm 动态求值：
// ① 安全热点：把源码字符串交给 vm 执行属于「动态执行代码」（SonarCloud S1523），
//    质量门要求新代码 0 Security Hotspots；改成模块 import 后没有任何字符串求值。
// ② 语义更接近真实：浏览器装载 Service Worker 就是「把 sw.js 当脚本执行、在全局作用域里读写
//    self / caches / fetch」，直接执行真实产物比自造 vm 沙箱更贴近 worker 语义。
// ③ 每个用例独立模块实例：加载前 vi.resetModules() + 递增查询串，让 sw.js 重新执行一次，
//    事件处理器只挂到**该用例自己的** self stub 上，用例之间不会串台。
// ---------------------------------------------------------------------------

interface SwSandbox {
  readonly handlers: Map<string, ((event: unknown) => void)[]>;
  readonly cachedUrls: string[];
  readonly fetchedUrls: string[];
}

/**
 * sw.js 在 worker 全局作用域里真正会触碰的成员。
 * 只声明这些：location.origin、addEventListener、clients.claim、skipWaiting。
 */
interface SwGlobalScope {
  readonly location: { readonly origin: string };
  addEventListener(type: string, handler: (event: unknown) => void): void;
  readonly clients: { claim: () => Promise<void> };
  skipWaiting(): Promise<void>;
}

/** 递增计数器：给每次模块加载一个唯一查询串（配合 vi.resetModules 拿到全新实例）。 */
let swModuleLoadCounter = 0;

/** 把真实的 sw.js（相对本测试文件定位，与进程 cwd 无关）当模块执行。 */
async function loadServiceWorker(): Promise<SwSandbox> {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const cachedUrls: string[] = [];
  const fetchedUrls: string[] = [];

  const cacheStub = {
    match: () => Promise.resolve(undefined),
    put: (request: Request) => {
      cachedUrls.push(typeof request === 'string' ? request : request.url);
      return Promise.resolve(undefined);
    },
  };
  const selfStub: SwGlobalScope = {
    location: { origin: SW_ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const list = handlers.get(type);
      if (list === undefined) {
        handlers.set(type, [handler]);
        return;
      }
      list.push(handler);
    },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
  };

  // 先把受控 stub 装成全局，再执行 sw.js——它一执行就会读 self / caches / fetch。
  // fetch/cache.put 都只做记录，不发真实网络请求、不写真实缓存。
  vi.stubGlobal('self', selfStub);
  vi.stubGlobal('caches', {
    open: () => Promise.resolve(cacheStub),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  });
  vi.stubGlobal('fetch', (request: Request) => {
    fetchedUrls.push(typeof request === 'string' ? request : request.url);
    return Promise.resolve(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/javascript' } }));
  });

  swModuleLoadCounter += 1;
  vi.resetModules();
  const moduleSpecifier = `../public/sw.js?test-case=${String(swModuleLoadCounter)}`;
  await import(/* @vite-ignore */ moduleSpecifier);

  return { handlers, cachedUrls, fetchedUrls };
}

describe('sw.js：CACHE_URLS 消息路径也受同一份策略约束', () => {
  it('缓存公开资源，但拒绝私有接口与跨域地址', async () => {
    const sandbox = await loadServiceWorker();
    const handler = sandbox.handlers.get('message')?.[0];
    expect(handler, 'sw.js 必须注册 message 处理器').toBeDefined();

    const waits: Promise<unknown>[] = [];
    handler?.({
      origin: SW_ORIGIN,
      source: { type: 'window', url: `${SW_ORIGIN}/` },
      data: {
        type: CACHE_URLS_MESSAGE,
        urls: [
          `${SW_ORIGIN}/assets/index-abc123.js`,
          `${SW_ORIGIN}/api/v1/me/navigation`,
          `${SW_ORIGIN}/api/v1/me/workbench`,
          'https://cdn.example.com/lib.js',
          'javascript:alert(1)',
        ],
      },
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    });
    await Promise.all(waits);

    expect(sandbox.fetchedUrls).toContain(`${SW_ORIGIN}/assets/index-abc123.js`);
    expect(sandbox.fetchedUrls.some((url) => url.includes('/api/v1/me/'))).toBe(false);
    expect(sandbox.fetchedUrls.some((url) => url.includes('cdn.example.com'))).toBe(false);
    expect(sandbox.fetchedUrls.some((url) => url.startsWith('javascript:'))).toBe(false);
    expect(sandbox.cachedUrls).toEqual([`${SW_ORIGIN}/assets/index-abc123.js`]);
  });

  it('拒绝跨域窗口发送的缓存指令', async () => {
    const sandbox = await loadServiceWorker();
    const handler = sandbox.handlers.get('message')?.[0];
    const waitUntil = vi.fn();
    handler?.({
      origin: 'https://untrusted.example',
      source: { type: 'window', url: 'https://untrusted.example/' },
      data: { type: CACHE_URLS_MESSAGE, urls: [`${SW_ORIGIN}/assets/untrusted.js`] },
      waitUntil,
    });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sandbox.fetchedUrls).toEqual([]);
    expect(sandbox.cachedUrls).toEqual([]);
  });
});
