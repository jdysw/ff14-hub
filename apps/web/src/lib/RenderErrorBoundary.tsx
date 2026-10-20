/**
 * 渲染期错误边界（HUB-044 通用件）。
 *
 * 为什么必须存在：渲染期抛错如果没人捕获，会一路上抛并卸载整棵子树——
 * 一个坏组件就能带走它的兄弟节点乃至整个 Shell。
 *
 * 异步请求和事件错误仍由对应业务组件处理。这里不展示异常详情，避免泄露私有输入。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface RenderErrorBoundaryProps {
  readonly children: ReactNode;
  /** Optional integration hook; the boundary always provides its own safe retry view. */
  readonly onError?: (error: unknown) => void;
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
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    return this.state.failed ? <section className="shell" role="alert">
      <h1>页面暂时无法显示</h1><p>个人数据仍保存在本机。请重试，或重新打开页面。</p>
      <button type="button" className="button" onClick={()=>this.setState({failed:false})}>重试页面</button>
    </section> : this.props.children;
  }
}
