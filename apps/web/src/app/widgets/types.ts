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

/**
 * 模块数据端口（阶段 04 / HUB-010）。
 *
 * 为什么需要它（边界，不允许绕过）：
 * - Widget **拿不到**设备 Token、拿不到 D1 绑定、也拿不到任意 URL 或任意 API 路径。
 * - 它只能调用**该模块在静态端口表里声明过的操作名**（例如 `ff14.navigation` 的
 *   `nav.snapshot`）。未声明的操作名一律被拒绝，因此「注入一个任意 fetch」不可能发生。
 * - 端口实现由应用层构造并持有会话凭证；组件看不到凭证本身，也无法选择 workspace。
 * - 端口在每次调用前复查模块门禁状态：`transitioning` / 停用 / 卸载的模块**不会**执行，
 *   所以数据端口不会绕过生命周期 fence。
 */
export interface ModuleDataPort {
  readonly moduleId: string;
  /** 该模块声明过的操作名（只读视图，便于界面解释「能做什么」）。 */
  readonly operations: readonly string[];
  /** 调用一个已声明的操作。未声明的操作名 → 拒绝（抛错），不做任何网络请求。 */
  call<T = unknown>(operation: string, input?: unknown): Promise<T>;
}

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
  /**
   * 模块数据端口（阶段 04 新增，可选以便阶段 02/03 的既有组件与测试保持可用）。
   * Host 渲染时会传入；组件缺少端口时必须降级（报告配置/不可用错误），不得自行读库或 fetch。
   */
  readonly data?: ModuleDataPort | undefined;
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
