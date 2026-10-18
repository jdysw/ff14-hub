/**
 * 工作台配置的备份与恢复（阶段 03 / HUB-054，含复核修复）。
 *
 * 能力边界（**不得**被读成阶段 06 的全量个人数据导入导出）：
 * - 只处理工作台配置：页面、Widget 实例、三个断点的布局，以及恢复所需的元数据。
 * - **不含**设备 Token（或其摘要）、恢复密钥、WebDAV 用户名/密码、VAPID 私钥、
 *   任何环境变量或服务端秘密。文档 Schema 是 `z.strict()`，多出来的字段是硬错误；
 *   另外还有一次**递归危险字段扫描**，因为组件配置（`config`）本身是自由形状。
 * - 不在导入过程中启用/停用/卸载任何模块，也不删除任何个人业务数据。
 *
 * 复核修复（本文件相关的四条）：
 * 1. **导出一致性**：页 / 实例 / 布局 / 工作台 revision 在**同一个 D1 batch（同一事务）**里读取，
 *    因此不会导出「混合态」或「有页面但缺布局」的不可恢复文件；导出结果还会再用
 *    `workbenchBackupDocumentSchema` 反校验一次。
 * 2. **恢复原子性**：备份的「未消费校验 + 标记消费」与页面替换在**同一个事务**里完成，
 *    因此两个不同 operationId 不能连续套用同一份撤销点，也不会留下「已恢复但未消费」的半状态。
 *    恢复还要带 `expectedRevision`，防止旧恢复请求静默覆盖刚发生的跨设备变更。
 * 3. **预览绑定**：预览返回 `previewToken`，它绑定 `document + mode + 工作台 revision +
 *    所有相关模块的门禁状态与 revision`。应用时必须原样回显并在提交前重算比对，
 *    任何一项变化都返回 409 要求重新预览——而不是用「执行时再跳过一些实例」事后改变用户确认过的结果。
 * 4. **幂等绑定意图**：导入/恢复同样走 `runIdempotentWrite` 的请求指纹校验，
 *    同一个 operationId 换 document/mode/backup 会被拒绝（零写入）。
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
import { stableStringify } from '../../lib/util';
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
  readModuleGate,
  readTakenSlugs,
  readWorkbenchRevision,
  setLayoutRevisionStatements,
  sizeConstraintOfWidget,
  type ModuleGate,
  type Statement,
  type StatementList,
} from './internal';
import {
  WORKBENCH_OP_KINDS,
  fingerprintOf,
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
    readonly previewToken: string;
    readonly operationId: string;
  }): Promise<WorkbenchResult<ImportApplyResult>>;
  restoreBackup(input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly backupId: string;
    readonly expectedRevision: number;
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
  /** 计划涉及模块的门禁事实（参与预览令牌与原子准入）。 */
  readonly gates: readonly { readonly moduleId: string; readonly gate: ModuleGate }[];
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
  readonly previewToken: string;
  readonly confirmPrompt: string;
}

interface SnapshotRows {
  readonly pages: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly is_default: number;
    readonly sort_order: number;
  }[];
  readonly instances: readonly {
    readonly id: string;
    readonly page_id: string;
    readonly module_id: string;
    readonly widget_type: string;
    readonly config_json: string;
    readonly config_version: number;
    readonly is_hidden: number;
    readonly created_at: number;
  }[];
  readonly layouts: readonly {
    readonly widget_id: string;
    readonly breakpoint: LayoutBreakpoint;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  }[];
  readonly revision: number;
}

// ---------------------------------------------------------------------------
// 纯函数与语句构造（放在外层，避免函数内嵌套抬高认知复杂度）
// ---------------------------------------------------------------------------

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

/** 递归扫描危险字段：组件配置是自由形状，`z.strict()` 管不到它内部。 */
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

/** 文档内部一致性：同一份备份内页面 / 实例 ID 重复必须被拒绝（否则 ID 映射有歧义）。 */
function collectDuplicateIssues(document: WorkbenchBackupDocument): WorkbenchImportIssue[] {
  const issues: WorkbenchImportIssue[] = [];
  const pageIds = new Set<string>();
  for (const page of document.pages) {
    if (pageIds.has(page.id)) {
      issues.push({ code: 'duplicate_page_id', path: page.id, detail: '备份内页面 ID 重复' });
    }
    pageIds.add(page.id);
    if (page.instances.length > MAX_WIDGETS_PER_PAGE) {
      issues.push({ code: 'page_limit_exceeded', path: page.id, detail: '单页组件数超过上限' });
    }
    const instanceIds = new Set<string>();
    for (const instance of page.instances) {
      if (instanceIds.has(instance.id)) {
        issues.push({ code: 'duplicate_instance_id', path: instance.id, detail: '备份内组件实例 ID 重复' });
      }
      instanceIds.add(instance.id);
    }
  }
  if (document.pages.length > MAX_BACKUP_PAGES) {
    issues.push({ code: 'page_limit_exceeded', detail: '备份中的页面数超过上限' });
  }
  return issues;
}

/** 未注册的组件类型是**致命**问题（整份文档不可导入）。 */
function collectUnknownWidgetIssues(document: WorkbenchBackupDocument, registry: ModuleRegistry): WorkbenchImportIssue[] {
  const issues: WorkbenchImportIssue[] = [];
  for (const page of document.pages) {
    for (const instance of page.instances) {
      if (moduleIdOfWidget(registry, instance.widgetType) === null) {
        issues.push({
          code: 'unknown_widget_type',
          path: `${page.id}/${instance.id}`,
          detail: `未注册的组件类型：${instance.widgetType}`,
        });
      }
    }
  }
  return issues;
}

/** 文档体积上限检查（与导出共用同一个常量，见 ADR-0003 D11）。 */
function checkSize(rawDocument: unknown, problems: WorkbenchImportIssue[]): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(rawDocument);
  } catch {
    problems.push({ code: 'invalid_shape', detail: '备份内容无法序列化。' });
    return false;
  }
  if (new TextEncoder().encode(serialized).byteLength > WORKBENCH_BACKUP_MAX_BYTES) {
    problems.push({ code: 'too_large', detail: WORKBENCH_MESSAGES.import_too_large });
    return false;
  }
  return true;
}

function readRawVersion(rawDocument: unknown): unknown {
  return typeof rawDocument === 'object' && rawDocument !== null
    ? (rawDocument as Record<string, unknown>)['schemaVersion']
    : undefined;
}

/**
 * 汇总「因模块不可用而被跳过」的实例。
 * 只描述事实：既不隐式启用模块，也不把这些实例当成「已导入」。
 */
function describeUnknownModules(input: {
  readonly document: WorkbenchBackupDocument;
  readonly gates: readonly { readonly moduleId: string; readonly gate: ModuleGate }[];
  readonly registry: ModuleRegistry;
}): WorkbenchImportUnknownModule[] {
  const disabled = new Map<string, ModuleGate>();
  for (const entry of input.gates) {
    if (entry.gate.status !== 'enabled') {
      disabled.set(entry.moduleId, entry.gate);
    }
  }
  const grouped = new Map<string, { instanceCount: number; widgetTypes: string[] }>();
  for (const page of input.document.pages) {
    for (const instance of page.instances) {
      const moduleId = moduleIdOfWidget(input.registry, instance.widgetType);
      if (moduleId === null || !disabled.has(moduleId)) {
        continue;
      }
      const entry = grouped.get(moduleId) ?? { instanceCount: 0, widgetTypes: [] };
      entry.instanceCount += 1;
      if (!entry.widgetTypes.includes(instance.widgetType)) {
        entry.widgetTypes.push(instance.widgetType);
      }
      grouped.set(moduleId, entry);
    }
  }
  return [...grouped.entries()].map(([moduleId, entry]) => ({
    moduleId,
    instanceCount: entry.instanceCount,
    widgetTypes: entry.widgetTypes,
    registered: input.registry.get(moduleId) !== undefined,
  }));
}

/** 计划摘要令牌。
 *
 * 绑定 `document` + `mode` + 工作台 revision + 每个相关模块的门禁状态与 revision。
 * 用 SHA-256 而不是自定义哈希：跨进程必须一致，且不希望出现「弱哈希被当成安全边界」的隐患。
 */
async function computePreviewToken(input: {
  readonly document: WorkbenchBackupDocument;
  readonly mode: WorkbenchImportMode;
  readonly revision: number;
  readonly gates: readonly { readonly moduleId: string; readonly gate: ModuleGate }[];
}): Promise<string> {
  const canonical = stableStringify({
    mode: input.mode,
    revision: input.revision,
    document: input.document,
    gates: [...input.gates]
      .map((entry) => ({ moduleId: entry.moduleId, status: entry.gate.status, revision: entry.gate.revision }))
      .sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

/** 与页面替换**同事务**的「消费撤销点」语句（0 行表示已被别的请求消费 / 不存在）。 */
function consumeBackupStatement(input: {
  readonly backupId: string;
  readonly workspaceId: string;
  readonly now: number;
}): Statement {
  return {
    sql: `UPDATE workbench_backups SET consumed_at = ?
           WHERE id = ? AND workspace_id = ? AND consumed_at IS NULL`,
    binds: [input.now, input.backupId, input.workspaceId],
  };
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export function createWorkbenchBackupService(deps: WorkbenchBackupDeps): WorkbenchBackupService {
  const now = deps.now ?? ((): number => Date.now());
  const registry: ModuleRegistry = deps.registry;

  // -------------------------------------------------------------------------
  // 导出一致快照
  // -------------------------------------------------------------------------

  /**
   * 读取导出一致快照。
   *
   * **四条 SELECT 放进同一个 `db.batch`**：D1 的 batch 是单个事务，因此页 / 实例 / 布局 /
   * revision 必然来自同一时刻。分多次 SELECT 会导出「页面已删但布局还在」这类不可恢复的混合态。
   */
  async function readConsistentSnapshot(workspaceId: string): Promise<SnapshotRows> {
    const results = await deps.db.batch([
      deps.db
        .prepare(
          `SELECT id, name, slug, is_default, sort_order
             FROM workspace_pages
            WHERE workspace_id = ? AND deleted_at IS NULL
            ORDER BY sort_order ASC, created_at ASC`,
        )
        .bind(workspaceId),
      deps.db
        .prepare(
          `SELECT wi.id, wi.page_id, wi.module_id, wi.widget_type, wi.config_json, wi.config_version,
                  wi.is_hidden, wi.created_at
             FROM widget_instances wi
             JOIN workspace_pages p ON p.id = wi.page_id
            WHERE p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL
            ORDER BY wi.created_at ASC, wi.id ASC`,
        )
        .bind(workspaceId),
      deps.db
        .prepare(
          `SELECT wl.widget_id, wl.breakpoint, wl.x, wl.y, wl.w, wl.h
             FROM widget_layouts wl
             JOIN widget_instances wi ON wi.id = wl.widget_id
             JOIN workspace_pages p ON p.id = wi.page_id
            WHERE p.workspace_id = ? AND wi.deleted_at IS NULL AND p.deleted_at IS NULL`,
        )
        .bind(workspaceId),
      deps.db
        .prepare('SELECT revision FROM workspace_workbench_state WHERE workspace_id = ?')
        .bind(workspaceId),
    ]);

    const revisionRow = results[3]?.results?.[0] as { revision: number } | undefined;
    return {
      pages: (results[0]?.results ?? []) as SnapshotRows['pages'],
      instances: (results[1]?.results ?? []) as SnapshotRows['instances'],
      layouts: (results[2]?.results ?? []) as SnapshotRows['layouts'],
      revision: revisionRow?.revision ?? 0,
    };
  }

  function assembleDocument(snapshot: SnapshotRows): unknown {
    const moduleVersions: Record<string, string> = {};
    const widgetConfigVersions: Record<string, number> = {};
    const backupPages = snapshot.pages.map((page) => {
      const instances = snapshot.instances.filter((instance) => instance.page_id === page.id);
      return {
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
            const rect = snapshot.layouts.find(
              (row) => row.widget_id === instance.id && row.breakpoint === breakpoint,
            );
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
      };
    });

    return {
      kind: WORKBENCH_BACKUP_KIND,
      schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
      exportedAt: now(),
      appVersion: SERVICE_VERSION,
      moduleVersions,
      widgetConfigVersions,
      pages: backupPages,
    };
  }

  async function buildDocument(workspaceId: string): Promise<WorkbenchResult<ExportResult>> {
    const snapshot = await readConsistentSnapshot(workspaceId);
    const document = assembleDocument(snapshot);

    // 导出自校验：不合格就**不**产出文件（宁可失败，也不给用户一份导不回来的备份）。
    const parsed = workbenchBackupDocumentSchema.safeParse(document);
    if (!parsed.success) {
      return workbenchFailure('export_inconsistent', '导出的备份未通过自身契约校验，已放弃本次导出。');
    }
    if (snapshot.pages.length > MAX_BACKUP_PAGES || snapshot.instances.length > MAX_BACKUP_INSTANCES) {
      return workbenchFailure('export_too_large', WORKBENCH_MESSAGES.export_too_large);
    }
    const byteLength = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
    if (byteLength > WORKBENCH_BACKUP_MAX_BYTES) {
      return workbenchFailure('export_too_large', WORKBENCH_MESSAGES.export_too_large);
    }
    return { ok: true, replayed: false, value: { document: parsed.data, byteLength, maxBytes: WORKBENCH_BACKUP_MAX_BYTES } };
  }

  // -------------------------------------------------------------------------
  // 规划
  // -------------------------------------------------------------------------

  /** 解析单个备份实例：返回 null 表示「跳过」，并给出可读原因。 */
  function planInstance(input: {
    readonly workspaceId: string;
    readonly pageId: string;
    readonly instance: WorkbenchBackupDocument['pages'][number]['instances'][number];
    readonly gates: Map<string, ModuleGate>;
    readonly skipped: { widgetType: string; detail: string }[];
    readonly warnings: WorkbenchImportIssue[];
  }): PlannedImportInstance | null {
    const { instance } = input;
    const moduleId = moduleIdOfWidget(registry, instance.widgetType);
    const found = registry.findWidget(instance.widgetType);
    if (moduleId === null || found === undefined) {
      input.skipped.push({ widgetType: instance.widgetType, detail: '组件类型未注册' });
      return null;
    }
    const gate = input.gates.get(moduleId);
    if (gate === undefined || gate.status !== 'enabled') {
      // 明确跳过，绝不偷偷启用模块。
      input.skipped.push({ widgetType: instance.widgetType, detail: `所属模块 ${moduleId} 当前不可用` });
      return null;
    }
    // 组件归属以**静态注册表**为权威：备份里声明的 moduleId 不能把组件挂到别的模块上。
    if (instance.moduleId !== moduleId) {
      input.warnings.push({
        code: 'invalid_shape',
        path: `${input.pageId}/${instance.id}`,
        detail: `组件归属以注册表为准：${instance.widgetType} 属于 ${moduleId}`,
      });
    }
    const normalized = normalizeWidgetConfig(registry, instance.widgetType, instance.config);
    if (!normalized.ok) {
      input.skipped.push({ widgetType: instance.widgetType, detail: normalized.detail });
      return null;
    }
    return {
      widgetType: instance.widgetType,
      moduleId,
      configJson: normalized.json,
      configVersion: normalized.configVersion,
      hidden: instance.hidden,
      rects: planInstanceRects({
        pageId: input.pageId,
        instanceId: instance.id,
        instance,
        widgetType: instance.widgetType,
        warnings: input.warnings,
      }),
    };
  }

  /** 逐断点校验备份里的矩形；不合法的断点留给自动排布（并给出警告）。 */
  function planInstanceRects(input: {
    readonly pageId: string;
    readonly instanceId: string;
    readonly instance: WorkbenchBackupDocument['pages'][number]['instances'][number];
    readonly widgetType: string;
    readonly warnings: WorkbenchImportIssue[];
  }): Partial<Record<LayoutBreakpoint, GridRect>> {
    const rects: Partial<Record<LayoutBreakpoint, GridRect>> = {};
    const constraint = sizeConstraintOfWidget(registry, input.widgetType);
    for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
      const rect = input.instance.layouts[breakpoint];
      if (rect === undefined || constraint === null) {
        continue;
      }
      const validation = validateLayoutRects({
        breakpoint,
        rects: [{ i: input.instanceId, x: rect.x, y: rect.y, w: rect.w, h: rect.h }],
        constraintsOf: () => constraint,
      });
      if (!validation.ok) {
        input.warnings.push({
          code: 'layout_invalid',
          path: `${input.pageId}/${input.instanceId}/${breakpoint}`,
          detail: `${breakpoint} 布局不合法，导入时改为自动排布`,
        });
        continue;
      }
      rects[breakpoint] = { i: '', x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    }
    return rects;
  }

  async function readGatesFor(
    workspaceId: string,
    document: WorkbenchBackupDocument,
  ): Promise<Map<string, ModuleGate>> {
    const moduleIds = new Set<string>();
    for (const page of document.pages) {
      for (const instance of page.instances) {
        const moduleId = moduleIdOfWidget(registry, instance.widgetType);
        if (moduleId !== null) {
          moduleIds.add(moduleId);
        }
      }
    }
    const gates = new Map<string, ModuleGate>();
    // 显式 localeCompare 比较器：默认的 Array#sort 按 UTF-16 码元排序，
    // 对「字母序」并不可靠（Sonar 可靠性规则会标记）；这里只需要稳定的确定性顺序，
    // 以便预览令牌在不同请求之间可复现。
    for (const moduleId of [...moduleIds].sort((a, b) => a.localeCompare(b))) {
      gates.set(moduleId, await readModuleGate(deps.db, workspaceId, moduleId));
    }
    return gates;
  }

  async function planImport(input: {
    readonly workspaceId: string;
    readonly document: WorkbenchBackupDocument;
  }): Promise<ImportPlan> {
    const gates = await readGatesFor(input.workspaceId, input.document);
    const takenSlugs = await readTakenSlugs(deps.db, input.workspaceId);
    const pages: PlannedImportPage[] = [];
    const skipped: { widgetType: string; detail: string }[] = [];
    const warnings: WorkbenchImportIssue[] = [];

    for (const page of input.document.pages) {
      const instances: PlannedImportInstance[] = [];
      for (const instance of page.instances) {
        const planned = planInstance({
          workspaceId: input.workspaceId,
          pageId: page.id,
          instance,
          gates,
          skipped,
          warnings,
        });
        if (planned !== null) {
          instances.push(planned);
        }
      }
      // slug 必须重新分配：slug 唯一索引覆盖**全部行（含墓碑）**，
      // 把导出导回同一工作空间时原 slug 必然已被占用。
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

    return {
      pages,
      skipped,
      warnings,
      gates: [...gates.entries()].map(([moduleId, gate]) => ({ moduleId, gate })),
    };
  }

  // -------------------------------------------------------------------------
  // 分析（预览）
  // -------------------------------------------------------------------------

  async function analyze(input: {
    readonly workspaceId: string;
    readonly rawDocument: unknown;
    readonly mode: WorkbenchImportMode;
  }): Promise<WorkbenchResult<ImportAnalysis>> {
    const problems: WorkbenchImportIssue[] = [];
    const previewRevision = await readWorkbenchRevision(deps.db, input.workspaceId);
    const activePageRows = await deps.db
      .prepare(
        `SELECT name FROM workspace_pages
          WHERE workspace_id = ? AND deleted_at IS NULL
          ORDER BY sort_order ASC, created_at ASC`,
      )
      .bind(input.workspaceId)
      .all<{ name: string }>();
    const activePages = activePageRows.results;
    const affectedPages = input.mode === 'replace' ? activePages.map((page) => page.name) : [];

    const fail = (schemaVersion: number | null): WorkbenchResult<ImportAnalysis> => ({
      ok: true,
      replayed: false,
      value: {
        importable: false,
        mode: input.mode,
        schemaVersion,
        problems,
        warnings: [],
        unknownModules: [],
        counts: emptyCounts(),
        affectedPages,
        previewRevision,
        previewToken: '',
        confirmPrompt: '',
      },
    });

    const rawVersion = readRawVersion(input.rawDocument);
    if (!checkSize(input.rawDocument, problems)) {
      return fail(rawVersion === WORKBENCH_BACKUP_SCHEMA_VERSION ? WORKBENCH_BACKUP_SCHEMA_VERSION : null);
    }
    scanDangerousFields(input.rawDocument, '$', problems);

    if (rawVersion !== WORKBENCH_BACKUP_SCHEMA_VERSION) {
      problems.push({
        code: 'unsupported_version',
        path: '$.schemaVersion',
        detail: `只支持 schemaVersion=${String(WORKBENCH_BACKUP_SCHEMA_VERSION)}，收到 ${String(rawVersion)}`,
      });
      return fail(null);
    }

    const parsed = workbenchBackupDocumentSchema.safeParse(input.rawDocument);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({ code: 'invalid_shape', path: issue.path.join('.') || '$', detail: '备份结构与契约不符' });
      }
      return fail(WORKBENCH_BACKUP_SCHEMA_VERSION);
    }
    const document = parsed.data;

    problems.push(...collectDuplicateIssues(document), ...collectUnknownWidgetIssues(document, registry));
    if (problems.length > 0) {
      return fail(WORKBENCH_BACKUP_SCHEMA_VERSION);
    }

    // 计数与警告一律来自实际规划函数，保证「预览 == 落地」。
    const plan = await planImport({ workspaceId: input.workspaceId, document });
    const previewToken = await computePreviewToken({
      document,
      mode: input.mode,
      revision: previewRevision,
      gates: plan.gates,
    });

    return {
      ok: true,
      replayed: false,
      value: {
        importable: true,
        mode: input.mode,
        schemaVersion: WORKBENCH_BACKUP_SCHEMA_VERSION,
        problems,
        warnings: plan.warnings,
        unknownModules: describeUnknownModules({ document, gates: plan.gates, registry }),
        counts: {
          pagesNew: plan.pages.length,
          pagesReplaced: input.mode === 'replace' ? activePages.length : 0,
          pagesSkipped: 0,
          instancesNew: plan.pages.reduce((sum, page) => sum + page.instances.length, 0),
          instancesReplaced: 0,
          instancesSkipped: plan.skipped.length,
        },
        affectedPages,
        previewRevision,
        previewToken,
        confirmPrompt:
          input.mode === 'replace'
            ? `将用备份内容替换当前 ${String(activePages.length)} 个页面（同一事务内先写入可撤销备份）。`
            : `将新增 ${String(plan.pages.length)} 个页面；现有页面不受影响。`,
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

    for (const breakpoint of LAYOUT_BREAKPOINT_LIST) {
      const rects = buildBreakpointRects(inserted, breakpoint);
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

  /** 显式矩形优先；缺失或非法的断点用自动排布补齐，保证每个实例在每个断点都有位置。 */
  function buildBreakpointRects(
    inserted: readonly { readonly instanceId: string; readonly widget: PlannedImportInstance }[],
    breakpoint: LayoutBreakpoint,
  ): GridRect[] {
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
    return [...explicit, ...autoFlowRects({ breakpoint, widgets: missing })];
  }

  interface ApplyPlan {
    readonly plan: ImportPlan;
    readonly result: ImportApplyResult;
    readonly backupId: string | null;
    readonly backupPayload: string;
    readonly createdRevisionByModule: Map<string, number>;
  }

  /** 落地前的全部读取与校验（不写库）：解析、规划、门禁复验、撤销点快照、结果预计算。 */
  async function prepareApply(input: {
    readonly workspaceId: string;
    readonly rawDocument: unknown;
    readonly mode: WorkbenchImportMode;
    readonly previewRevision: number;
    readonly previewToken: string;
    readonly expectConsumedBackupId: string | null;
    /** 新鲜度不满足时的拒绝原因（导入与恢复的错误码不同）。 */
    readonly staleFailure: WorkbenchFailure;
  }): Promise<WorkbenchResult<ApplyPlan>> {
    const analyzed = await analyze({
      workspaceId: input.workspaceId,
      rawDocument: input.rawDocument,
      mode: input.mode,
    });
    if (!analyzed.ok) {
      return analyzed;
    }
    if (!analyzed.value.importable) {
      return workbenchFailure(
        'import_not_importable',
        `${WORKBENCH_MESSAGES.import_not_importable}（${String(analyzed.value.problems.length)} 个问题）`,
      );
    }
    const parsed = workbenchBackupDocumentSchema.safeParse(input.rawDocument);
    if (!parsed.success) {
      return workbenchFailure('import_not_importable', WORKBENCH_MESSAGES.import_not_importable);
    }

    const plan = await planImport({ workspaceId: input.workspaceId, document: parsed.data });
    const revision = await readWorkbenchRevision(deps.db, input.workspaceId);
    const token = await computePreviewToken({ document: parsed.data, mode: input.mode, revision, gates: plan.gates });
    // 令牌绑定 document + mode + revision + 所有相关模块门禁；任何变化都要求重新预览。
    // 恢复备份走的是服务端自己写下的快照，没有「用户确认过的计划」，因此不比对令牌，
    // 由 `expectedRevision` + 「撤销点未消费」共同承担新鲜度与一次性语义。
    const tokenMatches = input.expectConsumedBackupId !== null || token === input.previewToken;
    if (revision !== input.previewRevision || !tokenMatches) {
      return input.staleFailure;
    }

    const createdRevisionByModule = new Map<string, number>();
    // 门禁校验只针对「真正会被写入」的实例所属模块。
    // 被跳过的实例（模块未启用/卸载/transitioning）**不应该阻塞整次导入**：
    // 这正是 D10 的语义——跳过并如实上报，而不是让用户什么都导不进来。
    const writtenModules = [
      ...new Set(plan.pages.flatMap((page) => page.instances.map((instance) => instance.moduleId))),
    ];
    for (const moduleId of writtenModules) {
      const gate = plan.gates.find((entry) => entry.moduleId === moduleId)?.gate;
      if (gate === undefined || gate.status !== 'enabled') {
        return workbenchFailure('module_not_ready', `模块 ${moduleId} 当前不可用（${gate?.status ?? 'unknown'}）`);
      }
      createdRevisionByModule.set(moduleId, gate.revision);
    }

    const timestamp = now();
    // `replace`（含「恢复备份」这条同样会替换工作台的路径）都在同一事务里先写一份可撤销备份。
    // 恢复因此也是可撤销的：撤销点被别人消费掉不会让用户失去回退能力。
    const backupId = input.mode === 'replace' ? crypto.randomUUID() : null;
    let backupPayload = '';
    if (backupId !== null) {
      const current = await buildDocument(input.workspaceId);
      if (!current.ok) {
        return current;
      }
      backupPayload = JSON.stringify(current.value.document);
    }

    const activePageCount = await deps.db
      .prepare('SELECT COUNT(*) AS count FROM workspace_pages WHERE workspace_id = ? AND deleted_at IS NULL')
      .bind(input.workspaceId)
      .first<{ count: number }>();
    const defaultPageId = plan.pages.find((page) => page.isDefault)?.id ?? plan.pages[0]?.id ?? null;

    /**
     * 默认页归属（数据库不变量：「有活跃页面时默认页唯一」，由部分唯一索引硬保证）。
     *
     * - `replace`：同批先把现有页面 `is_default` 清零，因此备份里的默认页可以直接写 1；
     * - `merge`：现有默认页**必须保留**，否则同一批插入第二个 `is_default = 1` 会撞唯一索引，
     *   让整批回滚（表现为 500）。因此只有「当前根本没有活跃默认页」（含导入到空工作空间）
     *   时才沿用备份里的默认页。
     */
    const existingDefault = await deps.db
      .prepare(
        'SELECT id FROM workspace_pages WHERE workspace_id = ? AND deleted_at IS NULL AND is_default = 1 LIMIT 1',
      )
      .bind(input.workspaceId)
      .first<{ id: string }>();
    const mayClaimDefault = input.mode === 'replace' || existingDefault === null;
    const importedDefaultId = mayClaimDefault ? defaultPageId : null;
    const effectiveDefaultId =
      input.mode === 'replace' ? importedDefaultId : (importedDefaultId ?? existingDefault?.id ?? null);

    return {
      ok: true,
      replayed: false,
      value: {
        plan,
        backupId,
        backupPayload,
        createdRevisionByModule,
        result: {
          mode: input.mode,
          backupId,
          pages: plan.pages.map((page, index) => ({
            id: page.id,
            name: page.name,
            slug: page.slug,
            isDefault: page.id === importedDefaultId,
            sortOrder: page.sortOrder === 0 ? index : page.sortOrder,
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          })),
          defaultPageId: effectiveDefaultId,
          counts: {
            pagesNew: plan.pages.length,
            pagesReplaced: input.mode === 'replace' ? (activePageCount?.count ?? 0) : 0,
            pagesSkipped: 0,
            instancesNew: plan.pages.reduce((sum, page) => sum + page.instances.length, 0),
            instancesReplaced: 0,
            instancesSkipped: plan.skipped.length,
          },
          skipped: plan.skipped,
          warnings: plan.warnings,
        },
      },
    };
  }

  /** 组装落地语句（纯函数，便于被两个入口共用）。 */
  function buildApplyStatements(input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly mode: WorkbenchImportMode;
    readonly plan: ImportPlan;
    readonly prepared: ApplyPlan;
    readonly now: number;
    readonly consumeBackupId: string | null;
  }): StatementList {
    const statements: StatementList = [];
    const timestamp = input.now;

    if (input.prepared.backupId !== null) {
      statements.push(
        insertBackupStatement({
          id: input.prepared.backupId,
          workspaceId: input.workspaceId,
          deviceId: input.deviceId,
          payloadJson: input.prepared.backupPayload,
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
    input.plan.pages.forEach((page, index) => {
      const defaultPageId = input.prepared.result.defaultPageId;
      statements.push(
        ...importPageStatements({
          workspaceId: input.workspaceId,
          page,
          isDefault: page.id === defaultPageId,
          now: timestamp + index,
          createdRevisionOf: (moduleId) => input.prepared.createdRevisionByModule.get(moduleId) ?? 0,
        }),
      );
    });
    if (input.consumeBackupId !== null) {
      // 与替换**同一事务**：消费撤销点不可能与恢复结果脱节。
      statements.push(
        consumeBackupStatement({
          backupId: input.consumeBackupId,
          workspaceId: input.workspaceId,
          now: timestamp,
        }),
      );
    }
    if (input.prepared.backupId !== null) {
      statements.push(pruneBackupsStatement(input.workspaceId));
    }
    statements.push(...bumpWorkbenchRevisionStatements({ workspaceId: input.workspaceId, now: timestamp }));
    return statements;
  }

  /** 导入与恢复共用的落地流程：幂等短路 → 准备 → 原子事务。 */
  async function applyDocument(input: {
    readonly workspaceId: string;
    readonly deviceId: string;
    readonly rawDocument: unknown;
    readonly mode: WorkbenchImportMode;
    readonly previewRevision: number;
    readonly previewToken: string;
    readonly operationId: string;
    readonly kind: string;
    readonly intent: unknown;
    /** 恢复备份时非 null：同事务消费该撤销点。 */
    readonly consumeBackupId: string | null;
    /** 额外的原子前置条件（工作台 revision、撤销点未消费等）。 */
    readonly extraPreconditionSql: readonly string[];
    readonly extraPreconditionBinds: readonly unknown[];
    readonly preconditionFailure: WorkbenchFailure;
    /** 可选的动态解释（认领失败时重新读库，给出更准确的原因）。 */
    readonly explainAsync?: () => Promise<WorkbenchFailure>;
    /** 新鲜度不满足时的拒绝原因（导入 = 预览过期；恢复 = 工作台 revision 冲突）。 */
    readonly staleFailure: WorkbenchFailure;
  }): Promise<WorkbenchResult<ImportApplyResult>> {
    const fingerprint = await fingerprintOf(input.kind, input.intent);
    const replay = await readWorkbenchReplay<ImportApplyResult>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: fingerprint,
    });
    if (replay !== null) {
      return replay;
    }

    const prepared = await prepareApply({
      workspaceId: input.workspaceId,
      rawDocument: input.rawDocument,
      mode: input.mode,
      previewRevision: input.previewRevision,
      previewToken: input.previewToken,
      expectConsumedBackupId: input.consumeBackupId,
      staleFailure: input.staleFailure,
    });
    if (!prepared.ok) {
      return prepared;
    }
    const gateConditions = moduleGateConditions({
      workspaceId: input.workspaceId,
      modules: [...prepared.value.createdRevisionByModule.entries()].map(([moduleId, revision]) => ({
        moduleId,
        revision,
      })),
    });

    const timestamp = now();
    return await runIdempotentWrite<ImportApplyResult>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: fingerprint,
      now: timestamp,
      preconditionSql: [
        ...input.extraPreconditionSql,
        ...(gateConditions.sql === '' ? [] : [gateConditions.sql]),
      ].join(' AND '),
      preconditionBinds: [...input.extraPreconditionBinds, ...gateConditions.binds],
      buildStatements: (guard) =>
        guardedStatements(
          deps.db,
          guard,
          buildApplyStatements({
            workspaceId: input.workspaceId,
            deviceId: input.deviceId,
            mode: input.mode,
            plan: prepared.value.plan,
            prepared: prepared.value,
            now: timestamp,
            consumeBackupId: input.consumeBackupId,
          }),
        ),
      result: prepared.value.result,
      explain: async (): Promise<WorkbenchFailure> =>
        input.explainAsync === undefined ? input.preconditionFailure : await input.explainAsync(),
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
          previewToken: analysis.previewToken,
          confirmPrompt: analysis.confirmPrompt,
        } satisfies WorkbenchImportPreview,
      };
    },

    async applyImport(input) {
      const mode = input.mode;
      return await applyDocument({
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
        rawDocument: input.rawDocument,
        mode,
        previewRevision: input.previewRevision,
        previewToken: input.previewToken,
        operationId: input.operationId,
        kind: mode === 'merge' ? WORKBENCH_OP_KINDS.importMerge : WORKBENCH_OP_KINDS.importReplace,
        intent: {
          mode,
          document: input.rawDocument,
          previewRevision: input.previewRevision,
          previewToken: input.previewToken,
        },
        consumeBackupId: null,
        // 新鲜度：预览之后工作台被改动过就必须重新预览。
        extraPreconditionSql: [
          'COALESCE((SELECT s.revision FROM workspace_workbench_state s WHERE s.workspace_id = ?), 0) = ?',
        ],
        extraPreconditionBinds: [input.workspaceId, input.previewRevision],
        preconditionFailure: workbenchFailure('import_preview_stale', WORKBENCH_MESSAGES.import_preview_stale),
        staleFailure: workbenchFailure('import_preview_stale', WORKBENCH_MESSAGES.import_preview_stale),
      });
    },

    async restoreBackup(input) {
      /**
       * 幂等短路必须**先于**「已消费」检查：
       * 同一 operationId 的重试应该拿回首次结果（`replayed: true` 且零写入），
       * 而不是因为「这份撤销点已经用过了」被判成 409——那会让「响应丢失后重试」永远失败。
       * 换成另一个 operationId 才是真正的「再次消费」，那时才返回 `backup_consumed`。
       */
      const fingerprint = await fingerprintOf(WORKBENCH_OP_KINDS.backupRestore, {
        backupId: input.backupId,
        expectedRevision: input.expectedRevision,
      });
      const replay = await readWorkbenchReplay<ImportApplyResult>({
        db: deps.db,
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.backupRestore,
        requestFingerprint: fingerprint,
      });
      if (replay !== null) {
        return replay;
      }

      const backup = await deps.db
        .prepare(
          'SELECT id, payload_json, consumed_at FROM workbench_backups WHERE id = ? AND workspace_id = ?',
        )
        .bind(input.backupId, input.workspaceId)
        .first<{ id: string; payload_json: string; consumed_at: number | null }>();
      if (backup === null) {
        return workbenchFailure('backup_not_found', WORKBENCH_MESSAGES.backup_not_found);
      }
      if (backup.consumed_at !== null) {
        return workbenchFailure('backup_consumed', WORKBENCH_MESSAGES.backup_consumed);
      }
      let document: unknown;
      try {
        document = JSON.parse(backup.payload_json);
      } catch {
        return workbenchFailure('backup_not_found', '该备份已损坏，无法恢复。');
      }

      return await applyDocument({
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
        rawDocument: document,
        mode: 'replace',
        previewRevision: input.expectedRevision,
        // 恢复不需要用户确认预览令牌：撤销点的内容就是服务端自己写下的快照，
        // 这里用「expectedRevision + 备份未消费」共同承担新鲜度与一次性语义。
        previewToken: '',
        operationId: input.operationId,
        kind: WORKBENCH_OP_KINDS.backupRestore,
        intent: { backupId: input.backupId, expectedRevision: input.expectedRevision },
        consumeBackupId: input.backupId,
        extraPreconditionSql: [
          // 工作台 revision 必须仍是用户看到的那一个（防旧恢复覆盖跨设备变更）。
          'COALESCE((SELECT s.revision FROM workspace_workbench_state s WHERE s.workspace_id = ?), 0) = ?',
          // 撤销点必须仍未消费（与同事务的 consume 语句一起构成一次性语义）。
          'EXISTS (SELECT 1 FROM workbench_backups b WHERE b.id = ? AND b.workspace_id = ? AND b.consumed_at IS NULL)',
        ],
        extraPreconditionBinds: [input.workspaceId, input.expectedRevision, input.backupId, input.workspaceId],
        // 认领失败时区分两种真实原因：撤销点已被消费（一次性语义）vs 工作台 revision 已变化。
        preconditionFailure: workbenchFailure('backup_consumed', WORKBENCH_MESSAGES.backup_consumed),
        explainAsync: async () => {
          const latest = await deps.db
            .prepare('SELECT consumed_at FROM workbench_backups WHERE id = ? AND workspace_id = ?')
            .bind(input.backupId, input.workspaceId)
            .first<{ consumed_at: number | null }>();
          if (latest === null || latest.consumed_at !== null) {
            return workbenchFailure('backup_consumed', WORKBENCH_MESSAGES.backup_consumed);
          }
          return workbenchFailure('backup_revision_conflict', WORKBENCH_MESSAGES.backup_revision_conflict);
        },
        staleFailure: workbenchFailure('backup_revision_conflict', WORKBENCH_MESSAGES.backup_revision_conflict),
      });
    },
  };
}
