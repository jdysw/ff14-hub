/**
 * Service Worker 注册与更新确认（HUB-012 / ADR-0004 D10）。
 *
 * 三条不可动摇的边界：
 * 1. **安全降级**：`navigator.serviceWorker` 不存在、`register()` 被拒（隐私模式、
 *    证书错误、CSP 阻断……）时一律返回结构化结果，**不抛错、不阻塞渲染**——
 *    注册失败只是没有离线能力，绝不能让整个应用白屏。
 * 2. **更新必须经用户确认**：本模块从不调用 `skipWaiting()`；
 *    页面只在用户确认后 `postMessage`，由 SW 自己激活（sw.js 里的 message 处理器）。
 * 3. **不打断编辑**：存在未保存草稿时 `applyPendingUpdate` 直接拒绝（`blocked_by_draft`），
 *    新版本就停在 waiting，等用户保存后再更新。
 *
 * `clearPrivateCaches()` 供登出/切换工作空间调用：按 cache-policy 删除一切非当前公开缓存，
 * 保留公开缓存（它按策略只含公开内容）。
 */
import { PUBLIC_CACHE_NAME, selectCachesToClear, shouldCacheRequest } from './cache-policy';
import { resolveOfflineState, type OfflineState } from './install-state';

export const SERVICE_WORKER_URL = '/sw.js';
/** 与 sw.js 中的常量同名同值；SW 只有在收到它之后才会 `skipWaiting()`。 */
export const SKIP_WAITING_MESSAGE = 'FF14_HUB_SKIP_WAITING';
/**
 * 与 sw.js 中的常量同名同值：页面把「当前这版真实加载过的资源」交给 SW 补缓存。
 *
 * 为什么需要：`install` 时 SW 不可能知道 `/assets/*` 的哈希文件名，于是首访后立刻离线会白屏
 * （外壳在、JS 不在）。这条消息让页面在受控后补齐清单，SW 逐条按同一份策略过滤后缓存。
 */
export const CACHE_URLS_MESSAGE = 'FF14_HUB_CACHE_URLS';

/** 单次上报的资源条数上限（与 sw.js 的 `CACHE_URLS_LIMIT` 保持一致）。 */
export const CACHE_URLS_LIMIT = 80;

/**
 * 收集当前文档真实加载过的同源静态资源（脚本 / 样式 / 字体 / 图片 / 公开目录请求）。
 *
 * 只收集**已经发生过**的请求（`performance` 资源计时），因此不会凭空探测不存在的路径；
 * 每条仍然要在 SW 侧过一次缓存策略——这里的过滤是「少发几条」的优化，不是安全边界。
 */
export function collectLoadedAssetUrls(): readonly string[] {
  const perf = (globalThis as { readonly performance?: Performance }).performance;
  const location = (globalThis as { readonly location?: Location }).location;
  if (perf === undefined || location === undefined || typeof perf.getEntriesByType !== 'function') {
    return [];
  }
  const origin = location.origin;
  const initiators = new Set(['script', 'link', 'css', 'img', 'fetch']);
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const entry of perf.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    if (!initiators.has(entry.initiatorType)) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry.name);
    } catch {
      continue;
    }
    if (url.origin !== origin) {
      continue;
    }
    if (!shouldCacheRequest({
      url: url.toString(),
      method: 'GET',
      hasAuthorizationHeader: false,
      appOrigin: origin,
    })) {
      continue;
    }
    const key = `${url.pathname}${url.search}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    urls.push(url.toString());
    if (urls.length >= CACHE_URLS_LIMIT) {
      break;
    }
  }
  return urls;
}

/** 把当前这版资源清单交给受控的 SW；没有受控 SW 或没有可缓存的资源时静默不做。 */
export function reportLoadedAssetsToServiceWorker(): void {
  const container = readServiceWorkerContainer(currentNavigator());
  if (container === null || container.controller === null || container.controller === undefined) {
    return;
  }
  const urls = collectLoadedAssetUrls();
  if (urls.length === 0) {
    return;
  }
  const controller = container.controller as ServiceWorker | null;
  if (controller === null || typeof controller.postMessage !== 'function') {
    return;
  }
  // 只发 URL 字符串，不发任何页面数据；SW 侧仍会逐条过策略。
  controller.postMessage({ type: CACHE_URLS_MESSAGE, urls });
}

export type RegistrationStatus = 'registered' | 'unsupported' | 'failed';

export interface RegistrationResult {
  readonly status: RegistrationStatus;
  /** 失败/不支持时为 null；成功时为真实注册对象。 */
  readonly registration: ServiceWorkerRegistration | null;
  /** 人类可读的原因（不包含任何凭证）。失败/不支持时非 null。 */
  readonly reason: string | null;
}

export type ApplyUpdateResult = 'activated' | 'blocked_by_draft' | 'no_pending_update';

export interface ApplyUpdateOptions {
  /** 页面是否有未保存的私有草稿；为真时**拒绝**激活，避免无提示重载丢草稿。 */
  readonly hasPrivateDraft: boolean;
}

/** 已装好、等待用户确认的更新。 */
export interface PendingUpdate {
  readonly worker: ServiceWorker;
  readonly registration: ServiceWorkerRegistration;
}

export interface ServiceWorkerHandle {
  readonly registration: RegistrationResult;
  /** 当前待激活的更新；用户确认激活（或草稿被保存后再次调用）之前一直保留。 */
  getPendingUpdate(): PendingUpdate | null;
  /** 激活更新。存在未保存草稿时返回 'blocked_by_draft'，且**不会**发出任何消息。 */
  applyPendingUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult>;
  /** 订阅「待激活更新 / 受控状态」变化；返回取消订阅函数。 */
  subscribe(listener: (snapshot: ServiceWorkerSnapshot) => void): () => void;
}

export interface ServiceWorkerSnapshot {
  readonly status: RegistrationStatus;
  readonly updateReady: boolean;
}

/** 从 Navigator 上安全地取出 ServiceWorkerContainer（测试/奇异环境下可能不存在）。 */
function readServiceWorkerContainer(nav: unknown): ServiceWorkerContainer | null {
  if (nav === null || typeof nav !== 'object') {
    return null;
  }
  const container = (nav as { readonly serviceWorker?: unknown }).serviceWorker;
  if (container === null || typeof container !== 'object') {
    return null;
  }
  if (typeof (container as { readonly register?: unknown }).register !== 'function') {
    return null;
  }
  return container as ServiceWorkerContainer;
}

function currentNavigator(): unknown {
  // 不直接引用全局标识符，避免某些环境下 `navigator` 未定义时抛 ReferenceError。
  return (globalThis as { readonly navigator?: unknown }).navigator;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  return String(error);
}

/**
 * 最近一次注册得到的句柄。应用里只有一个 Service Worker，因此这里是单例。
 *
 * 为什么要暴露它：更新提示的界面（Shell 侧）需要订阅「有待激活更新」并调用
 * `applyPendingUpdate`，但它不应该自己去注册第二次（虽然 `register()` 幂等，
 * 两个互不感知的句柄会让「草稿保护」判定发生在错误的那个实例上）。
 * 界面侧只要 `getServiceWorkerHandle()?.subscribe(...)` 即可。
 */
let activeHandle: ServiceWorkerHandle | null = null;

/**
 * 句柄订阅者。界面（更新提示）需要知道「句柄什么时候才出现」——注册是异步的，
 * 而在注册完成前 `getServiceWorkerHandle()` 返回 null。
 *
 * 为什么不用轮询：一个每 500ms 醒一次的定时器在「根本没有 Service Worker」的环境里
 * 会一直空转（隐私模式、测试环境、被策略阻止），既费电又让测试充满无意义的唤醒。
 * 事件订阅只在真的注册成功后才通知一次。
 */
const handleListeners = new Set<(handle: ServiceWorkerHandle) => void>();

/** 取最近一次注册的句柄；尚未注册时返回 null（界面必须能处理 null）。 */
export function getServiceWorkerHandle(): ServiceWorkerHandle | null {
  return activeHandle;
}

/**
 * 订阅「句柄可用」事件：若已经可用会**同步**回调一次，否则等注册完成时回调。
 * 返回取消订阅函数。
 */
export function subscribeServiceWorkerHandle(listener: (handle: ServiceWorkerHandle) => void): () => void {
  const existing = activeHandle;
  if (existing !== null) {
    listener(existing);
    return () => {
      handleListeners.delete(listener);
    };
  }
  handleListeners.add(listener);
  return () => {
    handleListeners.delete(listener);
  };
}

function publishHandle(handle: ServiceWorkerHandle): void {
  activeHandle = handle;
  for (const listener of handleListeners) {
    listener(handle);
  }
  handleListeners.clear();
}

/**
 * 仅供测试：清空单例句柄与订阅者。
 *
 * 为什么要暴露它：句柄是**进程级单例**（一个页面只有一个 Service Worker），
 * 而测试在同一个模块注册表里连续跑多个用例；没有这个复位，用例之间会通过
 * 「上一个用例留下的句柄」互相影响，产生顺序耦合。生产代码不调用它。
 */
export function resetServiceWorkerHandleForTests(): void {
  activeHandle = null;
  handleListeners.clear();
}

/**
 * 注册 Service Worker。
 *
 * 无论成功、失败还是环境不支持，**都返回结果对象而不抛错**；
 * 调用方（main.tsx）因此可以 `void registerServiceWorker()`，渲染不受影响。
 */
export async function registerServiceWorker(): Promise<ServiceWorkerHandle> {
  const listeners = new Set<(snapshot: ServiceWorkerSnapshot) => void>();
  let pending: PendingUpdate | null = null;
  let status: RegistrationStatus = 'unsupported';
  let reason: string | null = '当前环境没有 navigator.serviceWorker。';
  let registrationRef: ServiceWorkerRegistration | null = null;

  const emit = (): void => {
    const snapshot: ServiceWorkerSnapshot = { status, updateReady: pending !== null };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const container = readServiceWorkerContainer(currentNavigator());

  const makeHandle = (): ServiceWorkerHandle => ({
    registration: { status, registration: registrationRef, reason },
    getPendingUpdate: () => pending,
    applyPendingUpdate: (options) => {
      const update = pending;
      if (update === null) {
        return Promise.resolve<ApplyUpdateResult>('no_pending_update');
      }
      // 「不打断编辑」：存在未保存草稿时**直接拒绝**，新版本继续停在 waiting，
      // 等用户保存草稿后再确认——这里绝不做「先激活再说」。
      if (options.hasPrivateDraft) {
        return Promise.resolve<ApplyUpdateResult>('blocked_by_draft');
      }
      if (typeof update.worker.postMessage !== 'function') {
        return Promise.resolve<ApplyUpdateResult>('no_pending_update');
      }
      // 只发消息：真正的 skipWaiting 在 sw.js 里，页面无法绕过策略直接激活。
      update.worker.postMessage({ type: SKIP_WAITING_MESSAGE });
      return Promise.resolve<ApplyUpdateResult>('activated');
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener({ status, updateReady: pending !== null });
      return () => {
        listeners.delete(listener);
      };
    },
  });

  if (container === null) {
    const unsupported = makeHandle();
    publishHandle(unsupported);
    return unsupported;
  }

  const markUpdateReady = (worker: ServiceWorker): void => {
    if (registrationRef === null) {
      return;
    }
    pending = { worker, registration: registrationRef };
    emit();
  };

  try {
    const registration = await container.register(SERVICE_WORKER_URL, {
      scope: '/',
      // SW 脚本本身在 worker 侧是 no-store；这里再明确不借助 HTTP 缓存判断更新。
      updateViaCache: 'none',
    });
    registrationRef = registration;
    status = 'registered';
    reason = null;

    // 情况一：已有 waiting worker（用户上次没有确认更新）——直接恢复提示。
    const waiting = registration.waiting;
    if (waiting !== null && waiting !== undefined && container.controller !== null) {
      markUpdateReady(waiting);
    }

    // 情况二：本次新装好一个版本。只有「页面已被旧版本控制」才算更新，
    // 首次安装不弹更新提示（那没有可重载的内容）。
    if (typeof registration.addEventListener === 'function') {
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (installing === null || installing === undefined) {
          return;
        }
        if (typeof installing.addEventListener !== 'function') {
          return;
        }
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && container.controller !== null) {
            markUpdateReady(installing);
          }
        });
      });
    }

    // controllerchange：新版本已接管。这里只通知订阅者，**不**自动 reload——
    // 是否重新加载由页面在用户确认后决定。
    // 同时（且只在这里）把当前这版真实加载过的资源补进缓存：受控之后补，才能避免
    // 「首访后立刻离线 → 外壳在、JS 不在」的白屏。
    if (typeof container.addEventListener === 'function') {
      container.addEventListener('controllerchange', () => {
        reportLoadedAssetsToServiceWorker();
        emit();
      });
    }
    // 已经被旧版本控制（例如用户刷新过页面）：立刻补一次，无需等下一次接管。
    if (container.controller !== null) {
      reportLoadedAssetsToServiceWorker();
    }
  } catch (error) {
    status = 'failed';
    reason = errorMessage(error);
    registrationRef = null;
    // 刻意只记录一行警告：注册失败不影响任何渲染路径。
    console.warn('[pwa] Service Worker 注册失败，已降级为在线模式：', reason);
  }

  // 先把句柄发布给订阅者，再把**同一个**实例返回给调用方（保证界面与调用方看到同一份状态）。
  const published = makeHandle();
  publishHandle(published);
  return published;
}

export interface ClearPrivateCachesResult {
  readonly supported: boolean;
  /** 实际删除成功的缓存名。 */
  readonly deleted: readonly string[];
  /** 保留下来的缓存名（正常只有当前公开缓存）。 */
  readonly kept: readonly string[];
}

function readCacheStorage(): CacheStorage | null {
  const storage = (globalThis as { readonly caches?: unknown }).caches;
  if (storage === null || storage === undefined || typeof storage !== 'object') {
    return null;
  }
  if (typeof (storage as { readonly keys?: unknown }).keys !== 'function') {
    return null;
  }
  return storage as CacheStorage;
}

/**
 * 清除私有相关缓存（登出 / 切换工作空间时调用）。
 *
 * 策略：**只保留**当前公开缓存 `PUBLIC_CACHE_NAME`，其余缓存名一律删除。
 * 这么做是因为缓存名无法穷举（历史版本、其它功能、旧版私有缓存），
 * 而「不认识的就不删」会让旧工作空间的数据继续可见——默认删除才是安全的。
 * 公开缓存不含任何私有数据（见 cache-policy 的默认拒绝清单），因此不删。
 */
export async function clearPrivateCaches(): Promise<ClearPrivateCachesResult> {
  const storage = readCacheStorage();
  if (storage === null) {
    return { supported: false, deleted: [], kept: [] };
  }
  try {
    const names = await storage.keys();
    const toDelete = selectCachesToClear(names);
    const deletedFlags = await Promise.all(toDelete.map(async (name) => await storage.delete(name)));
    const deleted = toDelete.filter((_name, index) => deletedFlags[index] === true);
    const kept = names.filter((name) => name === PUBLIC_CACHE_NAME);
    return { supported: true, deleted, kept };
  } catch (error) {
    console.warn('[pwa] 清理私有缓存失败：', errorMessage(error));
    return { supported: false, deleted: [], kept: [] };
  }
}

export interface ObserveOfflineStateOptions {
  /** 每次判定时由调用方提供「当前是否有未保存的私有草稿」（它随编辑状态变化）。 */
  readonly hasPrivateDraft: () => boolean;
  readonly onChange: (state: OfflineState) => void;
}

function readOnlineFlag(): boolean {
  const nav = currentNavigator() as { readonly onLine?: unknown } | null;
  if (nav === null || typeof nav !== 'object' || typeof nav.onLine !== 'boolean') {
    // 探测不到时按「在线」处理：宁可不显示离线横幅，也不谎报离线。
    return true;
  }
  return nav.onLine;
}

/**
 * 订阅在线/离线状态（给界面渲染离线提示用）。
 *
 * 返回的结果由 install-state 的纯函数 `resolveOfflineState` 计算，
 * 因此界面文案与单测断言的是同一份逻辑。`hasPrivateDraft` 每次事件时重新读取。
 */
export function observeOfflineState(options: ObserveOfflineStateOptions): () => void {
  const emit = (): void => {
    options.onChange(resolveOfflineState({ online: readOnlineFlag(), hasPrivateDraft: options.hasPrivateDraft() }));
  };
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  const canListen = typeof target.addEventListener === 'function' && typeof target.removeEventListener === 'function';
  if (canListen) {
    target.addEventListener?.('online', emit);
    target.addEventListener?.('offline', emit);
  }
  emit();
  return () => {
    if (canListen) {
      target.removeEventListener?.('online', emit);
      target.removeEventListener?.('offline', emit);
    }
  };
}
