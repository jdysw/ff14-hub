/**
 * 工作台契约（阶段 03 / HUB-045 · HUB-046 · HUB-049 · HUB-054）。
 *
 * 定位（与 `module-manifest.ts` 同层）：**纯类型 + 纯函数**，无 DOM、无 D1、无 React。
 * 因此服务端校验、导入路径校验、前端草稿校验与测试共用同一份判定，不会出现
 * 「前端拦住、后端放行」这类只在某个入口生效的规则。
 *
 * 硬约束（对应规划 INV-02 / CUSTOM-01…08 / ADR-010）：
 * - 布局按「页面 + 断点」独立保存、独立修订；桌面 12 / 平板 8 / 手机 4 列（`BREAKPOINT_COLUMNS`）。
 * - 位置与尺寸必须遵守 Widget Manifest 的 min/max/defaultSize，不越界、不非法重叠。
 *   本文件的 `validateLayoutRects` 是**唯一**判定实现，服务端与导入都必须调用它。
 * - 删除一律用**墓碑**（`deleted_at`），不做硬删除，以便后续跨设备同步（规划 5.3）。
 * - 备份**只**含工作台配置；绝不含设备 Token、恢复密钥、WebDAV 凭证或任何服务端秘密。
 *
 * 明确定位为「非持久契约」的东西：本文件里的模板是**可自由修改的起点**，
 * 真实业务模块（导航 / 钓鱼 / 高难）尚未实现，因此模板只放置已注册的**演示**组件，
 * 并用 `honestyNote` 如实说明，绝不编造游戏数据。
 */
import { z } from 'zod';
import { BREAKPOINT_COLUMNS, LAYOUT_BREAKPOINTS, type LayoutBreakpoint, WIDGET_ID_PATTERN } from './module-manifest';

export { BREAKPOINT_COLUMNS, LAYOUT_BREAKPOINTS };
export type { LayoutBreakpoint };

// ---------------------------------------------------------------------------
// 容量与边界常量（单一来源：服务端、前端与测试都从这里取值）
// ---------------------------------------------------------------------------

/** 单个工作空间的活跃页面上限。 */
export const MAX_PAGES_PER_WORKSPACE = 30;
/** 单个页面的活跃 Widget 实例上限。 */
export const MAX_WIDGETS_PER_PAGE = 40;
/** 单个实例配置序列化后的字节上限（超限 413，不截断、不静默丢弃字段）。 */
export const MAX_WIDGET_CONFIG_BYTES = 4 * 1024;
/** 页面名长度上限。 */
export const MAX_PAGE_NAME_LENGTH = 60;
/** 网格纵坐标上限：防止「无限往下堆」把布局变成不可用形态。 */
export const MAX_LAYOUT_Y = 400;
/**
 * 备份文档字节上限，**导出与导入使用同一个常量**。
 *
 * 为什么必须相同（复核要求：不做「导出大于导入上限」的自相矛盾设计）：
 * - 全局 `MAX_JSON_BODY_BYTES`（64 KiB）是写请求体的硬上限，导入无法超过它；
 * - 因此导出在序列化后若超过本上限，**显式失败并说明可减少的内容**，而不是产出一个
 *   永远导不回来的文件；
 * - 断言有测试保证：正常规模的工作台导出结果必定能重新导入。
 */
export const WORKBENCH_BACKUP_MAX_BYTES = 48 * 1024;
/** 备份中允许的页面数与实例总数（与上面的字节上限共同构成容量声明）。 */
export const MAX_BACKUP_PAGES = MAX_PAGES_PER_WORKSPACE;
export const MAX_BACKUP_INSTANCES = MAX_PAGES_PER_WORKSPACE * MAX_WIDGETS_PER_PAGE;

/** 网格行高（像素）。前端渲染与「用计算出的像素高度做断言」的测试共用。 */
export const GRID_ROW_HEIGHT = 56;
/** 网格项间距（像素）。 */
export const GRID_MARGIN: readonly [number, number] = [8, 8];

// ---------------------------------------------------------------------------
// 网格矩形与布局校验（唯一判定实现）
// ---------------------------------------------------------------------------

/** 一个 Widget 实例在某个断点下的网格矩形。`i` 是实例 ID。 */
export interface GridRect {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const gridRectSchema = z
  .object({
    i: z.string().min(1).max(64),
    x: z.number().int().min(0).max(BREAKPOINT_COLUMNS.desktop),
    y: z.number().int().min(0).max(MAX_LAYOUT_Y),
    w: z.number().int().min(1).max(BREAKPOINT_COLUMNS.desktop),
    h: z.number().int().min(1).max(64),
  })
  .strict();

/** 某个 Widget 类型的尺寸约束（来自静态注册表，服务端不接受客户端提交的尺寸约束）。 */
export interface WidgetSizeConstraint {
  readonly minW: number;
  readonly minH: number;
  readonly maxW: number | null;
  readonly maxH: number | null;
}

export type LayoutViolationCode =
  | 'unknown_widget'
  | 'duplicate_widget'
  | 'negative_position'
  | 'size_below_min'
  | 'size_above_max'
  | 'out_of_bounds'
  | 'overlap';

export interface LayoutViolation {
  readonly widgetId: string;
  readonly code: LayoutViolationCode;
  readonly detail: string;
}

export type LayoutValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly LayoutViolation[] };

/** 某个断点的列数。断点必须来自白名单，未知断点由调用方先拒绝。 */
export function columnsForBreakpoint(breakpoint: LayoutBreakpoint): number {
  return BREAKPOINT_COLUMNS[breakpoint];
}

function overlaps(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 校验单个矩形（归属、重复、坐标、尺寸）。
 *
 * 从 `validateLayoutRects` 抽出来是为了让两处都保持在认知复杂度门槛内，
 * 而不是把一段长 `if` 链塞进同一个函数（Sonar 规则 S3776）。
 * 返回 true 表示这一项**已产生**违规、不应再参与重叠检查。
 */
function validateSingleRect(input: {
  readonly rect: GridRect;
  readonly cols: number;
  readonly seen: Set<string>;
  readonly constraintsOf: (widgetId: string) => WidgetSizeConstraint | null;
  readonly violations: LayoutViolation[];
}): boolean {
  const rect = input.rect;
  if (input.seen.has(rect.i)) {
    input.violations.push({ widgetId: rect.i, code: 'duplicate_widget', detail: '同一实例在同一断点出现了多次' });
    return true;
  }
  input.seen.add(rect.i);

  const constraint = input.constraintsOf(rect.i);
  if (constraint === null) {
    input.violations.push({ widgetId: rect.i, code: 'unknown_widget', detail: '该实例不属于本页面或组件类型未注册' });
    return true;
  }
  if (rect.x < 0 || rect.y < 0) {
    input.violations.push({ widgetId: rect.i, code: 'negative_position', detail: '坐标不能为负' });
    return true;
  }
  if (rect.w < constraint.minW || rect.h < constraint.minH) {
    input.violations.push({
      widgetId: rect.i,
      code: 'size_below_min',
      detail: `尺寸 ${rect.w}×${rect.h} 小于该组件的最小尺寸 ${constraint.minW}×${constraint.minH}`,
    });
    return true;
  }
  if (
    (constraint.maxW !== null && rect.w > constraint.maxW) ||
    (constraint.maxH !== null && rect.h > constraint.maxH)
  ) {
    input.violations.push({
      widgetId: rect.i,
      code: 'size_above_max',
      detail: `尺寸 ${rect.w}×${rect.h} 超过该组件的最大尺寸 ${constraint.maxW ?? '∞'}×${constraint.maxH ?? '∞'}`,
    });
    return true;
  }
  if (rect.x + rect.w > input.cols || rect.y + rect.h > MAX_LAYOUT_Y + 1) {
    input.violations.push({
      widgetId: rect.i,
      code: 'out_of_bounds',
      detail: `矩形 (x=${rect.x}, y=${rect.y}, w=${rect.w}, h=${rect.h}) 超出 ${input.cols} 列网格边界`,
    });
    return true;
  }
  return false;
}

/** 两两重叠检查（只对已通过单项校验的矩形做，避免同一错误重复报多条）。 */
function collectOverlaps(rects: readonly GridRect[], violations: LayoutViolation[]): void {
  for (let a = 0; a < rects.length; a += 1) {
    for (let b = a + 1; b < rects.length; b += 1) {
      const first = rects[a];
      const second = rects[b];
      if (first === undefined || second === undefined) {
        continue;
      }
      if (overlaps(first, second)) {
        violations.push({ widgetId: second.i, code: 'overlap', detail: `与实例 ${first.i} 的矩形重叠` });
      }
    }
  }
}

/**
 * 校验一组矩形是否构成该断点下的合法布局。
 *
 * 规则（全部必须满足）：
 * 1. 每个 `i` 必须在 `constraintsOf` 中有定义（= 该页面确实存在这个实例，且其 Widget 类型已注册）；
 * 2. `i` 不得重复；
 * 3. 坐标非负，`x + w <= cols`、`y + h <= MAX_LAYOUT_Y + 1`；
 * 4. 尺寸落在 min/max 区间内；
 * 5. 任意两项**不得重叠**。
 *
 * 注意：这里**不**做「自动压缩」或「自动纠偏」——服务端只拒绝非法输入，
 * 不替用户悄悄改布局（那正是「静默覆盖」的一种）。
 */
export function validateLayoutRects(input: {
  readonly breakpoint: LayoutBreakpoint;
  readonly rects: readonly GridRect[];
  readonly constraintsOf: (widgetId: string) => WidgetSizeConstraint | null;
}): LayoutValidation {
  const cols = columnsForBreakpoint(input.breakpoint);
  const violations: LayoutViolation[] = [];
  const seen = new Set<string>();
  const valid: GridRect[] = [];

  for (const rect of input.rects) {
    const failed = validateSingleRect({ rect, cols, seen, constraintsOf: input.constraintsOf, violations });
    if (!failed) {
      valid.push(rect);
    }
  }

  collectOverlaps(valid, violations);

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * 自动排布：把若干「已知尺寸」的组件按从左到右、从上到下的顺序放进网格。
 *
 * 用途（只有两处，且都必须是**新建**而非覆盖已有布局）：
 * - 新建实例时给三个断点各生成一个初始位置；
 * - 应用模板时为模板页面的三个断点生成初始布局。
 *
 * 之所以需要它：新建实例必须立刻在所有断点下可渲染，否则用户切到手机端会看到「有实例但没位置」
 * 的空洞状态。它**不**用于保存路径——保存路径只做校验，绝不自动纠偏。
 */
export function autoFlowRects(input: {
  readonly breakpoint: LayoutBreakpoint;
  readonly widgets: readonly { readonly id: string; readonly w: number; readonly h: number }[];
}): GridRect[] {
  const cols = columnsForBreakpoint(input.breakpoint);
  const rects: GridRect[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const widget of input.widgets) {
    // 单列窄屏上，超宽组件被夹到可用列数（这是**生成**初始布局，不是修改用户已有布局）。
    const w = Math.min(Math.max(1, widget.w), cols);
    const h = Math.max(1, widget.h);
    if (cursorX + w > cols) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    rects.push({ i: widget.id, x: cursorX, y: cursorY, w, h });
    cursorX += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return rects;
}

/**
 * 在已有矩形之间为新组件找一个不与任何现有项重叠的位置，并保证落在网格内。
 *
 * 用途：**新建**实例时为三个断点各生成初始位置。它只做「找空位」，
 * 不移动任何已有组件，也绝不用于保存路径（保存路径只校验、不纠偏）。
 *
 * 算法刻意保持简单可预测：从上到下逐行扫描 y，每行从左到右扫描 x，
 * 返回第一个不越界且不与任何已有矩形重叠的位置。找不到（页面被塞满）时返回 null，
 * 由调用方明确拒绝而不是硬塞一个重叠位置。
 */
export function findFreeRect(input: {
  readonly existing: readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number }[];
  readonly w: number;
  readonly h: number;
  readonly cols: number;
}): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null {
  const w = Math.min(Math.max(1, input.w), input.cols);
  const h = Math.max(1, input.h);
  for (let y = 0; y <= MAX_LAYOUT_Y; y += 1) {
    for (let x = 0; x + w <= input.cols; x += 1) {
      const candidate = { x, y, w, h };
      const collides = input.existing.some((rect) =>
        candidate.x < rect.x + rect.w &&
        rect.x < candidate.x + candidate.w &&
        candidate.y < rect.y + rect.h &&
        rect.y < candidate.y + candidate.h,
      );
      if (!collides) {
        return candidate;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 幂等 operationId
// ---------------------------------------------------------------------------

/**
 * 幂等操作 ID。
 * 长度下限 8 是为了让「客户端随手传 `1`」这类几乎必然碰撞的值被拒掉；
 * 同一工作空间内相同 `operationId` 的第二次提交返回首次结果，不重复施加副作用。
 */
export const operationIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'operationId 只允许字母、数字、下划线与连字符');

// ---------------------------------------------------------------------------
// 页面与实例的对外形状
// ---------------------------------------------------------------------------

export const pageSlugSchema = z
  .string()
  .min(1)
  .max(MAX_PAGE_NAME_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug 只允许小写字母、数字与连字符');

export const pageNameSchema = z.string().min(1).max(MAX_PAGE_NAME_LENGTH);

/** 页面摘要（GET /me/pages）。 */
export const workspacePageSchema = z.object({
  id: z.string().min(1).max(64),
  name: pageNameSchema,
  slug: pageSlugSchema,
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
  revision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type WorkspacePage = z.infer<typeof workspacePageSchema>;

/** Widget 实例（列表响应）。 */
export const widgetInstanceSchema = z.object({
  id: z.string().min(1).max(64),
  pageId: z.string().min(1).max(64),
  moduleId: z.string().min(1).max(80),
  widgetType: z.string().regex(WIDGET_ID_PATTERN),
  config: z.unknown(),
  configVersion: z.number().int().nonnegative(),
  hidden: z.boolean(),
  revision: z.number().int().nonnegative(),
  /**
   * 创建时该模块的 revision（生命周期清理端口的 fence 依据之一）。
   * 对外暴露是必要的：客户端据它判断「服务端卸载清理是否可能已经越过了我持有的实例」。
   */
  createdRevision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type WidgetInstance = z.infer<typeof widgetInstanceSchema>;

/** 单个断点的布局（含独立 revision）。 */
export const breakpointLayoutSchema = z.object({
  breakpoint: z.enum(LAYOUT_BREAKPOINTS),
  revision: z.number().int().nonnegative(),
  cols: z.number().int().positive(),
  rects: z.array(gridRectSchema),
});

export type BreakpointLayout = z.infer<typeof breakpointLayoutSchema>;

/** 工作台整体快照（前端一次拉取即可渲染）。 */
export const workbenchSnapshotSchema = z.object({
  pages: z.array(workspacePageSchema),
  defaultPageId: z.string().min(1).max(64).nullable(),
  revision: z.number().int().nonnegative(),
  limits: z.object({
    maxPages: z.number().int().positive(),
    maxWidgetsPerPage: z.number().int().positive(),
    maxWidgetConfigBytes: z.number().int().positive(),
  }),
});

export type WorkbenchSnapshot = z.infer<typeof workbenchSnapshotSchema>;

// ---------------------------------------------------------------------------
// 请求契约
// ---------------------------------------------------------------------------

export const createPageRequestSchema = z
  .object({
    name: pageNameSchema,
    /** 可选用模板初始化页面内容；缺省即空页（空白页是合法状态）。 */
    templateId: z.enum(['daily', 'fishing', 'raid', 'blank']).optional(),
    operationId: operationIdSchema,
  })
  .strict();

export const updatePageRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    name: pageNameSchema.optional(),
    sortOrder: z.number().int().min(0).max(MAX_PAGES_PER_WORKSPACE * 2).optional(),
    isDefault: z.boolean().optional(),
    operationId: operationIdSchema,
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.sortOrder !== undefined || value.isDefault !== undefined,
    { message: '至少需要提供一个待修改字段' },
  );

export const deletePageRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    operationId: operationIdSchema,
  })
  .strict();

export const addWidgetRequestSchema = z
  .object({
    widgetType: z.string().regex(WIDGET_ID_PATTERN),
    config: z.unknown().optional(),
    hidden: z.boolean().optional(),
    operationId: operationIdSchema,
  })
  .strict();

export const updateWidgetRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    config: z.unknown().optional(),
    hidden: z.boolean().optional(),
    operationId: operationIdSchema,
  })
  .strict()
  .refine((value) => value.config !== undefined || value.hidden !== undefined, {
    message: '至少需要提供一个待修改字段',
  });

export const deleteWidgetRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    operationId: operationIdSchema,
  })
  .strict();

export const duplicateWidgetRequestSchema = z
  .object({
    operationId: operationIdSchema,
  })
  .strict();

/** 保存某个断点的整页布局。`baseRevision` 必填：不允许「省略即覆盖」。 */
export const saveLayoutRequestSchema = z
  .object({
    breakpoint: z.enum(LAYOUT_BREAKPOINTS),
    baseRevision: z.number().int().nonnegative(),
    rects: z.array(gridRectSchema).max(MAX_WIDGETS_PER_PAGE),
    operationId: operationIdSchema,
  })
  .strict();

/** 应用模板。`mode` 决定影响范围；任何模式都必须显式给出 `operationId`。 */
export const applyTemplateRequestSchema = z
  .object({
    templateId: z.enum(['daily', 'fishing', 'raid', 'blank']),
    mode: z.enum(['new_page', 'replace_page', 'reset_workspace']),
    /** `new_page` 用新页面名；缺省取模板首页名。 */
    pageName: pageNameSchema.optional(),
    /** `replace_page` 必填。 */
    pageId: z.string().min(1).max(64).optional(),
    /**
     * `replace_page` 必填：被替换页面的当前 revision（防静默覆盖）。
     * `new_page` / `reset_workspace` 不需要它——前者不碰既有数据，后者是显式的整体重置。
     */
    expectedRevision: z.number().int().nonnegative().optional(),
    operationId: operationIdSchema,
  })
  .strict()
  .refine((value) => value.mode !== 'replace_page' || value.pageId !== undefined, {
    message: 'replace_page 模式必须提供 pageId',
  })
  .refine((value) => value.mode !== 'replace_page' || value.expectedRevision !== undefined, {
    message: 'replace_page 模式必须提供 expectedRevision',
  });

// ---------------------------------------------------------------------------
// 模板（可自由修改的起点）
// ---------------------------------------------------------------------------

export const WORKBENCH_TEMPLATE_IDS = ['daily', 'fishing', 'raid', 'blank'] as const;
export type WorkbenchTemplateId = (typeof WORKBENCH_TEMPLATE_IDS)[number];

export interface WorkbenchTemplateWidget {
  readonly widgetType: string;
  readonly config: unknown;
}

export interface WorkbenchTemplatePage {
  readonly name: string;
  readonly slug: string;
  readonly widgets: readonly WorkbenchTemplateWidget[];
}

/**
 * 初始模板。
 *
 * 诚实性声明（**必须**在界面上原样展示 `honestyNote`）：
 * 真实业务模块尚未实现，因此模板只放置 `demo.` 演示组件，并如实说明将来由哪个阶段提供真实能力。
 * 模板不编造任何游戏数据（不写具体鱼名、活动时间、副本名），也不是永久绑定关系。
 */
export interface WorkbenchTemplate {
  readonly id: WorkbenchTemplateId;
  readonly displayName: string;
  readonly description: string;
  readonly honestyNote: string;
  /** 该模板放置的组件是否全部来自 `demo.` 演示模块。 */
  readonly isDemoOnly: boolean;
  /** 空模板：合法的空状态，用于「从空白开始」。 */
  readonly isEmpty: boolean;
  /** 新建工作空间时推荐的默认选择。恰好一个模板为 true。 */
  readonly recommendedDefault: boolean;
  readonly pages: readonly WorkbenchTemplatePage[];
}

const DEMO_COUNTER = 'demo-counter';

export const BUILTIN_WORKBENCH_TEMPLATES: readonly WorkbenchTemplate[] = [
  {
    id: 'daily',
    displayName: '日常导航',
    description: '一个「日常」页面，用于验证页面切换、拖动与保存链路。',
    honestyNote:
      '阶段 04 才会提供真实的导航链接模块；本模板只放入已注册的演示组件作为可编辑起点，不含任何游戏数据。',
    isDemoOnly: true,
    isEmpty: false,
    recommendedDefault: true,
    pages: [
      {
        name: '日常',
        slug: 'daily',
        widgets: [{ widgetType: DEMO_COUNTER, config: { step: 1, label: '日常占位（导航模块见阶段 04）', initDelayMs: 0 } }],
      },
    ],
  },
  {
    id: 'fishing',
    displayName: '钓鱼',
    description: '一个「钓鱼」页面，用于验证多页面与独立断点布局。',
    honestyNote:
      '阶段 05 才会提供鱼类窗口与天气数据；本模板只放入已注册的演示组件，不推测任何鱼类时间或天气规则。',
    isDemoOnly: true,
    isEmpty: false,
    recommendedDefault: false,
    pages: [
      {
        name: '钓鱼',
        slug: 'fishing',
        widgets: [{ widgetType: DEMO_COUNTER, config: { step: 1, label: '鱼类窗口占位（阶段 05）', initDelayMs: 0 } }],
      },
    ],
  },
  {
    id: 'raid',
    displayName: '高难',
    description: '一个「高难」页面，用于验证模板应用与重置语义。',
    honestyNote:
      '阶段 05 才会提供活动与副本进度能力；本模板只放入已注册的演示组件，不编造副本名称或进度数据。',
    isDemoOnly: true,
    isEmpty: false,
    recommendedDefault: false,
    pages: [
      {
        name: '高难',
        slug: 'raid',
        widgets: [{ widgetType: DEMO_COUNTER, config: { step: 1, label: '高难占位（阶段 05）', initDelayMs: 0 } }],
      },
    ],
  },
  {
    id: 'blank',
    displayName: '空白',
    description: '一个不含任何业务组件的空页面：合法状态，系统入口仍然保留在 Shell 中。',
    honestyNote: '空白不是异常状态。页面切换、组件库、设置、导入恢复与设备入口始终保留在应用 Shell 中。',
    isDemoOnly: false,
    isEmpty: true,
    recommendedDefault: false,
    pages: [{ name: '空白', slug: 'blank', widgets: [] }],
  },
];

export function findWorkbenchTemplate(templateId: string): WorkbenchTemplate | null {
  return BUILTIN_WORKBENCH_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

// ---------------------------------------------------------------------------
// 备份 / 恢复（HUB-054：只备份工作台配置）
// ---------------------------------------------------------------------------

export const WORKBENCH_BACKUP_KIND = 'ff14-hub.workbench' as const;
export const WORKBENCH_BACKUP_SCHEMA_VERSION = 1 as const;

/**
 * 一个实例在备份中的形状：配置 + 三个断点的矩形。
 * `layouts` 中缺失的断点表示该断点没有显式布局（导入时按 `autoFlowRects` 生成初始位置）。
 */
export const backupInstanceSchema = z
  .object({
    id: z.string().min(1).max(64),
    widgetType: z.string().regex(WIDGET_ID_PATTERN),
    moduleId: z.string().min(1).max(80),
    config: z.unknown(),
    configVersion: z.number().int().nonnegative(),
    hidden: z.boolean(),
    layouts: z
      .object({
        desktop: gridRectSchema.optional(),
        tablet: gridRectSchema.optional(),
        mobile: gridRectSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const backupPageSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: pageNameSchema,
    slug: pageSlugSchema,
    isDefault: z.boolean(),
    sortOrder: z.number().int(),
    instances: z.array(backupInstanceSchema).max(MAX_WIDGETS_PER_PAGE),
  })
  .strict();

/**
 * 备份文档。
 *
 * **明确不含**：设备 Token（或其摘要）、恢复密钥、WebDAV 用户名/密码、VAPID 私钥、
 * 任何环境变量或服务端秘密。`z.strict()` 会把多出来的字段（例如被塞进来的 `token`）
 * 直接判为非法，而不是静默丢弃——「危险字段」必须有可解释结果。
 */
export const workbenchBackupDocumentSchema = z
  .object({
    kind: z.literal(WORKBENCH_BACKUP_KIND),
    schemaVersion: z.literal(WORKBENCH_BACKUP_SCHEMA_VERSION),
    exportedAt: z.number().int().nonnegative(),
    appVersion: z.string().min(1).max(40),
    /** 恢复所需的元数据：导出时这些模块/组件的版本，便于导入端判断兼容性。 */
    moduleVersions: z.record(z.string().min(1).max(80), z.string().min(1).max(40)),
    widgetConfigVersions: z.record(z.string().min(1).max(80), z.number().int().nonnegative()),
    /**
     * 页面列表。**允许为空**：删光所有页面是合法状态（Shell 提供恢复入口），
     * 而且「导出空工作台 → 再导入」必须能成立，因此不能要求至少一页。
     */
    pages: z.array(backupPageSchema).max(MAX_BACKUP_PAGES),
  })
  .strict();

export type WorkbenchBackupDocument = z.infer<typeof workbenchBackupDocumentSchema>;
export type WorkbenchBackupPage = z.infer<typeof backupPageSchema>;
export type WorkbenchBackupInstance = z.infer<typeof backupInstanceSchema>;

/** 导入模式。`replace` 需要预先存在的可恢复备份（由服务端在同一事务里写）。 */
export const WORKBENCH_IMPORT_MODES = ['merge', 'replace'] as const;
export type WorkbenchImportMode = (typeof WORKBENCH_IMPORT_MODES)[number];

/** 可恢复备份的类别：替换导入前自动生成的那一份，或用户手动创建的一份。 */
export const WORKBENCH_BACKUP_KINDS = ['pre_import', 'manual'] as const;
export type WorkbenchBackupKind = (typeof WORKBENCH_BACKUP_KINDS)[number];

/**
 * 应用导入。
 *
 * 除「显式确认」之外，还必须回显预览时服务端给出的 `previewToken`：
 * 它绑定「这份 document + 这个 mode + 当时的工作台 revision + 所有相关模块的门禁状态与 revision」。
 * 服务端在提交前会重算并比对，任何一项变化都要求重新预览（409），
 * 而不是用「实际执行时再跳过一些实例」来事后改变用户确认过的结果。
 */
export const importRequestSchema = z
  .object({
    mode: z.enum(WORKBENCH_IMPORT_MODES),
    /** 预览时返回的 `previewRevision`（工作台 revision 的显式回显）。 */
    previewRevision: z.number().int().nonnegative(),
    /** 预览时返回的 `previewToken`（计划摘要令牌，绑定 document / mode / revision / 模块门禁）。 */
    previewToken: z.string().min(16).max(128),
    /** 必须显式为 true：不接受「省略即确认」。 */
    confirm: z.literal(true),
    operationId: operationIdSchema,
  })
  .strict();

/**
 * 从墓碑恢复**页面**。页面恢复只依赖它自己的 revision（在服务端以「墓碑存在 + 页面数量」为前置条件），
 * 因此只需要 operationId。
 */
export const restorePageRequestSchema = z
  .object({
    operationId: operationIdSchema,
  })
  .strict();

/**
 * 从可恢复备份恢复**工作台**。
 *
 * `expectedRevision` 必填：用户在界面上选择「恢复」时所看到的工作台 revision。
 * 服务端在同一事务的准入条件里比对，因此一个「旧的」恢复请求不会静默覆盖
 * 刚发生的跨设备变更（那是「用旧快照覆盖新数据」的典型入口）。
 */
export const restoreBackupRequestSchema = z
  .object({
    operationId: operationIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export type WorkbenchImportProblemCode =
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_shape'
  | 'too_large'
  | 'duplicate_page_id'
  | 'duplicate_instance_id'
  | 'unknown_widget_type'
  | 'dangerous_field'
  | 'cross_workspace_reference'
  | 'page_limit_exceeded'
  | 'layout_invalid';

export interface WorkbenchImportIssue {
  readonly code: WorkbenchImportProblemCode;
  readonly detail: string;
  /** 非致命问题（warnings）与致命问题（problems）共用该形状，由所在数组区分语义。 */
  readonly path?: string;
}

export interface WorkbenchImportUnknownModule {
  readonly moduleId: string;
  readonly instanceCount: number;
  readonly widgetTypes: readonly string[];
  /** 该模块在服务端注册表里是否存在（存在但未安装 vs 完全未知，处理建议不同）。 */
  readonly registered: boolean;
}

export interface WorkbenchImportCounts {
  readonly pagesNew: number;
  readonly pagesReplaced: number;
  readonly pagesSkipped: number;
  readonly instancesNew: number;
  readonly instancesReplaced: number;
  readonly instancesSkipped: number;
}

/** 预览结果：`problems` 非空即**不可导入**，且不会有任何写入。 */
export interface WorkbenchImportPreview {
  readonly importable: boolean;
  readonly mode: WorkbenchImportMode;
  readonly schemaVersion: number | null;
  readonly problems: readonly WorkbenchImportIssue[];
  readonly warnings: readonly WorkbenchImportIssue[];
  readonly unknownModules: readonly WorkbenchImportUnknownModule[];
  readonly counts: WorkbenchImportCounts;
  /** 影响范围：将被替换/触及的现有页面名。 */
  readonly affectedPages: readonly string[];
  readonly previewRevision: number;
  /**
   * 计划摘要令牌：绑定 `document` + `mode` + 预览时的工作台 revision +
   * 所有相关模块的门禁状态与 revision。
   *
   * 应用导入时必须原样回显；服务端在提交前重算并比对，
   * 因此「预览时被跳过的集合」与「实际写入的集合」不可能在用户不知情时发生变化。
   */
  readonly previewToken: string;
  /** 预览后需要用户显式确认的文案。 */
  readonly confirmPrompt: string;
}

// ---------------------------------------------------------------------------
// 面向调用方的提示文案（错误码复用 `errors.ts` 的既有集合）
// ---------------------------------------------------------------------------

export const WORKBENCH_MESSAGES = {
  page_not_found: '页面不存在。',
  widget_not_found: '组件实例不存在。',
  page_limit_reached: `页面数量已达上限（${String(MAX_PAGES_PER_WORKSPACE)} 个）。`,
  widget_limit_reached: `该页面的组件数量已达上限（${String(MAX_WIDGETS_PER_PAGE)} 个）。`,
  widget_unknown: '该组件类型未注册，无法添加。',
  widget_single_instance: '该组件类型只允许一个实例。',
  widget_config_too_large: `组件配置超过 ${String(MAX_WIDGET_CONFIG_BYTES)} 字节上限。`,
  widget_config_invalid: '组件配置不满足该组件类型的配置 Schema。',
  module_not_ready: '所属模块当前不可用（未启用或正在变更），无法写入组件实例。',
  layout_revision_conflict: '布局已被其他设备修改，请先比较或重新载入。',
  revision_conflict: '数据已被其他设备修改，请重新载入后再提交。',
  operation_id_reused: '该操作 ID 已用于不同类型的操作。',
  /** 同一个 operationId 换了目标/正文（意图变了）：拒绝并零写入，绝不当成重放。 */
  operation_payload_mismatch: '该操作 ID 已用于不同的请求内容，请用新的操作 ID 重试。',
  layout_invalid: '布局不合法：位置或尺寸超出该组件的允许范围。',
  last_page_deleted: '已删除最后一个页面；可通过「新建页面」或模板恢复工作台。',
  import_not_importable: '备份内容存在问题，未执行任何写入。',
  import_preview_stale: '预览之后工作台或相关模块状态已变化，请重新预览。',
  import_too_large: `备份文档超过 ${String(WORKBENCH_BACKUP_MAX_BYTES)} 字节上限。`,
  export_too_large: `工作台内容超过备份上限（${String(WORKBENCH_BACKUP_MAX_BYTES)} 字节）；请减少页面或组件后再导出。`,
  export_inconsistent: '工作台在导出过程中被其他设备修改，已放弃本次导出；请重试。',
  backup_not_found: '可恢复备份不存在或已过期。',
  /** 该备份已被用过（恢复是「一次性撤销点」）。 */
  backup_consumed: '该备份已被使用过，不能再次恢复。',
  backup_revision_conflict: '工作台已被其他设备修改，请重新读取备份列表后再恢复。',
} as const;
