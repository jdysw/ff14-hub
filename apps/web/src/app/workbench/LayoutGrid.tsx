/**
 * 布局网格（react-grid-layout 2.3.0 集成，阶段 03 / ADR-0003 D13）。
 *
 * 为什么用 RGL 而不是自己实现拖拽：Pointer 事件、碰撞、缩放手柄、触摸行为
 * 都是容易写错且难以测试的部分；仓库已锁定 `react-grid-layout@2.3.0`（React 19 兼容）。
 * 这里**保留默认 DOM 结构**（根 `.react-grid-layout`、每项 `.react-grid-item`），
 * 因为端到端测试就是驱动这套结构。
 *
 * 与 2.x 的实际 API 对齐（**不是** 1.x 的 `isDraggable` / `draggableHandle`）：
 * - `useContainerWidth()` 提供宽度与 `containerRef`，未测量完成前不渲染网格；
 * - 拖拽 / 缩放配置走 `dragConfig` / `resizeConfig`（2.x 用配置对象分组）；
 * - `compactor` 用 `noCompactor`：**不自动压缩**（服务端不会替用户纠偏，本地渲染也不该偷偷
 *   移动组件），但拖拽撞到别的组件时仍由 RGL 的 `moveElement` 把被撞者让开，
 *   因此不会留下非法重叠；缩放产生的重叠由 `resolveOverlaps` 在草稿层消解。
 *
 * `onLayoutChange` 只表示「草稿变了」，**不表示已保存**：保存只发生在显式点击保存时。
 */
import {
  BREAKPOINT_COLUMNS,
  GRID_MARGIN,
  GRID_ROW_HEIGHT,
  LAYOUT_BREAKPOINTS,
  type GridRect,
  type LayoutBreakpoint,
} from '@ff14-hub/shared';
import { useMemo, type ReactNode } from 'react';
import { ResponsiveGridLayout, noCompactor, useContainerWidth, type LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { rectsOfLayout } from './workbench-model';

/** 断点 → 最小容器宽度（像素）。与 `BREAKPOINT_COLUMNS` 一起构成断点定义。 */
export const GRID_BREAKPOINTS: Readonly<Record<LayoutBreakpoint, number>> = {
  desktop: 1024,
  tablet: 640,
  mobile: 0,
};

/** 列数配置：模块级常量，保证传给 RGL 的引用永远稳定。 */
const GRID_COLS: Readonly<Record<LayoutBreakpoint, number>> = { ...BREAKPOINT_COLUMNS };

export interface LayoutGridProps {
  readonly breakpoint: LayoutBreakpoint;
  readonly editing: boolean;
  /** 三个断点各自的布局项：全部提供，RGL 就不需要「从别的断点生成」。 */
  readonly layouts: Readonly<Record<LayoutBreakpoint, readonly LayoutItem[]>>;
  /** 拖动 / 缩放产生的新矩形（**草稿**，不是保存）。 */
  readonly onDraftChange: (rects: readonly GridRect[]) => void;
  /**
   * 每个实例一个子元素，`key` 必须是实例 ID。
   *
   * 子元素会被 RGL 注入 `className` / `style` / `ref` / `onMouseDown` / `onMouseUp` / `onTouchEnd`
   * 以及 react-resizable 追加的缩放手柄，因此子元素必须把这些**全部**透传到自己的根 DOM 节点
   * （见 `WidgetCard`；漏掉 `onMouseDown` 会让拖动静默失效）。
   */
  readonly children: ReactNode;
}

export function LayoutGrid(props: LayoutGridProps) {
  const { width, mounted, containerRef } = useContainerWidth();
  const compactor = useMemo(() => noCompactor, []);
  /**
   * 拖动配置（两处刻意选择，均经真实浏览器验证）：
   *
   * 1. **`threshold: 0`**：RGL 2.3.0 在 `dragThreshold > 0` 时走「mousedown 先挂起、
   *    等第一次 `onDrag` 越过阈值再补发 `onDragStart`」的分支；该分支在本组合下表现为
   *    「按着把手拖动完全不动、且不报错」。设 0 走直通路径，行为可预测。
   * 2. `handle` 指向卡片内的 `.widget-card__drag-handle`。**handle 生效的前提是
   *    子元素把注入的 `onMouseDown` 转发到真正的 DOM 节点**——见 `WidgetCard` 的
   *    `onMouseDown` 注释：漏掉这一步会让拖动永久静默失效（缩放不受影响，所以很容易误判）。
   */
  const dragConfig = useMemo(
    () => ({ enabled: props.editing, bounded: false, threshold: 0, handle: '.widget-card__drag-handle' }),
    [props.editing],
  );
  const resizeConfig = useMemo(() => ({ enabled: props.editing, handles: ['se'] as const }), [props.editing]);

  return (
    <div className="workbench__grid" ref={containerRef} data-testid="layout-grid" data-breakpoint={props.breakpoint}>
      {mounted ? (
        <ResponsiveGridLayout
          width={width}
          breakpoint={props.breakpoint}
          breakpoints={GRID_BREAKPOINTS}
          cols={GRID_COLS}
          // 直接用传入的引用（不在本组件里复制数组）：受控布局的引用稳定性是防抖动的关键。
          layouts={props.layouts}
          rowHeight={GRID_ROW_HEIGHT}
          margin={GRID_MARGIN}
          compactor={compactor}
          dragConfig={dragConfig}
          resizeConfig={resizeConfig}
          onLayoutChange={(layout) => {
            props.onDraftChange(rectsOfLayout(layout));
          }}
        >
          {props.children}
        </ResponsiveGridLayout>
      ) : (
        <p className="panel__muted">正在测量网格容器宽度…</p>
      )}
    </div>
  );
}

/** 断点顺序（界面上的切换按钮顺序）。 */
export const BREAKPOINT_ORDER: readonly LayoutBreakpoint[] = LAYOUT_BREAKPOINTS;
