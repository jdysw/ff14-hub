/**
 * Widget Host 的运行时契约（HUB-044）。
 *
 * 边界（对应 docs/module-widget-boundaries.md 3.2）：
 * - **Host 拥有视图状态**：加载态 / 空态 / 错误卡片 / 重试都由 Host 渲染。
 * - **组件是内容生产者**：通过 `reportReady` / `reportEmpty` / `reportAsyncError` 通知 Host。
 * - 组件**不得**自行读库、不得拿设备 Token、不得决定自己的权限；它只拿到已校验的配置。
 *
 * 关键点：React 错误边界**捕获不到异步错误**（Promise 拒绝、定时器里的抛错）。
 * 因此两条路径都必须存在：
 *   渲染期抛错 → 错误边界（WidgetErrorBoundary）
 *   异步失败   → 组件调用 reportAsyncError，由 Host 渲染错误卡片并提供重试
 */
import type { ModuleCapability, ModuleGateStatus } from '@ff14-hub/shared';

/** 单个实例对外的视图阶段。由 Host 持有，组件无权直接改写。 */
export type WidgetPhase = 'loading' | 'ready' | 'empty' | 'error';

/** 错误来源，用于在卡片上给出可解释的提示。 */
export type WidgetErrorKind = 'render' | 'async' | 'config' | 'timeout';

export interface WidgetRuntimeProps {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly widgetId: string;
  /** 已经过 Schema 校验（必要时已迁移）的配置。 */
  readonly config: unknown;
  /**
   * 重试令牌：Host 每次点击重试都会递增。
   * 组件必须把它放进异步副作用的依赖里，否则重试不会重新执行加载逻辑。
   */
  readonly retryToken: number;
  /** 异步初始化完成。不调用则 Host 保持加载态（并有超时兜底）。 */
  reportReady: () => void;
  /** 本次没有内容可展示 → Host 渲染空态。 */
  reportEmpty: () => void;
  /** 异步失败必须走这里（错误边界捕获不到它）。 */
  reportAsyncError: (error: unknown) => void;
}

/**
 * Host 需要的访问判定结果：**门禁状态** + 服务端授予的能力。
 * 用门禁状态而不是有效状态：存在待完成操作时必须降级（`transitioning`），
 * 否则「状态已提交但清理未完成」的模块会被照常执行。
 */
export interface ModuleAccess {
  readonly status: ModuleGateStatus;
  readonly grantedCapabilities: readonly ModuleCapability[];
}
