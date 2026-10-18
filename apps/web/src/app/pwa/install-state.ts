/**
 * 可安装性与离线状态的**纯逻辑**（HUB-012 / ADR-0004 D10）。
 *
 * 为什么单独成文件：这些文案与状态开关是「对用户诚实」的边界。
 * - 离线时**不得**暗示私有修改已经保存到服务端（D10 最后一条）。
 * - 更新可用时**不得**在存在未保存草稿的情况下自动激活（D10「不重载正在编辑的页面」）。
 * 把它们写成不读全局、不产生副作用的纯函数，界面只负责渲染结果，
 * 于是「界面说了什么」可以被单测钉死，而不是散落在 JSX 里。
 */
import { OFFLINE_FALLBACK_PATH } from './cache-policy';

/** 离线提示的统一文案：界面任何位置要说明离线边界时都引用这一份，避免多处措辞漂移。 */
export const OFFLINE_DISCLOSURE =
  '离线：显示的是缓存的公开内容；私有修改不会在离线时持久化到服务端。';

export type OfflineStatus = 'online' | 'offline' | 'offline-unsaved-draft';

export interface OfflineStateInput {
  readonly online: boolean;
  readonly hasPrivateDraft: boolean;
}

export interface OfflineState {
  readonly status: OfflineStatus;
  readonly offline: boolean;
  /** 私有修改是否会被持久化到服务端。离线时**永远**是 false——这是硬约束。 */
  readonly privateWritesPersisted: boolean;
  /** 是否存在「草稿可能丢失」的风险（离线 + 有未保存的私有修改）。 */
  readonly draftAtRisk: boolean;
  readonly message: string;
  readonly detail: string;
}

/**
 * 由「是否在线」与「是否有未保存草稿」推出界面状态。
 * 三个分支都有测试覆盖；离线分支的 `privateWritesPersisted` 恒为 false。
 */
export function resolveOfflineState(input: OfflineStateInput): OfflineState {
  if (input.online) {
    return {
      status: 'online',
      offline: false,
      privateWritesPersisted: true,
      draftAtRisk: false,
      message: '在线',
      detail: '私有修改会即时保存到服务端。',
    };
  }
  if (input.hasPrivateDraft) {
    return {
      status: 'offline-unsaved-draft',
      offline: true,
      privateWritesPersisted: false,
      draftAtRisk: true,
      message: OFFLINE_DISCLOSURE,
      detail: '当前草稿只保留在本机内存，恢复网络后需要重新保存——离线期间不会写入服务端。',
    };
  }
  return {
    status: 'offline',
    offline: true,
    privateWritesPersisted: false,
    draftAtRisk: false,
    message: OFFLINE_DISCLOSURE,
    detail: `可以继续浏览已缓存的公开内容（应用外壳来自 ${OFFLINE_FALLBACK_PATH}）。`,
  };
}

export type InstallabilityStatus = 'installed' | 'installable' | 'unsupported';

export interface InstallStateInput {
  /** `'serviceWorker' in navigator`（由调用方探测，纯函数不读全局）。 */
  readonly hasServiceWorkerSupport: boolean;
  /** 页面是否声明了 `<link rel="manifest">`。 */
  readonly hasManifestLink: boolean;
  /** 是否正以独立窗口运行（`display-mode: standalone` 或 iOS 的 `navigator.standalone`）。 */
  readonly isStandalone: boolean;
  /** 浏览器是否已经给出 `beforeinstallprompt` 安装入口。 */
  readonly installPromptAvailable: boolean;
}

export interface InstallState {
  readonly status: InstallabilityStatus;
  /** 是否可以主动触发浏览器安装提示（iOS 没有这个入口，只能「添加到主屏幕」）。 */
  readonly canPromptInstall: boolean;
  readonly message: string;
  readonly detail: string;
}

/** 由各项能力探测推出可安装状态；缺任何一项都**不谎称**可安装。 */
export function resolveInstallState(input: InstallStateInput): InstallState {
  if (input.isStandalone) {
    return {
      status: 'installed',
      canPromptInstall: false,
      message: '已作为应用安装',
      detail: '当前以独立窗口运行，不再显示浏览器地址栏。',
    };
  }
  const missing: string[] = [];
  if (!input.hasServiceWorkerSupport) {
    missing.push('浏览器不支持 Service Worker');
  }
  if (!input.hasManifestLink) {
    missing.push('页面没有声明 manifest');
  }
  if (missing.length > 0) {
    return {
      status: 'unsupported',
      canPromptInstall: false,
      message: '当前环境不支持安装',
      detail: `${missing.join('；')}，因此只能作为普通网页使用。`,
    };
  }
  return {
    status: 'installable',
    canPromptInstall: input.installPromptAvailable,
    message: '可以安装为应用',
    detail: input.installPromptAvailable
      ? '浏览器已提供安装入口，安装后离线也能打开公开内容。'
      : '浏览器尚未提供安装入口（iOS Safari 请使用「添加到主屏幕」）。',
  };
}

export interface UpdatePromptInput {
  readonly updateReady: boolean;
  readonly hasPrivateDraft: boolean;
}

export interface UpdatePromptState {
  readonly visible: boolean;
  /** 是否允许此时激活新版本（激活会重新加载页面）。 */
  readonly canActivateNow: boolean;
  readonly message: string;
  readonly detail: string;
}

/**
 * 更新提示状态。存在未保存草稿时 `canActivateNow` 恒为 false：
 * 新 SW 已经装好并处于 waiting，但**不激活**（因此页面不会被重载），
 * 直到用户保存草稿并显式确认。
 */
export function resolveUpdatePromptState(input: UpdatePromptInput): UpdatePromptState {
  if (!input.updateReady) {
    return {
      visible: false,
      canActivateNow: false,
      message: '已是最新版本',
      detail: '没有待激活的更新。',
    };
  }
  if (input.hasPrivateDraft) {
    return {
      visible: true,
      canActivateNow: false,
      message: '有新版本可用',
      detail: '检测到未保存的草稿：更新不会自动激活，请先保存（或放弃）草稿再更新。',
    };
  }
  return {
    visible: true,
    canActivateNow: true,
    message: '有新版本可用',
    detail: '点击「立即更新」后页面会重新加载以启用新版本。',
  };
}
