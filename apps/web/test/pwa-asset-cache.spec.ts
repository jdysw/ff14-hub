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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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
  vi.restoreAllMocks();
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
    expect(Object.keys(message).sort()).toEqual(['type', 'urls']);
    expect(SERVICE_WORKER_URL).toBe('/sw.js');
  });
});

// ---------------------------------------------------------------------------
// SW 侧：即使被报了私有 URL，也必须拒绝缓存
// ---------------------------------------------------------------------------

interface SwSandbox {
  readonly handlers: Map<string, ((event: unknown) => void)[]>;
  readonly cachedUrls: string[];
  readonly fetchedUrls: string[];
}

function loadServiceWorker(): SwSandbox {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const cachedUrls: string[] = [];
  const fetchedUrls: string[] = [];
  const swPath = join(process.cwd(), 'public', 'sw.js');
  const source = readFileSync(swPath, 'utf8');

  const cacheStub = {
    match: () => Promise.resolve(undefined),
    put: (request: Request) => {
      cachedUrls.push(typeof request === 'string' ? request : request.url);
      return Promise.resolve(undefined);
    },
  };
  const selfStub: Record<string, unknown> = {
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
  const sandbox: Record<string, unknown> = {
    self: selfStub,
    caches: {
      open: () => Promise.resolve(cacheStub),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    fetch: (request: Request) => {
      fetchedUrls.push(typeof request === 'string' ? request : request.url);
      return Promise.resolve(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/javascript' } }));
    },
    Request,
    Response,
    Headers,
    URL,
    console,
  };
  runInNewContext(source, sandbox);
  return { handlers, cachedUrls, fetchedUrls };
}

describe('sw.js：CACHE_URLS 消息路径也受同一份策略约束', () => {
  it('缓存公开资源，但拒绝私有接口与跨域地址', async () => {
    const sandbox = loadServiceWorker();
    const handler = sandbox.handlers.get('message')?.[0];
    expect(handler, 'sw.js 必须注册 message 处理器').toBeDefined();

    const waits: Promise<unknown>[] = [];
    handler?.({
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
});
