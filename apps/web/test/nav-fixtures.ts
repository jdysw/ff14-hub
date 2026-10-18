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
  decodeSyncCursor,
  encodeSyncCursor,
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
  SyncChangesApi,
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
    /**
     * 同步水位（必填字段，第四轮契约变更）。
     *
     * 默认取 `revision` 只是**夹具约定**（「快照读出时工作空间的权威修订是 R，水位也是 R」），
     * 让绝大多数用例不必显式给出。但**验证 P1-A 竞态 / 地板语义的用例必须显式给出水位**：
     * 「快照里已经包含到哪个 `seq`」正是「内容 + 水位同批读出」的唯一证据，
     * 也是游标必须等于 `v2:<watermark>` 的依据。
     */
    watermark: overrides.revision ?? 1,
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
 * 一轮变更响应的形状（严格按共享契约）。
 *
 * `meta.navRevision` 是**服务端权威的工作空间修订**（全局 CAS 只能用它）：
 * 行级 `revision` 与它无关，测试用它证明客户端没有从行修订推导全局修订。
 * `resetRequired` / `meta.watermark` 属于「安全快照 + 稳定水位」初始化协议：
 * `since` 缺省时服务端必须回 `resetRequired: true` + 空的 `changes` + 水位游标。
 */
export function syncResponse(input: {
  readonly navRevision: number;
  readonly changes?: readonly SyncChange[] | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly hasMore?: boolean | undefined;
  readonly serverTimeMs?: number | undefined;
  readonly resetRequired?: boolean | undefined;
  readonly watermark?: number | undefined;
}): SyncChangesResponse {
  const changes = [...(input.changes ?? [])];
  const lastSeq = changes.length === 0 ? null : (changes[changes.length - 1]?.seq ?? null);
  return {
    changes,
    nextCursor: input.nextCursor ?? null,
    hasMore: input.hasMore ?? false,
    resetRequired: input.resetRequired ?? false,
    serverTimeMs: input.serverTimeMs ?? 1_700_000_000_000,
    entityTypes: ['nav_link', 'nav_group', 'nav_membership'],
    meta: {
      navRevision: input.navRevision,
      workbenchRevision: 0,
      watermark: input.watermark ?? lastSeq ?? 0,
    },
  };
}

/**
 * **初始化响应**：`since` 缺省时服务端按新契约返回的信封。
 *
 * 语义（见共享 `resetRequired` 注释）：**不返回任何历史变更**，只给出当前水位；
 * 客户端必须先读一次权威快照，再用这个水位开始取真实增量。
 * 历史行绝不能重放——变更流的 `payload` 是**当前**内容，重放历史会误删已恢复的数据。
 */
export function resetResponse(input: {
  readonly watermark: number;
  readonly navRevision?: number | undefined;
  readonly serverTimeMs?: number | undefined;
}): SyncChangesResponse {
  return syncResponse({
    navRevision: input.navRevision ?? 0,
    changes: [],
    nextCursor: encodeSyncCursor(input.watermark),
    hasMore: false,
    resetRequired: true,
    watermark: input.watermark,
    ...(input.serverTimeMs === undefined ? {} : { serverTimeMs: input.serverTimeMs }),
  });
}

/** 一个空的变更响应（默认行为：没有变更，`navRevision` 由调用方给出）。 */
export function emptySyncResponse(meta: { readonly navRevision?: number; readonly cursor?: number } = {}): SyncChangesResponse {
  return syncResponse({
    navRevision: meta.navRevision ?? 0,
    changes: [],
    nextCursor: meta.cursor === undefined ? null : encodeSyncCursor(meta.cursor),
    ...(meta.cursor === undefined ? {} : { watermark: meta.cursor }),
  });
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
  readonly api: SyncChangesApi;
  readonly queries: { readonly since: string | null; readonly limit?: number | undefined }[];
  /**
   * 同一个 `vi.fn`（`api.readChanges`）。
   *
   * 为什么暴露它：初始化协议要求「先发一次不带 `since` 的请求 → 再读权威快照 → 才采用水位」，
   * 而顺序只能由 `mock.invocationCallOrder` 与快照请求的发起顺序比较来断言，
   * 不能靠「请求计数」这种会被并发打乱的近似。
   */
  readonly readChanges: ReturnType<typeof vi.fn>;
  /** 队列耗尽后的兜底响应会用到它（`since` 缺省时回初始化信封）。 */
  readonly watermark: number;
  /**
   * 往队列尾部追加一步。
   *
   * 为什么需要它：有些用例要在**中间某个时刻之后**才喂入一页（例如「手动 reload 到新快照
   * 之后，再喂入 seq 小于新水位的旧增量」）。构造时就固定队列做不到这件事——
   * 挂载阶段的「确认无更多变更」那一轮会把页面提前消费掉。
   */
  readonly enqueue: (step: FakeSyncStep) => void;
}

/** 由测试**手动兑现**的一步：用于观察「排空中间态」与「分页之间发生并发写」。 */
export interface DeferredSyncStep {
  readonly deferred: Promise<NavResult<SyncChangesResponse>>;
}

/** 队列里的一步：一轮成功响应、一次失败（例如游标 `422`）、或一个延迟兑现的响应。 */
export type FakeSyncStep = SyncChangesResponse | NavResult<SyncChangesResponse> | DeferredSyncStep;

function isDeferredStep(step: FakeSyncStep): step is DeferredSyncStep {
  return 'deferred' in step;
}

/**
 * 一个可由测试兑现的响应（`resolve` 之后该页才会送达）。
 *
 * 为什么要它：要求「断言中间态」与「hasMore 期间禁止写」的用例必须在**排空进行中**
 * 观察界面，因此那一页必须停在被测代码手里，而不是立刻返回。
 */
export function deferredSyncResponse(): {
  readonly step: DeferredSyncStep;
  readonly resolve: (response: SyncChangesResponse) => void;
} {
  let settle: ((value: NavResult<SyncChangesResponse>) => void) | null = null;
  const deferred = new Promise<NavResult<SyncChangesResponse>>((resolve) => {
    settle = resolve;
  });
  return {
    step: { deferred },
    resolve: (response: SyncChangesResponse) => {
      settle?.({ ok: true, status: 200, data: response });
    },
  };
}

/**
 * 假变更 API：按队列依次返回响应，并记录每次查询（用于断言游标推进）。
 *
 * 队列耗尽后的兜底响应**按契约构造**，因此它能证明「客户端不会因为一次空响应就
 * 反复重建水位」：
 * - `since` 缺省（客户端没有游标）→ 回初始化信封（`resetRequired: true` + 水位游标）；
 * - 带游标 → 回「没有新变更」，并把**请求的游标原样回传**（水位不倒退）。
 */
export function fakeSyncApi(
  steps: readonly FakeSyncStep[] = [],
  options: { readonly navRevision?: number | undefined; readonly watermark?: number | undefined } = {},
): FakeSyncApi {
  const queue = [...steps];
  const queries: { since: string | null; limit?: number | undefined }[] = [];
  const watermark = options.watermark ?? 0;

  /** 队列耗尽后的兜底：保持「没有变更」，但形状必须与真实契约一致。 */
  const fallback = (since: string | null): SyncChangesResponse => {
    const navRevision = options.navRevision ?? 0;
    if (since === null) {
      return resetResponse({ watermark, navRevision });
    }
    const decoded = decodeSyncCursor(since);
    return syncResponse({
      navRevision,
      changes: [],
      nextCursor: since,
      watermark: decoded.ok ? decoded.seq : watermark,
    });
  };

  const readChanges = vi.fn(
    (query: { readonly since: string | null; readonly limit?: number | undefined }) => {
      queries.push(query);
      const step = queue.shift();
      if (step === undefined) {
        return Promise.resolve(ok(fallback(query.since)));
      }
      if (isDeferredStep(step)) {
        return step.deferred;
      }
      return 'ok' in step ? Promise.resolve(step) : Promise.resolve(ok(step));
    },
  );

  return {
    api: { readChanges },
    queries,
    readChanges,
    watermark,
    enqueue: (step: FakeSyncStep): void => {
      queue.push(step);
    },
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
  /**
   * 换掉 `readSnapshot` 之后返回的**权威快照**。
   *
   * 为什么必须有它：新协议下**状态只由快照发布**（变更日志只是失效信号），因此
   * 「远端发生了什么」必须体现为「快照变了」。一个永远返回同一份快照的替身根本无法验证
   * 「失效信号 → 重读快照 → 原子发布」这条链路，也无法验证「旧增量不得回退本地状态」。
   */
  readonly setSnapshot: (next: NavSnapshot) => void;
  /** 当前替身会返回的快照（断言「发布了哪一份」时用它比对引用）。 */
  readonly currentSnapshot: () => NavSnapshot;
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
  /**
   * `readSnapshot` 的失败结果：用于验证初始化协议的第 ③ 步——
   * 权威快照读不到时，客户端**既不能**推进同步水位、**也不能**应用任何变更。
   */
  readonly readSnapshotFailure?: NavResult<never> | undefined;
}): FakeNavApi {
  /**
   * 替身当前会返回的权威快照。用 `let` + `setSnapshot` 是为了让用例能模拟
   * 「远端又写了一次」——新协议下这是**唯一**能让本地状态变化的来源。
   */
  let current = input.snapshot ?? snapshot();
  const revisionFor = (): number => input.previewRevision ?? current.revision;

  const readSnapshot = vi.fn((): Promise<NavResult<NavSnapshot>> => {
    if (input.readSnapshotFailure !== undefined) {
      return Promise.resolve(input.readSnapshotFailure);
    }
    return ok(current);
  });
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
    setSnapshot: (next: NavSnapshot): void => {
      current = next;
    },
    currentSnapshot: (): NavSnapshot => current,
  };
}

/** 导航模块的完整能力（与 Manifest 声明一致；Host 会比对「声明 ⊆ 授予」）。 */
export const NAV_CAPABILITIES: readonly string[] = ['storage:own', 'navigation:read-catalog'];

export const NAV_MODULE = NAV_MODULE_ID;
