/**
 * 工作台配置的备份与恢复（HUB-054）。
 *
 * 能力边界（**不得**被读成阶段 06 的全量个人数据导入导出）：
 * - 只处理工作台配置：页面、Widget 实例、三个断点的布局，以及恢复所需的元数据。
 * - **不含**设备 Token（或其摘要）、恢复密钥、WebDAV 用户名/密码、VAPID 私钥、
 *   任何环境变量或服务端秘密。文档 Schema 是 `z.strict()`，多出来的字段是硬错误；
 *   另外还有一次**递归危险字段扫描**，因为组件配置（`config`）本身是自由形状，
 *   `z.strict()` 管不到它内部。
 * - 不在导入过程中启用/停用/卸载任何模块，也不删除任何个人业务数据。
 *
 * 容量自洽（复核要求：不做「导出大于导入上限」的设计）：
 * 导出与导入共用 `WORKBENCH_BACKUP_MAX_BYTES`。导出超过上限时**显式失败**并说明原因，
 * 绝不产出一个永远导不回来的文件；导入超过上限同样显式拒绝。有测试保证正常规模可 round-trip。
 *
 * ID 映射（安全要求：不能借备份 ID 引用别人的数据）：
 * 导入时**总是**为页面与实例重新分配 ID；备份里的 ID 只用于文档内部一致性检查
 * （同一份备份内重复 ID 属于 `duplicate_page_id` / `duplicate_instance_id`）。
 * 因此「拿别人的备份 ID 去覆盖自己的数据」在结构上不可能发生。
 *
 * 预览与落地必须一致：预览的计数直接来自**同一个规划函数** `planImport()`，
 * 因此「预览说会新增 2 页 3 个组件」与「实际写入了什么」不会出现两套说法。
 */
import {
  MAX_BACKUP_INSTANCES,
  MAX_BACKUP_PAGES,
  MAX_WIDGETS_PER_PAGE,
  SERVICE_VERSION,
  WORKBENCH_BACKUP_KIND,
  WORKBENCH_BACKUP_MAX_BYTES,
  WORKBENCH_BACKUP_SCHEMA_VERSION,
  WORKBENCH_MESSAGES,
  autoFlowRects,
  findWidgetConfigContract,
  validateLayoutRects,
  workbenchBackupDocumentSchema,
  type GridRect,
  type LayoutBreakpoint,
  type WorkbenchBackupDocument,
  type WorkbenchImportCounts,
  type WorkbenchImportIssue,
  type WorkbenchImportMode,
  type WorkbenchImportPreview,
  type WorkbenchImportUnknownModule,
  type WorkspacePage,
} from '@ff14-hub/shared';
import type { ModuleRegistry } from '../registry/module-registry';
import {
  LAYOUT_BREAKPOINT_LIST,
  bumpWorkbenchRevisionStatements,
  insertInstanceStatement,
  insertLayoutStatement,
  insertPageStatement,
  moduleGateConditions,
  moduleIdOfWidget,
  normalizeWidgetConfig,
  pickUniqueSlug,
  readActivePages,
  readLayoutRows,
  readModuleGate,
  readTakenSlugs,
  readWorkbenchRevision,
  setLayoutRevisionStatements,
  sizeConstraintOfWidget,
  type InstanceRow,
  type ModuleGate,
  type Statement,
  type StatementList,
} from './internal';
import {
  WORKBENCH_OP_KINDS,
  guardedStatements,
  readWorkbenchReplay,
  runIdempotentWrite,
  workbenchFailure,
  type WorkbenchFailure,
  type WorkbenchResult,
} from './tx';

/** 危险字段名（小写比较）：出现即判为 `dangerous_field`，不允许进入工作台数据。 */
const DANGEROUS_FIELD_NAMES: readonly string[] = [
  'token',
  'devicetoken',
  'device_token',
  'recoverykey',
  'recovery_key',
  'recoveryhash',
  'recovery_hash',
  'password',
  'passwd',
  'webdavpassword',
  'vapidprivatekey',
  'privatekey',
  'authorization',
  'cookie',
  'secret',
  'clientsecret',
];

/** 备份保留份数（含 pre_import 与 manual）。 */
export const WORKBENCH_BACKUP_RETENTION = 5;

export interface WorkbenchBackupSummary {
  readonly id: string;
  readonly kind: 'pre_import' | 'manual';
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly consumedAt: number | null;
}

export interface ImportApplyResult {
  readonly mode: WorkbenchImportMode;
  /** `replace` 模式下自动写入的可恢复备份 ID；`merge` 为 null。 */
  readonly backupId: string | null;
  readonly pages: readonly WorkspacePage[];
  readonly defaultPageId: string | null;
  readonly counts: WorkbenchImportCounts;
  readonly skipped: readonly { readonly widgetType: string; readonly detail: string }[];
  readonly warnings: readonly WorkbenchImportIssue[];
}

export interface ExportResult {
  readonly document: unknown;
  readonly byteLength: number;
  readonly maxBytes: number;
}

export interface WorkbenchBackupService {
  exportDocument(workspaceId: string): Promise<WorkbenchResult<ExportResult>>;
  listBackups(workspaceId: string): Promise<readonly WorkbenchBackupSummary[]>;
  previewImport(input: {
    readonly workspaceId: string;
    readonly rawDocument: unknown;
    readonly mode: WorkbenchImportMode;
  }): Promise<WorkbenchResult<WorkbenchImportPreview>>;
  applyImport(input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly rawDocument: unknown;
    readonly mode: WorkbenchImportMode;
    readonly previewRevision: number;
    readonly operationId: string;
  }): Promise<WorkbenchResult<ImportApplyResult>>;
  restoreBackup(input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly backupId: string;
    readonly operationId: string;
  }): Promise<WorkbenchResult<ImportApplyResult>>;
}

export interface WorkbenchBackupDeps {
  readonly db: D1Database;
  readonly registry: ModuleRegistry;
  readonly now?: () => number;
}

interface PlannedImportInstance {
  readonly widgetType: string;
  readonly moduleId: string;
  readonly configJson: string;
  readonly configVersion: number;
  readonly hidden: boolean;
  readonly rects: Partial<Record<LayoutBreakpoint, GridRect>>;
}

interface PlannedImportPage {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly isDefault: boolean;
  readonly sortOrder: number;
  readonly instances: readonly PlannedImportInstance[];
}

interface ImportPlan {
  readonly pages: readonly PlannedImportPage[];
  readonly skipped: readonly { readonly widgetType: string; readonly detail: string }[];
  readonly warnings: readonly WorkbenchImportIssue[];
}

/** 分析结果：`importable === false` 时 `problems` 非空，且**不会有任何写入**。 */
interface ImportAnalysis {
  readonly importable: boolean;
  readonly mode: WorkbenchImportMode;
  readonly schemaVersion: number | null;
  readonly problems: readonly WorkbenchImportIssue[];
  readonly warnings: readonly WorkbenchImportIssue[];
  readonly unknownModules: readonly WorkbenchImportUnknownModule[];
  readonly counts: WorkbenchImportCounts;
  readonly affectedPages: readonly string[];
  readonly previewRevision: number;
  readonly confirmPrompt: string;
}

export function createWorkbenchBackupService(deps: WorkbenchBackupDeps): WorkbenchBackupService {
  const now = deps.now ?? ((): number => Date.now());
  const registry: ModuleRegistry = deps.registry;

  function emptyCounts(): WorkbenchImportCounts {
    return {
      pagesNew: 0,
      pagesReplaced: 0,
      pagesSkipped: 0,
      instancesNew: 0,
      instancesReplaced: 0,
      instancesSkipped: 0,
    };
  }

  // -------------------------------------------------------------------------
  // 导出
  // -------------------------------------------------------------------------

  async function buildDocument(workspaceId: string): Promise<WorkbenchResult<ExportResult>> {
    const pages = await readActivePages(deps.db, workspaceId);
    const moduleVersions: Record<string, string> = {};
    const widgetConfigVersions: Record<string, number> = {};
    const backupPages: unknown[] = [];
    let instanceCount = 0;

    for (const page of pages) {
      const instances: InstanceRow[] = await readInstancesOfPage(workspaceId, page.id);
      const rects = await readLayoutRows(deps.db, page.id);
      instanceCount += instances.length;
      backupPages.push({
        id: page.id,
        name: page.name,
        slug: page.slug,
        isDefault: page.is_default === 1,
        sortOrder: page.sort_order,
        instances: instances.map((instance) => {
          moduleVersions[instance.module_id] = registry.get(instance.module_id)?.manifest.version ?? 'unknown';
          const contract = findWidgetConfigContract(instance.widget_type);
          widgetConfigVersions[instance.widget_type] = contract?.configSchemaVersion ?? instance.config_version;
          const layouts: Record<string, GridRect> = {};
          for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
            const rect = rects.find((row) => row.widget_id === instance.id && row.breakpoint === breakpoint);
            if (rect !== undefined) {
              layouts[breakpoint] = { i: instance.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
            }
          }
          return {
            id: instance.id,
            widgetType: instance.widget_type,
            moduleId: instance.module_id,
            config: JSON.parse(instance.config_json) as unknown,
            configVersion: instance.config_version,
            hidden: instance.is_hidden === 1,
            layouts,
          };
        }),
      });
    }

    const document = {
      kind: WORKBENCH_BACKUP_KIND,
      schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
      exportedAt: now(),
      appVersion: SERVICE_VERSION,
      moduleVersions,
      widgetConfigVersions,
      pages: backupPages,
    };

    if (pages.length > MAX_BACKUP_PAGES || instanceCount > MAX_BACKUP_INSTANCES) {
      return workbenchFailure('export_too_large', WORKBENCH_MESSAGES.export_too_large);
    }
    const byteLength = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (byteLength > WORKBENCH_BACKUP_MAX_BYTES) {
      // 关键：**不允许**产出一个导不回来的文件。
      return workbenchFailure('export_too_large', WORKBENCH_MESSAGES.export_too_large);
    }
    return { ok: true, replayed: false, value: { document, byteLength, maxBytes: WORKBENCH_BACKUP_MAX_BYTES } };
  }

  /** 按页面取活跃实例（导出一份自用读取器，避免与 service 的读路径互相耦合）。 */
  async function readInstancesOfPage(workspaceId: string, pageId: string): Promise<InstanceRow[]> {
    const result = await deps.db
      .prepare(
        `SELECT wi.id, wi.page_id, wi.module_id, wi.widget_type, wi.config_json, wi.config_version,
                wi.is_hidden, wi.revision, wi.created_revision, wi.created_at, wi.updated_at
           FROM widget_instances wi
           JOIN workspace_pages p ON p.id = wi.page_id
          WHERE wi.page_id = ? AND p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL
          ORDER BY wi.created_at ASC, wi.id ASC`,
      )
      .bind(pageId, workspaceId)
      .all<InstanceRow>();
    return result.results;
  }

  // -------------------------------------------------------------------------
  // 规划（预览与实际落地共用同一份实现）
  // -------------------------------------------------------------------------

  /** 把备份文档编译成「新页面 + 新实例 + 新布局」的计划（ID 全部重新分配）。 */
  async function planImport(input: {
    readonly workspaceId: string;
    readonly document: WorkbenchBackupDocument;
  }): Promise<ImportPlan> {
    const pages: PlannedImportPage[] = [];
    const skipped: { widgetType: string; detail: string }[] = [];
    const warnings: WorkbenchImportIssue[] = [];
    /**
     * slug 必须重新分配（与页面 ID 同理，见 ADR-0003 D9）。
     *
     * `idx_workspace_pages_slug` 是覆盖**全部行（含墓碑）**的唯一索引，因此备份里的 slug
     * 在同一个工作空间里几乎总是已被占用（把导出导回原地时必然如此）。
     * 原样写入会撞唯一索引并使整个导入事务回滚 —— 表现为 500 而不是可解释结果。
     */
    const takenSlugs = await readTakenSlugs(deps.db, input.workspaceId);

    for (const page of input.document.pages) {
      const instances: PlannedImportInstance[] = [];
      for (const instance of page.instances) {
        const moduleId = moduleIdOfWidget(registry, instance.widgetType);
        const found = registry.findWidget(instance.widgetType);
        if (moduleId === null || found === undefined) {
          skipped.push({ widgetType: instance.widgetType, detail: '组件类型未注册' });
          continue;
        }
        // 组件归属以**静态注册表**为权威：备份里声明的 moduleId 不能把组件挂到别的模块上。
        if (instance.moduleId !== moduleId) {
          warnings.push({
            code: 'invalid_shape',
            path: `${page.id}/${instance.id}`,
            detail: `组件归属以注册表为准：${instance.widgetType} 属于 ${moduleId}`,
          });
        }
        const gate = await readModuleGate(deps.db, input.workspaceId, moduleId);
        if (gate.status !== 'enabled') {
          // 明确跳过，绝不偷偷启用模块。
          skipped.push({ widgetType: instance.widgetType, detail: `所属模块 ${moduleId} 当前不可用` });
          continue;
        }
        const normalized = normalizeWidgetConfig(registry, instance.widgetType, instance.config);
        if (!normalized.ok) {
          skipped.push({ widgetType: instance.widgetType, detail: normalized.detail });
          continue;
        }
        const constraint = sizeConstraintOfWidget(registry, instance.widgetType);
        const rects: Partial<Record<LayoutBreakpoint, GridRect>> = {};
        for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
          const rect = instance.layouts[breakpoint];
          if (rect === undefined || constraint === null) {
            continue;
          }
          const validation = validateLayoutRects({
            breakpoint,
            rects: [{ i: instance.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h }],
            constraintsOf: () => constraint,
          });
          if (!validation.ok) {
            warnings.push({
              code: 'layout_invalid',
              path: `${page.id}/${instance.id}/${breakpoint}`,
              detail: `${breakpoint} 布局不合法，导入时改为自动排布`,
            });
            continue;
          }
          rects[breakpoint] = { i: '', x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        }
        instances.push({
          widgetType: instance.widgetType,
          moduleId,
          configJson: normalized.json,
          configVersion: normalized.configVersion,
          hidden: instance.hidden,
          rects,
        });
      }
      const slug = pickUniqueSlug(page.slug, takenSlugs);
      takenSlugs.add(slug);
      pages.push({
        id: crypto.randomUUID(),
        name: page.name,
        slug,
        isDefault: page.isDefault,
        sortOrder: page.sortOrder,
        instances,
      });
    }

    return { pages, skipped, warnings };
  }

  // -------------------------------------------------------------------------
  // 分析（预览）
  // -------------------------------------------------------------------------

  function scanDangerousFields(value: unknown, path: string, found: WorkbenchImportIssue[]): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        scanDangerousFields(item, `${path}[${String(index)}]`, found);
      });
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (DANGEROUS_FIELD_NAMES.includes(key.toLowerCase())) {
        found.push({ code: 'dangerous_field', path: `${path}.${key}`, detail: `不允许出现疑似凭证字段：${key}` });
      }
      scanDangerousFields(child, `${path}.${key}`, found);
    }
  }

  async function analyze(input: {
    readonly workspaceId: string;
    readonly rawDocument: unknown;
    readonly mode: WorkbenchImportMode;
  }): Promise<WorkbenchResult<ImportAnalysis>> {
    const problems: WorkbenchImportIssue[] = [];
    const warnings: WorkbenchImportIssue[] = [];
    const previewRevision = await readWorkbenchRevision(deps.db, input.workspaceId);
    const activePages = await readActivePages(deps.db, input.workspaceId);
    const affectedPages = input.mode === 'replace' ? activePages.map((page) => page.name) : [];

    const emptyAnalysis = (schemaVersion: number | null): ImportAnalysis => ({
      importable: false,
      mode: input.mode,
      schemaVersion,
      problems,
      warnings,
      unknownModules: [],
      counts: emptyCounts(),
      affectedPages,
      previewRevision,
      confirmPrompt: '',
    });

    let serialized: string;
    try {
      serialized = JSON.stringify(input.rawDocument);
    } catch {
      return workbenchFailure('invalid_input', '备份内容无法序列化。');
    }
    if (new TextEncoder().encode(serialized).byteLength > WORKBENCH_BACKUP_MAX_BYTES) {
      problems.push({ code: 'too_large', detail: WORKBENCH_MESSAGES.import_too_large });
    }
    scanDangerousFields(input.rawDocument, '$', problems);

    // 版本单独判断，才能给出「不支持哪个版本」这种可解释结果。
    const rawVersion =
      typeof input.rawDocument === 'object' && input.rawDocument !== null
        ? (input.rawDocument as Record<string, unknown>)['schemaVersion']
        : undefined;
    if (rawVersion !== WORKBENCH_BACKUP_SCHEMA_VERSION) {
      problems.push({
        code: 'unsupported_version',
        path: '$.schemaVersion',
        detail: `只支持 schemaVersion=${String(WORKBENCH_BACKUP_SCHEMA_VERSION)}，收到 ${String(rawVersion)}`,
      });
      return { ok: true, replayed: false, value: emptyAnalysis(null) };
    }

    const parsed = workbenchBackupDocumentSchema.safeParse(input.rawDocument);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({ code: 'invalid_shape', path: issue.path.join('.') || '$', detail: '备份结构与契约不符' });
      }
      return { ok: true, replayed: false, value: emptyAnalysis(WORKBENCH_BACKUP_SCHEMA_VERSION) };
    }
    const document = parsed.data;

    // 文档内部一致性：重复 ID 必须被拒绝（否则 ID 映射会产生歧义）。
    const pageIds = new Set<string>();
    for (const page of document.pages) {
      if (pageIds.has(page.id)) {
        problems.push({ code: 'duplicate_page_id', path: page.id, detail: '备份内页面 ID 重复' });
      }
      pageIds.add(page.id);
      const instanceIds = new Set<string>();
      if (page.instances.length > MAX_WIDGETS_PER_PAGE) {
        problems.push({ code: 'page_limit_exceeded', path: page.id, detail: '单页组件数超过上限' });
      }
      for (const instance of page.instances) {
        if (instanceIds.has(instance.id)) {
          problems.push({ code: 'duplicate_instance_id', path: instance.id, detail: '备份内组件实例 ID 重复' });
        }
        instanceIds.add(instance.id);
      }
    }
    if (document.pages.length > MAX_BACKUP_PAGES) {
      problems.push({ code: 'page_limit_exceeded', detail: '备份中的页面数超过上限' });
    }
    for (const page of document.pages) {
      for (const instance of page.instances) {
        if (moduleIdOfWidget(registry, instance.widgetType) === null) {
          problems.push({
            code: 'unknown_widget_type',
            path: `${page.id}/${instance.id}`,
            detail: `未注册的组件类型：${instance.widgetType}`,
          });
        }
      }
    }

    if (problems.length > 0) {
      return { ok: true, replayed: false, value: emptyAnalysis(WORKBENCH_BACKUP_SCHEMA_VERSION) };
    }

    // 计数与警告一律来自实际规划函数，保证「预览 == 落地」。
    const plan = await planImport({ workspaceId: input.workspaceId, document });
    warnings.push(...plan.warnings);

    const unknownModules = new Map<string, { instanceCount: number; widgetTypes: string[]; registered: boolean }>();
    for (const page of document.pages) {
      for (const instance of page.instances) {
        const moduleId = moduleIdOfWidget(registry, instance.widgetType);
        if (moduleId === null) {
          continue;
        }
        const gate = await readModuleGate(deps.db, input.workspaceId, moduleId);
        if (gate.status === 'enabled') {
          continue;
        }
        const entry = unknownModules.get(moduleId) ?? {
          instanceCount: 0,
          widgetTypes: [],
          registered: registry.get(moduleId) !== undefined,
        };
        entry.instanceCount += 1;
        if (!entry.widgetTypes.includes(instance.widgetType)) {
          entry.widgetTypes.push(instance.widgetType);
        }
        unknownModules.set(moduleId, entry);
      }
    }

    const counts: WorkbenchImportCounts = {
      pagesNew: plan.pages.length,
      pagesReplaced: input.mode === 'replace' ? activePages.length : 0,
      pagesSkipped: 0,
      instancesNew: plan.pages.reduce((sum, page) => sum + page.instances.length, 0),
      instancesReplaced: 0,
      instancesSkipped: plan.skipped.length,
    };

    return {
      ok: true,
      replayed: false,
      value: {
        importable: true,
        mode: input.mode,
        schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
        problems,
        warnings,
        unknownModules: [...unknownModules.entries()].map(([moduleId, entry]) => ({
          moduleId,
          instanceCount: entry.instanceCount,
          widgetTypes: entry.widgetTypes,
          registered: entry.registered,
        })),
        counts,
        affectedPages,
        previewRevision,
        confirmPrompt:
          input.mode === 'replace'
            ? `将用备份内容替换当前 ${String(counts.pagesReplaced)} 个页面（同一事务内先写入可撤销备份）。`
            : `将新增 ${String(counts.pagesNew)} 个页面；现有页面不受影响。`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 落地
  // -------------------------------------------------------------------------

  /** 生成「插入一个页面及其全部实例与布局」的语句。 */
  function importPageStatements(input: {
    readonly workspaceId: string;
    readonly page: PlannedImportPage;
    readonly isDefault: boolean;
    readonly now: number;
    readonly createdRevisionOf: (moduleId: string) => number;
  }): StatementList {
    const statements: StatementList = [
      insertPageStatement({
        id: input.page.id,
        workspaceId: input.workspaceId,
        name: input.page.name,
        slug: input.page.slug,
        isDefault: input.isDefault,
        sortOrder: input.page.sortOrder,
        now: input.now,
      }),
    ];

    const inserted: { readonly instanceId: string; readonly widget: PlannedImportInstance }[] = [];
    for (const widget of input.page.instances) {
      const instanceId = crypto.randomUUID();
      statements.push(
        insertInstanceStatement({
          id: instanceId,
          workspaceId: input.workspaceId,
          pageId: input.page.id,
          moduleId: widget.moduleId,
          widgetType: widget.widgetType,
          configJson: widget.configJson,
          configVersion: widget.configVersion,
          hidden: widget.hidden,
          createdRevision: input.createdRevisionOf(widget.moduleId),
          now: input.now,
        }),
      );
      inserted.push({ instanceId, widget });
    }

    // 显式矩形优先；缺失或非法的断点用「自动排布」补齐，
    // 保证每个实例在三个断点下都有位置（否则会留下「有实例没位置」的半状态）。
    for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
      const explicit: GridRect[] = [];
      const missing: { readonly id: string; readonly w: number; readonly h: number }[] = [];
      for (const entry of inserted) {
        const rect = entry.widget.rects[breakpoint];
        if (rect === undefined) {
          const found = registry.findWidget(entry.widget.widgetType);
          missing.push({
            id: entry.instanceId,
            w: found?.widget.defaultSize.w ?? 1,
            h: found?.widget.defaultSize.h ?? 1,
          });
          continue;
        }
        explicit.push({ i: entry.instanceId, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      }
      const rects = [...explicit, ...autoFlowRects({ breakpoint, widgets: missing })];
      if (rects.length === 0) {
        continue;
      }
      for (const rect of rects) {
        statements.push(insertLayoutStatement({ widgetId: rect.i, breakpoint, rect }));
      }
      statements.push(
        ...setLayoutRevisionStatements({ pageId: input.page.id, breakpoint, revision: 1, now: input.now }),
      );
    }
    return statements;
  }

  function insertBackupStatement(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly payloadJson: string;
    readonly now: number;
  }): Statement {
    return {
      sql: `INSERT INTO workbench_backups
              (id, workspace_id, kind, schema_version, payload_json, created_at, created_by_device, consumed_at)
            SELECT ?, ?, 'pre_import', ?, ?, ?, ?, NULL WHERE 1 = 1`,
      binds: [
        input.id,
        input.workspaceId,
        WORKBENCH_BACKUP_SCHEMA_VERSION,
        input.payloadJson,
        input.now,
        input.deviceId,
      ],
    };
  }

  function pruneBackupsStatement(workspaceId: string): Statement {
    return {
      sql: `DELETE FROM workbench_backups
             WHERE workspace_id = ?
               AND id NOT IN (SELECT b.id FROM workbench_backups b
                               WHERE b.workspace_id = ?
                               ORDER BY b.created_at DESC LIMIT ${String(WORKBENCH_BACKUP_RETENTION)})`,
      binds: [workspaceId, workspaceId],
    };
  }

  /**
   * 应用一份文档（导入与恢复共用）。
   * `replace` 模式在**同一个事务**里先写一份 pre_import 备份，因此「先备份、可撤销」是原子的，
   * 不存在「备份写成功但替换失败」或反过来的中间状态。
   */
  async function applyDocument(input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly rawDocument: unknown;
    readonly mode: WorkbenchImportMode;
    readonly operationId: string;
    readonly kind: string;
    readonly preconditionSql: string;
    readonly preconditionBinds: readonly unknown[];
    /** 认领失败且不存在同 operationId 记录时返回的拒绝原因（重放/并发冲突都是它）。 */
    readonly preconditionFailure: WorkbenchFailure;
  }): Promise<WorkbenchResult<ImportApplyResult>> {
    // 幂等短路必须最先执行：首次提交成功后工作台 revision 就变了，
    // 若先做新鲜度判断，重试会被早退成 409，客户端拿不到首次结果。
    const replay = await readWorkbenchReplay<ImportApplyResult>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
    });
    if (replay !== null) {
      return replay;
    }
    const analyzed = await analyze({
      workspaceId: input.workspaceId,
      rawDocument: input.rawDocument,
      mode: input.mode,
    });
    if (!analyzed.ok) {
      return analyzed;
    }
    if (!analyzed.value.importable) {
      // 不可导入：**不做任何写入**，把可解释的问题原样返回给预览路径。
      return workbenchFailure(
        'import_not_importable',
        `${WORKBENCH_MESSAGES.import_not_importable}（${String(analyzed.value.problems.length)} 个问题）`,
      );
    }
    const parsed = workbenchBackupDocumentSchema.safeParse(input.rawDocument);
    if (!parsed.success) {
      return workbenchFailure('import_not_importable', WORKBENCH_MESSAGES.import_not_importable);
    }

    const timestamp = now();
    const plan = await planImport({ workspaceId: input.workspaceId, document: parsed.data });
    const activePages = await readActivePages(deps.db, input.workspaceId);

    /**
     * 默认页的处理（数据库不变量：「有活跃页面时默认页唯一」，由部分唯一索引硬保证）。
     * - `replace`：同批先把现有页面 `is_default` 清零，因此备份里的默认页可以直接写 1；
     * - `merge`：现有默认页**必须保留**，否则同一批插入第二个 `is_default = 1` 会撞唯一索引，
     *   导致整个事务回滚（表现为 500，而不是可解释结果）。
     *   因此只有在「当前根本没有活跃默认页」（含导入到空工作空间）时才沿用备份里的默认页。
     */
    const existingDefaultId = activePages.find((page) => page.is_default === 1)?.id ?? null;
    const mayClaimDefault = input.mode === 'replace' || existingDefaultId === null;
    const documentDefaultId = plan.pages.find((page) => page.isDefault)?.id ?? plan.pages[0]?.id ?? null;
    const importedDefaultId = mayClaimDefault ? documentDefaultId : null;
    const effectiveDefaultId = importedDefaultId ?? existingDefaultId;

    const createdRevisionByModule = new Map<string, number>();
    const gateByModule = new Map<string, ModuleGate>();
    for (const page of plan.pages) {
      for (const instance of page.instances) {
        if (!gateByModule.has(instance.moduleId)) {
          gateByModule.set(instance.moduleId, await readModuleGate(deps.db, input.workspaceId, instance.moduleId));
        }
      }
    }
    // 复核：`analyze` 与真正提交之间可能隔着若干次读，模块可能已被停用/卸载。
    // 这里再判一次，并把代际写进认领语句，形成「读门禁 → 提交」之间的原子闭环。
    for (const [moduleId, gate] of gateByModule) {
      if (gate.status !== 'enabled') {
        return workbenchFailure('module_not_ready', `模块 ${moduleId} 当前不可用（${gate.status}）`);
      }
      createdRevisionByModule.set(moduleId, gate.revision);
    }
    const gateConditions = moduleGateConditions({
      workspaceId: input.workspaceId,
      modules: [...gateByModule.entries()].map(([moduleId, gate]) => ({ moduleId, revision: gate.revision })),
    });

    const backupId = input.mode === 'replace' ? crypto.randomUUID() : null;
    let backupPayload = '';
    if (backupId !== null) {
      const current = await buildDocument(input.workspaceId);
      if (!current.ok) {
        return current;
      }
      backupPayload = JSON.stringify(current.value.document);
    }

    const defaultPageId = effectiveDefaultId;
    const resultPages: WorkspacePage[] = plan.pages.map((page, index) => ({
      id: page.id,
      name: page.name,
      slug: page.slug,
      isDefault: page.id === importedDefaultId,
      sortOrder: page.sortOrder === 0 ? index : page.sortOrder,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    const result: ImportApplyResult = {
      mode: input.mode,
      backupId,
      pages: resultPages,
      defaultPageId,
      counts: {
        pagesNew: plan.pages.length,
        pagesReplaced: input.mode === 'replace' ? activePages.length : 0,
        pagesSkipped: 0,
        instancesNew: plan.pages.reduce((sum, page) => sum + page.instances.length, 0),
        instancesReplaced: 0,
        instancesSkipped: plan.skipped.length,
      },
      skipped: plan.skipped,
      warnings: plan.warnings,
    };

    return await runIdempotentWrite<ImportApplyResult>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      now: timestamp,
      preconditionSql: [
        input.preconditionSql,
        ...(gateConditions.sql === '' ? [] : [gateConditions.sql]),
      ].join(' AND '),
      preconditionBinds: [...input.preconditionBinds, ...gateConditions.binds],
      buildStatements: (guard) => {
        const statements: StatementList = [];
        if (backupId !== null) {
          statements.push(
            insertBackupStatement({
              id: backupId,
              workspaceId: input.workspaceId,
              deviceId: input.deviceId,
              payloadJson: backupPayload,
              now: timestamp,
            }),
          );
        }
        if (input.mode === 'replace') {
          // 只墓碑页面：其下实例与布局保持原样，因此替换前的状态整体可恢复。
          statements.push({
            sql: `UPDATE workspace_pages
                     SET deleted_at = ?, is_default = 0, revision = revision + 1, updated_at = ?
                   WHERE workspace_id = ? AND deleted_at IS NULL`,
            binds: [timestamp, timestamp, input.workspaceId],
          });
        }
        plan.pages.forEach((page, index) => {
          statements.push(
            ...importPageStatements({
              workspaceId: input.workspaceId,
              page,
              isDefault: page.id === defaultPageId,
              now: timestamp + index,
              createdRevisionOf: (moduleId) => createdRevisionByModule.get(moduleId) ?? 0,
            }),
          );
        });
        if (backupId !== null) {
          statements.push(pruneBackupsStatement(input.workspaceId));
        }
        statements.push(...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }));
        return guardedStatements(deps.db, guard, statements);
      },
      result,
      // 认领失败且不存在同 operationId 记录：一律返回调用方给定的拒绝原因
      // （替换导入 = 预览已过期；恢复备份 = 备份不存在或已用过）。
      explain: (): Promise<WorkbenchFailure> => Promise.resolve(input.preconditionFailure),
    });
  }

  return {
    exportDocument: buildDocument,

    async listBackups(workspaceId) {
      const result = await deps.db
        .prepare(
          `SELECT id, kind, schema_version, created_at, consumed_at
             FROM workbench_backups WHERE workspace_id = ?
            ORDER BY created_at DESC LIMIT ${String(WORKBENCH_BACKUP_RETENTION)}`,
        )
        .bind(workspaceId)
        .all<{
          id: string;
          kind: 'pre_import' | 'manual';
          schema_version: number;
          created_at: number;
          consumed_at: number | null;
        }>();
      return result.results.map((row) => ({
        id: row.id,
        kind: row.kind,
        schemaVersion: row.schema_version,
        createdAt: row.created_at,
        consumedAt: row.consumed_at,
      }));
    },

    async previewImport(input) {
      const analyzed = await analyze(input);
      if (!analyzed.ok) {
        return analyzed;
      }
      const analysis = analyzed.value;
      return {
        ok: true,
        replayed: false,
        value: {
          importable: analysis.importable,
          mode: analysis.mode,
          schemaVersion: analysis.schemaVersion,
          problems: analysis.problems,
          warnings: analysis.warnings,
          unknownModules: analysis.unknownModules,
          counts: analysis.counts,
          affectedPages: analysis.affectedPages,
          previewRevision: analysis.previewRevision,
          confirmPrompt: analysis.confirmPrompt,
        } satisfies WorkbenchImportPreview,
      };
    },

    async applyImport(input) {
      return await applyDocument({
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
        rawDocument: input.rawDocument,
        mode: input.mode,
        operationId: input.operationId,
        kind: input.mode === 'merge' ? WORKBENCH_OP_KINDS.importMerge : WORKBENCH_OP_KINDS.importReplace,
        // 新鲜度：预览之后工作台被改动过就必须重新预览，避免用旧预览替换掉别人的工作。
        preconditionSql:
          'COALESCE((SELECT s.revision FROM workspace_workbench_state s WHERE s.workspace_id = ?), 0) = ?',
        preconditionBinds: [input.workspaceId, input.previewRevision],
        preconditionFailure: workbenchFailure('import_preview_stale', WORKBENCH_MESSAGES.import_preview_stale),
      });
    },

    async restoreBackup(input) {
      const row = await deps.db
        .prepare('SELECT id, payload_json FROM workbench_backups WHERE id = ? AND workspace_id = ?')
        .bind(input.backupId, input.workspaceId)
        .first<{ id: string; payload_json: string }>();
      if (row === null) {
        return workbenchFailure('backup_not_found', WORKBENCH_MESSAGES.backup_not_found);
      }
      let document: unknown;
      try {
        document = JSON.parse(row.payload_json);
      } catch {
        return workbenchFailure('backup_not_found', '该备份已损坏，无法恢复。');
      }

      const applied = await applyDocument({
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
        rawDocument: document,
        mode: 'replace',
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.backupRestore,
        preconditionSql:
          'EXISTS (SELECT 1 FROM workbench_backups b WHERE b.id = ? AND b.workspace_id = ? AND b.consumed_at IS NULL)',
        preconditionBinds: [input.backupId, input.workspaceId],
        preconditionFailure: workbenchFailure('backup_not_found', WORKBENCH_MESSAGES.backup_not_found),
      });
      if (!applied.ok) {
        return applied;
      }
      // 标记已使用：便于界面区分「已用过的撤销点」，也防止同一份撤销点被重复套用。
      await deps.db
        .prepare('UPDATE workbench_backups SET consumed_at = ? WHERE id = ? AND workspace_id = ?')
        .bind(now(), input.backupId, input.workspaceId)
        .run();
      return applied;
    },
  };
}
