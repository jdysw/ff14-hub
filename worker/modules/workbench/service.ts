/**
 * 自定义工作台服务（HUB-045 布局编辑器 / HUB-046 多页面与独立断点 / HUB-049 模板与重置）。
 *
 * 安全前提（与本仓库既有私有端点一致）：
 * - 每个方法都要求显式传入 `workspaceId`，它**只能**来自认证中间件；
 *   入参里的 pageId / widgetId 只用于**过滤**，不参与作用域判定。
 *   跨工作空间引用会先被前置条件挡掉，最终表现为 404（而不是读到别人的数据）。
 * - 服务端**从不**信任客户端提交的尺寸约束、模块归属或 `allowMultiple`：
 *   这些一律取自静态注册表（`registry.findWidget`）。
 * - 新建实例必须同时满足「模块已启用」「模块没有待完成操作」「登记的模块代际与当前一致」，
 *   三条都在认领语句的原子条件里，因此不存在「读到 enabled 再被停用」的时间窗。
 * - 陈旧写一律 409：页面/实例用自身 revision，布局用「页面 + 断点」的独立 revision。
 *
 * 事务与幂等：所有写入都经 `runOperation` → `runIdempotentWrite`，
 * 即「认领 + 变更 + 收尾」同一个 D1 batch（原子，失败整体回滚）。
 *
 * 删除语义（规划规则 7，不得混淆）：
 * - 页面删除 = 墓碑（`deleted_at`）；其下的实例与布局**保持原样**，因此可以整体恢复。
 * - 实例「隐藏」（`is_hidden`）与「移除」（墓碑）是两件不同的事，
 *   两者都不改变模块状态，也不删除任何个人业务数据。
 */
import {
  MAX_PAGES_PER_WORKSPACE,
  MAX_WIDGET_CONFIG_BYTES,
  MAX_WIDGETS_PER_PAGE,
  WORKBENCH_MESSAGES,
  autoFlowRects,
  columnsForBreakpoint,
  findWorkbenchTemplate,
  validateLayoutRects,
  type BreakpointLayout,
  type GridRect,
  type LayoutBreakpoint,
  type WorkbenchSnapshot,
  type WorkspacePage,
} from '@ff14-hub/shared';
import type { ModuleRegistry } from '../registry/module-registry';
import {
  LAYOUT_BREAKPOINT_LIST,
  SQL_COUNT_ACTIVE_PAGES,
  SQL_COUNT_PAGE_INSTANCES,
  SQL_INSTANCE_ACTIVE,
  SQL_LAYOUT_REVISION,
  SQL_MODULE_ENABLED_AT_REVISION,
  SQL_MODULE_NOT_TRANSITIONING,
  SQL_PAGE_ACTIVE,
  allowMultipleOfWidget,
  bumpLayoutRevisionStatements,
  bumpWorkbenchRevisionStatements,
  clearOtherDefaultsStatement,
  configEquals,
  deleteInstanceLayoutsStatement,
  deletePageBreakpointLayoutsStatement,
  insertInstanceStatement,
  insertLayoutStatement,
  insertPageStatement,
  moduleIdOfWidget,
  moduleGateConditions,
  moduleNotReadyDetail,
  normalizeWidgetConfig,
  pickUniqueSlug,
  planInitialRects,
  readActiveInstances,
  readActivePages,
  readAnyPageRow,
  readInstanceRow,
  readLayoutRevisions,
  readLayoutRows,
  readModuleGate,
  readPageRow,
  readTakenSlugs,
  readWorkbenchRevision,
  rederiveDefaultPageStatement,
  restorePageStatement,
  setLayoutRevisionStatements,
  sizeConstraintOfWidget,
  tombstoneInstanceStatement,
  tombstonePageStatement,
  toInstance,
  toPage,
  updateInstanceStatement,
  updatePageStatement,
  type InstanceRow,
  type Statement,
} from './internal';
import {
  WORKBENCH_OP_KINDS,
  fingerprintOf,
  guardedStatements,
  layoutSaveKind,
  readWorkbenchReplay,
  runIdempotentWrite,
  workbenchFailure,
  type IdempotencyGuard,
  type WorkbenchFailure,
  type WorkbenchResult,
} from './tx';

export interface WorkbenchServiceDeps {
  readonly db: D1Database;
  readonly registry: ModuleRegistry;
  /** 可注入时钟，便于测试确定性时间戳。 */
  readonly now?: () => number;
}

export interface TemplateSkip {
  readonly widgetType: string;
  readonly detail: string;
}

export interface ApplyTemplateResult {
  readonly mode: 'new_page' | 'replace_page' | 'reset_workspace';
  readonly templateId: string;
  readonly pages: readonly WorkspacePage[];
  readonly defaultPageId: string | null;
  /** 因模块未启用/未安装而**明确跳过**的模板组件（绝不静默丢弃，也绝不偷偷启用模块）。 */
  readonly skipped: readonly TemplateSkip[];
}

export interface DeletePageResult {
  readonly deletedPageId: string;
  readonly defaultPageId: string | null;
  readonly remainingPages: number;
  readonly notice: string;
}

export interface WorkbenchService {
  readSnapshot(workspaceId: string): Promise<WorkbenchSnapshot>;
  listPages(
    workspaceId: string,
  ): Promise<{ readonly pages: readonly WorkspacePage[]; readonly defaultPageId: string | null }>;
  /**
   * 该页面的活跃实例。
   * 页面不属于本工作空间时返回 `page_not_found`（**不是**空数组）：
   * 这样「页面不存在」在所有 `:id` 路由上语义一致，前端也能据此识别过期的 pageId。
   */
  listInstances(input: {
    readonly workspaceId: string;
    readonly pageId: string;
  }): Promise<WorkbenchResult<readonly ReturnType<typeof toInstance>[]>>;
  readLayouts(input: {
    readonly workspaceId: string;
    readonly pageId: string;
  }): Promise<readonly BreakpointLayout[]>;

  createPage(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly templateId?: string;
    readonly operationId: string;
  }): Promise<
    WorkbenchResult<{
      readonly page: WorkspacePage;
      readonly skipped: readonly TemplateSkip[];
      /** 新建后的默认页：新页面成为默认页时是它自己，否则是原有默认页。 */
      readonly defaultPageId: string | null;
    }>
  >;

  updatePage(input: {
    readonly workspaceId: string;
    readonly pageId: string;
    readonly expectedRevision: number;
    readonly name?: string;
    readonly sortOrder?: number;
    readonly isDefault?: boolean;
    readonly operationId: string;
  }): Promise<WorkbenchResult<{ readonly page: WorkspacePage; readonly noop: boolean }>>;

  deletePage(input: {
    readonly workspaceId: string;
    readonly pageId: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<WorkbenchResult<DeletePageResult>>;

  restorePage(input: {
    readonly workspaceId: string;
    readonly pageId: string;
    readonly operationId: string;
  }): Promise<WorkbenchResult<{ readonly page: WorkspacePage; readonly defaultPageId: string | null }>>;

  addWidget(input: {
    readonly workspaceId: string;
    readonly pageId: string;
    readonly widgetType: string;
    readonly config?: unknown;
    readonly hidden?: boolean;
    readonly operationId: string;
  }): Promise<WorkbenchResult<{ readonly instance: ReturnType<typeof toInstance> }>>;

  updateWidget(input: {
    readonly workspaceId: string;
    readonly widgetId: string;
    readonly expectedRevision: number;
    readonly config?: unknown;
    readonly hidden?: boolean;
    readonly operationId: string;
  }): Promise<WorkbenchResult<{ readonly instance: ReturnType<typeof toInstance>; readonly noop: boolean }>>;

  /** 复制实例：新实例带独立配置与「找空位」得到的初始布局。 */
  duplicateWidget(input: {
    readonly workspaceId: string;
    readonly widgetId: string;
    readonly operationId: string;
  }): Promise<WorkbenchResult<{ readonly instance: ReturnType<typeof toInstance> }>>;

  deleteWidget(input: {
    readonly workspaceId: string;
    readonly widgetId: string;
    readonly expectedRevision: number;
    readonly operationId: string;
  }): Promise<WorkbenchResult<{ readonly widgetId: string }>>;

  saveLayout(input: {
    readonly workspaceId: string;
    readonly pageId: string;
    readonly breakpoint: LayoutBreakpoint;
    readonly baseRevision: number;
    readonly rects: readonly GridRect[];
    readonly operationId: string;
  }): Promise<WorkbenchResult<{ readonly layout: BreakpointLayout }>>;

  applyTemplate(input: {
    readonly workspaceId: string;
    readonly templateId: string;
    readonly mode: 'new_page' | 'replace_page' | 'reset_workspace';
    readonly pageName?: string;
    readonly pageId?: string;
    readonly expectedRevision?: number;
    readonly operationId: string;
  }): Promise<WorkbenchResult<ApplyTemplateResult>>;
}

/** 模板中一个「可用组件」的落库计划（已通过注册表与模块门禁）。 */
interface PlannedWidget {
  readonly widgetType: string;
  readonly moduleId: string;
  readonly configJson: string;
  readonly configVersion: number;
  readonly createdRevision: number;
  readonly defaultSize: { readonly w: number; readonly h: number };
}

export function createWorkbenchService(deps: WorkbenchServiceDeps): WorkbenchService {
  const now = deps.now ?? ((): number => Date.now());
  const registry: ModuleRegistry = deps.registry;

  /** 统一的写入入口：组装认领语句、构造带守卫的变更语句、执行原子幂等事务。 */
  function runOperation<T>(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    /** 请求指纹：同一个 operationId 换意图时必须拒绝（见 `fingerprintOf`）。 */
    readonly requestFingerprint: string;
    readonly preconditionSql: string;
    readonly preconditionBinds: readonly unknown[];
    readonly build: (guard: IdempotencyGuard) => Statement[];
    readonly result: T;
    readonly explain: () => Promise<WorkbenchFailure | null>;
  }): Promise<WorkbenchResult<T>> {
    return runIdempotentWrite<T>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: input.requestFingerprint,
      now: now(),
      preconditionSql: input.preconditionSql,
      preconditionBinds: input.preconditionBinds,
      buildStatements: (guard) => guardedStatements(deps.db, guard, input.build(guard)),
      result: input.result,
      explain: input.explain,
    });
  }

  /**
   * 幂等入口守卫：先算本次意图的指纹，再看是否已有同 ID 的成功记录。
   *
   * 两件事必须成对出现——只查 ID 不查指纹会把「同 ID 换 body」当重放放行；
   * 只算指纹不先短路会让「响应丢失后原样重试」被前置条件早退成 409。
   */
  async function replayGuard<T>(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    /** 参与指纹的**请求意图**（目标 ID / 动作 / 正文 / 预期 revision），不含服务端观察到的状态。 */
    readonly intent: unknown;
  }): Promise<{ readonly fingerprint: string; readonly replay: WorkbenchResult<T> | null }> {
    const fingerprint = await fingerprintOf(input.kind, input.intent);
    const replay = await readWorkbenchReplay<T>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: fingerprint,
    });
    return { fingerprint, replay };
  }

  /**
   * 解析模板组件：逐个检查注册表、模块门禁与配置合法性。
   * 模块不可用即**跳过并上报**（`skipped`），绝不偷偷启用模块。
   */
  async function planTemplateWidgets(input: {
    readonly workspaceId: string;
    readonly templateId: string;
  }): Promise<{ planned: PlannedWidget[]; skipped: TemplateSkip[] }> {
    const template = findWorkbenchTemplate(input.templateId);
    if (template === null) {
      return { planned: [], skipped: [] };
    }
    const planned: PlannedWidget[] = [];
    const skipped: TemplateSkip[] = [];
    for (const widget of template.pages[0]?.widgets ?? []) {
      const moduleId = moduleIdOfWidget(registry, widget.widgetType);
      const found = registry.findWidget(widget.widgetType);
      if (moduleId === null || found === undefined) {
        skipped.push({ widgetType: widget.widgetType, detail: '组件类型未注册' });
        continue;
      }
      const gate = await readModuleGate(deps.db, input.workspaceId, moduleId);
      if (gate.status !== 'enabled') {
        skipped.push({ widgetType: widget.widgetType, detail: moduleNotReadyDetail(gate) });
        continue;
      }
      const normalized = normalizeWidgetConfig(registry, widget.widgetType, widget.config);
      if (!normalized.ok) {
        skipped.push({ widgetType: widget.widgetType, detail: normalized.detail });
        continue;
      }
      planned.push({
        widgetType: widget.widgetType,
        moduleId,
        configJson: normalized.json,
        configVersion: normalized.configVersion,
        createdRevision: gate.revision,
        defaultSize: { w: found.widget.defaultSize.w, h: found.widget.defaultSize.h },
      });
    }
    return { planned, skipped };
  }

  /** 为一个新页面生成「实例 + 三个断点布局」的语句（布局按 autoFlowRects 自动排布）。 */
  function pageContentStatements(input: {
    readonly workspaceId: string;
    readonly pageId: string;
    readonly planned: readonly PlannedWidget[];
    readonly now: number;
  }): { statements: Statement[]; instanceIds: string[] } {
    const statements: Statement[] = [];
    const instanceIds: string[] = [];
    const ids: string[] = [];
    for (const widget of input.planned) {
      const widgetId = crypto.randomUUID();
      ids.push(widgetId);
      instanceIds.push(widgetId);
      statements.push(
        insertInstanceStatement({
          id: widgetId,
          workspaceId: input.workspaceId,
          pageId: input.pageId,
          moduleId: widget.moduleId,
          widgetType: widget.widgetType,
          configJson: widget.configJson,
          configVersion: widget.configVersion,
          hidden: false,
          createdRevision: widget.createdRevision,
          now: input.now,
        }),
      );
    }

    for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
      const rects = autoFlowRects({
        breakpoint,
        widgets: input.planned.map((widget, index) => ({
          id: ids[index] ?? '',
          w: widget.defaultSize.w,
          h: widget.defaultSize.h,
        })),
      });
      for (const rect of rects) {
        if (rect.i === '') {
          continue;
        }
        statements.push(insertLayoutStatement({ widgetId: rect.i, breakpoint, rect }));
      }
    }
    return { statements, instanceIds };
  }

  /** 选一个在工作空间内（含墓碑）唯一的 slug（与导入路径共用同一实现）。 */
  function pickSlug(base: string, taken: ReadonlySet<string>): string {
    return pickUniqueSlug(base, new Set(taken));
  }

  // 先赋给具名常量：`applyTemplate('new_page')` 需要复用 `createPage` 的同一份实现，
  // 而方法体里的 `this` 在对象字面量中被解构或转发时会丢失，因此用显式引用。
  const service: WorkbenchService = {
    async readSnapshot(workspaceId) {
      const pages = await readActivePages(deps.db, workspaceId);
      const revision = await readWorkbenchRevision(deps.db, workspaceId);
      const defaultPage = pages.find((page) => page.is_default === 1) ?? null;
      return {
        pages: pages.map(toPage),
        defaultPageId: defaultPage?.id ?? null,
        revision,
        limits: {
          maxPages: MAX_PAGES_PER_WORKSPACE,
          maxWidgetsPerPage: MAX_WIDGETS_PER_PAGE,
          maxWidgetConfigBytes: MAX_WIDGET_CONFIG_BYTES,
        },
      };
    },

    async listPages(workspaceId) {
      const pages = await readActivePages(deps.db, workspaceId);
      return {
        pages: pages.map(toPage),
        defaultPageId: pages.find((page) => page.is_default === 1)?.id ?? null,
      };
    },

    async listInstances(input) {
      const page = await readPageRow(deps.db, input.workspaceId, input.pageId);
      if (page === null) {
        return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
      }
      return {
        ok: true,
        replayed: false,
        value: (await readActiveInstances(deps.db, input.workspaceId, input.pageId)).map(toInstance),
      };
    },

    async readLayouts(input) {
      const page = await readPageRow(deps.db, input.workspaceId, input.pageId);
      if (page === null) {
        return [];
      }
      const revisions = await readLayoutRevisions(deps.db, input.pageId);
      const rectRows = await readLayoutRows(deps.db, input.pageId);
      return LAYOUT_BREAKPOINT_LIST.map((breakpoint) => ({
        breakpoint,
        revision: revisions.get(breakpoint) ?? 0,
        cols: columnsForBreakpoint(breakpoint),
        rects: rectRows
          .filter((row) => row.breakpoint === breakpoint)
          .map((row) => ({ i: row.widget_id, x: row.x, y: row.y, w: row.w, h: row.h })),
      }));
    },

    async createPage(input) {
      // 幂等短路必须在**任何前置读取之前**：首次提交成功后页面数量就变了，
      // 若先做新鲜度判断，重试会被早退成 409，客户端拿不到首次结果。
      const guard = await replayGuard<{
        page: WorkspacePage;
        skipped: readonly TemplateSkip[];
        defaultPageId: string | null;
      }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.pageCreate,
        intent: { name: input.name, templateId: input.templateId ?? null },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      if (input.templateId !== undefined && findWorkbenchTemplate(input.templateId) === null) {
        return workbenchFailure('invalid_input', `未知模板：${input.templateId}`);
      }
      const timestamp = now();
      const pageId = crypto.randomUUID();
      const [pages, taken, plan] = await Promise.all([
        readActivePages(deps.db, input.workspaceId),
        readTakenSlugs(deps.db, input.workspaceId),
        input.templateId === undefined
          ? Promise.resolve({ planned: [] as PlannedWidget[], skipped: [] as TemplateSkip[] })
          : planTemplateWidgets({ workspaceId: input.workspaceId, templateId: input.templateId }),
      ]);
      if (pages.length >= MAX_PAGES_PER_WORKSPACE) {
        return workbenchFailure('page_limit_reached', WORKBENCH_MESSAGES.page_limit_reached);
      }

      const template = input.templateId === undefined ? null : findWorkbenchTemplate(input.templateId);
      const slug = pickSlug(template?.pages[0]?.slug ?? input.name, taken);
      const isDefault = pages.length === 0;
      const sortOrder = pages.reduce((max, page) => Math.max(max, page.sort_order + 1), 0);

      const content = pageContentStatements({
        workspaceId: input.workspaceId,
        pageId,
        planned: plan.planned,
        now: timestamp,
      });

      const page: WorkspacePage = {
        id: pageId,
        name: input.name,
        slug,
        isDefault,
        sortOrder,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.pageCreate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: `${SQL_COUNT_ACTIVE_PAGES} = ? AND NOT EXISTS (SELECT 1 FROM workspace_pages s WHERE s.workspace_id = ? AND s.slug = ?)`,
        preconditionBinds: [input.workspaceId, pages.length, input.workspaceId, slug],
        build: () => [
          insertPageStatement({
            id: pageId,
            workspaceId: input.workspaceId,
            name: input.name,
            slug,
            isDefault,
            sortOrder,
            now: timestamp,
          }),
          ...content.statements,
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: {
          page,
          skipped: plan.skipped,
          defaultPageId: isDefault ? pageId : (pages.find((candidate) => candidate.is_default === 1)?.id ?? null),
        },
        explain: async () => {
          const current = await readActivePages(deps.db, input.workspaceId);
          if (current.length >= MAX_PAGES_PER_WORKSPACE) {
            return workbenchFailure('page_limit_reached', WORKBENCH_MESSAGES.page_limit_reached);
          }
          if (await slugTakenToday(deps.db, input.workspaceId, slug)) {
            return workbenchFailure('duplicate_slug', `slug 已被占用：${slug}`);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async updatePage(input) {
      const guard = await replayGuard<{ page: WorkspacePage; noop: boolean }>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: WORKBENCH_OP_KINDS.pageUpdate, intent: { pageId: input.pageId, expectedRevision: input.expectedRevision, name: input.name ?? null, sortOrder: input.sortOrder ?? null, isDefault: input.isDefault ?? null } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const current = await readPageRow(deps.db, input.workspaceId, input.pageId);
      if (current === null) {
        return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
      }
      if (current.revision !== input.expectedRevision) {
        return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
      }
      if (input.isDefault === false && current.is_default === 1) {
        return workbenchFailure(
          'invalid_input',
          '不能直接取消默认页；请把另一个页面设为默认页',
        );
      }

      const nextName = input.name ?? current.name;
      const nextSortOrder = input.sortOrder ?? current.sort_order;
      const nextIsDefault = input.isDefault === undefined ? current.is_default === 1 : input.isDefault;
      const noop =
        nextName === current.name && nextSortOrder === current.sort_order && nextIsDefault === (current.is_default === 1);

      const timestamp = now();
      const page: WorkspacePage = {
        ...toPage(current),
        name: nextName,
        sortOrder: nextSortOrder,
        isDefault: nextIsDefault,
        revision: noop ? current.revision : current.revision + 1,
        updatedAt: noop ? current.updated_at : timestamp,
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.pageUpdate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: `EXISTS (SELECT 1 FROM workspace_pages p
                                   WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL AND p.revision = ?)`,
        preconditionBinds: [input.pageId, input.workspaceId, input.expectedRevision],
        build: () => {
          if (noop) {
            return [];
          }
          const statements: Statement[] = [];
          if (nextIsDefault && current.is_default === 0) {
            statements.push(
              clearOtherDefaultsStatement({
                workspaceId: input.workspaceId,
                keepPageId: input.pageId,
                now: timestamp,
              }),
            );
          }
          statements.push(
            updatePageStatement({
              id: input.pageId,
              workspaceId: input.workspaceId,
              expectedRevision: input.expectedRevision,
              name: nextName,
              sortOrder: nextSortOrder,
              isDefault: nextIsDefault,
              now: timestamp,
            }),
          );
          statements.push(...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }));
          return statements;
        },
        result: { page, noop },
        explain: async () => {
          const latest = await readPageRow(deps.db, input.workspaceId, input.pageId);
          if (latest === null) {
            return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async deletePage(input) {
      const guard = await replayGuard<DeletePageResult>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: WORKBENCH_OP_KINDS.pageDelete, intent: { pageId: input.pageId, expectedRevision: input.expectedRevision } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const [current, pages] = await Promise.all([
        readPageRow(deps.db, input.workspaceId, input.pageId),
        readActivePages(deps.db, input.workspaceId),
      ]);
      if (current === null) {
        return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
      }
      if (current.revision !== input.expectedRevision) {
        return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
      }

      const timestamp = now();
      const remaining = pages.filter((page) => page.id !== input.pageId);
      // 删除的若不是默认页，默认页保持不变；删的若是默认页，则由同一事务里的
      // `rederiveDefaultPageStatement` 把 sort_order 最小的活跃页面推为默认页
      // （`remaining` 已按 sort_order / created_at 排序，故 `remaining[0]` 就是它）。
      // 两条路径都必须如实反映在响应里，否则客户端会拿到与数据库不一致的默认页。
      const survivingDefault = remaining.find((page) => page.is_default === 1) ?? null;
      const nextDefaultPageId = survivingDefault?.id ?? remaining[0]?.id ?? null;
      const result: DeletePageResult = {
        deletedPageId: input.pageId,
        defaultPageId: nextDefaultPageId,
        remainingPages: remaining.length,
        notice: remaining.length === 0 ? WORKBENCH_MESSAGES.last_page_deleted : '页面已删除，可随时恢复或从备份导入。',
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.pageDelete,
        requestFingerprint: guard.fingerprint,
        // 并发保护：页面集合必须仍等于读取时的状态（数量 + 目标页 revision）。
        preconditionSql: `EXISTS (SELECT 1 FROM workspace_pages p
                                   WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL AND p.revision = ?)
                            AND ${SQL_COUNT_ACTIVE_PAGES} = ?`,
        preconditionBinds: [input.pageId, input.workspaceId, input.expectedRevision, input.workspaceId, pages.length],
        build: () => [
          tombstonePageStatement({ id: input.pageId, workspaceId: input.workspaceId, now: timestamp }),
          rederiveDefaultPageStatement({ workspaceId: input.workspaceId, now: timestamp }),
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result,
        explain: async () => {
          const latest = await readPageRow(deps.db, input.workspaceId, input.pageId);
          if (latest === null) {
            return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async restorePage(input) {
      const guard = await replayGuard<{ page: WorkspacePage; defaultPageId: string | null }>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: WORKBENCH_OP_KINDS.pageRestore, intent: { pageId: input.pageId } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const [any, pages] = await Promise.all([
        readAnyPageRow(deps.db, input.workspaceId, input.pageId),
        readActivePages(deps.db, input.workspaceId),
      ]);
      if (any === null || any.deleted_at === null) {
        return workbenchFailure('page_not_found', '该页面不在可恢复的墓碑中。');
      }
      if (pages.length >= MAX_PAGES_PER_WORKSPACE) {
        return workbenchFailure('page_limit_reached', WORKBENCH_MESSAGES.page_limit_reached);
      }

      const timestamp = now();
      const existingDefault = pages.find((page) => page.is_default === 1) ?? null;
      const willBeDefault = existingDefault === null;
      const page: WorkspacePage = {
        id: any.id,
        name: any.name,
        slug: any.slug,
        isDefault: willBeDefault,
        sortOrder: any.sort_order,
        revision: any.revision + 1,
        createdAt: any.created_at,
        updatedAt: timestamp,
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.pageRestore,
        requestFingerprint: guard.fingerprint,
        preconditionSql: `EXISTS (SELECT 1 FROM workspace_pages p
                                   WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NOT NULL)
                            AND ${SQL_COUNT_ACTIVE_PAGES} = ?`,
        preconditionBinds: [input.pageId, input.workspaceId, input.workspaceId, pages.length],
        build: () => [
          restorePageStatement({ id: input.pageId, workspaceId: input.workspaceId, now: timestamp }),
          rederiveDefaultPageStatement({ workspaceId: input.workspaceId, now: timestamp }),
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { page, defaultPageId: willBeDefault ? input.pageId : (existingDefault?.id ?? null) },
        explain: async () => {
          const latestAny = await readAnyPageRow(deps.db, input.workspaceId, input.pageId);
          if (latestAny === null || latestAny.deleted_at === null) {
            return workbenchFailure('page_not_found', '该页面不在可恢复的墓碑中。');
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async addWidget(input) {
      const guard = await replayGuard<{ instance: ReturnType<typeof toInstance> }>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: WORKBENCH_OP_KINDS.widgetAdd, intent: { pageId: input.pageId, widgetType: input.widgetType, config: input.config ?? null, hidden: input.hidden ?? null } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const found = registry.findWidget(input.widgetType);
      const moduleId = moduleIdOfWidget(registry, input.widgetType);
      if (found === undefined || moduleId === null) {
        return workbenchFailure('widget_unknown', WORKBENCH_MESSAGES.widget_unknown);
      }
      const allowMultiple = allowMultipleOfWidget(registry, input.widgetType) ?? false;
      // 规划空位所依据的**一致快照**：实例集合 + 三个断点的布局修订号。
      // 这些值会一起进入认领语句，因此「规划 → 提交」之间任何布局变更都会让本次写入 409，
      // 而不是让两个并发请求各自选中同一空位、都提交成功、最后形成后端本应拒绝的重叠。
      const [page, gate, installed, existingRects, layoutRevisions] = await Promise.all([
        readPageRow(deps.db, input.workspaceId, input.pageId),
        readModuleGate(deps.db, input.workspaceId, moduleId),
        readActiveInstances(deps.db, input.workspaceId, input.pageId),
        readLayoutRows(deps.db, input.pageId),
        readLayoutRevisions(deps.db, input.pageId),
      ]);
      if (page === null) {
        return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
      }
      if (gate.status !== 'enabled') {
        return workbenchFailure('module_not_ready', moduleNotReadyDetail(gate));
      }
      if (installed.length >= MAX_WIDGETS_PER_PAGE) {
        return workbenchFailure('widget_limit_reached', WORKBENCH_MESSAGES.widget_limit_reached);
      }
      if (!allowMultiple) {
        const duplicate = await findActiveInstanceOfType(deps.db, input.workspaceId, input.widgetType);
        if (duplicate !== null) {
          return workbenchFailure('widget_single_instance', WORKBENCH_MESSAGES.widget_single_instance);
        }
      }
      const normalized = normalizeWidgetConfig(registry, input.widgetType, input.config);
      if (!normalized.ok) {
        return normalized;
      }

      const timestamp = now();
      const widgetId = crypto.randomUUID();
      const planned = planInitialRects({ registry, widgetType: input.widgetType, widgetId, existing: existingRects });
      if (planned === null) {
        return workbenchFailure('layout_invalid', '该断点已无可用空位，无法为新组件生成初始布局。');
      }

      const instance = {
        id: widgetId,
        pageId: input.pageId,
        moduleId,
        widgetType: input.widgetType,
        config: JSON.parse(normalized.json) as unknown,
        configVersion: normalized.configVersion,
        hidden: input.hidden ?? false,
        revision: 0,
        createdRevision: gate.revision,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.widgetAdd,
        requestFingerprint: guard.fingerprint,
        preconditionSql: [
          SQL_PAGE_ACTIVE,
          SQL_MODULE_ENABLED_AT_REVISION,
          SQL_MODULE_NOT_TRANSITIONING,
          // 实例集合必须与规划时完全相同（用 `=` 而不是 `< 上限`：新增/移除都会让数量变化）。
          `${SQL_COUNT_PAGE_INSTANCES} = ?`,
          // 三个断点的布局修订号必须仍是规划时的那一代：addWidget 自身会 bump 它们，
          // 因此任何并发新增/移除/整页保存都会让这里失败，绝不会带着过期空位提交。
          ...LAYOUT_BREAKPOINT_LIST.map(() => `${SQL_LAYOUT_REVISION} = ?`),
          ...(allowMultiple
            ? []
            : [
                `NOT EXISTS (SELECT 1 FROM widget_instances w2
                              JOIN workspace_pages p2 ON p2.id = w2.page_id
                             WHERE w2.workspace_id = ? AND w2.widget_type = ?
                               AND w2.deleted_at IS NULL AND p2.deleted_at IS NULL)`,
              ]),
        ].join(' AND '),
        preconditionBinds: [
          input.pageId,
          input.workspaceId,
          input.workspaceId,
          moduleId,
          gate.revision,
          input.workspaceId,
          moduleId,
          input.pageId,
          installed.length,
          ...LAYOUT_BREAKPOINT_LIST.flatMap((breakpoint) => [
            input.pageId,
            breakpoint,
            layoutRevisions.get(breakpoint) ?? 0,
          ]),
          ...(allowMultiple ? [] : [input.workspaceId, input.widgetType]),
        ],
        build: () => [
          insertInstanceStatement({
            id: widgetId,
            workspaceId: input.workspaceId,
            pageId: input.pageId,
            moduleId,
            widgetType: input.widgetType,
            configJson: normalized.json,
            configVersion: normalized.configVersion,
            hidden: input.hidden ?? false,
            createdRevision: gate.revision,
            now: timestamp,
          }),
          ...LAYOUT_BREAKPOINT_LIST.flatMap((breakpoint) => [
            insertLayoutStatement({ widgetId, breakpoint, rect: planned[breakpoint] }),
            ...bumpLayoutRevisionStatements({ pageId: input.pageId, breakpoint, now: timestamp }),
          ]),
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { instance },
        explain: async () => {
          const [latestPage, latestGate, latestInstances] = await Promise.all([
            readPageRow(deps.db, input.workspaceId, input.pageId),
            readModuleGate(deps.db, input.workspaceId, moduleId),
            readActiveInstances(deps.db, input.workspaceId, input.pageId),
          ]);
          if (latestPage === null) {
            return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
          }
          if (latestGate.status !== 'enabled') {
            return workbenchFailure('module_not_ready', moduleNotReadyDetail(latestGate));
          }
          if (latestInstances.length >= MAX_WIDGETS_PER_PAGE) {
            return workbenchFailure('widget_limit_reached', WORKBENCH_MESSAGES.widget_limit_reached);
          }
          if (!allowMultiple && (await findActiveInstanceOfType(deps.db, input.workspaceId, input.widgetType)) !== null) {
            return workbenchFailure('widget_single_instance', WORKBENCH_MESSAGES.widget_single_instance);
          }
          // 布局修订号变了说明「规划空位所依据的矩形集合」已经过期：
          // 这是并发新增/移除的同义词，必须让客户端重新读取后重试，而不是拿旧空位提交。
          const latestRevisions = await readLayoutRevisions(deps.db, input.pageId);
          const stale = LAYOUT_BREAKPOINT_LIST.some(
            (breakpoint) => (latestRevisions.get(breakpoint) ?? 0) !== (layoutRevisions.get(breakpoint) ?? 0),
          );
          if (stale) {
            return workbenchFailure('layout_revision_conflict', WORKBENCH_MESSAGES.layout_revision_conflict);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async duplicateWidget(input) {
      const guard = await replayGuard<{ instance: ReturnType<typeof toInstance> }>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: WORKBENCH_OP_KINDS.widgetDuplicate, intent: { widgetId: input.widgetId } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const source = await readInstanceRow(deps.db, input.workspaceId, input.widgetId);
      if (source === null) {
        return workbenchFailure('widget_not_found', WORKBENCH_MESSAGES.widget_not_found);
      }
      const found = registry.findWidget(source.widget_type);
      const moduleId = moduleIdOfWidget(registry, source.widget_type);
      if (found === undefined || moduleId === null) {
        return workbenchFailure('widget_unknown', WORKBENCH_MESSAGES.widget_unknown);
      }
      const allowMultiple = allowMultipleOfWidget(registry, source.widget_type) ?? false;
      // 与 `addWidget` 相同的一致快照：复制也依赖「实例集合 + 三个断点修订号」。
      const [gate, siblings, existingRects, layoutRevisions] = await Promise.all([
        readModuleGate(deps.db, input.workspaceId, moduleId),
        readActiveInstances(deps.db, input.workspaceId, source.page_id),
        readLayoutRows(deps.db, source.page_id),
        readLayoutRevisions(deps.db, source.page_id),
      ]);
      if (gate.status !== 'enabled') {
        return workbenchFailure('module_not_ready', moduleNotReadyDetail(gate));
      }
      if (siblings.length >= MAX_WIDGETS_PER_PAGE) {
        return workbenchFailure('widget_limit_reached', WORKBENCH_MESSAGES.widget_limit_reached);
      }
      if (!allowMultiple) {
        return workbenchFailure('widget_single_instance', WORKBENCH_MESSAGES.widget_single_instance);
      }

      const normalized = normalizeWidgetConfig(registry, source.widget_type, JSON.parse(source.config_json) as unknown);
      if (!normalized.ok) {
        return normalized;
      }
      const timestamp = now();
      const widgetId = crypto.randomUUID();
      const planned = planInitialRects({
        registry,
        widgetType: source.widget_type,
        widgetId,
        existing: existingRects,
      });
      if (planned === null) {
        return workbenchFailure('layout_invalid', '该断点已无可用空位，无法为新组件生成初始布局。');
      }
      const instance = {
        id: widgetId,
        pageId: source.page_id,
        moduleId,
        widgetType: source.widget_type,
        config: JSON.parse(normalized.json) as unknown,
        configVersion: normalized.configVersion,
        hidden: source.is_hidden === 1,
        revision: 0,
        createdRevision: gate.revision,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.widgetDuplicate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: [
          SQL_INSTANCE_ACTIVE,
          SQL_MODULE_ENABLED_AT_REVISION,
          SQL_MODULE_NOT_TRANSITIONING,
          `${SQL_COUNT_PAGE_INSTANCES} = ?`,
          ...LAYOUT_BREAKPOINT_LIST.map(() => `${SQL_LAYOUT_REVISION} = ?`),
        ].join(' AND '),
        preconditionBinds: [
          input.widgetId,
          input.workspaceId,
          input.workspaceId,
          moduleId,
          gate.revision,
          input.workspaceId,
          moduleId,
          source.page_id,
          siblings.length,
          ...LAYOUT_BREAKPOINT_LIST.flatMap((breakpoint) => [
            source.page_id,
            breakpoint,
            layoutRevisions.get(breakpoint) ?? 0,
          ]),
        ],
        build: () => [
          insertInstanceStatement({
            id: widgetId,
            workspaceId: input.workspaceId,
            pageId: source.page_id,
            moduleId,
            widgetType: source.widget_type,
            configJson: normalized.json,
            configVersion: normalized.configVersion,
            hidden: source.is_hidden === 1,
            createdRevision: gate.revision,
            now: timestamp,
          }),
          ...LAYOUT_BREAKPOINT_LIST.flatMap((breakpoint) => [
            insertLayoutStatement({ widgetId, breakpoint, rect: planned[breakpoint] }),
            ...bumpLayoutRevisionStatements({ pageId: source.page_id, breakpoint, now: timestamp }),
          ]),
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { instance },
        explain: async () => {
          const latest = await readInstanceRow(deps.db, input.workspaceId, input.widgetId);
          if (latest === null) {
            return workbenchFailure('widget_not_found', WORKBENCH_MESSAGES.widget_not_found);
          }
          const latestGate = await readModuleGate(deps.db, input.workspaceId, moduleId);
          if (latestGate.status !== 'enabled') {
            return workbenchFailure('module_not_ready', moduleNotReadyDetail(latestGate));
          }
          const latestRevisions = await readLayoutRevisions(deps.db, source.page_id);
          const stale = LAYOUT_BREAKPOINT_LIST.some(
            (breakpoint) => (latestRevisions.get(breakpoint) ?? 0) !== (layoutRevisions.get(breakpoint) ?? 0),
          );
          if (stale) {
            return workbenchFailure('layout_revision_conflict', WORKBENCH_MESSAGES.layout_revision_conflict);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async updateWidget(input) {
      const guard = await replayGuard<{ instance: ReturnType<typeof toInstance>; noop: boolean }>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: WORKBENCH_OP_KINDS.widgetUpdate, intent: { widgetId: input.widgetId, expectedRevision: input.expectedRevision, config: input.config ?? null, hidden: input.hidden ?? null } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const current = await readInstanceRow(deps.db, input.workspaceId, input.widgetId);
      if (current === null) {
        return workbenchFailure('widget_not_found', WORKBENCH_MESSAGES.widget_not_found);
      }
      if (current.revision !== input.expectedRevision) {
        return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
      }
      const normalized =
        input.config === undefined
          ? { ok: true as const, json: current.config_json, configVersion: current.config_version }
          : normalizeWidgetConfig(registry, current.widget_type, input.config);
      if (!normalized.ok) {
        return normalized;
      }
      const nextHidden = input.hidden ?? current.is_hidden === 1;
      const noop = configEquals(current.config_json, normalized.json) && nextHidden === (current.is_hidden === 1);

      const timestamp = now();
      const instance = {
        ...toInstance(current),
        config: JSON.parse(normalized.json) as unknown,
        configVersion: normalized.configVersion,
        hidden: nextHidden,
        revision: noop ? current.revision : current.revision + 1,
        updatedAt: noop ? current.updated_at : timestamp,
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.widgetUpdate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: [
          `EXISTS (SELECT 1 FROM widget_instances wi
                    JOIN workspace_pages p ON p.id = wi.page_id
                   WHERE wi.id = ? AND p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL
                     AND wi.revision = ?)`,
          SQL_MODULE_NOT_TRANSITIONING,
        ].join(' AND '),
        preconditionBinds: [
          input.widgetId,
          input.workspaceId,
          input.expectedRevision,
          input.workspaceId,
          current.module_id,
        ],
        build: () => {
          if (noop) {
            return [];
          }
          return [
            updateInstanceStatement({
              id: input.widgetId,
              workspaceId: input.workspaceId,
              expectedRevision: input.expectedRevision,
              configJson: normalized.json,
              configVersion: normalized.configVersion,
              hidden: nextHidden,
              now: timestamp,
            }),
            ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
          ];
        },
        result: { instance, noop },
        explain: async () => {
          const latest = await readInstanceRow(deps.db, input.workspaceId, input.widgetId);
          if (latest === null) {
            return workbenchFailure('widget_not_found', WORKBENCH_MESSAGES.widget_not_found);
          }
          const gate = await readModuleGate(deps.db, input.workspaceId, latest.module_id);
          if (gate.status === 'transitioning') {
            return workbenchFailure('module_not_ready', moduleNotReadyDetail(gate));
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async deleteWidget(input) {
      const guard = await replayGuard<{ widgetId: string }>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: WORKBENCH_OP_KINDS.widgetDelete, intent: { widgetId: input.widgetId, expectedRevision: input.expectedRevision } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const current = await readInstanceRow(deps.db, input.workspaceId, input.widgetId);
      if (current === null) {
        return workbenchFailure('widget_not_found', WORKBENCH_MESSAGES.widget_not_found);
      }
      if (current.revision !== input.expectedRevision) {
        return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
      }
      const timestamp = now();

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.widgetDelete,
        requestFingerprint: guard.fingerprint,
        preconditionSql: [
          `EXISTS (SELECT 1 FROM widget_instances wi
                    JOIN workspace_pages p ON p.id = wi.page_id
                   WHERE wi.id = ? AND p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL
                     AND wi.revision = ?)`,
          SQL_MODULE_NOT_TRANSITIONING,
        ].join(' AND '),
        preconditionBinds: [
          input.widgetId,
          input.workspaceId,
          input.expectedRevision,
          input.workspaceId,
          current.module_id,
        ],
        build: () => [
          tombstoneInstanceStatement({ id: input.widgetId, workspaceId: input.workspaceId, now: timestamp }),
          deleteInstanceLayoutsStatement(input.widgetId),
          ...LAYOUT_BREAKPOINT_LIST.flatMap((breakpoint) =>
            bumpLayoutRevisionStatements({ pageId: current.page_id, breakpoint, now: timestamp }),
          ),
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { widgetId: input.widgetId },
        explain: async () => {
          const latest = await readInstanceRow(deps.db, input.workspaceId, input.widgetId);
          if (latest === null) {
            return workbenchFailure('widget_not_found', WORKBENCH_MESSAGES.widget_not_found);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async saveLayout(input) {
      const guard = await replayGuard<{ layout: BreakpointLayout }>({ workspaceId: input.workspaceId, operationId: input.operationId, kind: layoutSaveKind(input.breakpoint), intent: { pageId: input.pageId, breakpoint: input.breakpoint, baseRevision: input.baseRevision, rects: input.rects } });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const page = await readPageRow(deps.db, input.workspaceId, input.pageId);
      if (page === null) {
        return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
      }
      const [instances, revisions] = await Promise.all([
        readActiveInstances(deps.db, input.workspaceId, input.pageId),
        readLayoutRevisions(deps.db, input.pageId),
      ]);
      const currentRevision = revisions.get(input.breakpoint) ?? 0;
      if (currentRevision !== input.baseRevision) {
        return workbenchFailure('layout_revision_conflict', WORKBENCH_MESSAGES.layout_revision_conflict);
      }

      // 整页保存：矩形集合必须**恰好**覆盖该页面的全部活跃实例。
      // 为什么不允许部分提交：缺少某个实例的矩形会让它在某个断点下变成「有实例没位置」，
      // 那种半状态正是「静默丢布局」的来源。
      const activeIds = new Set(instances.map((instance) => instance.id));
      const submittedIds = new Set(input.rects.map((rect) => rect.i));
      if (activeIds.size !== submittedIds.size || [...activeIds].some((id) => !submittedIds.has(id))) {
        return workbenchFailure('layout_invalid', '布局必须覆盖该页面的全部组件实例，不能只提交一部分。');
      }

      const constraints = new Map<string, ReturnType<typeof sizeConstraintOfWidget>>();
      for (const instance of instances) {
        constraints.set(instance.id, sizeConstraintOfWidget(registry, instance.widget_type));
      }
      const validation = validateLayoutRects({
        breakpoint: input.breakpoint,
        rects: input.rects,
        constraintsOf: (widgetId) => constraints.get(widgetId) ?? null,
      });
      if (!validation.ok) {
        const first = validation.violations[0];
        return workbenchFailure(
          'layout_invalid',
          `${WORKBENCH_MESSAGES.layout_invalid}（${first?.code ?? 'unknown'}：${first?.detail ?? ''}）`,
        );
      }

      const timestamp = now();
      const nextRevision = currentRevision + 1;
      const layout: BreakpointLayout = {
        breakpoint: input.breakpoint,
        revision: nextRevision,
        cols: columnsForBreakpoint(input.breakpoint),
        rects: [...input.rects],
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: layoutSaveKind(input.breakpoint),
        requestFingerprint: guard.fingerprint,
        preconditionSql: [
          SQL_PAGE_ACTIVE,
          `${SQL_LAYOUT_REVISION} = ?`,
          `${SQL_COUNT_PAGE_INSTANCES} = ?`,
          `NOT EXISTS (SELECT 1 FROM widget_instances w2
                        WHERE w2.page_id = ? AND w2.deleted_at IS NULL
                          AND w2.id NOT IN (${input.rects.map(() => '?').join(', ') || 'NULL'}))`,
        ].join(' AND '),
        preconditionBinds: [
          input.pageId,
          input.workspaceId,
          input.pageId,
          input.breakpoint,
          input.baseRevision,
          input.pageId,
          input.rects.length,
          input.pageId,
          ...input.rects.map((rect) => rect.i),
        ],
        build: () => [
          deletePageBreakpointLayoutsStatement({ pageId: input.pageId, breakpoint: input.breakpoint }),
          ...input.rects.map((rect) =>
            insertLayoutStatement({ widgetId: rect.i, breakpoint: input.breakpoint, rect }),
          ),
          ...setLayoutRevisionStatements({
            pageId: input.pageId,
            breakpoint: input.breakpoint,
            revision: nextRevision,
            now: timestamp,
          }),
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { layout },
        explain: async () => {
          const latestPage = await readPageRow(deps.db, input.workspaceId, input.pageId);
          if (latestPage === null) {
            return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
          }
          const latestRevisions = await readLayoutRevisions(deps.db, input.pageId);
          const latest = latestRevisions.get(input.breakpoint) ?? 0;
          if (latest !== input.baseRevision) {
            return workbenchFailure('layout_revision_conflict', WORKBENCH_MESSAGES.layout_revision_conflict);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },

    async applyTemplate(input) {
      // 请求指纹：三种模板模式共用同一份意图描述，避免两处各写一遍导致漂移。
      // `new_page` 复用 `createPage`（类别是 `page.create`），由那条路径自己做幂等短路；
      // 另外两种模式在这里短路，因为存入的结果本身就是 `ApplyTemplateResult`。
      const templateIntent = {
        templateId: input.templateId,
        mode: input.mode,
        pageName: input.pageName ?? null,
        pageId: input.pageId ?? null,
        expectedRevision: input.expectedRevision ?? null,
      };
      let templateFingerprint = '';
      if (input.mode !== 'new_page') {
        const kind =
          input.mode === 'replace_page'
            ? WORKBENCH_OP_KINDS.templateReplacePage
            : WORKBENCH_OP_KINDS.templateResetWorkspace;
        templateFingerprint = await fingerprintOf(kind, templateIntent);
        const replay = await readWorkbenchReplay<ApplyTemplateResult>({
          db: deps.db,
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          kind,
          requestFingerprint: templateFingerprint,
        });
        if (replay !== null) {
          return replay;
        }
      }
      const template = findWorkbenchTemplate(input.templateId);
      if (template === null) {
        return workbenchFailure('invalid_input', `未知模板：${input.templateId}`);
      }
      const timestamp = now();
      const plan = await planTemplateWidgets({ workspaceId: input.workspaceId, templateId: input.templateId });
      /**
       * 模板会批量写入多个模块的实例，而这些实例语句各自没有模块门禁条件
       * （与 `addWidget` 不同）。因此必须把「模块已启用且代际一致、且不在 transitioning」
       * 整体放进认领语句，否则「读门禁 → 组批 → 提交」之间模块被停用时
       * 会写入未授权模块的实例。
       */
      const gateConditions = moduleGateConditions({
        workspaceId: input.workspaceId,
        modules: plan.planned.map((widget) => ({ moduleId: widget.moduleId, revision: widget.createdRevision })),
      });

      if (input.mode === 'new_page') {
        const pageName = input.pageName ?? template.pages[0]?.name ?? '新页面';
        const created = await service.createPage({
          workspaceId: input.workspaceId,
          name: pageName,
          templateId: input.templateId,
          operationId: input.operationId,
        });
        if (!created.ok) {
          return created;
        }
        return {
          ok: true,
          replayed: created.replayed,
          value: {
            mode: 'new_page',
            templateId: input.templateId,
            pages: [created.value.page],
            defaultPageId: created.value.defaultPageId,
            skipped: created.value.skipped,
          },
        };
      }

      if (input.mode === 'replace_page') {
        const pageId = input.pageId;
        const expectedRevision = input.expectedRevision;
        if (pageId === undefined || expectedRevision === undefined) {
          return workbenchFailure('invalid_input', 'replace_page 需要 pageId 与 expectedRevision');
        }
        const page = await readPageRow(deps.db, input.workspaceId, pageId);
        if (page === null) {
          return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
        }
        if (page.revision !== expectedRevision) {
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        }
        const [pages, revisions] = await Promise.all([
          readActivePages(deps.db, input.workspaceId),
          readLayoutRevisions(deps.db, pageId),
        ]);

        // 替换页面内容：墓碑旧实例（保留模块数据）→ 写入模板实例与布局 → 页面 revision +1。
        const content = pageContentStatements({
          workspaceId: input.workspaceId,
          pageId,
          planned: plan.planned,
          now: timestamp,
        });
        const nextPageRevision = page.revision + 1;
        const nextLayoutRevisions = new Map<LayoutBreakpoint, number>();
        for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
          nextLayoutRevisions.set(breakpoint, (revisions.get(breakpoint) ?? 0) + 1);
        }
        const updatedPage: WorkspacePage = {
          ...toPage(page),
          revision: nextPageRevision,
          updatedAt: timestamp,
        };

        return await runOperation({
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          kind: WORKBENCH_OP_KINDS.templateReplacePage,
          requestFingerprint: templateFingerprint,
          preconditionSql: [
            `EXISTS (SELECT 1 FROM workspace_pages p
                      WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL AND p.revision = ?)`,
            ...(gateConditions.sql === '' ? [] : [gateConditions.sql]),
          ].join(' AND '),
          preconditionBinds: [pageId, input.workspaceId, expectedRevision, ...gateConditions.binds],
          build: () => [
            {
              sql: `UPDATE widget_instances
                       SET deleted_at = ?, revision = revision + 1, updated_at = ?
                     WHERE page_id = ? AND deleted_at IS NULL`,
              binds: [timestamp, timestamp, pageId],
            },
            {
              sql: `DELETE FROM widget_layouts
                     WHERE widget_id IN (SELECT id FROM widget_instances WHERE page_id = ?)`,
              binds: [pageId],
            },
            ...content.statements,
            {
              sql: `UPDATE workspace_pages SET revision = revision + 1, updated_at = ?
                     WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
              binds: [timestamp, pageId, input.workspaceId, expectedRevision],
            },
            ...LAYOUT_BREAKPOINT_LIST.flatMap((breakpoint) =>
              setLayoutRevisionStatements({
                pageId,
                breakpoint,
                revision: nextLayoutRevisions.get(breakpoint) ?? 1,
                now: timestamp,
              }),
            ),
            ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
          ],
          result: {
            mode: 'replace_page' as const,
            templateId: input.templateId,
            pages: [updatedPage],
            defaultPageId: pages.find((candidate) => candidate.is_default === 1)?.id ?? null,
            skipped: plan.skipped,
          },
          explain: async () => {
            const latest = await readPageRow(deps.db, input.workspaceId, pageId);
            if (latest === null) {
              return workbenchFailure('page_not_found', WORKBENCH_MESSAGES.page_not_found);
            }
            return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
          },
        });
      }

      // reset_workspace：把当前全部活跃页面墓碑化，再按模板重建页面。
      // 刻意**不**删除实例与布局：墓碑页面上的内容保持原样，因此逐页 restore 可以把内容带回来。
      // 彻底清空请走「导入替换」，那条路径会自动先写一份可恢复备份。
      const pages = await readActivePages(deps.db, input.workspaceId);
      const newPageId = crypto.randomUUID();
      const slugBase = template.pages[0]?.slug ?? 'page';
      const taken = await readTakenSlugs(deps.db, input.workspaceId);
      const slug = pickSlug(slugBase, taken);
      const pageName = input.pageName ?? template.pages[0]?.name ?? '工作台';
      const content = pageContentStatements({
        workspaceId: input.workspaceId,
        pageId: newPageId,
        planned: plan.planned,
        now: timestamp,
      });
      const createdPage: WorkspacePage = {
        id: newPageId,
        name: pageName,
        slug,
        isDefault: true,
        sortOrder: 0,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.templateResetWorkspace,
        requestFingerprint: templateFingerprint,
        preconditionSql: [`${SQL_COUNT_ACTIVE_PAGES} = ?`, ...(gateConditions.sql === '' ? [] : [gateConditions.sql])].join(
          ' AND ',
        ),
        preconditionBinds: [input.workspaceId, pages.length, ...gateConditions.binds],
        build: () => [
          {
            sql: `UPDATE workspace_pages
                     SET deleted_at = ?, is_default = 0, revision = revision + 1, updated_at = ?
                   WHERE workspace_id = ? AND deleted_at IS NULL`,
            binds: [timestamp, timestamp, input.workspaceId],
          },
          insertPageStatement({
            id: newPageId,
            workspaceId: input.workspaceId,
            name: pageName,
            slug,
            isDefault: true,
            sortOrder: 0,
            now: timestamp,
          }),
          ...content.statements,
          ...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: {
          mode: 'reset_workspace' as const,
          templateId: input.templateId,
          pages: [createdPage],
          defaultPageId: newPageId,
          skipped: plan.skipped,
        },
        explain: async () => {
          if (await slugTakenToday(deps.db, input.workspaceId, slug)) {
            return workbenchFailure('duplicate_slug', `slug 已被占用：${slug}`);
          }
          return workbenchFailure('revision_conflict', WORKBENCH_MESSAGES.revision_conflict);
        },
      });
    },
  };

  return service;
}

/** 该工作空间内是否已存在某类型的活跃实例（`allowMultiple = false` 的判定依据）。 */
export async function findActiveInstanceOfType(
  db: D1Database,
  workspaceId: string,
  widgetType: string,
): Promise<InstanceRow | null> {
  return await db
    .prepare(
      `SELECT wi.id, wi.page_id, wi.module_id, wi.widget_type, wi.config_json, wi.config_version,
              wi.is_hidden, wi.revision, wi.created_revision, wi.created_at, wi.updated_at
         FROM widget_instances wi
         JOIN workspace_pages p ON p.id = wi.page_id
        WHERE wi.workspace_id = ? AND wi.widget_type = ?
          AND wi.deleted_at IS NULL AND p.deleted_at IS NULL
        LIMIT 1`,
    )
    .bind(workspaceId, widgetType)
    .first<InstanceRow>();
}

/** slug（含墓碑）是否已被占用。 */
async function slugTakenToday(db: D1Database, workspaceId: string, slug: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS taken FROM workspace_pages WHERE workspace_id = ? AND slug = ?')
    .bind(workspaceId, slug)
    .first<{ taken: number }>();
  return row !== null;
}
