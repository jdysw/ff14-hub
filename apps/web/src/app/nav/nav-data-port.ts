/**
 * 导航模块的数据端口操作表（阶段 04 / HUB-010）。
 *
 * 只有这里（以及它构造的 `nav-api` 客户端）看得见设备 Token；Widget 拿到的是
 * `ModuleDataPort`，只能按操作名调用，不能选择 URL、workspace 或 header（见
 * `widgets/module-data-ports.ts` 的边界说明）。
 *
 * 三条硬要求（都在本文件里落实）：
 * 1. **输入用共享 Schema 校验**：操作实现收到的是 `unknown`，绝不信任组件传来的形状。
 *    共享写请求 Schema 里的 `operationId` 是必填字段，而该 ID 必须由端口生成，
 *    因此这里把输入折叠成一个**全新的对象字面量**（只含共享契约声明过的键 + 内部占位
 *    `operationId`）后再交给共享 Schema 校验，最后把占位 ID 换成真 ID
 *    —— 组件既无法指定 `operationId`，也无法借输入夹带作用域字段（多带即被拒绝）。
 * 2. **响应用共享 Schema 校验后再返回**：校验失败**抛错**，绝不返回半可信数据——
 *    返回半可信数据会让界面显示错误的事实，比报错更糟。
 * 3. **`operationId` 由端口生成并在同一次意图内复用**：一次 `call()` = 一次用户意图；
 *    重试（组件重新调用）得到新 ID，而服务端按 ID 幂等去重。
 *
 * Token 纪律：`Authorization` 头只在端口层由 `createApiClient` 拼接；
 * Token 绝不进 URL、绝不进日志、绝不进错误消息（错误文案只用服务端已脱敏的 code/message/requestId）。
 */
import {
  createNavGroupRequestSchema,
  createNavLinkRequestSchema,
  deleteNavGroupRequestSchema,
  deleteNavLinkRequestSchema,
  navCatalogImportRequestSchema,
  navFilterSchema,
  navGroupSchema,
  navImportApplyRequestSchema,
  navImportPreviewRequestSchema,
  navSnapshotSchema,
  reorderNavGroupsRequestSchema,
  reorderNavLinksRequestSchema,
  setNavLinkGroupsRequestSchema,
  updateNavGroupRequestSchema,
  updateNavLinkRequestSchema,
  NAV_MODULE_ID,
  type ModuleCapability,
  type NavGroup,
  type NavSnapshot,
  type SyncConflict,
} from '@ff14-hub/shared';
import { z } from 'zod';
import type { ModulePortContext, ModulePortFactory } from '../widgets/module-data-ports';
import {
  createNavApi,
  createNavTransport,
  navCatalogImportResponseSchema,
  navCatalogResponseSchema,
  navDeleteResponseSchema,
  navExportResponseSchema,
  navImportApplyResponseSchema,
  navImportPreviewResponseSchema,
  navLinkListViewSchema,
  navLinkResponseSchema,
  navRevisionResponseSchema,
  newOperationId,
  type NavApi,
  type NavCatalogImportRequest,
  type NavCatalogImportResponse,
  type NavExportResponse,
  type NavImportApplyRequest,
  type NavImportApplyResponse,
  type NavImportPreviewRequest,
  type NavImportPreviewResponse,
  type NavApiErrorInfo,
  type NavLinkResponse,
  type NavResult,
} from './nav-api';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 导航模块声明过的全部操作名。未列出的操作名一律被端口层拒绝（不发任何请求）。 */
export const NAV_PORT_OPERATIONS = [
  'nav.snapshot',
  'nav.links',
  'nav.createLink',
  'nav.updateLink',
  'nav.deleteLink',
  'nav.reorderLinks',
  'nav.setLinkGroups',
  'nav.createGroup',
  'nav.updateGroup',
  'nav.deleteGroup',
  'nav.reorderGroups',
  'nav.catalog',
  'nav.importCatalog',
  'nav.importPreview',
  'nav.importApply',
  'nav.export',
] as const;

export type NavPortOperation = (typeof NAV_PORT_OPERATIONS)[number];

/**
 * 读公开目录所需的能力。
 *
 * 为什么在这里显式检查：Host 已经在渲染前比对过能力声明，但组件可能在渲染之后才发起调用。
 * 端口在调用前再查一次「服务端授予的能力」，于是缺少 `navigation:read-catalog` 时
 * 不会真的去读目录 —— 门禁不是一次性的渲染期判定。
 */
export const NAV_CATALOG_CAPABILITY: ModuleCapability = 'navigation:read-catalog';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 端口调用失败。
 *
 * `conflict` 只承载 `409` 的 `details.conflict`（结构化冲突），供界面提示
 * 「服务器上是 revision N」。message 永远只由服务端已脱敏的 code/message/requestId 拼成，
 * 因此不会把 Token 或响应原文带出去。
 */
export class NavPortError extends Error {
  readonly code: string;
  readonly status: number;
  readonly conflict: SyncConflict | null;

  constructor(code: string, status: number, message: string, conflict: SyncConflict | null) {
    super(message);
    this.name = 'NavPortError';
    this.code = code;
    this.status = status;
    this.conflict = conflict;
  }
}

function errorOf(result: { readonly status: number; readonly error: NavApiErrorInfo }): NavPortError {
  const conflict = result.error.conflict;
  const suffix = conflict === null ? '' : '；该数据已被其他设备修改';
  return new NavPortError(
    result.error.code,
    result.status,
    `${result.error.message}（${result.error.code} · ${result.error.requestId}）${suffix}`,
    conflict,
  );
}

/**
 * 取出一次调用的结果：失败即抛错。
 *
 * 为什么把 `unauthorized` 单独拎出来：凭证失效不是「这次操作失败」，而是**整个会话失效**。
 * 应用层注入的 `onUnauthorized` 会把界面切回未登录态，而不是让人反复看到同一个错误。
 */
function unwrap<T>(result: NavResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw errorOf(result);
}

// ---------------------------------------------------------------------------
// 输入校验与 operationId
//
// 共享写请求 Schema 的 `operationId` 是必填字段（服务端用它做幂等去重），但**生成它
// 是端口层的职责**：组件只能声明「我要做这件事」，不能自己编一个键。为此：
//   1. `bodyOf` 复制输入并删掉**端口自己管的键**（`operationId`）与**路径参数**
//      （`linkId` / `groupId`），其余字段原样保留；
//   2. `parseWriteBody` 用**共享 Schema** 校验这份输入 —— 未声明的字段会被 `.strict()`
//      拒绝（例如组件偷传 `workspaceId`），端口因此不可能被借来改变作用域；
//   3. 通过校验后把占位 ID 换成 `crypto.randomUUID()` 生成的真 ID。
// ---------------------------------------------------------------------------

/** 只在本文件内使用的占位 operationId（长度 ≥ 8，满足 `operationIdSchema`）。 */
const PLACEHOLDER_OPERATION_ID = '__nav-port-placeholder__';

/** 行 ID：与共享契约同规则（1..64 字符的非空字符串）。 */
function pathIdOf(input: unknown, key: 'linkId' | 'groupId', operation: string): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new NavPortError('validation_failed', 0, `操作 ${operation} 的输入不满足契约，未发出任何请求。`, null);
  }
  const id = (input as Record<string, unknown>)[key];
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    throw new NavPortError('validation_failed', 0, `操作 ${operation} 缺少合法的 ${key}，未发出任何请求。`, null);
  }
  return id;
}

/** 复制输入，删掉端口自己管的键与路径参数（其余字段交给共享 Schema 判定）。 */
function bodyOf(input: unknown, drop: readonly string[], operation: string): Record<string, unknown> {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new NavPortError('validation_failed', 0, `操作 ${operation} 的输入不满足契约，未发出任何请求。`, null);
  }
  const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of ['operationId', ...drop]) {
    delete copy[key];
  }
  return copy;
}

/**
 * 用共享 Schema 校验写正文，并返回可直接发送的请求体（含端口的真 `operationId`）。
 *
 * 两个 `schema` 参数指向**同一个共享 Schema 的两个视图**：
 * 校验用的是共享契约本身（规则同源），返回类型用的是 `z.input`（与 `nav-api` 的请求类型对齐）。
 */
function parseWriteBody<TOut, TIn>(
  schema: z.ZodType<TOut>,
  body: Record<string, unknown>,
  operation: string,
): TIn {
  const parsed = schema.safeParse({ ...body, operationId: PLACEHOLDER_OPERATION_ID });
  if (!parsed.success) {
    throw new NavPortError('validation_failed', 0, `操作 ${operation} 的输入不满足契约，未发出任何请求。`, null);
  }
  const record = parsed.data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'operationId') {
      continue;
    }
    out[key] = value;
  }
  out['operationId'] = newOperationId();
  return out as TIn;
}

/** 无参数操作（快照 / 目录 / 导出）的输入：只接受空对象（或省略）。 */
const noInputSchema = z.object({}).strict();

function parseNoInput(input: unknown, operation: string): void {
  if (input === undefined || input === null) {
    return;
  }
  const parsed = noInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new NavPortError('validation_failed', 0, `操作 ${operation} 不接受输入参数，未发出任何请求。`, null);
  }
}

/** 响应不满足契约 → 抛错（绝不返回半可信数据）。 */
function parseResponse<T>(schema: z.ZodType<T>, data: unknown, operation: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new NavPortError('internal_error', 0, `操作 ${operation} 的响应不符合契约，已拒绝使用该结果。`, null);
  }
  return parsed.data;
}

/** 能力门禁：组件可能在渲染之后才调用，因此每次调用前复查服务端授予的能力。 */
function requireCapability(context: ModulePortContext, capability: ModuleCapability): void {
  const access = context.moduleAccess(NAV_MODULE_ID);
  if (!access.grantedCapabilities.includes(capability)) {
    throw new NavPortError(
      'forbidden',
      403,
      `模块 ${NAV_MODULE_ID} 缺少服务端授予的能力「${capability}」，该调用已被拒绝。`,
      null,
    );
  }
}

// ---------------------------------------------------------------------------
// 端口工厂
// ---------------------------------------------------------------------------

/**
 * 构造导航模块的操作表。
 *
 * 注意：API 客户端在这里用 `context.token` 装配。`ModulePortContext` 的 token 由应用层
 * 在**构造端口时**从会话内存凭证读取；返回的端口对象里没有 token 字段，
 * 错误消息也只含服务端已脱敏的字段，因此组件无法通过端口看到凭证。
 */
export const navModulePortFactory: ModulePortFactory = (context: ModulePortContext) => {
  const api: NavApi = createNavApi(
    createNavTransport({
      getToken: () => context.token,
      baseUrl: context.apiBaseUrl,
      ...(context.onUnauthorized === undefined ? {} : { onUnauthorized: context.onUnauthorized }),
    }),
  );

  return {
    // 读取 -------------------------------------------------------------------

    'nav.snapshot': async (input): Promise<NavSnapshot> => {
      parseNoInput(input, 'nav.snapshot');
      return parseResponse(navSnapshotSchema, unwrap(await api.readSnapshot()), 'nav.snapshot');
    },

    'nav.links': async (input) => {
      const filter = navFilterSchema.safeParse(input ?? {});
      if (!filter.success) {
        throw new NavPortError('validation_failed', 0, '操作 nav.links 的输入不满足契约，未发出任何请求。', null);
      }
      return parseResponse(navLinkListViewSchema, unwrap(await api.listLinks(filter.data)), 'nav.links');
    },

    'nav.catalog': async (input) => {
      parseNoInput(input, 'nav.catalog');
      requireCapability(context, NAV_CATALOG_CAPABILITY);
      return parseResponse(navCatalogResponseSchema, unwrap(await api.readCatalog()), 'nav.catalog');
    },

    // 个人链接 ---------------------------------------------------------------

    'nav.createLink': async (input): Promise<NavLinkResponse> => {
      const body = bodyOf(input, [], 'nav.createLink');
      const request = parseWriteBody<z.input<typeof createNavLinkRequestSchema>, z.input<typeof createNavLinkRequestSchema>>(
        createNavLinkRequestSchema,
        body,
        'nav.createLink',
      );
      return parseResponse(
        navLinkResponseSchema,
        unwrap(await api.createLink(request)),
        'nav.createLink',
      );
    },

    'nav.updateLink': async (input): Promise<NavLinkResponse> => {
      const id = pathIdOf(input, 'linkId', 'nav.updateLink');
      const body = bodyOf(input, ['linkId'], 'nav.updateLink');
      const request = parseWriteBody<z.input<typeof updateNavLinkRequestSchema>, z.input<typeof updateNavLinkRequestSchema>>(
        updateNavLinkRequestSchema,
        body,
        'nav.updateLink',
      );
      return parseResponse(navLinkResponseSchema, unwrap(await api.updateLink(id, request)), 'nav.updateLink');
    },

    'nav.deleteLink': async (input) => {
      const id = pathIdOf(input, 'linkId', 'nav.deleteLink');
      const body = bodyOf(input, ['linkId'], 'nav.deleteLink');
      const request = parseWriteBody<z.input<typeof deleteNavLinkRequestSchema>, z.input<typeof deleteNavLinkRequestSchema>>(
        deleteNavLinkRequestSchema,
        body,
        'nav.deleteLink',
      );
      return parseResponse(navDeleteResponseSchema, unwrap(await api.deleteLink(id, request)), 'nav.deleteLink');
    },

    'nav.reorderLinks': async (input) => {
      const body = bodyOf(input, [], 'nav.reorderLinks');
      const request = parseWriteBody<z.input<typeof reorderNavLinksRequestSchema>, z.input<typeof reorderNavLinksRequestSchema>>(
        reorderNavLinksRequestSchema,
        body,
        'nav.reorderLinks',
      );
      return parseResponse(
        navRevisionResponseSchema,
        unwrap(await api.reorderLinks(request)),
        'nav.reorderLinks',
      );
    },

    'nav.setLinkGroups': async (input) => {
      const id = pathIdOf(input, 'linkId', 'nav.setLinkGroups');
      const body = bodyOf(input, ['linkId'], 'nav.setLinkGroups');
      const request = parseWriteBody<z.input<typeof setNavLinkGroupsRequestSchema>, z.input<typeof setNavLinkGroupsRequestSchema>>(
        setNavLinkGroupsRequestSchema,
        body,
        'nav.setLinkGroups',
      );
      return parseResponse(
        navRevisionResponseSchema,
        unwrap(await api.setLinkGroups(id, request)),
        'nav.setLinkGroups',
      );
    },

    // 分组 -------------------------------------------------------------------

    'nav.createGroup': async (input): Promise<NavGroup> => {
      const body = bodyOf(input, [], 'nav.createGroup');
      const request = parseWriteBody<z.input<typeof createNavGroupRequestSchema>, z.input<typeof createNavGroupRequestSchema>>(
        createNavGroupRequestSchema,
        body,
        'nav.createGroup',
      );
      return parseResponse(navGroupSchema, unwrap(await api.createGroup(request)), 'nav.createGroup');
    },

    'nav.updateGroup': async (input): Promise<NavGroup> => {
      const id = pathIdOf(input, 'groupId', 'nav.updateGroup');
      const body = bodyOf(input, ['groupId'], 'nav.updateGroup');
      const request = parseWriteBody<z.input<typeof updateNavGroupRequestSchema>, z.input<typeof updateNavGroupRequestSchema>>(
        updateNavGroupRequestSchema,
        body,
        'nav.updateGroup',
      );
      return parseResponse(navGroupSchema, unwrap(await api.updateGroup(id, request)), 'nav.updateGroup');
    },

    'nav.deleteGroup': async (input) => {
      const id = pathIdOf(input, 'groupId', 'nav.deleteGroup');
      const body = bodyOf(input, ['groupId'], 'nav.deleteGroup');
      const request = parseWriteBody<z.input<typeof deleteNavGroupRequestSchema>, z.input<typeof deleteNavGroupRequestSchema>>(
        deleteNavGroupRequestSchema,
        body,
        'nav.deleteGroup',
      );
      return parseResponse(
        navDeleteResponseSchema,
        unwrap(await api.deleteGroup(id, request)),
        'nav.deleteGroup',
      );
    },

    'nav.reorderGroups': async (input) => {
      const body = bodyOf(input, [], 'nav.reorderGroups');
      const request = parseWriteBody<z.input<typeof reorderNavGroupsRequestSchema>, z.input<typeof reorderNavGroupsRequestSchema>>(
        reorderNavGroupsRequestSchema,
        body,
        'nav.reorderGroups',
      );
      return parseResponse(
        navRevisionResponseSchema,
        unwrap(await api.reorderGroups(request)),
        'nav.reorderGroups',
      );
    },

    // 目录导入 / 通用导入导出 -------------------------------------------------

    'nav.importCatalog': async (input): Promise<NavCatalogImportResponse> => {
      const body = bodyOf(input, [], 'nav.importCatalog');
      // 目录是受能力保护的数据源：读不了目录就不该写目录派生的行。
      requireCapability(context, NAV_CATALOG_CAPABILITY);
      const request = parseWriteBody<z.input<typeof navCatalogImportRequestSchema>, NavCatalogImportRequest>(
        navCatalogImportRequestSchema,
        body,
        'nav.importCatalog',
      );
      return parseResponse(
        navCatalogImportResponseSchema,
        unwrap(await api.importCatalog(request)),
        'nav.importCatalog',
      );
    },

    'nav.importPreview': async (input): Promise<NavImportPreviewResponse> => {
      const parsed = navImportPreviewRequestSchema.safeParse(input ?? {});
      if (!parsed.success) {
        throw new NavPortError('validation_failed', 0, '操作 nav.importPreview 的输入不满足契约，未发出任何请求。', null);
      }
      const request: NavImportPreviewRequest = parsed.data;
      return parseResponse(
        navImportPreviewResponseSchema,
        unwrap(await api.previewImport(request)),
        'nav.importPreview',
      );
    },

    'nav.importApply': async (input): Promise<NavImportApplyResponse> => {
      const body = bodyOf(input, [], 'nav.importApply');
      const request = parseWriteBody<z.input<typeof navImportApplyRequestSchema>, NavImportApplyRequest>(
        navImportApplyRequestSchema,
        body,
        'nav.importApply',
      );
      return parseResponse(
        navImportApplyResponseSchema,
        unwrap(await api.applyImport(request)),
        'nav.importApply',
      );
    },

    'nav.export': async (input): Promise<NavExportResponse> => {
      parseNoInput(input, 'nav.export');
      return parseResponse(navExportResponseSchema, unwrap(await api.exportDocument()), 'nav.export');
    },
  };
};
