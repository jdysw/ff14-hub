/**
 * 渲染期错误边界（HUB-044 通用件）。
 *
 * 为什么必须存在：渲染期抛错如果没人捕获，会一路上抛并卸载整棵子树——
 * 一个坏组件就能带走它的兄弟节点乃至整个 Shell。
 *
 * 为什么它**不够**：React 错误边界捕获不到异步错误（Promise 拒绝、定时器抛错、
 * 事件处理器里的 throw）。那条路径必须由组件主动上报（见 WidgetHost 的 reportAsyncError）。
 * 两者都不可省。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface RenderErrorBoundaryProps {
  readonly children: ReactNode;
  /** 捕获到渲染期错误时通知上层；上层据此渲染错误卡片并提供重试。 */
  readonly onError: (error: unknown) => void;
}

interface RenderErrorBoundaryState {
  readonly failed: boolean;
}

export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  override state: RenderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RenderErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    // 失败后不渲染任何内容：错误卡片由上层渲染，因此兄弟节点完全不受影响。
    return this.state.failed ? null : this.props.children;
  }
}

/** 把未知异常转成可展示的一句话。 */
export function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return '未知错误';
}
