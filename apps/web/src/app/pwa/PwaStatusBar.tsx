/**
 * PWA 状态条（HUB-012 / ADR-0004 D10）——离线提示与「安全更新」入口。
 *
 * 三件事，都刻意做得**可见且不夸大**：
 * 1. **离线提示**：离线时明确写出「显示的是缓存的公开内容；私有修改不会在离线时持久化到服务端」。
 *    文案来自 `install-state.ts` 的纯函数，因此界面与单测断言的是同一份逻辑。
 * 2. **更新提示**：只有 Service Worker 真的处于 waiting（有待激活版本）时才显示；
 *    点击「立即更新」会先检查未保存草稿，有草稿就**拒绝**激活并给出提示，
 *    绝不做「先重载再说」。
 * 3. **注册失败如实说明**：Service Worker 不可用时只记录在控制台并保持静默（没有离线能力时
 *    不显示一个永远不出现的更新按钮，也不假装有离线能力）。
 *
 * 隐私：本组件不读设备 Token、不读缓存内容，只读在线标志、SW 句柄与「是否有草稿」的布尔值。
 */
import { useEffect, useState } from 'react';
import { hasAnyPrivateDraft } from './draft-registry';
import { resolveOfflineState, resolveUpdatePromptState } from './install-state';
import {
  getServiceWorkerHandle,
  observeOfflineState,
  subscribeServiceWorkerHandle,
} from './register-service-worker';

/** 读取在线标志；探测不到时按「在线」处理（宁可不显示，也不谎报离线）。 */
function readOnlineFlag(): boolean {
  const nav = (globalThis as { readonly navigator?: { readonly onLine?: unknown } }).navigator;
  return typeof nav?.onLine === 'boolean' ? nav.onLine : true;
}

export function PwaStatusBar({localMode=false}:{localMode?:boolean}={}) {
  const [offlineState, setOfflineState] = useState(() =>
    resolveOfflineState({ online: readOnlineFlag(), hasPrivateDraft: false }),
  );
  const [updateReady, setUpdateReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 离线状态：事件驱动（online/offline），判定交给 install-state 的纯函数。
  useEffect(() => {
    return observeOfflineState({
      hasPrivateDraft: hasAnyPrivateDraft,
      onChange: (state) => {
        setOfflineState(state);
      },
    });
  }, []);

  // 更新状态：注册是异步的，句柄出现时由事件通知（不轮询），随后订阅它的待激活状态。
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    const unsubscribeHandle = subscribeServiceWorkerHandle((handle) => {
      unsubscribe?.();
      unsubscribe = handle.subscribe((snapshot) => {
        setUpdateReady(snapshot.updateReady);
      });
    });
    return () => {
      unsubscribeHandle();
      unsubscribe?.();
    };
  }, []);

  const draftNow = hasAnyPrivateDraft();
  const prompt = resolveUpdatePromptState({ updateReady, hasPrivateDraft: draftNow });

  async function handleUpdate(): Promise<void> {
    const handle = getServiceWorkerHandle();
    if (handle === null) {
      setNotice('Service Worker 尚未就绪，暂时无法更新。');
      return;
    }
    // 点击这一刻**重新**判定草稿：提示可能是几百毫秒前算出来的。
    const result = await handle.applyPendingUpdate({ hasPrivateDraft: hasAnyPrivateDraft() });
    if (result === 'blocked_by_draft') {
      setNotice('你有未保存的草稿：已暂缓更新。保存或放弃草稿后可以再点「立即更新」。');
      return;
    }
    if (result === 'activated') {
      setNotice('新版本已激活。刷新页面即可使用；此前的草稿已保存，不会被丢弃。');
      return;
    }
    setNotice('当前没有待激活的更新（可能已被激活或已失效）。');
  }

  const showOffline = offlineState.offline;
  if (!showOffline && !prompt.visible && notice === null) {
    return null;
  }

  return (
    <section className="pwa-status" aria-label="PWA 状态" data-testid="pwa-status">
      {showOffline ? (
        <div className="notice notice--warn" aria-live="polite" aria-atomic="true" data-testid="offline-notice">
          <p>{localMode?'当前离线，钓获、收藏和个人设置仍可保存在本机。':offlineState.message}</p>
          <p className="panel__muted">{localMode?'公开活动与目录可能无法更新；恢复网络后可重新读取。':offlineState.detail}</p>
        </div>
      ) : null}

      {prompt.visible ? (
        <div className="notice notice--info" aria-live="polite" aria-atomic="true" data-testid="update-notice">
          <p>{prompt.message}</p>
          <p className="panel__muted">{prompt.detail}</p>
          <button type="button" className="button button--small" onClick={() => void handleUpdate()}>
            立即更新
          </button>
        </div>
      ) : null}

      {notice !== null ? (
        <output className="notice" data-testid="pwa-notice" style={{display:'block'}}>
          {notice}
        </output>
      ) : null}
    </section>
  );
}
