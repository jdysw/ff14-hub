// @vitest-environment jsdom
/**
 * PWA 状态条与草稿登记处的测试（HUB-012 / ADR-0004 D10）。
 *
 * 这里断言的是**行为边界**，不是实现细节：
 * - 离线时必须显示「私有修改不会持久化到服务端」的诚实说明；
 * - 有未保存草稿时，点「立即更新」**不能**发出 skipWaiting 消息（否则无提示重载会丢草稿）；
 * - 没有草稿时才允许激活更新。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaStatusBar } from '../src/app/pwa/PwaStatusBar';
import {
  hasAnyPrivateDraft,
  registerPrivateDraftSource,
  resetPrivateDraftSources,
} from '../src/app/pwa/draft-registry';
import { OFFLINE_DISCLOSURE } from '../src/app/pwa/install-state';
import {
  SKIP_WAITING_MESSAGE,
  registerServiceWorker,
  resetServiceWorkerHandleForTests,
} from '../src/app/pwa/register-service-worker';

afterEach(() => {
  cleanup();
  resetPrivateDraftSources();
  // 句柄是进程级单例：不复位会让用例之间通过「上一个用例留下的句柄」互相影响。
  resetServiceWorkerHandleForTests();
  vi.restoreAllMocks();
});

describe('私有草稿登记处', () => {
  it('没有任何来源时视为「没有草稿」', () => {
    expect(hasAnyPrivateDraft()).toBe(false);
  });

  it('任一来源为真即为「有草稿」；注销后不再计入', () => {
    const unregister = registerPrivateDraftSource(() => true);
    expect(hasAnyPrivateDraft()).toBe(true);
    unregister();
    expect(hasAnyPrivateDraft()).toBe(false);
  });

  it('来源抛错按「有草稿」处理（保守：宁可晚更新也不丢输入）', () => {
    registerPrivateDraftSource(() => {
      throw new Error('view is unmounting');
    });
    expect(hasAnyPrivateDraft()).toBe(true);
  });
});

/** 造一个「已被旧版本控制、且存在 waiting worker」的容器：这才算真正的更新待激活。 */
function installFakeServiceWorker(): { readonly postMessage: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn();
  const worker = { postMessage, state: 'installed', addEventListener: vi.fn() };
  const registration = {
    waiting: worker,
    installing: null,
    scope: '/',
    addEventListener: vi.fn(),
  };
  const container = {
    controller: {},
    // 刻意不用 async 箭头：这里没有 await，返回已 resolve 的 Promise 即可。
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: vi.fn(),
  };
  Object.defineProperty(window.navigator, 'serviceWorker', { value: container, configurable: true });
  return { postMessage };
}

describe('PwaStatusBar', () => {
  beforeEach(() => {
    // 离线：状态条必须如实说明私有修改不会被持久化。
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
  });

  it('离线时显示诚实说明（不假装已保存）', () => {
    render(<PwaStatusBar />);
    const notice = screen.getByTestId('offline-notice');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain(OFFLINE_DISCLOSURE);
  });

  it('没有待激活更新时，不显示更新按钮', () => {
    render(<PwaStatusBar />);
    expect(screen.queryByTestId('update-notice')).toBeNull();
  });

  it('注册晚于挂载时，句柄出现后仍然显示更新按钮（事件驱动，不轮询）', async () => {
    installFakeServiceWorker();
    render(<PwaStatusBar />);
    // 组件先挂载（此时还没有句柄），注册随后完成。
    await registerServiceWorker();
    expect(await screen.findByTestId('update-notice')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即更新' })).toBeTruthy();
  });

  it('有待激活更新时显示按钮；有草稿时点击**拒绝**激活且不发送消息', async () => {
    const { postMessage } = installFakeServiceWorker();
    await registerServiceWorker();

    const unregister = registerPrivateDraftSource(() => true);
    render(<PwaStatusBar />);

    const button = await screen.findByRole('button', { name: '立即更新' });
    button.click();

    expect(await screen.findByTestId('pwa-notice')).toBeTruthy();
    expect(screen.getByTestId('pwa-notice').textContent).toContain('已暂缓更新');
    expect(postMessage).not.toHaveBeenCalled();

    // 草稿保存后（来源返回 false）再点一次：这次必须真的发出激活消息。
    unregister();
    resetPrivateDraftSources();
    button.click();
    expect(postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING_MESSAGE });
  });
});
