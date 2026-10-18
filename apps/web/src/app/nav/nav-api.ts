/**
 * 导航 API 客户端（阶段 04：HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009）。
 *
 * 定位与 `workbench-api.ts` / `modules-api.ts` 完全一致：**只做请求与形状声明**，
 * 不做业务判断。合法性一律以服务端为准（服务端在 apply 时会**重新校验**，
 * 绝不相信客户端传来的「已校验」结果，见 ADR-0004 D6）。
 *
 * 安全前提：
 * - 复用 `lib/api-client`，因此设备 Token 只走 `Authorization` 头，
 *   绝不进 URL（`toQuery` 只序列化筛选字段，从不拼 Token）、不进日志、不进浏览器存储。
 * - 所有路径参数先 `encodeURIComponent`，避免用户可控字符串改变路径结构。
 * - 请求体形状取自 `@ff14-hub/shared` 的 Zod Schema（`z.input`），与服务端严格同源。
 *
 * 为什么响应校验写在这里（而不是散在调用处）：
 * 数据端口的硬要求是「校验失败就抛错，不返回半可信数据」。把响应 Schema 集中在这一层，
 * 端口、`use-nav`、Widget 三条路径拿到的就是同一份判定，不会出现「某处忘了校验」。
 */
import {
  API_ROUTES,
  apiErrorBodySchema,
  navCatalogEntrySchema,
  navExportDocumentSchema,
  navImportItemSchema,
  navImportSkippedSchema,
  navLinkSchema,
  navLinkViewSchema,
  navFilterSchema,
  syncConflictSchema,
  REQUEST_ID_HEADER,
  type ApiErrorCode,
  type NavCatalogEntry,
  type NavExportDocument,
  type NavFilter,
  type NavGroup,
  type NavImportItem,
  type NavImportSkipped,
  type NavLink,
  type NavLinkView,
  type NavSnapshot,
  type SyncChangesResponse,
  type SyncConflict,
} from '@ff14-hub/shared';
// Schema 只出现在类型位置（`z.input<typeof ...>`），因此必须是 type-only import。
import type {
  createNavGroupRequestSchema,
  createNavLinkRequestSchema,
  deleteNavGroupRequestSchema,
  deleteNavLinkRequestSchema,
  navCatalogImportRequestSchema,
  navImportApplyRequestSchema,
  navImportPreviewRequestSchema,
  reorderNavGroupsRequestSchema,
  reorderNavLinksRequestSchema,
  setNavLinkGroupsRequestSchema,
  updateNavGroupRequestSchema,
  updateNavLinkRequestSchema,
} from '@ff14-hub/shared';
import { z } from 'zod';
import { buildApiUrl, NETWORK_FAILURE_STATUS, normalizeApiError } from '../../lib/api-client';

// ---------------------------------------------------------------------------
// 请求形状（直接取自共享契约，避免与服务端漂移）
// ---------------------------------------------------------------------------

export type CreateNavLinkRequest = z.input<typeof createNavLinkRequestSchema>;
export type UpdateNavLinkRequest = z.input<typeof updateNavLinkRequestSchema>;
export type DeleteNavLinkRequest = z.input<typeof deleteNavLinkRequestSchema>;
export type ReorderNavLinksRequest = z.input<typeof reorderNavLinksRequestSchema>;
export type SetNavLinkGroupsRequest = z.input<typeof setNavLinkGroupsRequestSchema>;
export type CreateNavGroupRequest = z.input<typeof createNavGroupRequestSchema>;
export type UpdateNavGroupRequest = z.input<typeof updateNavGroupRequestSchema>;
export type DeleteNavGroupRequest = z.input<typeof deleteNavGroupRequestSchema>;
export type ReorderNavGroupsRequest = z.input<typeof reorderNavGroupsRequestSchema>;
export type NavCatalogImportRequest = z.input<typeof navCatalogImportRequestSchema>;
export type NavImportPreviewRequest = z.input<typeof navImportPreviewRequestSchema>;
export type NavImportApplyRequest = z.input<typeof navImportApplyRequestSchema>;

// ---------------------------------------------------------------------------
// 响应形状（与 worker/api/v1/me-navigation.ts 的响应包一一对应）
//
// 这里刻意**不用** `.strict()`：服务端可以追加字段（例如 `replayed`）而不破坏客户端。
// 契约的核心实体（链接 / 分组 / 成员关系 / 快照）仍然用共享 Schema 严格校验，
// 因此「半可信数据」不会因为外层宽松而漏进来。
// ---------------------------------------------------------------------------

/** 单条链接的写响应。 */
export const navLinkResponseSchema = z.object({
  link: navLinkSchema,
  /** 同一次意图被服务端幂等重放时为 true（界面据此提示「已生效，未重复写入」）。 */
  replayed: z.boolean().optional(),
});

/** 删除链接 / 分组的响应：只回传被删 ID 与工作空间新修订（删除后没有实体可回传）。 */
export const navDeleteResponseSchema = z.object({
  deletedId: z.string().min(1).max(64),
  revision: z.number().int().nonnegative(),
  replayed: z.boolean().optional(),
});

/** 重排链接 / 分组、整体替换链接分组归属的响应。 */
export const navRevisionResponseSchema = z.object({
  revision: z.number().int().nonnegative(),
  replayed: z.boolean().optional(),
});

/** `GET /me/navigation/links`：服务端用**与前端同一份**纯函数算出的投影视图。 */
export const navLinkListViewSchema = z.object({
  links: z.array(navLinkViewSchema),
  revision: z.number().int().nonnegative(),
});

/** 公开推荐目录（只读）。`catalogSourceVersion` 是客户端判断「目录有没有升级」的依据。 */
export const navCatalogResponseSchema = z.object({
  entries: z.array(navCatalogEntrySchema),
  sourceVersion: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * 导入预览响应。
 *
 * `items` / `skipped` 是**服务端重新校验后**的结果（不是客户端解析结果的回显）：
 * 客户端只拿它来展示「这次会写什么、跳过了什么」，不据此推断合法性。
 */
export const navImportPreviewResponseSchema = z.object({
  items: z.array(navImportItemSchema),
  skipped: z.array(navImportSkippedSchema),
  /** 预览时的工作空间修订：apply 必须回显它，服务端据此拒绝按旧预览覆盖。 */
  revision: z.number().int().nonnegative(),
});

/** 导入落地（通用导入与目录导入共用）。 */
export const navImportApplyResponseSchema = z.object({
  importedCount: z.number().int().nonnegative(),
  importedLinkIds: z.array(z.string().min(1).max(64)),
  skipped: z.array(navImportSkippedSchema),
  revision: z.number().int().nonnegative(),
  replayed: z.boolean().optional(),
  /**
   * `restore` 模式落地的分组 / 成员关系数量（服务端权威值，可选）。
   *
   * 字段名与服务端返回一致（`importedGroups` / `importedMemberships`）。为什么可选：
   * `links` 模式没有分组与关系可恢复，服务端不会给出这两个字段；恢复流程的摘要必须
   * **优先**用服务端数字，只有在服务端尚未回传时才退化为「按提交的文档计数」并把口径
   * 写在文案里——绝不用一个本地推断冒充服务端事实。
   */
  importedGroups: z.number().int().nonnegative().optional(),
  importedMemberships: z.number().int().nonnegative().optional(),
});

/** 目录导入的响应：逐条给出「这条做了什么」，界面据此解释墓碑恢复与覆盖。 */
export const navCatalogImportResponseSchema = z.object({
  importedCount: z.number().int().nonnegative(),
  importedLinkIds: z.array(z.string().min(1).max(64)),
  /** 被显式恢复的墓碑行 ID（「这会恢复你删除过的条目」的可见证据）。 */
  restoredLinkIds: z.array(z.string().min(1).max(64)),
  /** 因为「用户改过且未允许覆盖」而被跳过的目录条目 ID。 */
  skippedCatalogIds: z.array(z.string().min(1).max(64)),
  revision: z.number().int().nonnegative(),
  replayed: z.boolean().optional(),
});

/** 导出响应：文档本身可被 `parseNavExportDocument` 读回（roundtrip）。 */
export const navExportResponseSchema = z.object({
  document: navExportDocumentSchema,
  exportedAt: z.number().int().nonnegative(),
});

export type NavLinkResponse = z.infer<typeof navLinkResponseSchema>;
export type NavDeleteResponse = z.infer<typeof navDeleteResponseSchema>;
export type NavRevisionResponse = z.infer<typeof navRevisionResponseSchema>;
export type NavLinkListView = z.infer<typeof navLinkListViewSchema>;
export type NavCatalogResponse = z.infer<typeof navCatalogResponseSchema>;
export type NavImportPreviewResponse = z.infer<typeof navImportPreviewResponseSchema>;
export type NavImportApplyResponse = z.infer<typeof navImportApplyResponseSchema>;
export type NavCatalogImportResponse = z.infer<typeof navCatalogImportResponseSchema>;
export type NavExportResponse = z.infer<typeof navExportResponseSchema>;

// ---------------------------------------------------------------------------
// 冲突解析
// ---------------------------------------------------------------------------

/** 服务端 `409` 的 `details.conflict`（ADR-0004 D7 / D11）。 */
export const navConflictDetailsSchema = z.object({ conflict: syncConflictSchema });

/**
 * 从 `409` 的 `details` 里解析结构化冲突。
 *
 * 为什么只认结构、不认文案：客户端需要知道「服务器上是 revision N」并让用户显式选择，
 * 而 `message` 是给人读的、随时可能改。解析不出来就返回 null（界面退化为只显示文案），
 * **绝不**猜一个 revision 出来——猜错会让用户以为可以安心覆盖。
 */
export function parseNavConflict(details: unknown): SyncConflict | null {
  const parsed = navConflictDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.conflict : null;
}

// ---------------------------------------------------------------------------
// 查询串（唯一实现）
// ---------------------------------------------------------------------------

/**
 * 把筛选条件序列化成查询串。
 *
 * 只序列化**契约里声明过的**字段：不接受任意键对象，因此没有任何路径能把 Token
 * 或用户自定义字符串塞进 URL。布尔用 `true`/`false`（服务端按字面量判定，
 * 不接受 `1`/`0` 这类模糊写法）。
 */
export function toNavLinksQuery(filter: NavFilter): string {
  const parsed = navFilterSchema.parse(filter);
  const params = new URLSearchParams();
  if (parsed.text !== undefined && parsed.text.length > 0) {
    params.set('text', parsed.text);
  }
  if (parsed.groupId !== undefined) {
    params.set('groupId', parsed.groupId);
  }
  if (parsed.region !== undefined) {
    params.set('region', parsed.region);
  }
  if (parsed.status !== undefined) {
    params.set('status', parsed.status);
  }
  if (parsed.tag !== undefined) {
    params.set('tag', parsed.tag);
  }
  if (parsed.favoritesOnly !== undefined) {
    params.set('favoritesOnly', parsed.favoritesOnly ? 'true' : 'false');
  }
  if (parsed.sort !== undefined) {
    params.set('sort', parsed.sort);
  }
  const query = params.toString();
  return query.length === 0 ? '' : `?${query}`;
}

/**
 * 生成一次**用户意图**的幂等操作 ID。
 *
 * 与工作台同一原则（`workbench-api.newOperationId`）：同一意图重试必须复用同一个 ID，
 * 端口为「一次调用 = 一次意图」生成它。ID 不参与保密，但仍然是可被第三方碰撞的键
 * （碰撞会抑制或冒用真实写入），因此不退回 `Math.random`；两者都不可用时**显式抛错**。
 */
export function newOperationId(): string {
  const source: Crypto | undefined = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }
  if (source !== undefined && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return `op-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new Error('当前环境没有可用的安全随机源（crypto.randomUUID / crypto.getRandomValues 都不可用）');
}

// ---------------------------------------------------------------------------
// 传输层（阶段 04）
//
// 为什么不直接用 `lib/api-client` 的 `ApiResult`：导航需要把 `409` 的 `details.conflict`
// **解析成结构化对象**（谁在哪个字段上冲突、服务器当前 revision、可选处理方式）供界面直接使用；
// `ApiResult` 只提供原始 `error`，每个调用点都要再解析一遍就会漂移。
// 因此这里复用它的**零件**（`buildApiUrl` / `normalizeApiError` / `NETWORK_FAILURE_STATUS`）
// 自己走一次 fetch，并额外用共享 `apiErrorBodySchema` 取出结构化细节。
// （补充说明：`lib/api-client` 自阶段 04 起也会保留 `details`；本层保留是因为它多做一步解析。）
// 路径必须是以 `/` 开头的相对路径，且 Token 只进 `Authorization` 头——绝不进 URL。
// ---------------------------------------------------------------------------

export interface NavApiErrorInfo {
  readonly code: ApiErrorCode | 'network_error';
  readonly message: string;
  readonly requestId: string;
  /** 服务端 `details`（契约保证可安全回显）；无则为 null。 */
  readonly details: unknown;
  /** 解析成功时的结构化冲突（`details.conflict`），否则 null——绝不猜。 */
  readonly conflict: SyncConflict | null;
}

export type NavResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: NavApiErrorInfo };

/** 「拿路径就发请求」的最小能力；测试可注入替身。 */
export type NavRequester = <T>(path: string, init?: RequestInit) => Promise<NavResult<T>>;

export interface NavTransportOptions {
  /** 读取设备凭证（每次请求时读取）。 */
  readonly getToken: () => string | null;
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /** 401 时的统一处理（应用层据此切回未登录态）。 */
  readonly onUnauthorized?: (() => void) | undefined;
}

function errorInfoOf(payload: unknown): NavApiErrorInfo {
  // 先用**共享契约**解析（它有完整的错误码表与可选 details）；
  // 不满足契约的响应体（例如中间层返回的 HTML 错误页）退回 api-client 的固定文案，
  // 绝不把原始文本当作消息回显。
  const parsed = apiErrorBodySchema.safeParse(payload);
  if (parsed.success) {
    const details: unknown = parsed.data.details ?? null;
    return {
      code: parsed.data.code,
      message: parsed.data.message,
      requestId: parsed.data.requestId,
      details,
      conflict: parseNavConflict(details),
    };
  }
  const fallback = normalizeApiError(payload);
  return {
    code: fallback.code,
    message: fallback.message,
    requestId: fallback.requestId,
    details: null,
    conflict: null,
  };
}

export function createNavTransport(options: NavTransportOptions): NavRequester {
  const baseUrl = options.baseUrl ?? '';
  const doFetch = options.fetchImpl ?? fetch;

  return async function request<T>(path: string, init: RequestInit = {}): Promise<NavResult<T>> {
    const url = buildApiUrl(path, baseUrl);
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();
    const token = options.getToken();
    if (token !== null && token.length > 0) {
      // 只走请求头；绝不追加到 URL。
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await doFetch(url, { ...init, method, headers });
    } catch {
      return {
        ok: false,
        status: NETWORK_FAILURE_STATUS,
        error: {
          code: 'network_error',
          message: '网络请求失败，请检查网络后重试。',
          requestId: 'client-network',
          details: null,
          conflict: null,
        },
      };
    }

    if (!response.ok) {
      if (response.status === 401) {
        options.onUnauthorized?.();
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      const info = errorInfoOf(payload);
      const headerRequestId = response.headers.get(REQUEST_ID_HEADER);
      return {
        ok: false,
        status: response.status,
        error: headerRequestId === null ? info : { ...info, requestId: headerRequestId },
      };
    }

    try {
      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data };
    } catch {
      return {
        ok: false,
        status: response.status,
        error: {
          code: 'internal_error',
          message: '服务器返回了无法识别的响应体（不是合法 JSON）。',
          requestId: 'client-malformed',
          details: null,
          conflict: null,
        },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// API 客户端
// ---------------------------------------------------------------------------

export interface NavApi {
  /** `GET /me/navigation`：本工作空间快照（链接 + 分组 + 成员关系 + revision）。 */
  readSnapshot(): Promise<NavResult<NavSnapshot>>;
  /** `GET /me/navigation/links`：服务端筛选/排序视图（与前端共用同一份纯函数）。 */
  listLinks(filter: NavFilter): Promise<NavResult<NavLinkListView>>;
  createLink(request: CreateNavLinkRequest): Promise<NavResult<NavLinkResponse>>;
  updateLink(linkId: string, request: UpdateNavLinkRequest): Promise<NavResult<NavLinkResponse>>;
  deleteLink(linkId: string, request: DeleteNavLinkRequest): Promise<NavResult<NavDeleteResponse>>;
  reorderLinks(request: ReorderNavLinksRequest): Promise<NavResult<NavRevisionResponse>>;
  setLinkGroups(linkId: string, request: SetNavLinkGroupsRequest): Promise<NavResult<NavRevisionResponse>>;
  createGroup(request: CreateNavGroupRequest): Promise<NavResult<NavGroup>>;
  updateGroup(groupId: string, request: UpdateNavGroupRequest): Promise<NavResult<NavGroup>>;
  deleteGroup(groupId: string, request: DeleteNavGroupRequest): Promise<NavResult<NavDeleteResponse>>;
  reorderGroups(request: ReorderNavGroupsRequest): Promise<NavResult<NavRevisionResponse>>;
  /** `GET /navigation/catalog`：公开推荐目录（匿名可读，服务端另有能力门禁）。 */
  readCatalog(): Promise<NavResult<NavCatalogResponse>>;
  importCatalog(request: NavCatalogImportRequest): Promise<NavResult<NavCatalogImportResponse>>;
  previewImport(request: NavImportPreviewRequest): Promise<NavResult<NavImportPreviewResponse>>;
  applyImport(request: NavImportApplyRequest): Promise<NavResult<NavImportApplyResponse>>;
  exportDocument(): Promise<NavResult<NavExportResponse>>;
}

function withId(template: string, id: string): string {
  return template.replace(':id', encodeURIComponent(id));
}

/** 写请求：PATCH/POST/DELETE 的请求体一律是 JSON，且必须带 `operationId`。 */
function writeInit(body: unknown, method: string): RequestInit {
  return { method, body: JSON.stringify(body) };
}

export function createNavApi(request: NavRequester): NavApi {
  return {
    readSnapshot: () => request<NavSnapshot>(API_ROUTES.meNavigation),
    listLinks: (filter) =>
      request<NavLinkListView>(`${API_ROUTES.meNavigationLinks}${toNavLinksQuery(filter)}`),
    createLink: (body) => request<NavLinkResponse>(API_ROUTES.meNavigationLinks, writeInit(body, 'POST')),
    updateLink: (linkId, body) =>
      request<NavLinkResponse>(withId(API_ROUTES.meNavigationLinkById, linkId), writeInit(body, 'PATCH')),
    deleteLink: (linkId, body) =>
      request<NavDeleteResponse>(withId(API_ROUTES.meNavigationLinkById, linkId), writeInit(body, 'DELETE')),
    reorderLinks: (body) =>
      request<NavRevisionResponse>(API_ROUTES.meNavigationLinksReorder, writeInit(body, 'POST')),
    setLinkGroups: (linkId, body) =>
      request<NavRevisionResponse>(withId(API_ROUTES.meNavigationLinkGroups, linkId), writeInit(body, 'PUT')),
    createGroup: (body) => request<NavGroup>(API_ROUTES.meNavigationGroups, writeInit(body, 'POST')),
    updateGroup: (groupId, body) =>
      request<NavGroup>(withId(API_ROUTES.meNavigationGroupById, groupId), writeInit(body, 'PATCH')),
    deleteGroup: (groupId, body) =>
      request<NavDeleteResponse>(withId(API_ROUTES.meNavigationGroupById, groupId), writeInit(body, 'DELETE')),
    reorderGroups: (body) =>
      request<NavRevisionResponse>(API_ROUTES.meNavigationGroupsReorder, writeInit(body, 'POST')),
    readCatalog: () => request<NavCatalogResponse>(API_ROUTES.navCatalog),
    importCatalog: (body) =>
      request<NavCatalogImportResponse>(API_ROUTES.meNavigationCatalogImport, writeInit(body, 'POST')),
    previewImport: (body) =>
      request<NavImportPreviewResponse>(API_ROUTES.meNavigationImportPreview, writeInit(body, 'POST')),
    applyImport: (body) =>
      request<NavImportApplyResponse>(API_ROUTES.meNavigationImportApply, writeInit(body, 'POST')),
    exportDocument: () => request<NavExportResponse>(API_ROUTES.meNavigationExport),
  };
}

// ---------------------------------------------------------------------------
// 跨设备变更 / 水位（HUB-051 客户端侧）
//
// 为什么它放在导航的 API 客户端里：导航是第一个消费方（D7 的清单里 `nav_link` /
// `nav_group` / `nav_membership` 紧跟在布局之后），而工作台布局的消费方复用同一个
// `SyncChangesApi`。**它只做请求与形状声明**：游标编解码与分页推进全部走共享纯函数，
// 任何本地缓冲/去重都留给状态层。
// ---------------------------------------------------------------------------

export interface SyncChangesQuery {
  /**
   * 上一轮的 `nextCursor`；**首次同步传 `null`**（请求里因此不带 `since`）。
   *
   * 注意首次同步的语义（第三轮复核修正的 P1）：`null` **不是**「从最早开始给我历史」，
   * 而是「先告诉我水位，我读完权威快照再来取增量」。服务端此时返回
   * `resetRequired: true` + `changes: []` + `nextCursor = v2:<当前水位>` + `meta.watermark`；
   * 客户端必须先读一次权威快照（`readSnapshot`）并替换本地状态，**然后**才把游标设为该水位。
   * 原因是变更流的 `payload` 是**当前**实体内容、而日志条目是**历史事件**，
   * 把历史重放到一份已经是当前状态的本地副本上会误删已恢复的数据。
   * 因此 `SyncChangesApi` 的调用方（状态层）绝不能从 `null` 逐页应用历史。
   */
  readonly since: string | null;
  readonly limit?: number | undefined;
}

export interface SyncChangesApi {
  readChanges(query: SyncChangesQuery): Promise<NavResult<SyncChangesResponse>>;
}

/**
 * 构造变更查询串。
 *
 * `since` 是服务端给出的游标字符串（`v2:<单调变更序号>`），这里只做 `URLSearchParams` 编码：
 * 它在路径/查询里只是数据，**不含凭证**（凭证永远只在 `Authorization` 头里）。
 * 客户端**不**在这里解析或改写游标——编解码的唯一实现是共享 `decodeSyncCursor` /
 * `encodeSyncCursor`（状态层在存下游标前已往返校验过一次）。
 */
export function toSyncChangesQuery(query: SyncChangesQuery): string {
  const params = new URLSearchParams();
  if (query.since !== null && query.since.length > 0) {
    params.set('since', query.since);
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

export function createSyncChangesApi(request: NavRequester): SyncChangesApi {
  return {
    readChanges: (query) =>
      request<SyncChangesResponse>(`${API_ROUTES.meSyncChanges}${toSyncChangesQuery(query)}`),
  };
}

/**
 * 服务端拒绝游标的两种结构化原因（`422` 的 `details.reason`）。
 *
 * 为什么必须结构化识别而不是看 `message`：文案随时可改，而「游标不被接受」是一个
 * 必须**自动恢复**的事实——丢掉本地游标、下一轮重新初始化（读权威快照 + 新水位），
 * 并给用户一条可见提示。拿文案去猜会让这条恢复路径在文案改动的某一天静默失效。
 */
export const SYNC_CURSOR_FAILURE_REASONS = ['cursor_version_unsupported', 'cursor_malformed'] as const;
export type SyncCursorFailureReason = (typeof SYNC_CURSOR_FAILURE_REASONS)[number];

/**
 * 结构化原因的**等价别名**。
 *
 * 兼容并存的两种写法，都来自本项目的契约，不是模糊匹配：
 * - 共享 `decodeSyncCursor` 的失败名（`unsupported_version` / `malformed`）；
 * - 服务端错误日志里既有的 `sync_cursor_<reason>` 形式（若它被放进 `details`）。
 * 未知取值一律返回 `null`（宁可显示一条普通同步失败，也不猜一个恢复动作出来）。
 */
const SYNC_CURSOR_FAILURE_ALIASES: Readonly<Record<string, SyncCursorFailureReason>> = {
  cursor_version_unsupported: 'cursor_version_unsupported',
  cursor_malformed: 'cursor_malformed',
  unsupported_version: 'cursor_version_unsupported',
  malformed: 'cursor_malformed',
  sync_cursor_unsupported_version: 'cursor_version_unsupported',
  sync_cursor_malformed: 'cursor_malformed',
};

/**
 * 从 `422` 的 `details` 里取游标失败原因。
 *
 * 只认结构（`details.reason` 是已知取值之一），解析不出来就返回 `null`：
 * 界面据此退化为普通失败提示，**绝不**在原因未知时擅自丢弃本地游标。
 */
export function parseSyncCursorFailure(details: unknown): SyncCursorFailureReason | null {
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const reason = (details as Record<string, unknown>)['reason'];
  if (typeof reason !== 'string') {
    return null;
  }
  return SYNC_CURSOR_FAILURE_ALIASES[reason] ?? null;
}

/**
 * 游标被拒绝时的可见提示（说明「本地游标已丢弃、下一轮重新做一次完整同步」，不静默）。
 *
 * 「完整同步」在**新协议**下的含义是：先读一次权威快照并整份替换本地状态，
 * 再用服务端给出的水位取真实增量——**不是**「从最早的变更开始回放历史」
 * （变更流的 payload 是当前内容，回放历史会改错数据，见 `SyncChangesQuery.since`）。
 */
export const SYNC_CURSOR_RESET_MESSAGES: Readonly<Record<SyncCursorFailureReason, string>> = {
  cursor_version_unsupported:
    '服务端不接受本地同步游标（版本不匹配）：已丢弃游标，下一轮会重新读取权威快照并重建同步水位（完整同步），不会静默跳过任何改动。',
  cursor_malformed:
    '本地同步游标无法解析：已丢弃游标，下一轮会重新读取权威快照并重建同步水位（完整同步），不会静默跳过任何改动。',
};

export function describeSyncCursorReset(reason: SyncCursorFailureReason): string {
  return SYNC_CURSOR_RESET_MESSAGES[reason];
}

// ---------------------------------------------------------------------------
// 面向界面的错误文案（只使用服务端已脱敏的 code / message / requestId）
// ---------------------------------------------------------------------------

/**
 * 把失败结果拼成可读文案。
 *
 * 刻意**不**包含请求体或响应原文：服务端/中间层返回的 HTML 错误页一旦进文案，
 * 就会被渲染到界面上，成为注入源（与 `api-client` 的兜底同一理由）。
 */
export function describeNavError(error: NavApiErrorInfo): string {
  return `${error.message}（${error.code} · ${error.requestId}）`;
}

/** 供界面直接使用的类型别名（避免各处重复 `z.infer`）。 */
export type { NavCatalogEntry, NavExportDocument, NavFilter, NavGroup, NavImportItem, NavImportSkipped, NavLink, NavLinkView, NavSnapshot };
