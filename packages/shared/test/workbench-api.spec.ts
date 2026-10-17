/**
 * 工作台契约测试（HUB-045 / HUB-046 / HUB-054）。
 *
 * 这里测的是**唯一的布局判定实现**与几个纯函数，它们同时被服务端保存路径、
 * 导入路径与前端键盘替代操作调用。因此本文件的用例就是这三处的共同基线：
 * 一旦规则变了，三个调用点会同时被发现，而不是各自漂移。
 */
import { describe, expect, it } from 'vitest';
import {
  BREAKPOINT_COLUMNS,
  BUILTIN_WORKBENCH_TEMPLATES,
  LAYOUT_BREAKPOINTS,
  MAX_JSON_BODY_BYTES,
  MAX_LAYOUT_Y,
  WORKBENCH_BACKUP_MAX_BYTES,
  WORKBENCH_BACKUP_SCHEMA_VERSION,
  autoFlowRects,
  backupPageSchema,
  columnsForBreakpoint,
  findFreeRect,
  findWorkbenchTemplate,
  gridRectSchema,
  operationIdSchema,
  saveLayoutRequestSchema,
  validateLayoutRects,
  workbenchBackupDocumentSchema,
  type GridRect,
  type WidgetSizeConstraint,
} from '../src/index';

const unrestricted: WidgetSizeConstraint = { minW: 1, minH: 1, maxW: null, maxH: null };

function constraintOf(map: Record<string, WidgetSizeConstraint>) {
  return (widgetId: string): WidgetSizeConstraint | null => map[widgetId] ?? null;
}

describe('断点列数基线（规划 9.1 / ADR-010）', () => {
  it('桌面 12 / 平板 8 / 手机 4 列，且 columnsForBreakpoint 与常量同源', () => {
    expect(BREAKPOINT_COLUMNS).toEqual({ desktop: 12, tablet: 8, mobile: 4 });
    for (const breakpoint of LAYOUT_BREAKPOINTS) {
      expect(columnsForBreakpoint(breakpoint)).toBe(BREAKPOINT_COLUMNS[breakpoint]);
    }
  });
});

describe('validateLayoutRects：唯一的布局判定实现', () => {
  it('合法的矩形集合通过', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [
        { i: 'a', x: 0, y: 0, w: 4, h: 3 },
        { i: 'b', x: 4, y: 0, w: 4, h: 3 },
      ],
      constraintsOf: constraintOf({ a: unrestricted, b: unrestricted }),
    });
    expect(result.ok).toBe(true);
  });

  it('坐标越界被拒绝（x + w > 列数）', () => {
    const result = validateLayoutRects({
      breakpoint: 'mobile',
      rects: [{ i: 'a', x: 3, y: 0, w: 2, h: 1 }],
      constraintsOf: constraintOf({ a: unrestricted }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain('out_of_bounds');
    }
  });

  it('纵坐标超过上限被拒绝（不允许无限向下堆）', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [{ i: 'a', x: 0, y: MAX_LAYOUT_Y, w: 1, h: 2 }],
      constraintsOf: constraintOf({ a: unrestricted }),
    });
    expect(result.ok).toBe(false);
  });

  it('小于 minSize 被拒绝', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [{ i: 'a', x: 0, y: 0, w: 1, h: 1 }],
      constraintsOf: constraintOf({ a: { minW: 2, minH: 2, maxW: null, maxH: null } }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.code).toBe('size_below_min');
    }
  });

  it('大于 maxSize 被拒绝（只有声明了 maxSize 的组件才有上界）', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [{ i: 'a', x: 0, y: 0, w: 6, h: 3 }],
      constraintsOf: constraintOf({ a: { minW: 2, minH: 2, maxW: 4, maxH: 4 } }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.code).toBe('size_above_max');
    }
  });

  it('两个矩形重叠被拒绝（互相包含与部分相交都算）', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [
        { i: 'a', x: 0, y: 0, w: 4, h: 4 },
        { i: 'b', x: 2, y: 2, w: 2, h: 2 },
      ],
      constraintsOf: constraintOf({ a: unrestricted, b: unrestricted }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((violation) => violation.code)).toContain('overlap');
    }
  });

  it('相邻但不重叠是合法的（边界接触不算重叠）', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [
        { i: 'a', x: 0, y: 0, w: 4, h: 3 },
        { i: 'b', x: 4, y: 0, w: 4, h: 3 },
      ],
      constraintsOf: constraintOf({ a: unrestricted, b: unrestricted }),
    });
    expect(result.ok).toBe(true);
  });

  it('未注册/不属于本页面的实例被拒绝', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [{ i: 'ghost', x: 0, y: 0, w: 1, h: 1 }],
      constraintsOf: constraintOf({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.code).toBe('unknown_widget');
    }
  });

  it('同一实例在同一断点出现多次被拒绝（避免主键冲突）', () => {
    const result = validateLayoutRects({
      breakpoint: 'desktop',
      rects: [
        { i: 'a', x: 0, y: 0, w: 1, h: 1 },
        { i: 'a', x: 2, y: 0, w: 1, h: 1 },
      ],
      constraintsOf: constraintOf({ a: unrestricted }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.code).toBe('duplicate_widget');
    }
  });

  it('同一组矩形在手机断点可能非法，在桌面断点却合法（列数真的生效）', () => {
    const rects: GridRect[] = [{ i: 'a', x: 8, y: 0, w: 3, h: 1 }];
    const constraintsOf = constraintOf({ a: unrestricted });
    expect(validateLayoutRects({ breakpoint: 'desktop', rects, constraintsOf }).ok).toBe(true);
    expect(validateLayoutRects({ breakpoint: 'tablet', rects, constraintsOf }).ok).toBe(false);
    expect(validateLayoutRects({ breakpoint: 'mobile', rects, constraintsOf }).ok).toBe(false);
  });
});

describe('autoFlowRects：只用于生成初始布局，不用于修改用户已有布局', () => {
  it('从左到右、超列换行，且互不重叠', () => {
    const rects = autoFlowRects({
      breakpoint: 'mobile',
      widgets: [
        { id: 'a', w: 3, h: 2 },
        { id: 'b', w: 3, h: 2 },
        { id: 'c', w: 2, h: 1 },
      ],
    });
    expect(rects).toHaveLength(3);
    // 第一项占 0..3 列；第二项放不下 → 换行到下一行。
    expect(rects[0]).toEqual({ i: 'a', x: 0, y: 0, w: 3, h: 2 });
    expect(rects[1]).toEqual({ i: 'b', x: 0, y: 2, w: 3, h: 2 });
    expect(rects[2]?.y).toBeGreaterThanOrEqual(2);
    const validation = validateLayoutRects({
      breakpoint: 'mobile',
      rects,
      constraintsOf: constraintOf({ a: unrestricted, b: unrestricted, c: unrestricted }),
    });
    expect(validation.ok).toBe(true);
  });

  it('超宽组件被夹到可用列数（生成初始布局时的安全收敛）', () => {
    const rects = autoFlowRects({ breakpoint: 'mobile', widgets: [{ id: 'a', w: 12, h: 1 }] });
    expect(rects[0]?.w).toBe(BREAKPOINT_COLUMNS.mobile);
  });

  it('空输入产生空布局（空白页是合法状态）', () => {
    expect(autoFlowRects({ breakpoint: 'desktop', widgets: [] })).toEqual([]);
  });
});

describe('findFreeRect：为新组件找一个不重叠的空位', () => {
  it('跳过已被占用的区域', () => {
    const placed = findFreeRect({ existing: [{ x: 0, y: 0, w: 6, h: 3 }], w: 4, h: 3, cols: 12 });
    expect(placed).not.toBeNull();
    expect(placed?.x).toBe(6);
    expect(placed?.y).toBe(0);
  });

  it('整行都放不下时换到下一行', () => {
    const placed = findFreeRect({
      existing: [
        { x: 0, y: 0, w: 12, h: 2 },
      ],
      w: 4,
      h: 2,
      cols: 12,
    });
    expect(placed?.y).toBe(2);
  });

  it('所有位置都不重叠且落在列数内', () => {
    const placed = findFreeRect({ existing: [], w: 20, h: 1, cols: 12 });
    expect(placed).not.toBeNull();
    expect(placed?.w).toBe(12);
    expect(placed?.x).toBe(0);
  });
});

describe('请求契约：operationId 与布局保存', () => {
  it('operationId 过短或含非法字符被拒绝（防止几乎必然碰撞的值）', () => {
    expect(operationIdSchema.safeParse('short').success).toBe(false);
    expect(operationIdSchema.safeParse('op-12345678').success).toBe(true);
    expect(operationIdSchema.safeParse('op 12345678').success).toBe(false);
    expect(operationIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('布局保存必须带 baseRevision（不允许「省略即覆盖」）', () => {
    const withoutRevision = saveLayoutRequestSchema.safeParse({
      breakpoint: 'desktop',
      rects: [{ i: 'a', x: 0, y: 0, w: 1, h: 1 }],
      operationId: 'op-12345678',
    });
    expect(withoutRevision.success).toBe(false);
  });

  it('网格矩形拒绝多余字段与非法断点', () => {
    expect(gridRectSchema.safeParse({ i: 'a', x: 0, y: 0, w: 1, h: 1, extra: true }).success).toBe(false);
    const wrongBreakpoint = saveLayoutRequestSchema.safeParse({
      breakpoint: 'watch',
      baseRevision: 0,
      rects: [],
      operationId: 'op-12345678',
    });
    expect(wrongBreakpoint.success).toBe(false);
  });
});

describe('模板契约（诚实性）', () => {
  it('恰好四种模板，其中恰好一个推荐默认，且四种 id 齐全', () => {
    expect(BUILTIN_WORKBENCH_TEMPLATES.map((template) => template.id)).toEqual([
      'daily',
      'fishing',
      'raid',
      'blank',
    ]);
    expect(BUILTIN_WORKBENCH_TEMPLATES.filter((template) => template.recommendedDefault)).toHaveLength(1);
  });

  it('每个模板都带非空诚实说明，且说明里点明后续阶段或「空白是合法状态」', () => {
    for (const template of BUILTIN_WORKBENCH_TEMPLATES) {
      expect(template.honestyNote.length).toBeGreaterThan(10);
      expect(template.honestyNote).toMatch(/阶段 0[456]|空白/);
    }
  });

  it('空白模板不含任何业务组件，其余模板只使用已注册的演示组件', () => {
    const blank = findWorkbenchTemplate('blank');
    expect(blank?.isEmpty).toBe(true);
    expect(blank?.pages[0]?.widgets ?? []).toHaveLength(0);
    for (const template of BUILTIN_WORKBENCH_TEMPLATES) {
      for (const page of template.pages) {
        for (const widget of page.widgets) {
          // 真实业务模块（如 ff14.fishing）此刻并不存在，模板不得引用它们。
          expect(widget.widgetType.startsWith('demo-')).toBe(true);
        }
      }
    }
  });

  it('未知模板 id 返回 null（调用方必须显式处理，不得猜）', () => {
    expect(findWorkbenchTemplate('nope')).toBeNull();
  });
});

describe('备份契约（HUB-054）', () => {
  const minimalDocument = {
    kind: 'ff14-hub.workbench',
    schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
    exportedAt: 1,
    appVersion: '0.0.0',
    moduleVersions: { 'demo.basics': '1.0.0' },
    widgetConfigVersions: { 'demo-counter': 1 },
    pages: [
      {
        id: 'p1',
        name: '日常',
        slug: 'daily',
        isDefault: true,
        sortOrder: 0,
        instances: [
          {
            id: 'i1',
            widgetType: 'demo-counter',
            moduleId: 'demo.basics',
            config: { step: 1, label: 'x', initDelayMs: 0 },
            configVersion: 1,
            hidden: false,
            layouts: { desktop: { i: 'i1', x: 0, y: 0, w: 4, h: 3 } },
          },
        ],
      },
    ],
  };

  it('最小合法文档通过校验，且允许空工作台（pages 为空数组）', () => {
    expect(workbenchBackupDocumentSchema.safeParse(minimalDocument).success).toBe(true);
    expect(workbenchBackupDocumentSchema.safeParse({ ...minimalDocument, pages: [] }).success).toBe(true);
  });

  it('拒绝被塞进来的凭证字段（z.strict 把多出来的顶层字段判为硬错误）', () => {
    const withToken = { ...minimalDocument, token: 'device-token-value' };
    expect(workbenchBackupDocumentSchema.safeParse(withToken).success).toBe(false);
  });

  it('拒绝不受支持的 schemaVersion', () => {
    expect(workbenchBackupDocumentSchema.safeParse({ ...minimalDocument, schemaVersion: 2 }).success).toBe(false);
  });

  it('拒绝页面实例上的多余字段，并要求 layouts 是严格对象', () => {
    const badInstance = {
      ...minimalDocument,
      pages: [
        {
          ...minimalDocument.pages[0],
          instances: [{ ...minimalDocument.pages[0]?.instances[0], layouts: { desktop: {}, watch: {} } }],
        },
      ],
    };
    expect(workbenchBackupDocumentSchema.safeParse(badInstance).success).toBe(false);
  });

  it('页面名称/slug 形状受限（不能塞入超长或含非法字符的值）', () => {
    expect(backupPageSchema.safeParse({ ...minimalDocument.pages[0], slug: 'Daily Page!' }).success).toBe(false);
    expect(
      backupPageSchema.safeParse({ ...minimalDocument.pages[0], name: 'x'.repeat(200) }).success,
    ).toBe(false);
  });

  it('容量自洽：备份上限严格小于全局请求体上限，且大于零', () => {
    expect(WORKBENCH_BACKUP_MAX_BYTES).toBeGreaterThan(0);
    expect(WORKBENCH_BACKUP_MAX_BYTES).toBeLessThan(MAX_JSON_BODY_BYTES);
  });
});
