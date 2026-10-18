/**
 * 导航前端测试的共用夹具（阶段 04）。
 *
 * 为什么单独一个文件：`nav-view.spec.tsx` / `nav-widgets.spec.tsx` / `nav-sync.spec.tsx`
 * 都需要同一份「共享契约的数据形状」与假端口/假 API 构造器；复制多份会被判为重复代码，
 * 而且容易漂移（改了一处忘了另一处）。
 *
 * 这些夹具只做**形状构造**，不含任何断言与业务判断。
 */
import {
  navSnapshotSchema,
  NAV_MODULE_ID,
  type ApiErrorCode,
  type NavCatalogEntry,
  type NavExportDocument,
  type NavGroup,
  type NavLink,
  type NavLinkView,
  type NavMembership,
  type NavSnapshot,
  type SyncChange,
  type SyncChangesResponse,
  type SyncConflict,
  type SyncEntityType,
} from '@ff14-hub/shared';
import { vi } from 'vitest';
import type {
  NavApi,
  NavCatalogResponse,
  NavImportApplyResponse,
  NavImportPreviewResponse,
  NavLinkListView,
  NavLinkResponse,
  NavRevisionResponse,
  NavDeleteResponse,
  NavExportResponse,
  NavResult,
} from '../src/app/nav/nav-api';

/** 契约里的链接行（默认值全部合法，调用方只覆盖关心的字段）。 */
export function link(id: string, overrides: Partial<NavLink> = {}): NavLink {
  return {
    id,
    sourceCatalogId: null,
    importedSourceVersion: null,
    title: `链接 ${id}`,
    url: `https://example.com/${id}`,
    description: '',
    tags: [],
    aliases: [],
    icon: '🔗',
    openMode: 'new_tab',
    region: 'cn',
    status: 'active',
    isFavorite: false,
    sortOrder: 0,
    health: 'unknown',
    healthCheckedAt: null,
    revision: 1,
    deletedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function linkView(linkRow: NavLink, groupIds: readonly string[] = [], groupNames: readonly string[] = []): NavLinkView {
  return { ...linkRow, groupIds: [...groupIds], groupNames: [...groupNames] };
}

export function group(id: string, overrides: Partial<NavGroup> = {}): NavGroup {
  return {
    id,
    name: `分组 ${id}`,
    sortOrder: 0,
    revision: 1,
    deletedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function membership(linkId: string, groupId: string, overrides: Partial<NavMembership> = {}): NavMembership {
  return {
    linkId,
    groupId,
    sortOrder: 0,
    deletedAt: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** 快照：**必须**通过共享 Schema（否则状态层会（正确地）拒绝它，测试会以奇怪的方式失败）。 */
export function snapshot(overrides: Partial<NavSnapshot> = {}): NavSnapshot {
  const candidate: NavSnapshot = {
    links: [],
    groups: [],
    memberships: [],
    revision: 1,
    catalogSourceVersion: 1,
    limits: { maxLinks: 500, maxGroups: 100, maxGroupsPerLink: 20 },
    ...overrides,
  };
  const parsed = navSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`导航快照夹具不满足共享契约：${parsed.error.issues[0]?.message ?? '未知问题'}`);
  }
  return parsed.data;
}

export function catalogEntry(id: string, overrides: Partial<NavCatalogEntry> = {}): NavCatalogEntry {
  return {
    id,
    sourceVersion: 1,
    title: `目录条目 ${id}`,
    url: `https://catalog.example.com/${id}`,
    description: '推荐目录条目',
    category: '资料站',
    tags: [],
    aliases: [],
    icon: '📚',
    openMode: 'new_tab',
    region: 'both',
    sortOrder: 0,
    sourceUrl: 'https://catalog.example.com/source',
    sourceName: '目录来源',
    verifiedAt: 1_700_000_000_000,
    verificationStatus: 'verified',
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 假变更 API（HUB-051）
// ---------------------------------------------------------------------------

/**
 * 一条变更。
 *
 * `seq` 是**排序、去重、判新旧**的唯一依据；`updatedAt` 只用于展示（默认全部取同一个毫秒，
 * 以便测试证明「同一毫秒内的时间比较不可能正确」）。
 */
export function syncUpsert(input: {
  readonly entityId: string;
  readonly payload: unknown;
  readonly seq: number;
  readonly entityType?: SyncEntityType | undefined;
  readonly revision?: number | undefined;
  readonly updatedAt?: number | undefined;
}): SyncChange {
  return {
    seq: input.seq,
    entityType: input.entityType ?? 'nav_link',
    entityId: input.entityId,
    op: 'upsert',
    revision: input.revision ?? 1,
    updatedAt: input.updatedAt ?? 1_700_000_000_000,
    payload: input.payload,
  };
}

/** 一条墓碑变更（`payload` 显式为 `null`，与契约一致）。 */
export function syncDelete(input: {
  readonly entityId: string;
  readonly seq: number;
  readonly entityType?: SyncEntityType | undefined;
  readonly revision?: number | undefined;
  readonly updatedAt?: number | undefined;
}): SyncChange {
  return {
    seq: input.seq,
    entityType: input.entityType ?? 'nav_link',
    entityId: input.entityId,
    op: 'delete',
    revision: input.revision ?? 1,
    updatedAt: input.updatedAt ?? 1_700_000_000_000,
    payload: null,
  };
}

/**
 * 一轮变更响应。
 *
 * `meta.navRevision` 是**服务端权威的工作空间修订**（全局 CAS 只能用它）：
 * 行级 `revision` 与它无关，测试用它证明客户端没有从行修订推导全局修订。
 */
export function syncResponse(input: {
  readonly navRevision: number;
  readonly changes?: readonly SyncChange[] | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly hasMore?: boolean | undefined;
  readonly serverTimeMs?: number | undefined;
}): SyncChangesResponse {
  return {
    changes: [...(input.changes ?? [])],
    nextCursor: input.nextCursor ?? null,
    hasMore: input.hasMore ?? false,
    serverTimeMs: input.serverTimeMs ?? 1_700_000_000_000,
    entityTypes: ['nav_link', 'nav_group', 'nav_membership'],
    meta: { navRevision: input.navRevision, workbenchRevision: 0, watermark: 0 },
  };
}

/** 一个空的变更响应（默认行为：没有变更，`navRevision` 由调用方给出）。 */
export function emptySyncResponse(meta: { readonly navRevision?: number } = {}): SyncChangesResponse {
  return syncResponse({ navRevision: meta.navRevision ?? 0 });
}

/** 失败结果（用于游标被拒 / 409 等分支；`details` 是结构化原因的唯一来源）。 */
export function failureResult<T>(input: {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: unknown;
  readonly conflict?: SyncConflict | null;
}): NavResult<T> {
  return {
    ok: false,
    status: input.status,
    error: {
      code: input.code,
      message: input.message,
      requestId: 'req-fixture-failure',
      details: input.details ?? null,
      conflict: input.conflict ?? null,
    },
  };
}

/** `409` + 结构化行级冲突（真并发用例：客户端必须显示新旧两个 revision 并保留草稿）。 */
export function navConflictResult(input: {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly baseRevision: number;
  readonly currentRevision: number;
}): NavResult<never> {
  const conflict: SyncConflict = {
    reason: 'revision_conflict',
    entityType: input.entityType,
    entityId: input.entityId,
    field: null,
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    resolutionOptions: ['local', 'server'],
  };
  return failureResult<never>({
    status: 409,
    code: 'conflict',
    message: '该数据已被其他设备修改，请先比较差异再提交。',
    details: { conflict },
    conflict,
  });
}

/**
 * 构造一个「已成功」的结果。
 *
 * 同步返回 Promise（而不是写 `async`）的原因有二：
 * 一是这里没有任何等待，`async` 只会让 lint 报「async 没有 await」；
 * 二是替身返回值的形状因此与 `NavResult` 完全一致，测试读到的就是真实契约。
 */
function ok<T>(data: T, status = 200): Promise<NavResult<T>> {
  return Promise.resolve({ ok: true, status, data });
}

export interface FakeSyncApi {
  readonly api: {
    readonly readChanges: (query: {
      readonly since: string | null;
      readonly limit?: number | undefined;
    }) => Promise<NavResult<SyncChangesResponse>>;
  };
  readonly queries: { readonly since: string | null; readonly limit?: number | undefined }[];
}

/** 队列里的一步：要么是一轮成功响应，要么是一次失败（例如游标 `422`）。 */
export type FakeSyncStep = SyncChangesResponse | NavResult<SyncChangesResponse>;

/**
 * 假变更 API：按队列依次返回响应，并记录每次查询（用于断言游标推进）。
 * 队列用完后一直返回空响应（`navRevision` 可用第二个参数固定，默认 0）。
 */
export function fakeSyncApi(
  steps: readonly FakeSyncStep[] = [],
  options: { readonly navRevision?: number | undefined } = {},
): FakeSyncApi {
  const queue = [...steps];
  const queries: { since: string | null; limit?: number | undefined }[] = [];
  /** 队列耗尽后的兜底：保持「没有变更」，但修订必须与调用方声明的一致。 */
  const fallback = (): SyncChangesResponse =>
    options.navRevision === undefined ? emptySyncResponse() : emptySyncResponse({ navRevision: options.navRevision });
  return {
    api: {
      readChanges: vi.fn(
        (query: { readonly since: string | null; readonly limit?: number | undefined }) => {
          queries.push(query);
          const step = queue.shift();
          if (step === undefined) {
            return ok(fallback());
          }
          return 'ok' in step ? Promise.resolve(step) : ok(step);
        },
      ),
    },
    queries,
  };
}

/**
 * 本应用导出的版本化配置（`parseNavExportDocument` 能读回的形状）。
 * 默认空文档；调用方按需给出 links / groups / memberships。
 */
export function exportDocument(overrides: Partial<NavExportDocument> = {}): NavExportDocument {
  return {
    schemaVersion: 1,
    exportedAt: 1_700_000_100_000,
    catalogSourceVersion: 1,
    links: [],
    groups: [],
    memberships: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 假导航 API
// ---------------------------------------------------------------------------

export interface FakeNavApi {
  readonly api: NavApi;
  readonly calls: {
    readonly readSnapshot: ReturnType<typeof vi.fn>;
    readonly createLink: ReturnType<typeof vi.fn>;
    readonly updateLink: ReturnType<typeof vi.fn>;
    readonly deleteLink: ReturnType<typeof vi.fn>;
    readonly reorderLinks: ReturnType<typeof vi.fn>;
    readonly createGroup: ReturnType<typeof vi.fn>;
    readonly updateGroup: ReturnType<typeof vi.fn>;
    readonly deleteGroup: ReturnType<typeof vi.fn>;
    readonly reorderGroups: ReturnType<typeof vi.fn>;
    readonly readCatalog: ReturnType<typeof vi.fn>;
    readonly importCatalog: ReturnType<typeof vi.fn>;
    readonly previewImport: ReturnType<typeof vi.fn>;
    readonly applyImport: ReturnType<typeof vi.fn>;
    readonly exportDocument: ReturnType<typeof vi.fn>;
  };
}

/**
 * 假导航 API。
 *
 * 每个方法都是 `vi.fn()`：测试可以断言「点了按钮确实走了正确的操作」，
 * 以及「不该发的请求一次都没发」（例如危险 URL 被就地拒绝）。
 */
export function fakeNavApi(input: {
  readonly snapshot?: NavSnapshot | undefined;
  readonly catalog?: readonly NavCatalogEntry[] | undefined;
  /**
   * 服务端此刻的**权威**工作空间修订（预览响应里回传的那一个）。
   * 默认与快照一致；用于断言 apply 回显的是**服务端给的值**，不是本地推算。
   */
  readonly previewRevision?: number | undefined;
  /** `updateLink` 的失败结果（真并发 409 用例）：给定则每次 updateLink 都返回它。 */
  readonly updateLinkFailure?: NavResult<never> | undefined;
}): FakeNavApi {
  const current = input.snapshot ?? snapshot();
  const revisionFor = (): number => input.previewRevision ?? current.revision;

  const readSnapshot = vi.fn((): Promise<NavResult<NavSnapshot>> => ok(current));
  const listLinks = vi.fn(
    (): Promise<NavResult<NavLinkListView>> => ok({ links: [], revision: revisionFor() }),
  );
  const createLink = vi.fn((): Promise<NavResult<NavLinkResponse>> => ok({ link: link('created') }, 201));
  const updateLink = vi.fn(
    (linkId: string, _request: unknown): Promise<NavResult<NavLinkResponse>> => {
      if (input.updateLinkFailure !== undefined) {
        return Promise.resolve(input.updateLinkFailure);
      }
      return ok({ link: link(linkId, { revision: 2 }) });
    },
  );
  const deleteLink = vi.fn(
    (linkId: string, _request: unknown): Promise<NavResult<NavDeleteResponse>> =>
      ok({ deletedId: linkId, revision: revisionFor() + 1 }),
  );
  const reorderLinks = vi.fn(
    (_request: unknown): Promise<NavResult<NavRevisionResponse>> => ok({ revision: revisionFor() + 1 }),
  );
  const setLinkGroups = vi.fn(
    (_linkId: string, _request: unknown): Promise<NavResult<NavRevisionResponse>> =>
      ok({ revision: revisionFor() + 1 }),
  );
  const createGroup = vi.fn(
    (request: { readonly name: string }): Promise<NavResult<NavGroup>> => ok(group('G-new', { name: request.name }), 201),
  );
  const updateGroup = vi.fn(
    (groupId: string, request: { readonly name?: string | undefined }): Promise<NavResult<NavGroup>> =>
      ok(group(groupId, { name: request.name ?? '分组' })),
  );
  const deleteGroup = vi.fn(
    (groupId: string): Promise<NavResult<NavDeleteResponse>> =>
      ok({ deletedId: groupId, revision: revisionFor() + 1 }),
  );
  const reorderGroups = vi.fn(
    (_request: unknown): Promise<NavResult<NavRevisionResponse>> => ok({ revision: revisionFor() + 1 }),
  );
  const readCatalog = vi.fn(
    (): Promise<NavResult<NavCatalogResponse>> =>
      ok({ entries: [...(input.catalog ?? [])], sourceVersion: 1, updatedAt: 1_700_000_000_000 }),
  );
  const importCatalog = vi.fn(
    (
      request: { readonly catalogIds: readonly string[] },
    ): Promise<
      NavResult<{
        importedCount: number;
        importedLinkIds: string[];
        restoredLinkIds: string[];
        skippedCatalogIds: string[];
        revision: number;
      }>
    > =>
      ok({
        importedCount: request.catalogIds.length,
        importedLinkIds: ['L-imported'],
        restoredLinkIds: [],
        skippedCatalogIds: [],
        revision: current.revision + 1,
      }),
  );
  const previewImport = vi.fn(
    // 预览必须回显**服务端重新校验后**的条目：apply 按钮只在 items 非空时可用，
    // 一个恒返回空数组的替身会让「确认导入」永远点不动（那不是被测代码的问题）。
    // `restore` 模式本来就不提交 items，因此空 items 是它的正常形状。
    (request: {
      readonly mode?: 'links' | 'restore' | undefined;
      readonly items?: NavImportPreviewResponse['items'] | undefined;
      readonly skipped?: NavImportPreviewResponse['skipped'] | undefined;
      readonly document?: NavExportDocument | undefined;
    }): Promise<NavResult<NavImportPreviewResponse>> =>
      ok({
        items: [...(request.items ?? [])],
        skipped: [...(request.skipped ?? [])],
        revision: revisionFor(),
      }),
  );
  const applyImport = vi.fn(
    (request: {
      readonly mode?: 'links' | 'restore' | undefined;
      readonly document?: NavExportDocument | undefined;
    }): Promise<NavResult<NavImportApplyResponse>> => {
      if (request.mode === 'restore' && request.document !== undefined) {
        // 恢复的权威计数：链接写入数 = 文档里的链接数（服务端会重新映射 ID）。
        return ok({
          importedCount: request.document.links.length,
          importedLinkIds: request.document.links.map((row) => row.id),
          skipped: [],
          revision: revisionFor() + 1,
          // 字段名与服务端真实响应一致（`importedGroups` / `importedMemberships`）。
          importedGroups: request.document.groups.length,
          importedMemberships: request.document.memberships.length,
        });
      }
      return ok({ importedCount: 1, importedLinkIds: ['L-imported'], skipped: [], revision: current.revision + 1 });
    },
  );
  const exportDocument = vi.fn((): Promise<NavResult<NavExportResponse>> => {
    const document: NavExportDocument = {
      schemaVersion: 1,
      exportedAt: 1_700_000_000_000,
      catalogSourceVersion: 1,
      links: current.links,
      groups: current.groups,
      memberships: current.memberships,
    };
    return ok({ document, exportedAt: document.exportedAt });
  });

  const api: NavApi = {
    readSnapshot,
    listLinks,
    createLink,
    updateLink,
    deleteLink,
    reorderLinks,
    setLinkGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    reorderGroups,
    readCatalog,
    importCatalog,
    previewImport,
    applyImport,
    exportDocument,
  };

  return {
    api,
    calls: {
      readSnapshot,
      createLink,
      updateLink,
      deleteLink,
      reorderLinks,
      createGroup,
      updateGroup,
      deleteGroup,
      reorderGroups,
      readCatalog,
      importCatalog,
      previewImport,
      applyImport,
      exportDocument,
    },
  };
}

/** 导航模块的完整能力（与 Manifest 声明一致；Host 会比对「声明 ⊆ 授予」）。 */
export const NAV_CAPABILITIES: readonly string[] = ['storage:own', 'navigation:read-catalog'];

export const NAV_MODULE = NAV_MODULE_ID;
