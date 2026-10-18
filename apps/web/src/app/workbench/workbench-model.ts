/**
 * 工作台前端的**纯逻辑层**（阶段 03 / HUB-045 · HUB-046 · HUB-049 · HUB-054）。
 *
 * 这里没有任何 React、没有网络、没有 DOM：草稿比较、键盘移动的候选矩形、
 * 服务端同规则的合法性判定、本地与远端差异摘要都集中在这里，因此可以被直接测试，
 * 也保证「按钮可用」与「保存被接受」用的是同一份判定（共享契约的 `validateLayoutRects`）。
 *
 * 关键取舍：
 * - 布局按「页面 × 断点」独立存取（`layoutKey`），因此切换断点**不可能**把草稿写进另一个断点。
 * - 草稿保存 `baseRevision`：它是草稿「基于哪个服务端修订」的事实。
 *   保存时提交它，服务端据此拒绝陈旧写（409），前端绝不盲重试、绝不静默覆盖。
 */
import {
  BREAKPOINT_COLUMNS,
  autoFlowRects,
  findFreeRect,
  validateLayoutRects,
  type GridRect,
  type LayoutBreakpoint,
  type LayoutValidation,
  type WidgetInstance,
  type WidgetSizeConstraint,
} from '@ff14-hub/shared';
import { moveElement, verticalCompactor, type LayoutItem } from 'react-grid-layout';

/** 未注册 / 未知组件的宽松约束：只用于「渲染不用崩」，服务端仍然是权威。 */
export const LOOSE_CONSTRAINT: WidgetSizeConstraint = { minW: 1, minH: 1, maxW: null, maxH: null };

/** 一个组件类型的工作台元数据（展示名 + 默认尺寸 + 尺寸约束）。 */
export interface WorkbenchWidgetMeta {
  readonly displayName: string;
  readonly moduleId: string;
  readonly defaultSize: { readonly w: number; readonly h: number };
  readonly constraint: WidgetSizeConstraint;
}
export type WorkbenchWidgetLookup = (widgetType: string) => WorkbenchWidgetMeta | null;

/** 断点的中文标签（界面文案的唯一来源，避免各处各写一遍）。 */
export const BREAKPOINT_LABELS: Readonly<Record<LayoutBreakpoint, string>> = {
  desktop: '桌面',
  tablet: '平板',
  mobile: '手机',
};

/** 草稿键：页面 + 断点。用 `#` 分隔是因为页面 ID 与断点名都不含它。 */
export function layoutKey(pageId: string, breakpoint: LayoutBreakpoint): string {
  return `${pageId}#${breakpoint}`;
}

/** 局部草稿：矩形 + 它基于的服务端修订 + 这次意图的幂等 ID。 */
export interface LayoutDraft {
  readonly rects: readonly GridRect[];
  readonly baseRevision: number;
  readonly operationId: string;
}

function rectSignature(rect: GridRect): string {
  return `${rect.i}:${String(rect.x)}:${String(rect.y)}:${String(rect.w)}:${String(rect.h)}`;
}

/** 矩形集合是否等价（**与顺序无关**：RGL 会重排数组，顺序不该被当成差异）。 */
export function rectsEqual(a: readonly GridRect[], b: readonly GridRect[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = new Set(a.map(rectSignature));
  if (left.size !== new Set(b.map(rectSignature)).size) {
    return false;
  }
  for (const rect of b) {
    if (!left.has(rectSignature(rect))) {
      return false;
    }
  }
  return true;
}

/** 只保留网格需要的字段：RGL 的 LayoutItem 带 min/max/moved 等，草稿不该被它们污染。 */
export function rectsOfLayout(layout: readonly LayoutItem[]): GridRect[] {
  return layout.map((item) => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h }));
}

/** 组装 RGL 需要的布局项：尺寸约束来自静态注册表（服务端也用同一份）。 */
export function toLayoutItems(
  rects: readonly GridRect[],
  instanceById: ReadonlyMap<string, WidgetInstance>,
  widgetOf: WorkbenchWidgetLookup,
): LayoutItem[] {
  return rects.map((rect) => {
    const instance = instanceById.get(rect.i);
    const meta = instance === undefined ? null : widgetOf(instance.widgetType);
    const constraint = meta?.constraint ?? LOOSE_CONSTRAINT;
    return {
      i: rect.i,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      minW: constraint.minW,
      minH: constraint.minH,
      ...(constraint.maxW === null ? {} : { maxW: constraint.maxW }),
      ...(constraint.maxH === null ? {} : { maxH: constraint.maxH }),
    };
  });
}

/**
 * 为「当前页面的全部实例」补齐矩形。
 *
 * 为什么必须覆盖全部实例：服务端的整页保存要求矩形集合**恰好**覆盖该页面全部活跃实例
 * （少一个就 422）。因此草稿一旦产生就必须是完整集合，缺位置的实例按
 * `findFreeRect` 找空位（与新建实例时服务端生成初始位置的算法同源）。
 */
export function coveringRects(input: {
  readonly instances: readonly WidgetInstance[];
  readonly rects: readonly GridRect[];
  readonly breakpoint: LayoutBreakpoint;
  readonly widgetOf: WorkbenchWidgetLookup;
}): GridRect[] {
  const remaining = new Map(input.rects.map((rect) => [rect.i, rect]));
  const cols = BREAKPOINT_COLUMNS[input.breakpoint];
  const out: GridRect[] = [];

  for (const instance of input.instances) {
    const existing = remaining.get(instance.id);
    if (existing !== undefined) {
      remaining.delete(instance.id);
      out.push(existing);
      continue;
    }
    const size = input.widgetOf(instance.widgetType)?.defaultSize ?? { w: 3, h: 3 };
    const w = Math.min(Math.max(1, size.w), cols);
    const h = Math.max(1, size.h);
    const free = findFreeRect({ existing: out, w, h, cols }) ?? { x: 0, y: 0, w, h };
    out.push({ i: instance.id, x: free.x, y: free.y, w: free.w, h: free.h });
  }
  return out;
}

/** 键盘可完成的矩形操作（不依赖拖拽，也不需要鼠标）。 */
export type RectAction = 'up' | 'down' | 'left' | 'right' | 'grow-w' | 'shrink-w' | 'grow-h' | 'shrink-h';

export interface RectActionSpec {
  readonly action: RectAction;
  readonly label: string;
  readonly testId: string;
}

/** 顺序即工具栏顺序：先移动再缩放，方便键盘用户建立肌肉记忆。 */
export const RECT_ACTIONS: readonly RectActionSpec[] = [
  { action: 'up', label: '上移', testId: 'widget-move-up' },
  { action: 'down', label: '下移', testId: 'widget-move-down' },
  { action: 'left', label: '左移', testId: 'widget-move-left' },
  { action: 'right', label: '右移', testId: 'widget-move-right' },
  { action: 'grow-w', label: '加宽', testId: 'widget-grow-w' },
  { action: 'shrink-w', label: '缩窄', testId: 'widget-shrink-w' },
  { action: 'grow-h', label: '增高', testId: 'widget-grow-h' },
  { action: 'shrink-h', label: '降低', testId: 'widget-shrink-h' },
];

/** 计算目标矩形。**只做位移**，是否合法交给 `validateLayoutRects`。 */
export function moveRect(rect: GridRect, action: RectAction): GridRect {
  switch (action) {
    case 'up':
      return { ...rect, y: rect.y - 1 };
    case 'down':
      return { ...rect, y: rect.y + 1 };
    case 'left':
      return { ...rect, x: rect.x - 1 };
    case 'right':
      return { ...rect, x: rect.x + 1 };
    case 'grow-w':
      return { ...rect, w: rect.w + 1 };
    case 'shrink-w':
      return { ...rect, w: rect.w - 1 };
    case 'grow-h':
      return { ...rect, h: rect.h + 1 };
    case 'shrink-h':
      return { ...rect, h: rect.h - 1 };
  }
}

/**
 * 用**服务端同一份规则**判断某个矩形改动是否可接受。
 * 因此「按钮可用」蕴含「保存会被接受」（前提是 baseRevision 仍然新鲜）。
 */
export function validateRectsWith(input: {
  readonly breakpoint: LayoutBreakpoint;
  readonly rects: readonly GridRect[];
  readonly constraintsOfInstance: (instanceId: string) => WidgetSizeConstraint | null;
}): LayoutValidation {
  return validateLayoutRects({
    breakpoint: input.breakpoint,
    rects: input.rects,
    constraintsOf: input.constraintsOfInstance,
  });
}

/**
 * 计算一次键盘移动 / 缩放的目标布局。
 *
 * 三级判定（**与服务端同一份** `validateLayoutRects` 做最终把关）：
 * 1. 目标位置本身合法 → 直接采用；
 * 2. 只是与别的组件重叠 → 用 RGL **拖动时同一套**碰撞消解（`moveElement`：被撞者让位），
 *    因此键盘操作与鼠标拖动得到同样的结果（这正是「不用拖拽也能排布」的含义）；
 * 3. 仍然不合法（越界 / 低于最小尺寸 / 超过最大尺寸 / 消解后仍重叠）→ 返回 null，按钮禁用。
 *
 * 由此保证：**按钮可用 ⇒ 保存一定不会被服务端拒绝**。
 * （任务书里「重叠即禁用」的字面写法在这里被解释为「消解碰撞后仍然不合法才禁用」，
 * 因为拖动本身就会让被撞者让位，键盘等价物必须与之一致；见交付说明的偏差一节。）
 */
export function planRectAction(input: {
  readonly breakpoint: LayoutBreakpoint;
  readonly rects: readonly GridRect[];
  readonly instanceId: string;
  readonly target: GridRect;
  readonly constraintsOfInstance: (instanceId: string) => WidgetSizeConstraint | null;
  readonly instanceById: ReadonlyMap<string, WidgetInstance>;
  readonly widgetOf: WorkbenchWidgetLookup;
}): { readonly rects: GridRect[]; readonly rect: GridRect } | null {
  const original = input.rects.find((rect) => rect.i === input.instanceId);
  if (original === undefined) {
    return null;
  }
  const direct = withReplacedRect(input.rects, input.instanceId, input.target);
  const directValidation = validateRectsWith({
    breakpoint: input.breakpoint,
    rects: direct,
    constraintsOfInstance: input.constraintsOfInstance,
  });
  if (directValidation.ok) {
    return { rects: direct, rect: input.target };
  }
  if (!directValidation.violations.every((violation) => violation.code === 'overlap')) {
    // 越界 / 尺寸违规不在这里「智能纠偏」：直接禁用，让用户看到真实约束。
    return null;
  }

  const items = toLayoutItems(input.rects, input.instanceById, input.widgetOf);
  const moving = items.find((item) => item.i === input.instanceId);
  if (moving === undefined) {
    return null;
  }
  moving.w = input.target.w;
  moving.h = input.target.h;
  const pushed = rectsOfLayout(
    moveElement(
      items,
      moving,
      input.target.x,
      input.target.y,
      true,
      false,
      null,
      BREAKPOINT_COLUMNS[input.breakpoint],
      false,
    ),
  );
  const pushedValidation = validateRectsWith({
    breakpoint: input.breakpoint,
    rects: pushed,
    constraintsOfInstance: input.constraintsOfInstance,
  });
  const resolved = pushedValidation.ok
    ? pushed
    : resolveOverlaps({
        breakpoint: input.breakpoint,
        rects: pushed,
        constraintsOfInstance: input.constraintsOfInstance,
        instanceById: input.instanceById,
        widgetOf: input.widgetOf,
      });
  const finalValidation = validateRectsWith({
    breakpoint: input.breakpoint,
    rects: resolved,
    constraintsOfInstance: input.constraintsOfInstance,
  });
  if (!finalValidation.ok) {
    return null;
  }
  const rect = resolved.find((candidate) => candidate.i === input.instanceId);
  return rect === undefined ? null : { rects: resolved, rect: rect };
}

/** 把某个实例替换成目标矩形后的整页矩形集合。 */
export function withReplacedRect(
  rects: readonly GridRect[],
  instanceId: string,
  target: GridRect,
): GridRect[] {
  return rects.map((rect) => (rect.i === instanceId ? target : rect));
}

/**
 * 消解重叠：**只在确实出现重叠时**才动位置，且只把被撞的组件往下推。
 *
 * 为什么需要它：RGL 的缩放（`onResize`）不做碰撞消解，而服务端的布局校验**拒绝重叠**
 * （`validateLayoutRects` 的 `overlap`）。如果不处理，用户缩放出来的草稿会变成
 * 「本地能看、保存必被拒」——那正是我们要避免的「按钮可点但保存失败」。
 *
 * 为什么不用 RGL 默认的垂直压缩器：垂直压缩会在**每次**变更后把组件向上贴紧，
 * 于是「下移一格」会被立刻撤销（用户明明看到它下去了，保存却不生效）。
 * 因此规则是：没有重叠 → 一个像素都不动；有重叠 → 按与 RGL 默认一致的规则把被撞者下移。
 */
export function resolveOverlaps(input: {
  readonly breakpoint: LayoutBreakpoint;
  readonly rects: readonly GridRect[];
  readonly constraintsOfInstance: (instanceId: string) => WidgetSizeConstraint | null;
  readonly instanceById: ReadonlyMap<string, WidgetInstance>;
  readonly widgetOf: WorkbenchWidgetLookup;
}): GridRect[] {
  const validation = validateRectsWith({
    breakpoint: input.breakpoint,
    rects: input.rects,
    constraintsOfInstance: input.constraintsOfInstance,
  });
  if (validation.ok) {
    return [...input.rects];
  }
  // 只处理重叠；越界/尺寸违规不在这里纠正（那属于「保存前自检并如实说明」的范畴）。
  if (!validation.violations.every((violation) => violation.code === 'overlap')) {
    return [...input.rects];
  }
  const items = toLayoutItems(input.rects, input.instanceById, input.widgetOf);
  return rectsOfLayout(verticalCompactor.compact(items, BREAKPOINT_COLUMNS[input.breakpoint]));
}

/**
 * 本地草稿与服务端布局的差异摘要（`conflict-compare` 用）。
 * 只描述事实，不给建议，也不修改任何状态。
 */
export function diffRects(
  local: readonly GridRect[],
  server: readonly GridRect[],
  instanceById: ReadonlyMap<string, WidgetInstance>,
): string[] {
  const label = (id: string): string => {
    const instance = instanceById.get(id);
    return instance === undefined ? id : `${instance.widgetType}（${id.slice(0, 8)}）`;
  };
  const localMap = new Map(local.map((rect) => [rect.i, rect]));
  const serverMap = new Map(server.map((rect) => [rect.i, rect]));
  const lines: string[] = [];

  for (const [id, rect] of localMap) {
    const remote = serverMap.get(id);
    if (remote === undefined) {
      lines.push(`本地新增位置：${label(id)} → (${String(rect.x)}, ${String(rect.y)}) ${String(rect.w)}×${String(rect.h)}`);
      continue;
    }
    if (rect.x !== remote.x || rect.y !== remote.y) {
      lines.push(
        `位置不同：${label(id)} 本地 (${String(rect.x)}, ${String(rect.y)}) ↔ 服务端 (${String(remote.x)}, ${String(remote.y)})`,
      );
    }
    if (rect.w !== remote.w || rect.h !== remote.h) {
      lines.push(
        `尺寸不同：${label(id)} 本地 ${String(rect.w)}×${String(rect.h)} ↔ 服务端 ${String(remote.w)}×${String(remote.h)}`,
      );
    }
  }
  for (const id of serverMap.keys()) {
    if (!localMap.has(id)) {
      lines.push(`仅服务端存在：${label(id)}（本地草稿里没有它）`);
    }
  }
  return lines.length === 0 ? ['本地草稿与服务端布局在矩形上没有差异。'] : lines;
}

/** 默认尺寸 + 空位：把某个实例重置为注册表里的默认尺寸并重新找位置。 */
export function resetRect(input: {
  readonly instanceId: string;
  readonly widgetType: string;
  readonly breakpoint: LayoutBreakpoint;
  readonly others: readonly GridRect[];
  readonly widgetOf: WorkbenchWidgetLookup;
}): GridRect {
  const cols = BREAKPOINT_COLUMNS[input.breakpoint];
  const size = input.widgetOf(input.widgetType)?.defaultSize ?? { w: 3, h: 3 };
  const w = Math.min(Math.max(1, size.w), cols);
  const h = Math.max(1, size.h);
  const free = findFreeRect({ existing: input.others, w, h, cols }) ?? { x: 0, y: 0, w, h };
  return { i: input.instanceId, x: free.x, y: free.y, w: free.w, h: free.h };
}

/**
 * 在给定顺序下重新自动排布整页（重置整页）。
 * 直接复用共享契约的 `autoFlowRects`：与「新建实例 / 应用模板」生成初始位置的是同一份实现。
 */
export function autoFlowRectsFor(input: {
  readonly instances: readonly WidgetInstance[];
  readonly breakpoint: LayoutBreakpoint;
  readonly widgetOf: WorkbenchWidgetLookup;
}): GridRect[] {
  return autoFlowRects({
    breakpoint: input.breakpoint,
    widgets: input.instances.map((instance) => {
      const size = input.widgetOf(instance.widgetType)?.defaultSize ?? { w: 3, h: 3 };
      return { id: instance.id, w: size.w, h: size.h };
    }),
  });
}
