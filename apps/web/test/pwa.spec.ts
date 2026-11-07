/**
 * 保留缓存边界、真实 Service Worker 行为、离线恢复和更新时的草稿保护。
 * manifest、图标和静态响应头由 Worker 的 static-assets-headers.spec.ts 验证。
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CacheRequestDescriptor,
  type CacheResponseDescriptor,
} from '../src/app/pwa/cache-policy';
import {
  resolveInstallState,
  resolveUpdatePromptState,
} from '../src/app/pwa/install-state';
import {
  SKIP_WAITING_MESSAGE,
} from '../src/app/pwa/register-service-worker';

afterEach(() => {
  // 清理本用例装的 self / caches / fetch stub，并丢弃它加载的 sw.js 模块实例，
  // 保证下一个用例从一个干净的模块注册表开始（不残留任何事件处理器）。
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const APP_ORIGIN = 'https://ff14-hub.test';




// ---------------------------------------------------------------------------
// 1. 请求放行判断
// ---------------------------------------------------------------------------





// ---------------------------------------------------------------------------
// 2. 响应放行判断
// ---------------------------------------------------------------------------





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
  const cacheKeys = ['ff14-hub-public-v3', 'ff14-hub-public-v0', 'ff14-hub-private'];
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

describe('sw.js：与 cache-policy.ts 一一对应', () => {

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
  it('鱼窗通知仅按校验后的 ID 打开固定同源目标',async()=>{
    const sandbox=await loadServiceWorker();let pending=Promise.resolve();
    const click=(fish:unknown)=>handlerOf(sandbox,'notificationclick')({notification:{close:()=>undefined,data:{fish,url:'https://evil.test'}},waitUntil:(promise:Promise<void>)=>{pending=promise;}});
    click({region:'cn',fishId:8754,windowStartsAt:123});await pending;expect(sandbox.openedUrls[0]).toBe('/?view=fish&region=cn&fish=8754&window=123');
    click({region:'cn',fishId:1.5,windowStartsAt:123});await pending;expect(sandbox.openedUrls[1]).toBe('/?view=notifications');
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
    handlerOf(sandbox, 'message')({ origin: APP_ORIGIN, source: { type: 'window', url: `${APP_ORIGIN}/` }, data: { type: '别的消息' }, waitUntil: () => undefined });
    expect(sandbox.skipWaitingCalls()).toBe(0);

    handlerOf(sandbox, 'message')({
      origin: APP_ORIGIN,
      source: { type: 'window', url: `${APP_ORIGIN}/` },
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
  it('鱼类目录联网优先读取新资料，断网保留已有目录', async () => {
    const sandbox=await loadServiceWorker();
    const cache={match:vi.fn(()=>Promise.resolve(new Response('old catalog'))),put:vi.fn(()=>Promise.resolve())};
    vi.stubGlobal('caches',{open:()=>Promise.resolve(cache)});
    const live=vi.fn(()=>Promise.resolve(new Response('new catalog',{headers:{'Content-Type':'application/json'}})));vi.stubGlobal('fetch',live);
    const visit=async(path:string)=>{let result:Promise<Response>|undefined;handlerOf(sandbox,'fetch')({request:{url:APP_ORIGIN+path,method:'GET',headers:new Headers()},respondWith:(response:Promise<Response>)=>{result=response;}});return (await result!).text();};
    expect(await visit('/fishing/catalog-cn.json')).toBe('new catalog');expect(await visit('/fishing/catalog-global.json')).toBe('new catalog');
    live.mockRejectedValueOnce(new Error('offline'));expect(await visit('/fishing/catalog-cn.json')).toBe('old catalog');
  });
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



describe('install-state：resolveInstallState', () => {
  const base = { hasServiceWorkerSupport: true, hasManifestLink: true, installPromptAvailable: true, isStandalone: false };





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


  it('有未保存草稿时提示可见但拒绝此时激活', () => {
    const state = resolveUpdatePromptState({ updateReady: true, hasPrivateDraft: true });
    expect(state.visible).toBe(true);
    expect(state.canActivateNow).toBe(false);
    expect(state.detail).toContain('草稿');
  });


});











// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
