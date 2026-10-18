/**
 * 工作台 API 客户端（阶段 03 / HUB-045 · HUB-046 · HUB-049 · HUB-054）。
 *
 * 定位与 `apps/web/src/app/modules/modules-api.ts` 完全一致：**只做请求与形状声明**，
 * 不做业务判断。合法性一律以服务端为准，前端只把服务端的 `code` / `message` 原样带上来，
 * 从而让界面能区分「409 冲突（需要比较/重新载入）」与「422 校验失败（输入本身不合法）」。
 *
 * 安全前提：
 * - 复用 `lib/api-client`，凭证只走 `Authorization` 头，绝不进 URL / 日志 / 浏览器存储。
 * - 所有路径参数都先 `encodeURIComponent`，避免用户可控字符串改变路径结构。
 * - 请求体形状取自 `@ff14-hub/shared` 的 Zod Schema（`z.input`），因此与服务端严格同源：
 *   服务端 `validateJsonBody` 用的是同一批 Schema，多余字段会被拒。
 */
import { API_ROUTES, type BreakpointLayout, type WidgetInstance, type WorkbenchImportCounts, type WorkbenchImportIssue, type WorkbenchImportMode, type WorkbenchImportPreview, type WorkbenchSnapshot, type WorkbenchTemplateId, type WorkspacePage, type WorkspaceProfile } from '@ff14-hub/shared';
// 这些 Schema 只出现在类型位置（`z.input<typeof ...>`），因此必须是 type-only import。
import type {
  addWidgetRequestSchema,
  applyTemplateRequestSchema,
  createPageRequestSchema,
  deletePageRequestSchema,
  deleteWidgetRequestSchema,
  duplicateWidgetRequestSchema,
  restoreBackupRequestSchema,
  saveLayoutRequestSchema,
  updatePageRequestSchema,
  updateWidgetRequestSchema,
} from '@ff14-hub/shared';
import type { z } from 'zod';
import type { ApiResult } from '../../lib/api-client';
import type { ApiRequester } from '../modules/modules-api';

// ---------------------------------------------------------------------------
// 请求形状（直接取自共享契约，避免与服务端漂移）
// ---------------------------------------------------------------------------

export type CreatePageRequest = z.input<typeof createPageRequestSchema>;
export type UpdatePageRequest = z.input<typeof updatePageRequestSchema>;
export type DeletePageRequest = z.input<typeof deletePageRequestSchema>;
/**
 * 从墓碑恢复页面（`POST /me/pages/:id/restore`）的请求体。
 *
 * 这个端点**不**接受 `expectedRevision`：被墓碑化的页面已经不在快照里，
 * 客户端拿不到「用户看到的页面 revision」，因此恢复动作只带幂等 `operationId`
 * （服务端的 `restorePage` 入口只接受 `workspaceId` / `pageId` / `operationId`）。
 * 它与下面的备份恢复是两个不同的契约，**不要**共用同一个 Schema。
 */
export interface RestorePageRequest {
  readonly operationId: string;
}
/**
 * 从可恢复备份恢复（`POST /me/workbench/backup/:id/restore`）的请求体。
 * `expectedRevision` 必填且**取用户点击「恢复」时的工作台 revision**：
 * 服务端在同一事务里比对，旧恢复请求不会静默覆盖刚发生的跨设备变更。
 */
export type RestoreBackupRequest = z.input<typeof restoreBackupRequestSchema>;
export type SaveLayoutRequest = z.input<typeof saveLayoutRequestSchema>;
export type AddInstanceRequest = z.input<typeof addWidgetRequestSchema>;
export type UpdateInstanceRequest = z.input<typeof updateWidgetRequestSchema>;
export type DeleteInstanceRequest = z.input<typeof deleteWidgetRequestSchema>;
export type DuplicateInstanceRequest = z.input<typeof duplicateWidgetRequestSchema>;
export type ApplyTemplateRequest = z.input<typeof applyTemplateRequestSchema>;

/**
 * 导入预览请求体。
 * `document` 刻意是 `unknown`：备份文档的**结构性问题**要由服务端逐条给出可解释结果
 * （`unsupported_version` / `dangerous_field` / `duplicate_page_id` …），
 * 前端提前用 Schema 拦掉只会得到一句笼统的「结构不符」。
 */
export interface ImportPreviewRequest {
  readonly mode: WorkbenchImportMode;
  readonly document: unknown;
}

/**
 * 导入应用请求体：必须回显 `previewRevision` 与 `previewToken`，并显式 `confirm: true`。
 *
 * `previewToken` **原样**回显预览响应里的值（见 `WorkbenchImportPreview.previewToken`）：
 * 服务端在提交前会重算并比对，因此绝不自行编造、也绝不自动重试——
 * 一旦预览过期（409）就必须让用户重新预览，否则「预览时被跳过的集合」与
 * 「实际写入的集合」可能在用户不知情时发生变化。
 */
export interface ImportApplyRequest extends ImportPreviewRequest {
  readonly previewRevision: number;
  /** 预览时服务端给出的计划摘要令牌（绑定 document / mode / revision / 模块门禁）。 */
  readonly previewToken: string;
  readonly confirm: true;
  readonly operationId: string;
}

// ---------------------------------------------------------------------------
// 响应形状（与 `worker/api/v1/me-workbench.ts` 的响应包一一对应）
// ---------------------------------------------------------------------------

export interface PageListResponse {
  readonly pages: readonly WorkspacePage[];
  readonly defaultPageId: string | null;
}

/** 模板/导入被跳过的实例原因（模块未启用等），服务端逐条给出。 */
export interface WorkbenchSkip {
  readonly widgetType: string;
  readonly detail: string;
}

export interface CreatePageResponse {
  readonly page: WorkspacePage;
  readonly skipped: readonly WorkbenchSkip[];
  readonly replayed: boolean;
}

export interface UpdatePageResponse {
  readonly page: WorkspacePage;
  readonly noop: boolean;
  readonly replayed: boolean;
}

export interface DeletePageResponse {
  readonly deletedPageId: string;
  readonly defaultPageId: string | null;
  readonly remainingPages: number;
  readonly notice: string | null;
  readonly replayed: boolean;
}

export interface RestorePageResponse {
  readonly page: WorkspacePage;
  readonly defaultPageId: string | null;
  readonly replayed: boolean;
}

export interface LayoutListResponse {
  readonly layouts: readonly BreakpointLayout[];
}

export interface SaveLayoutResponse {
  readonly layout: BreakpointLayout;
  readonly replayed: boolean;
}

export interface InstanceListResponse {
  readonly instances: readonly WidgetInstance[];
}

export interface InstanceResponse {
  readonly instance: WidgetInstance;
  readonly replayed: boolean;
}

export interface UpdateInstanceResponse {
  readonly instance: WidgetInstance;
  readonly noop: boolean;
  readonly replayed: boolean;
}

export interface DeleteInstanceResponse {
  readonly widgetId: string;
  readonly replayed: boolean;
}

/** 模板目录项：**含 `honestyNote` 诚实说明**，界面必须原样展示。 */
export interface TemplateSummary {
  readonly id: WorkbenchTemplateId;
  readonly displayName: string;
  readonly description: string;
  readonly honestyNote: string;
  readonly isDemoOnly: boolean;
  readonly isEmpty: boolean;
  readonly recommendedDefault: boolean;
  readonly pageNames: readonly string[];
  readonly widgetCount: number;
}

export interface TemplateListResponse {
  readonly templates: readonly TemplateSummary[];
}

export interface ApplyTemplateResponse {
  readonly mode: 'new_page' | 'replace_page' | 'reset_workspace';
  readonly templateId: WorkbenchTemplateId;
  readonly pages: readonly WorkspacePage[];
  readonly defaultPageId: string | null;
  readonly skipped: readonly WorkbenchSkip[];
  readonly replayed: boolean;
}

export interface BackupExportResponse {
  readonly backup: unknown;
  readonly byteLength: number;
  readonly maxBytes: number;
}

export interface BackupSummary {
  readonly id: string;
  readonly kind: 'pre_import' | 'manual';
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly consumedAt: number | null;
}

export interface BackupListResponse {
  readonly backups: readonly BackupSummary[];
}

export interface ImportPreviewResponse {
  readonly preview: WorkbenchImportPreview;
}

/** 导入/恢复的落地结果。 */
export interface ImportApplyResult {
  readonly mode: WorkbenchImportMode;
  readonly backupId: string | null;
  readonly pages: readonly WorkspacePage[];
  readonly defaultPageId: string | null;
  readonly counts: WorkbenchImportCounts;
  readonly skipped: readonly WorkbenchSkip[];
  readonly warnings: readonly WorkbenchImportIssue[];
}

export interface ImportApplyResponse {
  readonly result: ImportApplyResult;
  readonly replayed: boolean;
}

export interface RestoreBackupResponse {
  readonly result: ImportApplyResult;
  readonly notice: string;
  readonly replayed: boolean;
}

export interface WorkbenchApi {
  /**
   * 当前工作空间的非敏感配置（`GET /me/profile`）。
   * 只用于一个目的：导出备份时给文件起一个有意义的标识段（`id` = 工作空间 ID）。
   * 备份文档本身**不含**工作空间标识，因此这个值不参与任何鉴权或写入。
   */
  readProfile(): Promise<ApiResult<WorkspaceProfile>>;
  readSnapshot(): Promise<ApiResult<WorkbenchSnapshot>>;
  listPages(): Promise<ApiResult<PageListResponse>>;
  createPage(request: CreatePageRequest): Promise<ApiResult<CreatePageResponse>>;
  updatePage(pageId: string, request: UpdatePageRequest): Promise<ApiResult<UpdatePageResponse>>;
  deletePage(pageId: string, request: DeletePageRequest): Promise<ApiResult<DeletePageResponse>>;
  restorePage(pageId: string, request: RestorePageRequest): Promise<ApiResult<RestorePageResponse>>;
  readLayouts(pageId: string): Promise<ApiResult<LayoutListResponse>>;
  saveLayout(pageId: string, request: SaveLayoutRequest): Promise<ApiResult<SaveLayoutResponse>>;
  listInstances(pageId: string): Promise<ApiResult<InstanceListResponse>>;
  addInstance(pageId: string, request: AddInstanceRequest): Promise<ApiResult<InstanceResponse>>;
  updateInstance(instanceId: string, request: UpdateInstanceRequest): Promise<ApiResult<UpdateInstanceResponse>>;
  deleteInstance(instanceId: string, request: DeleteInstanceRequest): Promise<ApiResult<DeleteInstanceResponse>>;
  duplicateInstance(instanceId: string, request: DuplicateInstanceRequest): Promise<ApiResult<InstanceResponse>>;
  listTemplates(): Promise<ApiResult<TemplateListResponse>>;
  applyTemplate(request: ApplyTemplateRequest): Promise<ApiResult<ApplyTemplateResponse>>;
  exportBackup(): Promise<ApiResult<BackupExportResponse>>;
  listBackups(): Promise<ApiResult<BackupListResponse>>;
  restoreBackup(backupId: string, request: RestoreBackupRequest): Promise<ApiResult<RestoreBackupResponse>>;
  previewImport(request: ImportPreviewRequest): Promise<ApiResult<ImportPreviewResponse>>;
  applyImport(request: ImportApplyRequest): Promise<ApiResult<ImportApplyResponse>>;
}

function withId(template: string, id: string): string {
  return template.replace(':id', encodeURIComponent(id));
}

function writeInit(body: unknown, method: string): RequestInit {
  return { method, body: JSON.stringify(body) };
}

export function createWorkbenchApi(client: ApiRequester): WorkbenchApi {
  return {
    readProfile: () => client.request<WorkspaceProfile>(API_ROUTES.meProfile),
    readSnapshot: () => client.request<WorkbenchSnapshot>(API_ROUTES.meWorkbench),
    listPages: () => client.request<PageListResponse>(API_ROUTES.mePages),
    createPage: (request) => client.request<CreatePageResponse>(API_ROUTES.mePages, writeInit(request, 'POST')),
    updatePage: (pageId, request) =>
      client.request<UpdatePageResponse>(withId(API_ROUTES.mePageById, pageId), writeInit(request, 'PATCH')),
    deletePage: (pageId, request) =>
      client.request<DeletePageResponse>(withId(API_ROUTES.mePageById, pageId), writeInit(request, 'DELETE')),
    restorePage: (pageId, request) =>
      client.request<RestorePageResponse>(withId(API_ROUTES.mePageRestore, pageId), writeInit(request, 'POST')),
    readLayouts: (pageId) => client.request<LayoutListResponse>(withId(API_ROUTES.mePageLayout, pageId)),
    saveLayout: (pageId, request) =>
      client.request<SaveLayoutResponse>(withId(API_ROUTES.mePageLayout, pageId), writeInit(request, 'PUT')),
    listInstances: (pageId) => client.request<InstanceListResponse>(withId(API_ROUTES.mePageWidgets, pageId)),
    addInstance: (pageId, request) =>
      client.request<InstanceResponse>(withId(API_ROUTES.mePageWidgets, pageId), writeInit(request, 'POST')),
    updateInstance: (instanceId, request) =>
      client.request<UpdateInstanceResponse>(withId(API_ROUTES.meWidgetById, instanceId), writeInit(request, 'PATCH')),
    deleteInstance: (instanceId, request) =>
      client.request<DeleteInstanceResponse>(withId(API_ROUTES.meWidgetById, instanceId), writeInit(request, 'DELETE')),
    duplicateInstance: (instanceId, request) =>
      client.request<InstanceResponse>(withId(API_ROUTES.meWidgetDuplicate, instanceId), writeInit(request, 'POST')),
    listTemplates: () => client.request<TemplateListResponse>(API_ROUTES.meWorkbenchTemplates),
    applyTemplate: (request) =>
      client.request<ApplyTemplateResponse>(API_ROUTES.meWorkbenchApplyTemplate, writeInit(request, 'POST')),
    exportBackup: () => client.request<BackupExportResponse>(API_ROUTES.meWorkbenchBackup),
    listBackups: () => client.request<BackupListResponse>(`${API_ROUTES.meWorkbenchBackup}s`),
    restoreBackup: (backupId, request) =>
      client.request<RestoreBackupResponse>(
        `${withId(API_ROUTES.meWorkbenchBackupById, backupId)}/restore`,
        writeInit(request, 'POST'),
      ),
    previewImport: (request) =>
      client.request<ImportPreviewResponse>(API_ROUTES.meWorkbenchImportPreview, writeInit(request, 'POST')),
    applyImport: (request) =>
      client.request<ImportApplyResponse>(API_ROUTES.meWorkbenchImportApply, writeInit(request, 'POST')),
  };
}

/**
 * 生成一次**用户意图**的幂等操作 ID。
 * 规则（共享契约 `operationIdSchema`）：长度 ≥ 8、仅 `[A-Za-z0-9_-]`。
 * 同一意图重试必须复用同一个 ID（服务端据此丢弃重复副作用）；新意图必须换新的。
 *
 * 随机源（刻意**不**降级到弱随机）：
 * `operationId` 只用于幂等去重，**不用于保密**——它不参与鉴权、不进 URL、不进凭证，
 * 因此它不是一个「密钥」。但即使如此也不使用弱随机数生成器（`Math.random` 可预测、
 * 种子可枚举）：可预测的 ID 会让幂等去重被第三方猜到并碰撞，从而抑制或冒用真实的写入。
 * 优先 `crypto.randomUUID()`；其次 `crypto.getRandomValues()`（16 字节 → 32 位十六进制）；
 * 两者都不可用时**显式抛错**，让「这个运行环境没有安全随机源」成为可见事实。
 */
export function newOperationId(): string {
  const source: Crypto | undefined = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }
  if (source !== undefined && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    // 前缀 `op-` 只是为了人眼可读；总长 35 ≤ 64，且字符集满足 operationIdSchema。
    return `op-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new Error(
    '当前环境没有可用的安全随机源（crypto.randomUUID / crypto.getRandomValues 都不可用），' +
      '无法生成幂等 operationId；这里不会退回弱随机数生成器。',
  );
}
