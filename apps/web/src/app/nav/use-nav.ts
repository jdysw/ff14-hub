/**
 * 导航状态容器（阶段 04 / HUB-007 · 008 · 009 · 047 · 048 · 051）。
 *
 * 与 `use-workbench` 同一套分层：本 Hook 是**唯一**持有导航可变状态的地方，视图全部是纯展示。
 * 会话代际一变，整棵会话子树以新 `key` 重挂，状态因此不会被旧会话的响应污染。
 *
 * 五条硬要求（都能在这里找到对应实现）：
 * 1. **筛选/排序必须用共享纯函数**：`projectNavLinks`（内部调用 `filterNavLinks` +
 *    `sortNavLinks`）是唯一实现，Widget 与服务端查询端点调用的是同一份，三处不可能漂移。
 *    本文件里**没有**第二套关键字/分组/区服/标签筛选逻辑。
 * 2. **编辑中的草稿遇到远程变化时保留草稿并提示冲突**：草稿记录 `baseRevision`
 *    （用户开始编辑时看到的服务端修订），后台刷新只更新快照，**绝不**写进草稿；
 *    一旦快照修订前进，就置位 `conflicted` 并提示「服务器上是 revision N」。
 * 3. **乐观更新 + 失败回滚**：收藏切换、删除、个人排序都是乐观的；失败时把快照
 *    恢复成操作前的**同一个对象引用**，界面立刻回到事实状态。
 * 4. **409 冲突不盲重试、不静默覆盖**：服务端结构化冲突（`details.conflict`）被解析出来，
 *    记进 `conflict` 供界面显示 `baseRevision` / `currentRevision` 并让用户显式决定。
 * 5. **导入先预览、再显式 apply**：本地解析（书签 HTML / 版本化配置 / 链接 JSON）用共享纯函数；
 *    apply 回显预览时的工作空间修订，期间数据被改动则由服务端 409 拒绝。
 *
 * ── 变更应用的三条复核修正（P1）──────────────────────────────────────────────
 * A. **排序/去重/墓碑一律只看 `seq`**（数据库单调变更序号）。`updatedAt` 不再参与任何
 *    新旧判断：同一毫秒内完全可能既有删除又有恢复，时间表达不了先后。每个实体维护
 *    `lastAppliedSeq`，墓碑表也存 `seq`，因此「删除后到达的更旧 upsert」在结构上无法复活它。
 * B. **工作空间级修订号只来自服务端 `meta.navRevision`，且只在排空之后采用**。早先这里用
 *    `Math.max(snapshot.revision, change.revision)` 从**行**修订推导全局修订，导致远端
 *    每次新增/编辑之后本地全局修订恒落后，下一次重排/导入必然 409——除非用户手动刷新。
 *    `change.revision` 现在只用于**行级**判断（草稿是否落后于该行）。
 * C. **绝不从 null 游标回放历史**（第三轮复核）：变更流的 `payload` 是**当前**实体内容，
 *    而日志条目是**历史事件**。「导入 → 删除 → 显式恢复」之后再重放那条历史 `delete`
 *    会把已恢复的链接删掉（成员关系一起丢）。因此初始化严格按「不带 `since` 请求 →
 *    `resetRequired` → 读权威快照并整份替换 → 才采用水位」执行（见 `useSyncChangesPoller`），
 *    并且应用前先用**快照水位地板** `snapshotFloorRef` 丢掉 `seq <= 地板` 的历史行。
 *    `hasMore === true`（还有页没取完）期间既不采用 `meta.navRevision`，也禁止重排/导入。
 */
import {
  buildNavExportDocument,
  catalogUpgradePlan,
  compareSyncChanges,
  decodeSyncCursor,
  decideCatalogImport,
  encodeSyncCursor,
  navCatalogEntryState,
  navGroupSchema,
  navLinkSchema,
  navMembershipSchema,
  navUrlSchema,
  nextSyncCursor,
  parseBookmarkHtml,
  parseNavImportDocument,
  parseNavExportDocument,
  projectNavLinks,
  SYNC_DEFAULT_LIMIT,
  syncChangesResponseSchema,
  NAV_DEFAULT_ICON,
  type NavCatalogEntry,
  type NavCatalogEntryState,
  type NavExportDocument,
  type NavFilter,
  type NavGroup,
  type NavImportItem,
  type NavImportSkipped,
  type NavLink,
  type NavLinkStatus,
  type NavLinkView,
  type NavMembership,
  type NavRegion,
  type NavSnapshot,
  type NavSortMode,
  type SyncChange,
  type SyncChangesResponse,
  type SyncConflict,
  type SyncEntityType,
  type SyncMeta,
} from '@ff14-hub/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createNavApi,
  createNavTransport,
  createSyncChangesApi,
  describeNavError,
  describeSyncCursorReset,
  newOperationId,
  parseSyncCursorFailure,
  type NavApi,
  type NavApiErrorInfo,
  type NavImportApplyResponse,
  type NavRequester,
  type NavResult,
  type SyncChangesApi,
} from './nav-api';

// ---------------------------------------------------------------------------
// 视图需要的派生类型与纯函数
// ---------------------------------------------------------------------------

/** 链接表单值（标签/别名以文本输入，提交时按分隔符切分）。 */
export interface NavLinkFormValues {
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly tags: string;
  readonly aliases: string;
  readonly icon: string;
  readonly openMode: NavLink['openMode'];
  readonly region: NavRegion;
  readonly status: NavLinkStatus;
  readonly isFavorite: boolean;
  readonly groupIds: readonly string[];
}

/**
 * 编辑中的草稿。
 *
 * `baseRevision` 是**保存时要提交的基数**，因此两种模式语义不同（必须与服务的 CAS 一致）：
 * - `mode: 'edit'`：**该链接行的修订号**（`nav_link.revision`）。服务端 `PATCH`/`DELETE` 的
 *   `expectedRevision` 正是与行修订比较的条件更新。
 * - `mode: 'create'`：新建没有「自己那一行」，服务端也不接受 `expectedRevision`
 *   （它用「活跃行数 + operationId 幂等」做准入），因此这里放工作空间修订仅作留痕。
 *
 * 复核修正（阶段 04）：早先两种模式都记工作空间修订，而行修订与工作空间修订的差值恒 ≥ 1
 * 且单调不减 → 链接编辑保存**永远** 409。这是真实缺陷，改为按模式取正确的基数。
 *
 * `conflicted` 只影响提示——草稿内容一个字节都不会被改写（这是「不静默覆盖」的实现）。
 */
export interface NavLinkDraft {
  readonly mode: 'create' | 'edit';
  readonly linkId: string | null;
  readonly values: NavLinkFormValues;
  readonly baseRevision: number;
  readonly conflicted: boolean;
  readonly serverRevision: number | null;
}

/** 409 冲突的可见状态（草稿保留 + 让用户显式选择）。 */
export interface NavConflictState {
  readonly code: string;
  readonly message: string;
  readonly conflict: SyncConflict | null;
}

/** 目录条目 + 它相对「我的副本」的状态（用共享 `catalogUpgradePlan` 算出）。 */
export interface NavCatalogRow {
  readonly entry: NavCatalogEntry;
  readonly state: NavCatalogEntryState;
  readonly linkId: string | null;
  /** 该状态下的默认动作（共享 `decideCatalogImport` 的唯一实现）。 */
  readonly defaultAction: string;
  readonly defaultActionReason: string;
  /** 默认是否可被勾选：墓碑与「用户改过」的条目需要显式额外确认，默认不勾选。 */
  readonly selectable: boolean;
}

/** 本地解析出的待导入内容（来自书签文件、链接 JSON 或本应用的版本化导出文档）。 */
export interface NavLocalImport {
  /**
   * 三种来源，**必须区分**（复核发现的真实缺陷）：
   * - `bookmarks`：Netscape 书签 HTML（只有标题 / URL / 文件夹名）；
   * - `json`：普通链接数组或 `{ links: [...] }`；
   * - `restore`：本应用导出的**版本化完整配置**——保留分组、多对多归属、收藏、状态与顺序。
   */
  readonly kind: 'bookmarks' | 'json' | 'restore';
  readonly sourceName: string;
  readonly items: readonly NavImportItem[];
  readonly skipped: readonly NavImportSkipped[];
  /** `kind === 'restore'` 时**原样**保留的完整文档（绝不拆成 items 提交）。 */
  readonly document: NavExportDocument | null;
  /** `kind === 'restore'` 时的可见摘要（数量 / 导出时间 / schemaVersion）。 */
  readonly summary: NavRestoreSummary | null;
  /**
   * 整份输入不可用时的原因（未来版本 / 引用不完整 / 危险 URL / 非法 JSON）。
   * 非空时预览与导入一律不发生——**绝不**降级成「只取 links 数组」。
   */
  readonly error: string | null;
}

/** 完整配置恢复前展示的摘要（全部来自文档本身，不是推断）。 */
export interface NavRestoreSummary {
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly linkCount: number;
  readonly groupCount: number;
  readonly membershipCount: number;
}

/** 服务端预览结果 + apply 需要的一切（修订与目标分组）。 */
export interface NavImportPreviewState {
  readonly preview: {
    readonly items: readonly NavImportItem[];
    readonly skipped: readonly NavImportSkipped[];
    readonly revision: number;
  };
  /** 预览时的工作空间修订（服务端回传的权威值）；apply 必须回显它。 */
  readonly expectedRevision: number;
  readonly source: NavLocalImport;
  readonly targetGroupId: string | null;
}

export interface NavController {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly notice: string | null;
  readonly busy: boolean;
  /**
   * 是否**正在排空**跨设备变更（服务端说 `hasMore === true`，还有页没取完）。
   *
   * 为什么必须让界面知道：排空期间本地集合是**不完整**的，此时提交「全局 CAS 写」
   * （重排 / 导入这类带 `expectedRevision` 的整体操作）等于拿一份部分旧集合去覆盖服务端。
   * 因此这些动作在 `syncing === true` 时被拒绝并给出「正在同步」的提示，
   * 而不是静默地用旧修订（或服务端当前修订）提交。
   */
  readonly syncing: boolean;
  readonly snapshot: NavSnapshot | null;
  /** 已投影的视图（筛选 + 排序 + 分组名）：视图直接渲染它，不再自己算。 */
  readonly visibleLinks: readonly NavLinkView[];
  readonly activeGroups: readonly NavGroup[];
  readonly filter: NavFilter;
  readonly sort: NavSortMode;
  readonly draft: NavLinkDraft | null;
  readonly conflict: NavConflictState | null;
  /**
   * 跨设备同步发现「正在编辑的链接在远端变了」时的提示（草稿仍然保留）。
   * 与 `conflict` 分开：那个是服务端 409 的结构化冲突，这个是**收到远端变更**的事实。
   */
  readonly draftRemoteNotice: string | null;
  /**
   * 同步机制本身的可恢复异常提示（当前只有「服务端拒绝本地游标 → 已丢弃并从头完整同步」）。
   *
   * 与 `error` 分开：这不是失败，而是**已经自动恢复**的事实，必须让用户看得见
   * （静默丢游标会让用户以为「数据一直是最新的」）。下一轮同步成功后自动清除。
   */
  readonly syncNotice: string | null;
  readonly lastDeletedLinkId: string | null;
  readonly catalog: readonly NavCatalogEntry[] | null;
  readonly catalogRows: readonly NavCatalogRow[];
  readonly catalogError: string | null;
  readonly localImport: NavLocalImport | null;
  readonly importPreview: NavImportPreviewState | null;
  readonly importTargetGroupId: string | null;
  readonly exportedJson: string | null;
  readonly exportNotice: string | null;
  readonly exportReadBack: string | null;
  readonly reload: () => Promise<void>;
  /** 立刻同步一次跨设备变更（轮询之外的显式入口）。 */
  readonly syncNow: () => Promise<void>;
  readonly setNotice: (notice: string | null) => void;
  readonly patchFilter: (patch: Partial<NavFilter>) => void;
  readonly setSort: (sort: NavSortMode) => void;
  readonly startCreateLink: (presetGroupId?: string | null) => void;
  readonly startEditLink: (linkId: string) => void;
  readonly updateDraft: (patch: Partial<NavLinkFormValues>) => void;
  readonly cancelDraft: () => void;
  readonly acknowledgeConflict: () => void;
  readonly createLink: () => Promise<void>;
  readonly updateLink: () => Promise<void>;
  readonly deleteLink: (linkId: string) => Promise<void>;
  readonly toggleFavorite: (linkId: string) => Promise<void>;
  readonly moveLink: (linkId: string, direction: -1 | 1) => Promise<void>;
  readonly createGroup: (name: string) => Promise<void>;
  readonly renameGroup: (groupId: string, name: string) => Promise<void>;
  readonly deleteGroup: (groupId: string) => Promise<void>;
  readonly moveGroup: (groupId: string, direction: -1 | 1) => Promise<void>;
  readonly loadCatalog: () => Promise<void>;
  readonly importCatalog: (input: {
    readonly catalogIds: readonly string[];
    readonly explicitReimport: boolean;
    readonly overwriteUserEdits: boolean;
  }) => Promise<void>;
  readonly previewLocalImport: (input: {
    readonly kind: 'bookmarks' | 'json';
    readonly sourceName: string;
    readonly text: string;
  }) => void;
  readonly clearLocalImport: () => void;
  readonly setImportTargetGroup: (groupId: string | null) => void;
  readonly previewImport: () => Promise<void>;
  readonly applyImport: () => Promise<void>;
  readonly discardImportPreview: () => void;
  readonly exportDocument: () => Promise<void>;
  /** 读回校验：把一段 JSON 文本按共享 `parseNavExportDocument` 解析并报告结果。 */
  readonly readBackExport: (text: string) => void;
}

interface NavState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly notice: string | null;
  readonly busy: boolean;
  /** 正在排空跨设备变更（见 `NavController.syncing`）。 */
  readonly syncing: boolean;
  readonly snapshot: NavSnapshot | null;
  readonly catalog: readonly NavCatalogEntry[] | null;
  readonly catalogError: string | null;
  readonly localImport: NavLocalImport | null;
  readonly importPreview: NavImportPreviewState | null;
  readonly conflict: NavConflictState | null;
  readonly draftRemoteNotice: string | null;
  readonly syncNotice: string | null;
  readonly lastDeletedLinkId: string | null;
  readonly exportedJson: string | null;
  readonly exportNotice: string | null;
  readonly exportReadBack: string | null;
}

const INITIAL_STATE: NavState = {
  status: 'idle',
  error: null,
  notice: null,
  busy: false,
  syncing: false,
  snapshot: null,
  catalog: null,
  catalogError: null,
  localImport: null,
  importPreview: null,
  conflict: null,
  draftRemoteNotice: null,
  syncNotice: null,
  lastDeletedLinkId: null,
  exportedJson: null,
  exportNotice: null,
  exportReadBack: null,
};

export interface UseNavOptions {
  /** 读取设备凭证（只在发请求的那一刻读取，绝不进 state / props / URL）。 */
  readonly getToken: () => string | null;
  /** 何时开始首次加载（进入导航视图）。离开视图不清空状态。 */
  readonly enabled: boolean;
  /** 凭证失效时切回未登录态。 */
  readonly onUnauthorized?: (() => void) | undefined;
  /** 便于测试注入替身；默认用真实 API 客户端（与数据端口同一份实现）。 */
  readonly api?: NavApi | undefined;
  /** 跨设备变更的 API 替身（测试注入）；默认与 `api` 同一套凭证装配。 */
  readonly syncApi?: SyncChangesApi | undefined;
  /** 变更轮询间隔（毫秒）。默认 30 秒；`<= 0` 表示只在挂载与窗口获得焦点时同步。 */
  readonly syncIntervalMs?: number | undefined;
  /**
   * 每页变更条数（默认共享 `SYNC_DEFAULT_LIMIT`）。
   *
   * 只在测试里注入较小的值（例如 1）：那样一次同步必然要跨多页，才能真正验证
   * 「发现 `hasMore` 立即续取下一页直到排空」以及「排空期间禁止全局 CAS 写」。
   */
  readonly syncLimit?: number | undefined;
}

// ---------------------------------------------------------------------------
// 纯辅助（导出以便视图与测试复用同一份判定）
// ---------------------------------------------------------------------------

/** 新建链接的表单初值（`presetGroupId` 用于「在某个分组里新建」）。 */
export function emptyLinkForm(presetGroupId?: string | null): NavLinkFormValues {
  return {
    title: '',
    url: '',
    description: '',
    tags: '',
    aliases: '',
    icon: NAV_DEFAULT_ICON,
    openMode: 'new_tab',
    region: 'cn',
    status: 'active',
    isFavorite: false,
    groupIds: presetGroupId === null || presetGroupId === undefined ? [] : [presetGroupId],
  };
}

/** 已有链接 → 表单初值。 */
export function formOfLink(link: NavLink, groupIds: readonly string[]): NavLinkFormValues {
  return {
    title: link.title,
    url: link.url,
    description: link.description,
    tags: link.tags.join('，'),
    aliases: link.aliases.join('，'),
    icon: link.icon,
    openMode: link.openMode,
    region: link.region,
    status: link.status,
    isFavorite: link.isFavorite,
    groupIds,
  };
}

/**
 * 把「标签 / 别名」输入拆成数组。
 *
 * 逗号同时接受中英文（用户两种都会打），顿号也当分隔符。规范化（NFKC、去重、截断）
 * 由共享 Schema 在提交时完成，这里只做切分。
 */
export function splitTagInput(raw: string): string[] {
  return raw
    .split(/[,，、]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 从 URL 取主机名（只用于显示；不合法时退化为原字符串）。 */
export function hostOf(url: string): string {
  const withoutScheme = url.startsWith('https://') ? url.slice('https://'.length) : url;
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
  return authority.length === 0 ? url : authority;
}

/**
 * 就地校验 URL（输入框失焦 / 提交前）。
 *
 * 判定用的是**共享** `navUrlSchema`（底层 `validateNavUrl` 是前后端唯一实现），
 * 因此「前端放行、服务端拒绝」的漂移不可能发生。危险协议（`javascript:` 等）
 * 在这里就被拦下，**不发任何请求**。
 */
export function localUrlError(url: string): string | null {
  const parsed = navUrlSchema.safeParse(url);
  if (parsed.success) {
    return null;
  }
  return parsed.error.issues[0]?.message ?? '链接地址不合法';
}

/** 触发浏览器下载（结构相同的导出文档也有人眼可核对的只读回显）。 */
function triggerDownload(text: string): void {
  const helper = URL;
  if (typeof helper.createObjectURL !== 'function') {
    // 环境不支持对象 URL（例如某些测试环境）：只保留只读回显，不假装下载成功。
    return;
  }
  const blob = new Blob([text], { type: 'application/json' });
  const href = helper.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `ff14-hub-navigation-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.rel = 'noreferrer noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  helper.revokeObjectURL(href);
}

// ---------------------------------------------------------------------------
// 跨设备变更（HUB-051）：纯判定 + 轮询
//
// 四条硬规则（都在下面用纯函数表达，便于单测与双上下文验收）：
// 1. **顺序与去重只看 `seq`**：`seq` 是数据库单调变更序号，全局唯一且严格递增，
//    因此它是「谁更新」的唯一判据。同一毫秒内的删除与恢复靠它正确落地，
//    `updatedAt` 只作展示/诊断（绝不再参与新旧判断）。
// 2. **删除即删除**：`op:'delete'` 移除本地行/关系并把该键的墓碑记为**这次删除的 seq**；
//    任何 seq 更小的 upsert 都被 `lastAppliedSeq` / 墓碑双重拦下，不存在复活路径。
// 3. **草稿优先于远端**：正在编辑的实体收到远端变化时**不动本地、不丢草稿**，
//    只产生一条明确的提示，由用户决定放弃草稿或重新载入。
// 4. **不做无谓刷新**：只有真正需要应用的变更才会产生新快照。
// ---------------------------------------------------------------------------

/** 导航关心的变更实体类型（其余类型不由本模块处理）。 */
export const NAV_SYNC_ENTITY_TYPES: readonly SyncEntityType[] = ['nav_link', 'nav_group', 'nav_membership'];

export function isNavSyncEntityType(entityType: SyncEntityType): boolean {
  return (NAV_SYNC_ENTITY_TYPES as readonly string[]).includes(entityType);
}

/** 墓碑键：`实体类型:实体ID`。 */
export function syncTombstoneKey(change: Pick<SyncChange, 'entityType' | 'entityId'>): string {
  return `${change.entityType}:${change.entityId}`;
}

/**
 * 成员关系的实体 ID 是 `${linkId}:${groupId}`（上限 96）。
 *
 * 刻意**不截断**：截断会把两条不同成员关系映射到同一个键，
 * 于是「删掉 linkA:groupB」可能误删另一条关系。
 */
export function membershipPartsOf(entityId: string): { readonly linkId: string; readonly groupId: string } | null {
  const separator = entityId.indexOf(':');
  if (separator <= 0 || separator === entityId.length - 1) {
    return null;
  }
  return { linkId: entityId.slice(0, separator), groupId: entityId.slice(separator + 1) };
}

export interface RemoteChangeVerdict {
  readonly kind: 'apply' | 'draft_conflict' | 'ignore';
  readonly reason: string;
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly remoteOp: SyncChange['op'];
  /** 与草稿冲突时，被影响的链接 ID（`nav_membership` 时是链接那一半）。 */
  readonly affectedLinkId: string | null;
}

/**
 * 判定「这条远端变更该怎么处理」（**纯函数**，便于单测与 Playwright 双上下文验收）。
 *
 * 输入只有两件事：这条变更、以及用户正在编辑的链接 ID（没有草稿时为 null）。
 * 输出只有三种结论：应用 / 草稿冲突 / 忽略。任何分支都不会修改草稿。
 */
export function resolveRemoteChange(input: {
  readonly change: SyncChange;
  readonly draftLinkId: string | null;
}): RemoteChangeVerdict {
  const { change } = input;
  const base = {
    entityType: change.entityType,
    entityId: change.entityId,
    remoteOp: change.op,
    affectedLinkId: null as string | null,
  };
  if (!isNavSyncEntityType(change.entityType)) {
    return { ...base, kind: 'ignore', reason: '不是导航实体，本模块不处理' };
  }
  if (input.draftLinkId === null) {
    return { ...base, kind: 'apply', reason: '没有正在编辑的草稿' };
  }
  if (change.entityType === 'nav_link' && change.entityId === input.draftLinkId) {
    return {
      ...base,
      kind: 'draft_conflict',
      affectedLinkId: change.entityId,
      reason: change.op === 'delete' ? '该链接在其它设备上被删除' : '该链接在其它设备上被更新',
    };
  }
  if (change.entityType === 'nav_membership') {
    const parts = membershipPartsOf(change.entityId);
    if (parts !== null && parts.linkId === input.draftLinkId) {
      return {
        ...base,
        kind: 'draft_conflict',
        affectedLinkId: parts.linkId,
        reason: change.op === 'delete' ? '该链接的分组归属在其它设备上被移除' : '该链接的分组归属在其它设备上被修改',
      };
    }
  }
  // 分组改名 / 其它链接 / 其它成员关系：与当前草稿无关，可以安全应用。
  return { ...base, kind: 'apply', reason: '与正在编辑的链接无关' };
}

/**
 * 草稿冲突的用户可见文案。
 *
 * 刻意说清三件事：远端发生了什么、草稿还在、草稿在第几行。
 * 绝不含「已自动合并」这类说法——本模块**不会**自动合并草稿。
 */
export function describeRemoteDraftConflict(input: {
  readonly verdict: RemoteChangeVerdict;
  readonly rowNumber: number | null;
  readonly title: string | null;
}): string {
  const row = input.rowNumber === null ? '' : `你的草稿保留在第 ${String(input.rowNumber)} 行，`;
  const label = input.title === null ? '' : `「${input.title}」`;
  return `${input.verdict.reason}${label === '' ? '' : `：${label}`}；${row}未保存。`;
}

/**
 * 「正在排空变更页」的可见文案（排空期间写入被拒绝时也复用它）。
 */
export const SYNC_DRAINING_NOTICE =
  '正在同步其它设备的改动（还有变更页未取完）：在排空之前不会采用服务端的全局修订，' +
  '重排 / 导入等整体操作暂时不可用，以免用不完整的本地集合覆盖服务端。';

/**
 * 「忽略了快照之前的历史事件」的可见文案。
 *
 * 必须让用户看得见：这说明服务端投递了本不该投递的历史行，而客户端按协议丢弃了它们
 * （重放会把已恢复的数据改错）。静默丢弃会让「为什么这条没生效」无从解释。
 */
export function describeHistoryIgnored(count: number): string {
  return `已忽略 ${String(count)} 条早于本次同步水位的变更（它们已包含在权威快照里，重放会把已恢复的数据改错）。`;
}

export interface NavSyncApplyResult {
  readonly snapshot: NavSnapshot;
  /** 每个实体（`类型:ID`）已应用过的最大 `seq`（活跃与已删除实体都记）。 */
  readonly appliedSeq: Readonly<Record<string, number>>;
  /** 墓碑表：`类型:ID` → 该实体被删除那一次的 `seq`。 */
  readonly tombstones: Readonly<Record<string, number>>;
  /** 因重复序号、形状不符或已删除而被丢弃的变更条数（界面据此诚实说明）。 */
  readonly ignored: number;
}

/**
 * 把变更应用到快照（**纯函数**）。
 *
 * 规则（每一条都对应一个复核缺陷）：
 * - **按 `seq` 升序处理**（共享 `compareSyncChanges` 是唯一排序实现）：同一毫秒内的
 *   「删除 → 恢复」因此能按真实先后落地，不再被 `updatedAt` 误判成旧数据而丢掉。
 * - **`seq <= 已应用序号` 一律丢弃**：重复投递与「墓碑之后才到达的更旧 upsert」都在这里被拦下。
 * - **墓碑表也存 `seq`**：即使某次全量重建丢了 `appliedSeq`，墓碑仍是第二道闸门。
 * - **绝不改 `snapshot.revision`**：全局修订只由服务端 `meta.navRevision` 给出（见调用方）。
 *   行修订与全局修订是两个计数器，互相推导必然产生恒 409。
 * - `upsert` 的 payload 必须是该实体的**活跃快照**；`deletedAt` 非空的 payload 按墓碑处理
 *   （服务端也可能用 upsert 表达「这一行已被删除」这个事实）。
 */
export function applyNavSyncChanges(input: {
  readonly snapshot: NavSnapshot;
  readonly changes: readonly SyncChange[];
  readonly appliedSeq: Readonly<Record<string, number>>;
  readonly tombstones: Readonly<Record<string, number>>;
}): NavSyncApplyResult {
  let links = [...input.snapshot.links];
  let groups = [...input.snapshot.groups];
  let memberships = [...input.snapshot.memberships];
  const appliedSeq: Record<string, number> = { ...input.appliedSeq };
  const tombstones: Record<string, number> = { ...input.tombstones };
  let ignored = 0;

  /** 记「这个键已消费到 seq」；能走到这里的 `seq` 必然大于既有值。 */
  const markApplied = (key: string, seq: number): void => {
    appliedSeq[key] = seq;
  };

  /** 记墓碑：墓碑序号只增不减（一次更早的删除不能把墓碑拨回去）。 */
  const markTombstone = (key: string, seq: number): void => {
    tombstones[key] = Math.max(tombstones[key] ?? 0, seq);
    appliedSeq[key] = Math.max(appliedSeq[key] ?? 0, seq);
  };

  /**
   * 级联移除成员关系，并把它们也记在**同一次删除的 seq** 上。
   *
   * 为什么必须一起记：链接/分组被删时服务端会一并墓碑化它的成员关系。若这里只删本地行、
   * 不记序号，那么一次从头全量重建里那条**更早**的成员关系 upsert 就会把它加回来，
   * 快照里便出现一条指向已删实体的悬空关系。
   * （诚实记录：只覆盖本地已知的关系；从未同步过的关系无法在此登记，但它指向的链接/分组
   * 在本地已经不存在，投影与界面都不会把它当成有效归属。）
   */
  const cascadeDeleteMemberships = (match: (membership: NavMembership) => boolean, seq: number): void => {
    for (const membership of memberships) {
      if (!match(membership)) {
        continue;
      }
      const membershipKey = `nav_membership:${membership.linkId}:${membership.groupId}`;
      tombstones[membershipKey] = Math.max(tombstones[membershipKey] ?? 0, seq);
      appliedSeq[membershipKey] = Math.max(appliedSeq[membershipKey] ?? 0, seq);
    }
    memberships = memberships.filter((membership) => !match(membership));
  };

  for (const change of [...input.changes].sort(compareSyncChanges)) {
    const key = syncTombstoneKey(change);
    const appliedSoFar = appliedSeq[key] ?? 0;
    const tombstoneSeq = tombstones[key] ?? 0;
    if (change.seq <= appliedSoFar || change.seq <= tombstoneSeq) {
      // 重复投递、或墓碑之后才到达的更旧 upsert：一律丢弃（这是「不复活删除」的闸门）。
      ignored += 1;
      continue;
    }

    if (change.op === 'delete') {
      markTombstone(key, change.seq);
      if (change.entityType === 'nav_link') {
        links = links.filter((link) => link.id !== change.entityId);
        // 链接被删 → 它的成员关系也一并移除（服务端同样会墓碑化它们）。
        cascadeDeleteMemberships((membership) => membership.linkId === change.entityId, change.seq);
      } else if (change.entityType === 'nav_group') {
        groups = groups.filter((group) => group.id !== change.entityId);
        cascadeDeleteMemberships((membership) => membership.groupId === change.entityId, change.seq);
      } else if (change.entityType === 'nav_membership') {
        const parts = membershipPartsOf(change.entityId);
        if (parts !== null) {
          memberships = memberships.filter(
            (membership) => membership.linkId !== parts.linkId || membership.groupId !== parts.groupId,
          );
        }
      }
      continue;
    }

    if (change.entityType === 'nav_link') {
      const parsed = navLinkSchema.safeParse(change.payload);
      if (!parsed.success) {
        ignored += 1;
        continue;
      }
      const row = parsed.data;
      if (row.deletedAt !== null) {
        markTombstone(key, change.seq);
        links = links.filter((link) => link.id !== row.id);
        cascadeDeleteMemberships((membership) => membership.linkId === row.id, change.seq);
      } else {
        links = links.some((link) => link.id === row.id)
          ? links.map((link) => (link.id === row.id ? row : link))
          : [...links, row];
        markApplied(key, change.seq);
      }
      continue;
    }

    if (change.entityType === 'nav_group') {
      const parsed = navGroupSchema.safeParse(change.payload);
      if (!parsed.success) {
        ignored += 1;
        continue;
      }
      const row = parsed.data;
      if (row.deletedAt !== null) {
        markTombstone(key, change.seq);
        groups = groups.filter((group) => group.id !== row.id);
        cascadeDeleteMemberships((membership) => membership.groupId === row.id, change.seq);
      } else {
        groups = groups.some((group) => group.id === row.id)
          ? groups.map((group) => (group.id === row.id ? row : group))
          : [...groups, row];
        markApplied(key, change.seq);
      }
      continue;
    }

    // nav_membership：payload 缺失时用实体 ID 还原两端，避免整条变更被白丢。
    const parts = membershipPartsOf(change.entityId);
    const parsed = navMembershipSchema.safeParse(change.payload);
    const row: NavMembership | null = parsed.success
      ? parsed.data
      : parts === null
        ? null
        : {
            linkId: parts.linkId,
            groupId: parts.groupId,
            sortOrder: 0,
            deletedAt: null,
            updatedAt: change.updatedAt,
          };
    if (row === null) {
      ignored += 1;
      continue;
    }
    if (row.deletedAt !== null) {
      markTombstone(key, change.seq);
      memberships = memberships.filter(
        (membership) => membership.linkId !== row.linkId || membership.groupId !== row.groupId,
      );
    } else {
      memberships = memberships.some(
        (membership) => membership.linkId === row.linkId && membership.groupId === row.groupId,
      )
        ? memberships.map((membership) =>
            membership.linkId === row.linkId && membership.groupId === row.groupId ? row : membership,
          )
        : [...memberships, row];
      markApplied(key, change.seq);
    }
  }

  // 刻意**不**在这里碰 `snapshot.revision`：全局修订只能来自服务端 `meta.navRevision`。
  return {
    snapshot: { ...input.snapshot, links, groups, memberships },
    appliedSeq,
    tombstones,
    ignored,
  };
}

/** 默认轮询间隔（毫秒）：30 秒。测试可注入更短的值，注入 0 表示不轮询。 */
export const NAV_SYNC_DEFAULT_INTERVAL_MS = 30_000;

/**
 * 一次同步里最多连续取回的页数（安全阀）。
 *
 * 为什么需要它：协议要求「发现 `hasMore` 就立刻续取下一页直到排空」，因此一次 `syncNow`
 * 可能连续往返很多轮。上限保证一个异常的服务端（永远声称 `hasMore === true`）不会把界面
 * 卡在无休止的请求里；到上限时**游标已经前移**，下一轮从断点继续，不会丢变更。
 */
export const SYNC_MAX_PAGES_PER_SYNC = 50;

export interface SyncChangesPollerOptions {
  readonly enabled: boolean;
  /** 真实环境下读取设备凭证；注入 `api` 替身时不需要它。 */
  readonly getToken?: (() => string | null) | undefined;
  readonly api?: SyncChangesApi | undefined;
  /** 轮询间隔；`<= 0` 表示只在挂载与窗口获得焦点时同步。 */
  readonly intervalMs?: number | undefined;
  readonly limit?: number | undefined;
  /**
   * 应用**一页**变更。
   *
   * `meta` 是与变更流**同一快照**读出的权威工作空间修订（`syncMetaSchema`）：
   * 调用方只能用它更新全局 CAS 基数，绝不能用 `change.revision` 推导。
   *
   * `drained` 表示本页是否为最后一页（`hasMore === false`）。它是硬约束的一部分：
   * `hasMore === true` 期间本地集合还不完整，**不得**采用 `meta` 里的全局修订号——那对应
   * 服务端**当前**状态，用它做全局 CAS 是「按未来修订号批准基于部分旧集合的写入」。
   */
  readonly onChanges: (
    changes: readonly SyncChange[],
    serverTimeMs: number,
    meta: SyncMeta,
    drained: boolean,
  ) => void;
  readonly onUnauthorized?: (() => void) | undefined;
  readonly onError?: ((message: string) => void) | undefined;
  /**
   * 服务端**拒绝本地游标**（`422` + `details.reason`）时的可见回调。
   *
   * 为什么单列一条：这不是失败而是**已自动恢复**（游标已丢弃，下一轮做一次完整重建），
   * 必须让用户看得见；静默重来会让用户误以为「本地数据一直是最新的」。
   */
  readonly onCursorReset?: ((message: string) => void) | undefined;
  /**
   * `resetRequired === true`（客户端没有游标）时**唯一**的初始化入口：读一次权威快照
   * 并**替换**本地状态。
   *
   * 参数是该轮水位（服务端给的 `nextCursor` 对应的 `seq`）。调用方在快照成功落地后应把它
   * 记为「已经包含在快照里的水位」——比它更旧（或相等）的变更一律是**历史事件**，
   * 而变更流的 `payload` 是**当前**内容，重放历史会误删已恢复的数据，因此必须能识别出来。
   * 返回 `true` 才表示快照已落地；返回 `false` 时轮询器**既不推进游标也不应用任何变更**。
   */
  readonly onSnapshotRequired?: ((watermarkSeq: number) => Promise<boolean>) | undefined;
  /** 排空（还有页没取完）开始 / 结束：界面据此禁用全局 CAS 写并提示「正在同步」。 */
  readonly onDrainingChange?: ((draining: boolean) => void) | undefined;
}

export interface SyncChangesPoller {
  /** 立刻同步一次（轮询之外的显式入口，便于测试与「手动刷新」）。 */
  readonly syncNow: () => Promise<void>;
}

/** 规范化服务端给出的游标：只接受本版本能理解的 `v2:<seq>`，其余一律视为不可用。 */
function normalizeSyncCursor(raw: string | null): { readonly cursor: string; readonly seq: number } | null {
  if (raw === null) {
    return null;
  }
  const decoded = decodeSyncCursor(raw);
  return decoded.ok ? { cursor: encodeSyncCursor(decoded.seq), seq: decoded.seq } : null;
}

/**
 * 推进游标（**唯一实现**是共享 `nextSyncCursor` 与 `encodeSyncCursor`）。
 *
 * 三种情况：
 * - 服务端给了 `nextCursor` → 往返校验后采用（版本/形状不合法则清空，下一轮重新初始化）；
 * - 没有 `nextCursor` 且本页没有变更 → **水位不变**：游标语义是「已消费到 seq < N」，
 *   「本次没有下一轮」并不表示水位失效（若在这里清空，每轮同步都会白白重读一次快照）；
 * - 没有 `nextCursor` 但本页有变更（契约瑕疵）→ 用共享纯函数从最后一条的 `seq` 推进，
 *   绝不原地打转（否则每一轮都会把同一页重新投递一次）。
 */
function advanceSyncCursor(input: {
  readonly response: SyncChangesResponse;
  readonly requestSince: string;
  readonly requestSeq: number;
  readonly limit: number;
}): { readonly cursor: string | null; readonly invalid: boolean } {
  if (input.response.nextCursor !== null) {
    const decoded = decodeSyncCursor(input.response.nextCursor);
    return decoded.ok
      ? { cursor: encodeSyncCursor(decoded.seq), invalid: false }
      : { cursor: null, invalid: true };
  }
  const last = input.response.changes[input.response.changes.length - 1];
  if (last === undefined) {
    return { cursor: input.requestSince, invalid: false };
  }
  const advanced = nextSyncCursor({
    returned: input.response.changes.length,
    limit: input.limit,
    lastSeq: last.seq,
    requestSeq: input.requestSeq,
  });
  return { cursor: advanced.nextCursor, invalid: false };
}

/**
 * 变更轮询（HUB-051 客户端侧，导航与工作台布局共用）。
 *
 * 触发时机：**挂载**、**窗口获得焦点**、以及**固定间隔**。
 * 为什么必须有焦点触发：笔记本合盖、切走标签页之后定时器可能被节流甚至暂停，
 * 回到页面时如果只等下一次定时器，用户会看到过期数据任意长的时间。
 *
 * ── 初始化协议（第三轮复核修正的 P1：**禁止从零回放历史**）────────────────────
 * 变更流的 `payload` 是**当前**实体内容，日志条目却是**历史事件**，因此「拿 null 游标
 * 把整段历史按 seq 重放到一个已经是当前状态的本地副本上」是不成立的。反例：A 导入链接 →
 * 删除 → 显式恢复之后，历史里的那条 `delete`（payload=null）仍然存在，重放它会把本地一条
 * **已恢复**的链接删掉（成员关系一起丢），直到更靠后的恢复页才补回来。
 *
 * 因此首次同步（本地没有游标）严格按下面的顺序执行，任何一步都不能交换：
 *   ① 先发一次不带 `since` 的 `GET /me/sync/changes`；
 *   ② 收到 `resetRequired: true` → **不应用任何 changes**（此时应为空），把返回的
 *      `nextCursor` 作为**待用水位**先拿在手里，但**先不写进游标**；
 *   ③ 通过 `onSnapshotRequired` 读一次权威快照并**替换**本地状态；
 *   ④ 快照落地**之后**才把游标设为 ② 的水位，之后只用 `since` 取真实增量。
 * 这样被投递的每一条都发生在本地快照之后，按 seq 顺序应用自洽；快照与游标之间若发生新写入，
 * 增量里会再次出现该实体（upsert 幂等，不会回退）。
 *
 * 分页：发现 `hasMore === true` 就**立刻续取下一页**（不等下一个轮询间隔），直到排空；
 * `hasMore` 期间通过 `onDrainingChange` 明确告知调用方「正在同步」，后者据此禁止全局 CAS 写。
 *
 * 游标处理：`since` 是服务端给出的字符串；每轮用共享 `decodeSyncCursor` 校验
 * **再**用 `encodeSyncCursor` 编回去（往返一次，证明拿到的确实是本版本能理解的游标）。
 * 解析失败（损坏或来自更新的版本）时把游标清空，下一轮重新走一次初始化——
 * 这比「猜一个值继续增量」安全：漏掉的变更不会自己回来。
 * 服务端**拒绝**我们的游标（`422` + `details.reason`）时同样丢弃本地游标并重新初始化，
 * 但会额外给出一条可见提示（`onCursorReset`），不静默。
 */
export function useSyncChangesPoller(options: SyncChangesPollerOptions): SyncChangesPoller {
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const handlersRef = useRef({
    onChanges: options.onChanges,
    onError: options.onError,
    onCursorReset: options.onCursorReset,
    onSnapshotRequired: options.onSnapshotRequired,
    onDrainingChange: options.onDrainingChange,
  });
  const unauthorizedRef = useRef(options.onUnauthorized);

  useEffect(() => {
    handlersRef.current = {
      onChanges: options.onChanges,
      onError: options.onError,
      onCursorReset: options.onCursorReset,
      onSnapshotRequired: options.onSnapshotRequired,
      onDrainingChange: options.onDrainingChange,
    };
    unauthorizedRef.current = options.onUnauthorized;
  });

  const enabled = options.enabled;
  const limit = options.limit;
  const injectedApi = options.api;
  /**
   * 凭证读取器在**首次渲染时记录一次**。
   *
   * 为什么不用 ref 承载它：`createApiClient` 是在渲染期被调用的，把「读 ref 的函数」
   * 交给它会触发 `react-hooks/refs`（渲染期访问 ref 是不允许的）。
   * 这里记录的是**函数本身**而不是 Token：Token 依然只在发请求的那一刻被读取，
   * 因此凭证既不进 state 快照，也不进任何 props。调用方必须传引用稳定的回调
   * （应用层传的是 `useCallback` 包装的 `getToken`，测试里传的是固定替身）。
   */
  const [tokenGetter] = useState(() => options.getToken);

  const api = useMemo<SyncChangesApi | undefined>(() => {
    if (injectedApi !== undefined) {
      return injectedApi;
    }
    if (tokenGetter === undefined) {
      return undefined;
    }
    return createSyncChangesApi(createNavTransport({ getToken: () => tokenGetter() }));
  }, [injectedApi, tokenGetter]);

  const syncNow = useCallback(async (): Promise<void> => {
    if (!enabled || api === undefined || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    /**
     * 「正在排空」的可见状态：一旦收到 `hasMore === true` 就置位，排空 / 出错 / 重置时一律
     * 在 `finally` 里复位——界面绝不会因为一次中途失败的排空而永久禁用写入。
     */
    let draining = false;
    const setDraining = (next: boolean): void => {
      if (draining === next) {
        return;
      }
      draining = next;
      handlersRef.current.onDrainingChange?.(next);
    };
    try {
      let since = cursorRef.current;
      for (let page = 0; ; page += 1) {
        if (page >= SYNC_MAX_PAGES_PER_SYNC) {
          handlersRef.current.onError?.(
            `一次同步连续取回了 ${String(page)} 页仍未排空，已暂停本轮（游标已前移，下一轮从断点继续）。`,
          );
          return;
        }
        const result = await api.readChanges({ since, limit: limit ?? SYNC_DEFAULT_LIMIT });
        if (!result.ok) {
          if (result.error.code === 'unauthorized') {
            unauthorizedRef.current?.();
            return;
          }
          /**
           * 服务端拒绝本地游标（`422` + `details.reason`）：
           * 丢掉本地游标 → 下一轮重新走初始化（读权威快照 + 新水位）→ 给出可见提示。
           * 只认**结构化原因**（`parseSyncCursorFailure`），原因未知时按普通失败处理——
           * 绝不在不明原因时擅自丢弃水位。
           */
          const cursorFailure = result.status === 422 ? parseSyncCursorFailure(result.error.details) : null;
          if (cursorFailure !== null) {
            cursorRef.current = null;
            handlersRef.current.onCursorReset?.(describeSyncCursorReset(cursorFailure));
            return;
          }
          handlersRef.current.onError?.(`同步变更失败：${describeNavError(result.error)}`);
          return;
        }
        const parsed = syncChangesResponseSchema.safeParse(result.data);
        if (!parsed.success) {
          // 形状不符的响应一律不用：宁可不应用变更，也不用半可信数据改本地快照。
          handlersRef.current.onError?.('同步响应不符合契约，本轮结果已忽略。');
          return;
        }
        const response = parsed.data;

        if (response.resetRequired) {
          /**
           * 初始化（①②③④）：**不应用任何 changes**，先读权威快照，快照落地后才采用水位。
           * 注意顺序不能交换——若先写游标再读快照，快照可能落在水位**之前**，
           * 那段时间里的变更既不在快照里、也不会再被投递（永久丢失）。
           */
          const pending = normalizeSyncCursor(response.nextCursor);
          const readSnapshot = handlersRef.current.onSnapshotRequired;
          if (readSnapshot === undefined) {
            handlersRef.current.onError?.(
              '服务端要求先读取权威快照再增量，但当前上下文没有提供快照读取步骤，本轮结果已忽略。',
            );
            return;
          }
          if (pending === null) {
            handlersRef.current.onError?.(
              '服务端要求重建同步水位，但没有给出可用的水位游标，本轮未推进（下一轮会重新初始化）。',
            );
            return;
          }
          const landed = await readSnapshot(pending.seq);
          if (!landed) {
            handlersRef.current.onError?.(
              '读取权威快照失败，暂不推进同步水位（下一轮会重新初始化，绝不会在没有快照时应用历史变更）。',
            );
            return;
          }
          cursorRef.current = pending.cursor;
          since = pending.cursor;
          // 立刻用新水位取**真实增量**，而不是等下一个轮询间隔。
          continue;
        }

        /**
         * 没有可用游标却收到了变更：绝不应用。这是「禁止历史回放」的最后一道闸门——
         * 在没有权威快照的情况下把历史按 seq 重放，会误删已恢复的行。
         */
        if (since === null) {
          handlersRef.current.onError?.(
            '服务端在没有可用同步游标时返回了变更，本轮已忽略（不会在没有权威快照的情况下回放历史变更）。',
          );
          return;
        }
        const requestedSeq = decodeSyncCursor(since);
        if (!requestedSeq.ok) {
          handlersRef.current.onError?.(
            '本地的同步游标无法解析，本轮已忽略（不会在没有可用水位的情况下应用变更）。',
          );
          return;
        }

        const drained = !response.hasMore;
        setDraining(!drained);
        handlersRef.current.onChanges(response.changes, response.serverTimeMs, response.meta, drained);

        const advanced = advanceSyncCursor({
          response,
          requestSince: since,
          requestSeq: requestedSeq.seq,
          limit: limit ?? SYNC_DEFAULT_LIMIT,
        });
        cursorRef.current = advanced.cursor;
        if (advanced.invalid) {
          handlersRef.current.onCursorReset?.('同步游标不可用，下一轮将做一次完整同步。');
        }

        const nextSince = cursorRef.current;
        if (drained || nextSince === null) {
          // 排空完成，或游标已不可用（下一轮重新初始化，继续排空只会拿到空游标）。
          return;
        }
        since = nextSince;
      }
    } finally {
      setDraining(false);
      inFlightRef.current = false;
    }
  }, [api, enabled, limit]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // 挂载即同步一次：首屏数据可能是上次会话留下的（或干脆还没拉过）。
    void syncNow();
    const intervalMs = options.intervalMs ?? NAV_SYNC_DEFAULT_INTERVAL_MS;
    const timer =
      intervalMs > 0
        ? setInterval(() => {
            void syncNow();
          }, intervalMs)
        : null;
    const onFocus = (): void => {
      void syncNow();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
    }
    return () => {
      if (timer !== null) {
        clearInterval(timer);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
      }
    };
  }, [enabled, options.intervalMs, syncNow]);

  return { syncNow };
}

// ---------------------------------------------------------------------------
// 导入解析与结果文案（纯函数；界面与测试复用同一份判定）
// ---------------------------------------------------------------------------

const EMPTY_LOCAL_IMPORT = {
  items: [] as readonly NavImportItem[],
  skipped: [] as readonly NavImportSkipped[],
  document: null,
  summary: null,
  error: null,
} as const;

/**
 * 本地解析导入输入（**唯一入口**，用共享 `parseNavImportDocument` 判定类型）。
 *
 * 三种结果必须分开对待：
 * - `restore`：带 `schemaVersion` 的版本化配置 → 保留完整文档（分组 / 多对多 / 收藏 /
 *   状态 / 顺序都在里面），走 restore 预览与 apply；
 * - `links`：数组或 `{ links: [...] }` → 普通链接列表（逐项跳过原因照旧展示）；
 * - `error`：未来版本、引用不完整、危险 URL、非法 JSON → **明确展示原因**，
 *   绝不降级成「只取 links 数组」（那会静默丢掉分组与关系）。
 *
 * 书签 HTML 仍走共享 `parseBookmarkHtml`（只把 `<A HREF>` 与文件夹名当**数据**读）。
 */
export function parseLocalImport(input: {
  readonly kind: 'bookmarks' | 'json';
  readonly sourceName: string;
  readonly text: string;
}): NavLocalImport {
  if (input.kind === 'bookmarks') {
    const parsed = parseBookmarkHtml(input.text);
    return {
      ...EMPTY_LOCAL_IMPORT,
      kind: 'bookmarks',
      sourceName: input.sourceName,
      items: parsed.items,
      skipped: parsed.skipped,
    };
  }
  const parsed = parseNavImportDocument(input.text);
  if (parsed.kind === 'links') {
    return {
      ...EMPTY_LOCAL_IMPORT,
      kind: 'json',
      sourceName: input.sourceName,
      items: parsed.items,
      skipped: parsed.skipped,
    };
  }
  if (parsed.kind === 'restore') {
    return {
      ...EMPTY_LOCAL_IMPORT,
      kind: 'restore',
      sourceName: input.sourceName,
      document: parsed.document,
      summary: {
        schemaVersion: parsed.document.schemaVersion,
        exportedAt: parsed.document.exportedAt,
        linkCount: parsed.document.links.length,
        groupCount: parsed.document.groups.length,
        membershipCount: parsed.document.memberships.length,
      },
    };
  }
  return {
    ...EMPTY_LOCAL_IMPORT,
    kind: 'json',
    sourceName: input.sourceName,
    error: parsed.reason,
  };
}

/** 普通链接导入完成后的提示（数字全部来自服务端响应）。 */
export function describeLinkImportOutcome(data: {
  readonly importedCount: number;
  readonly skipped: readonly NavImportSkipped[];
}): string {
  return `导入完成：写入 ${String(data.importedCount)} 条，跳过 ${String(data.skipped.length)} 条。`;
}

/**
 * 完整配置恢复完成后的提示。
 *
 * 数字口径刻意分两层：
 * - 服务端给出 `importedGroups` / `importedMemberships` 时用**服务端权威值**；
 * - 否则退化为「按提交的文档计数」，并把口径写清楚（「配置含」），绝不把本地推断
 *   伪装成服务端事实。
 */
export function describeRestoreOutcome(
  data: NavImportApplyResponse,
  local: NavLocalImport,
): string {
  const groups = data.importedGroups;
  const memberships = data.importedMemberships;
  const detail =
    groups !== undefined && memberships !== undefined
      ? `，${String(groups)} 个分组，${String(memberships)} 条分组关系`
      : local.document === null
        ? ''
        : `（提交的配置含 ${String(local.document.groups.length)} 个分组 / ${String(local.document.memberships.length)} 条关系）`;
  return (
    `已恢复完整导航配置：写入 ${String(data.importedCount)} 条链接${detail}，` +
    `跳过 ${String(data.skipped.length)} 项。分组、多对多归属、收藏、状态与顺序都已按配置恢复。`
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNav(options: UseNavOptions): NavController {
  const [state, setState] = useState<NavState>(INITIAL_STATE);
  const [filter, setFilter] = useState<NavFilter>({});
  const [sort, setSortMode] = useState<NavSortMode>('manual');
  const [draft, setDraft] = useState<NavLinkDraft | null>(null);
  const [importTargetGroupId, setImportTargetGroup] = useState<string | null>(null);

  /**
   * 状态的**同步镜像**：异步动作必须在「刚刚写下的状态」之上继续计算，
   * 而 `setState` 的更新函数不能在事件回调里同步读取（与 `use-workbench` 同一理由）。
   */
  const ref = useRef<NavState>(INITIAL_STATE);
  const update = useCallback((mutate: (current: NavState) => NavState): void => {
    const next = mutate(ref.current);
    ref.current = next;
    setState(next);
  }, []);

  const draftRef = useRef<NavLinkDraft | null>(null);
  const setDraftState = useCallback((next: NavLinkDraft | null): void => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const mountedRef = useRef(true);
  const loadedRef = useRef(false);
  /** 凭证读取器：记录**函数本身**（Token 只在发请求时读取，绝不进 state / props）。 */
  const [tokenGetter] = useState(() => options.getToken);
  const unauthorizedRef = useRef(options.onUnauthorized);
  /**
   * 已见墓碑（`实体类型:实体ID` → 该实体被删除那一次的 `seq`）。
   *
   * 为什么必须**跨轮次**保留：一轮增量里先收到 delete、后收到一个 `seq` 更小的 upsert 时，
   * 只靠当轮数据无法判断「这是旧数据」；保留墓碑后，任何更旧的 upsert 都会被丢弃，
   * 因此不存在「删除过的行被后续合并加回来」的路径。
   *
   * 注意它存的是 **`seq`**（数据库单调变更序号），不是 `updatedAt`：同一毫秒内的
   * 「删除 → 恢复」只有 `seq` 能表达先后。
   */
  const tombstonesRef = useRef<Readonly<Record<string, number>>>({});

  /**
   * 每个实体已应用过的最大 `seq`（`实体类型:实体ID` → seq）。
   *
   * 与墓碑表的分工：墓碑表只回答「这个键是不是被删过、删在哪一号」，这张表回答
   * 「这个键的变更我消费到第几号了」——重复投递与乱序旧数据都由它拦下。
   */
  const appliedSeqRef = useRef<Readonly<Record<string, number>>>({});

  /**
   * **快照水位地板**：本地这份快照里已经包含了 `seq <= 地板` 的全部变更。
   *
   * 为什么必须有它（第三轮复核修正的 P1）：变更流的 `payload` 是**当前**实体内容，
   * 而日志条目是**历史事件**。因此任何 `seq <= 地板` 的变更都是「快照之前的历史」，
   * 把它重放到一份已经是当前状态的快照上只会造成错误——典型反例是
   * 「导入 → 删除 → 显式恢复」：历史里的 `delete`（`payload=null`）会把一条**已恢复**的
   * 链接删掉，成员关系一起丢，直到更靠后的恢复页才补回（甚至补不回）。
   *
   * 地板在**初始化流程**里、快照落地那一刻被抬到服务端给出的水位（只增不减）：
   *   没有游标 → `since` 缺省 → `resetRequired: true` + `nextCursor = v2:<当前水位>`
   *   → 读权威快照并替换本地状态 → 采用该水位。
   * 应用变更前先按它过滤，因此「从 null 回放整段历史」在结构上不可能发生。
   */
  const snapshotFloorRef = useRef(0);

  /**
   * 权威快照请求的**发起序号**与**最近一次落地序号**。
   *
   * 用途：快照是**整份替换**，因此「更早发起、更晚返回」的响应绝不能覆盖更新的那份
   * （挂载时的后台刷新与初始化流程的读取天然并发）。规则是单调的：一旦有更新发起的
   * 请求落地（`applied` 变大），更旧请求的结果就只用于回答「快照是否已可用」，
   * 不再写状态。
   */
  const snapshotRequestSeqRef = useRef(0);
  const snapshotAppliedSeqRef = useRef(0);

  /**
   * 为什么用 `useEffect`（而不是渲染期赋值）同步 ref：渲染期写 ref 在并发渲染下
   * 可能被丢弃或重复，`useEffect` 保证提交后才可见。
   */
  useEffect(() => {
    unauthorizedRef.current = options.onUnauthorized;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // 会话切换 / 卸载：此后所有在途响应都必须被丢弃。
      mountedRef.current = false;
    };
  }, []);

  /**
   * API 客户端在**每次请求时**才读取凭证（`tokenGetter`），因此旋转凭证后立刻生效，
   * 而 Token 本身不会出现在 state / props / URL 里（它只经由 Authorization 头出去）。
   */
  const api = useMemo<NavApi>(() => {
    if (options.api !== undefined) {
      return options.api;
    }
    const requester: NavRequester = createNavTransport({ getToken: () => tokenGetter() });
    return createNavApi(requester);
  }, [options.api, tokenGetter]);

  // -------------------------------------------------------------------------
  // 跨设备变更：应用远端变化，但**永不**动正在编辑的草稿
  // -------------------------------------------------------------------------

  const failureText = useCallback(
    (result: { readonly error: NavApiErrorInfo }, prefix: string): string => {
      if (result.error.code === 'unauthorized') {
        unauthorizedRef.current?.();
        return `${prefix}：凭证已失效，请重新输入设备凭证。`;
      }
      return `${prefix}：${describeNavError(result.error)}`;
    },
    [],
  );

  /**
   * 读一次**权威快照**并整份替换本地状态；返回 `true` 表示「已有一份不早于本轮水位的快照落地」。
   *
   * 两个调用方：挂载 / 写入后的普通刷新（不给水位），以及初始化协议的第 ③ 步（给出水位）。
   * 后者落地时把**快照水位地板**抬到该水位——地板是「禁止历史回放」的判据（见 `snapshotFloorRef`）。
   *
   * 并发处理：快照是整份替换，「更早发起、更晚返回」的响应绝不能覆盖更新的那份。
   * 因此给每次请求发一个**递增的发起序号**，并只允许不早于「已落地序号」的结果写状态；
   * 被更新的请求落地的旧结果只用于回答「快照是否可用」，不写状态、不报错（避免把界面标红）。
   */
  const readAuthoritativeSnapshot = useCallback(
    async (watermarkSeq?: number): Promise<boolean> => {
      const requestSeq = snapshotRequestSeqRef.current + 1;
      snapshotRequestSeqRef.current = requestSeq;
      const result = await api.readSnapshot();
      if (!mountedRef.current) {
        return false;
      }
      if (!result.ok) {
        if (requestSeq === snapshotRequestSeqRef.current) {
          update((current) => ({ ...current, status: 'error', error: failureText(result, '加载导航快照失败') }));
        }
        return false;
      }
      /**
       * 地板在**拿到快照之后**才抬高，而且只增不减。
       *
       * 为什么「被更新的请求取代」这一支也可以抬：任何 `applied` 更大的请求都是**更晚发起**的，
       * 而初始化流程的请求本身发在 `resetRequired` 之后，因此那份更新的快照不可能早于本轮水位
       * ——它至少同样新鲜。
       */
      if (watermarkSeq !== undefined) {
        snapshotFloorRef.current = Math.max(snapshotFloorRef.current, watermarkSeq);
      }
      if (requestSeq < snapshotAppliedSeqRef.current) {
        // 已有更新的快照落地：这份结果更旧，只回答「可用」，不覆盖状态。
        return true;
      }
      snapshotAppliedSeqRef.current = requestSeq;
      update((current) => ({ ...current, status: 'ready', snapshot: result.data, error: null }));
      return true;
    },
    [api, failureText, update],
  );

  /**
   * 把**一页**变更应用到给定快照上（纯判定 + 纯应用，本函数只负责把结果落到状态里）。
   *
   * 顺序刻意如此：
   * 0. 先用**快照水位地板**丢掉「快照之前的历史事件」（`seq <= 地板`）——变更流的 payload 是
   *    **当前**内容，重放历史会误删已恢复的行；这一步是 P1 修复的核心闸门；
   * 1. 再逐条判定（`resolveRemoteChange`）：与草稿冲突的**不进入应用集合**；
   * 2. 只对可应用的子集调用 `applyNavSyncChanges`（按 `seq` 升序 + 墓碑防复活）；
   * 3. 写状态：草稿内容一个字段都不会被改写，只置位「远端变了」的提示；
   * 4. **全局修订只认 `meta.navRevision`，且只在 `drained === true` 的那一页之后写入**。
   *    `hasMore === true` 期间 meta 对应的是服务端**当前**状态，而本地集合还不完整，
   *    拿它当 CAS 基数就是「按未来修订号批准基于部分旧集合的写入」。
   */
  const applyChangesTo = useCallback(
    (snapshot: NavSnapshot, changes: readonly SyncChange[], meta: SyncMeta | null, drained: boolean): void => {
      const floor = snapshotFloorRef.current;
      const fresh: SyncChange[] = [];
      let historyIgnored = 0;
      for (const change of changes) {
        if (change.seq <= floor) {
          historyIgnored += 1;
          continue;
        }
        fresh.push(change);
      }

      const draftNow = draftRef.current;
      const draftLinkId = draftNow !== null && draftNow.mode === 'edit' ? draftNow.linkId : null;

      const applicable: SyncChange[] = [];
      let conflictVerdict: RemoteChangeVerdict | null = null;
      for (const change of fresh) {
        const verdict = resolveRemoteChange({ change, draftLinkId });
        if (verdict.kind === 'ignore') {
          continue;
        }
        if (verdict.kind === 'draft_conflict') {
          conflictVerdict ??= verdict;
          continue;
        }
        applicable.push(change);
      }

      let remoteNotice: string | null = null;
      if (conflictVerdict !== null && draftLinkId !== null) {
        const ordered = projectNavLinks({
          links: snapshot.links,
          groups: snapshot.groups,
          memberships: snapshot.memberships,
          filter: { sort: 'manual' },
        });
        const index = ordered.findIndex((link) => link.id === draftLinkId);
        remoteNotice = describeRemoteDraftConflict({
          verdict: conflictVerdict,
          rowNumber: index < 0 ? null : index + 1,
          title: snapshot.links.find((link) => link.id === draftLinkId)?.title ?? null,
        });
      }

      /**
       * 权威全局修订（`meta.navRevision`）。三种情况保持原值：
       * `meta === null`（拿不到权威值 ≠ 权威值是 0）、`drained === false`（集合还不完整）、
       * 以及修订本来就没变（返回**原对象**，避免每轮同步都制造一次无谓的重渲染）。
       */
      const revisionFromMeta = meta === null || !drained ? null : meta.navRevision;
      const withRevision = (base: NavSnapshot): NavSnapshot =>
        revisionFromMeta === null || revisionFromMeta === base.revision
          ? base
          : { ...base, revision: revisionFromMeta };

      if (applicable.length === 0) {
        const currentSnapshot = ref.current.snapshot;
        const nextSnapshot = currentSnapshot === null ? null : withRevision(currentSnapshot);
        const revisionMoved = nextSnapshot !== null && nextSnapshot !== currentSnapshot;
        if (remoteNotice !== null || revisionMoved || historyIgnored > 0) {
          update((current) => ({
            ...current,
            snapshot: nextSnapshot ?? current.snapshot,
            draftRemoteNotice: remoteNotice ?? current.draftRemoteNotice,
            notice: historyIgnored > 0 ? describeHistoryIgnored(historyIgnored) : current.notice,
          }));
        }
        if (remoteNotice !== null) {
          const current = draftRef.current;
          if (current !== null) {
            // 只置位提示：草稿的 values 与 baseRevision 一个字节都不动。
            setDraftState({ ...current, conflicted: true });
          }
        }
        return;
      }

      const applied = applyNavSyncChanges({
        snapshot,
        changes: applicable,
        appliedSeq: appliedSeqRef.current,
        tombstones: tombstonesRef.current,
      });
      appliedSeqRef.current = applied.appliedSeq;
      tombstonesRef.current = applied.tombstones;
      update((current) => ({
        ...current,
        snapshot: withRevision(applied.snapshot),
        draftRemoteNotice: remoteNotice ?? current.draftRemoteNotice,
        notice:
          `已应用其它设备的 ${String(applicable.length)} 条导航变更` +
          (applied.ignored > 0 ? `（另有 ${String(applied.ignored)} 条因重复、形状不符或已删除被忽略）` : '') +
          (historyIgnored > 0 ? `。${describeHistoryIgnored(historyIgnored)}` : '。'),
      }));
      if (remoteNotice !== null) {
        const current = draftRef.current;
        if (current !== null) {
          // 只置位提示：草稿的 values 与 baseRevision 保持不变（保存仍然走 expectedRevision）。
          setDraftState({ ...current, conflicted: true });
        }
        update((state2) => ({ ...state2, draftRemoteNotice: remoteNotice }));
      }
    },
    [setDraftState, update],
  );

  const handleSyncChanges = useCallback(
    (changes: readonly SyncChange[], meta: SyncMeta | null, drained: boolean): void => {
      const snapshot = ref.current.snapshot;
      if (snapshot === null) {
        /**
         * 新协议下增量只会在**权威快照落地之后**到达（初始化流程保证：先 reset → 读快照 → 采用水位）。
         * 这里若没有快照，说明协议被破坏：绝不逐页应用历史，只给一条可见说明，
         * 下一轮同步会重新走初始化。早先的「先暂存、等快照到了再补应用」正是 P1 缺陷的入口——
         * 它等于「在没有快照的情况下把历史重放上去」，因此被删除。
         */
        update((current) => ({
          ...current,
          error:
            current.error ??
            '同步增量到达时还没有权威快照，本轮已忽略（不会在没有快照的情况下回放历史变更）。',
        }));
        return;
      }
      applyChangesTo(snapshot, changes, meta, drained);
    },
    [applyChangesTo, update],
  );

  const poller = useSyncChangesPoller({
    enabled: options.enabled,
    ...(options.syncApi === undefined ? {} : { api: options.syncApi }),
    getToken: options.getToken,
    ...(options.syncIntervalMs === undefined ? {} : { intervalMs: options.syncIntervalMs }),
    ...(options.syncLimit === undefined ? {} : { limit: options.syncLimit }),
    // 初始化协议第 ③ 步：只在这里读权威快照，并在快照落地那一刻抬高「水位地板」。
    onSnapshotRequired: (watermarkSeq) => readAuthoritativeSnapshot(watermarkSeq),
    onChanges: (changes, _serverTimeMs, meta, drained) => {
      // 只有**排空完成**（`hasMore === false`）才意味着同步机制已经恢复：清掉可恢复提示。
      if (drained) {
        update((current) => (current.syncNotice === null ? current : { ...current, syncNotice: null }));
      }
      handleSyncChanges(changes, meta, drained);
    },
    onDrainingChange: (draining) => {
      update((current) => ({
        ...current,
        syncing: draining,
        syncNotice: draining
          ? SYNC_DRAINING_NOTICE
          : current.syncNotice === SYNC_DRAINING_NOTICE
            ? null
            : current.syncNotice,
      }));
    },
    ...(options.onUnauthorized === undefined ? {} : { onUnauthorized: options.onUnauthorized }),
    onCursorReset: (message) => {
      // 可见提示（不静默）：游标已丢弃，下一轮重新走初始化（读权威快照 + 新水位）。
      update((current) => ({ ...current, syncNotice: message }));
    },
    onError: (message) => {
      // 同步失败**不**清空已有数据，也不显示成致命错误：它只是「这次没拿到增量」。
      update((current) => ({ ...current, error: current.error ?? message }));
    },
  });

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /**
   * 重新读一次权威快照（挂载、写入之后、用户点「重新加载」）。
   *
   * 为什么**不再**在这里补应用「快照还没到时先到达的增量」：那是 P1 缺陷的入口
   * （等于在没有快照的旧状态上逐页回放历史）。新协议把这件事交给初始化流程：
   * 增量只在快照落地之后才会被请求，因此不存在「先到一步」的增量。
   */
  const refresh = useCallback(async (): Promise<void> => {
    update((current) => ({
      ...current,
      // 已经渲染出内容后不回退到「加载中」：否则每次写入后的刷新都会让整页闪一下。
      status: current.snapshot === null ? 'loading' : current.status,
      error: null,
    }));
    await readAuthoritativeSnapshot();
  }, [readAuthoritativeSnapshot, update]);

  useEffect(() => {
    if (!options.enabled || loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    void refresh();
  }, [options.enabled, refresh]);

  const reload = useCallback(async (): Promise<void> => {
    await refresh();
  }, [refresh]);

  // -------------------------------------------------------------------------
  // 投影（唯一实现：共享纯函数）
  // -------------------------------------------------------------------------

  const effectiveFilter = useMemo<NavFilter>(() => ({ ...filter, sort }), [filter, sort]);

  const visibleLinks = useMemo<readonly NavLinkView[]>(() => {
    const snapshot = state.snapshot;
    if (snapshot === null) {
      return [];
    }
    // 这里没有任何本地筛选/排序规则：全部交给共享 `projectNavLinks`。
    return projectNavLinks({
      links: snapshot.links,
      groups: snapshot.groups,
      memberships: snapshot.memberships,
      filter: effectiveFilter,
    });
  }, [state.snapshot, effectiveFilter]);

  const activeGroups = useMemo<readonly NavGroup[]>(() => {
    const snapshot = state.snapshot;
    if (snapshot === null) {
      return [];
    }
    return [...snapshot.groups]
      .filter((group) => group.deletedAt === null)
      .sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id < b.id ? -1 : 1));
  }, [state.snapshot]);

  const catalogRows = useMemo<readonly NavCatalogRow[]>(() => {
    const entries = state.catalog;
    if (entries === null) {
      return [];
    }
    const links = state.snapshot?.links ?? [];
    /**
     * 目录状态 = **本地计算 + 服务端墓碑投影**，两者缺一不可：
     *
     * - 本地计算（`catalogUpgradePlan` on `snapshot.links`）永远是最新的：收藏、改名等操作会
     *   就地更新快照，因此状态能立刻跟着变；但它**看不到墓碑**（快照只含活跃行）。
     * - 服务端投影（`snapshot.catalogPlan`）含墓碑行，因此是 `tombstoned` 的唯一来源；
     *   代价是它随快照响应一起冻结，本地乐观更新之后可能暂时过期。
     *
     * 因此只在「本地判为 new（没导入过）而服务端说 tombstoned」时采用服务端结论——
     * 其余状态一律以本地为准。这样既不会把「你删除过」显示成「尚未导入」（复核缺陷 #3），
     * 也不会因为投影过期而把刚改过的条目显示回 unchanged（端到端验收发现的回归）。
     */
    const localPlan = catalogUpgradePlan({ catalog: entries, links });
    const serverPlan = new Map(
      (state.snapshot?.catalogPlan ?? []).map((item) => [item.catalogId, item] as const),
    );
    const plan = localPlan.map((item) => {
      const server = serverPlan.get(item.catalogId);
      return server?.state === 'tombstoned' && item.state === 'new'
        ? { ...item, state: 'tombstoned' as const, linkId: server.linkId }
        : item;
    });
    const planByCatalogId = new Map(plan.map((item) => [item.catalogId, item] as const));
    return entries.map((entry) => {
      const resolved = planByCatalogId.get(entry.id);
      const link = links.find((candidate) => candidate.sourceCatalogId === entry.id);
      const entryState: NavCatalogEntryState =
        resolved?.state ?? navCatalogEntryState({ entry, link: link ?? undefined });
      const decision = decideCatalogImport({ state: entryState });
      return {
        entry,
        state: entryState,
        linkId: resolved?.linkId ?? null,
        defaultAction: decision.action,
        defaultActionReason: decision.reason,
        // 墓碑与「用户改过」的条目**默认不勾选**：默认勾选等于把「复活 / 覆盖」
        // 变成一次误点的后果（ADR-0004 D1）。
        selectable: entryState === 'new' || entryState === 'unchanged',
      };
    });
  }, [state.catalog, state.snapshot]);

  // -------------------------------------------------------------------------
  // 远程变化 vs 编辑中草稿：保留草稿并提示冲突
  // -------------------------------------------------------------------------

  /**
   * 编辑中的草稿只关心**自己那一行**是否在远端变过（服务端 CAS 用的就是行修订）。
   *
   * 为什么不用工作空间修订：它每次任意写入都会 +1，于是「别人改了别的链接」也会把自己
   * 这个草稿标成冲突——提示会变成噪音；反过来行修订能精确指出「你正在编辑的这条被动过」。
   * `-1` 表示该行已经不在快照里（被其他设备删除了），同样算冲突。
   */
  const remoteRowRevision = useMemo((): number | null => {
    const current = draft;
    if (current === null || current.mode !== 'edit' || current.linkId === null) {
      return null;
    }
    const snapshot = state.snapshot;
    if (snapshot === null) {
      return null;
    }
    const row = snapshot.links.find((candidate) => candidate.id === current.linkId);
    return row === undefined ? -1 : row.revision;
  }, [draft, state.snapshot]);

  useEffect(() => {
    const current = draftRef.current;
    if (remoteRowRevision === null || current === null || current.conflicted) {
      return;
    }
    if (remoteRowRevision === current.baseRevision) {
      return;
    }
    // 只置位提示位：**不**触碰 values，也**不**改写 baseRevision。
    // 「后台刷新静默覆盖草稿」在这里被结构性地排除——刷新只写 snapshot。
    setDraftState({ ...current, conflicted: true, serverRevision: remoteRowRevision });
  }, [remoteRowRevision, setDraftState]);

  const acknowledgeConflict = useCallback((): void => {
    const current = draftRef.current;
    if (current === null) {
      return;
    }
    // 用户明确选择「基于最新修订保存」：把基数抬到**该行当前的行修订**。
    // 这是**用户显式动作**的结果，不是自动覆盖。
    const linkId = current.linkId;
    const row =
      linkId === null ? undefined : ref.current.snapshot?.links.find((candidate) => candidate.id === linkId);
    setDraftState({
      ...current,
      conflicted: false,
      baseRevision: row?.revision ?? current.baseRevision,
      serverRevision: null,
    });
  }, [setDraftState]);

  // -------------------------------------------------------------------------
  // 草稿动作
  // -------------------------------------------------------------------------

  const startCreateLink = useCallback(
    (presetGroupId?: string | null): void => {
      setDraftState({
        mode: 'create',
        linkId: null,
        values: emptyLinkForm(presetGroupId),
        baseRevision: ref.current.snapshot?.revision ?? 0,
        conflicted: false,
        serverRevision: null,
      });
    },
    [setDraftState],
  );

  const startEditLink = useCallback(
    (linkId: string): void => {
      const snapshot = ref.current.snapshot;
      const link = snapshot?.links.find((candidate) => candidate.id === linkId);
      if (snapshot === null || link === undefined) {
        update((current) => ({ ...current, error: '该链接已不存在（可能已被其他设备删除）。' }));
        return;
      }
      const groupIds = snapshot.memberships
        .filter((membership) => membership.linkId === linkId && membership.deletedAt === null)
        .map((membership) => membership.groupId);
      setDraftState({
        mode: 'edit',
        linkId,
        values: formOfLink(link, groupIds),
        // 行修订（不是工作空间修订）：服务端的 CAS 比较的就是它。
        baseRevision: link.revision,
        conflicted: false,
        serverRevision: null,
      });
    },
    [setDraftState, update],
  );

  const updateDraft = useCallback(
    (patch: Partial<NavLinkFormValues>): void => {
      const current = draftRef.current;
      if (current === null) {
        return;
      }
      setDraftState({ ...current, values: { ...current.values, ...patch } });
    },
    [setDraftState],
  );

  const cancelDraft = useCallback((): void => {
    setDraftState(null);
  }, [setDraftState]);

  const discardImportPreview = useCallback((): void => {
    update((current) => ({ ...current, importPreview: null, localImport: null }));
  }, [update]);

  // -------------------------------------------------------------------------
  // 写操作骨架：乐观更新 + 失败回滚 + 409 结构化冲突
  // -------------------------------------------------------------------------

  const write = useCallback(
    async <T,>(input: {
      readonly prefix: string;
      readonly optimistic?: (current: NavSnapshot) => NavSnapshot | null;
      readonly run: () => Promise<NavResult<T>>;
      readonly onSuccess?: (data: T) => void;
    }): Promise<T | null> => {
      const before = ref.current.snapshot;
      if (input.optimistic !== undefined && before !== null) {
        const next = input.optimistic(before);
        if (next !== null) {
          update((current) => ({ ...current, snapshot: next, error: null }));
        }
      }
      update((current) => ({ ...current, busy: true, error: null }));
      const result = await input.run();
      if (!mountedRef.current) {
        return null;
      }
      update((current) => ({ ...current, busy: false }));
      if (!result.ok) {
        // 传输层已经把 details.conflict 解析好了（解析不出来时是 null，绝不猜）。
        const conflict = result.error.code === 'conflict' ? result.error.conflict : null;
        update((current) => ({
          ...current,
          // 回滚到操作前的**同一个对象引用**：界面立刻回到事实状态，不需要重新拉取。
          snapshot: before ?? current.snapshot,
          error: `${input.prefix}：${describeNavError(result.error)}`,
          conflict:
            result.error.code === 'conflict'
              ? { code: result.error.code, message: result.error.message, conflict }
              : current.conflict,
        }));
        return null;
      }
      update((current) => ({ ...current, conflict: null }));
      input.onSuccess?.(result.data);
      return result.data;
    },
    [update],
  );

  /**
   * 就地替换一条链接（保留其余行的引用）。
   *
   * 刻意**不**碰 `snapshot.revision`：行修订不能推导工作空间修订（复核发现的真实缺陷），
   * 全局修订由紧随其后的 `refresh()`（服务端权威快照）或写响应里的 `revision` 给出。
   */
  const replaceLink = useCallback(
    (snapshot: NavSnapshot, link: NavLink): NavSnapshot => ({
      ...snapshot,
      links: snapshot.links.map((candidate) => (candidate.id === link.id ? link : candidate)),
    }),
    [],
  );

  /** 用写响应里**服务端给出的**工作空间修订更新快照（绝不本地推算）。 */
  const adoptRevision = useCallback(
    (revision: number): void => {
      update((current) =>
        current.snapshot === null ? current : { ...current, snapshot: { ...current.snapshot, revision } },
      );
    },
    [update],
  );

  /**
   * 排空期间的**全局 CAS 写**闸门：拒绝提交并给出「正在同步」的可见提示。
   *
   * 为什么只拦这一类（重排 / 目录导入 / 导入 apply）：它们提交的是**工作空间级**
   * `expectedRevision`，语义是「基于我看到的整份集合」。`hasMore === true` 时本地集合
   * 还不完整，此时提交等于用部分旧集合覆盖服务端；而服务端 `meta.navRevision` 也不能拿来当
   * 基数（那是**未来**的全局值）。行级写（编辑 / 删除 / 收藏）用的是**行修订**，与集合完整性
   * 无关，因此不受此闸门影响。
   *
   * 返回 `true` 表示「已拒绝」——调用方必须立刻返回，什么都不发。
   */
  const rejectWriteWhileSyncing = useCallback((): boolean => {
    if (!ref.current.syncing) {
      return false;
    }
    update((current) => ({ ...current, notice: SYNC_DRAINING_NOTICE }));
    return true;
  }, [update]);

  // -------------------------------------------------------------------------
  // 链接 CRUD
  // -------------------------------------------------------------------------

  const createLink = useCallback(async (): Promise<void> => {
    const current = draftRef.current;
    if (current === null || current.mode !== 'create') {
      return;
    }
    const values = current.values;
    const urlError = localUrlError(values.url);
    if (urlError !== null) {
      // 就地报错，**不发任何请求**。
      update((state2) => ({ ...state2, error: `链接地址不可用：${urlError}`, notice: null }));
      return;
    }
    const created = await write<{ link: NavLink }>({
      prefix: '新建链接失败',
      run: () =>
        api.createLink({
          operationId: newOperationId(),
          title: values.title,
          url: values.url,
          description: values.description,
          tags: splitTagInput(values.tags),
          aliases: splitTagInput(values.aliases),
          icon: values.icon,
          openMode: values.openMode,
          region: values.region,
          status: values.status,
          isFavorite: values.isFavorite,
          ...(values.groupIds.length === 0 ? {} : { groupIds: [...values.groupIds] }),
        }),
      onSuccess: () => {
        setDraftState(null);
        update((state2) => ({ ...state2, notice: `已新建链接「${values.title}」。` }));
      },
    });
    if (created === null) {
      // 失败时草稿保留（`draftRef` 未被清理），用户可以就地修正后重试。
      return;
    }
    // 成员关系与分组名由服务端权威给出（可能复用了同名分组），因此写成功后刷新一次快照。
    await refresh();
  }, [api, refresh, setDraftState, update, write]);

  const updateLink = useCallback(async (): Promise<void> => {
    const current = draftRef.current;
    if (current === null || current.mode !== 'edit' || current.linkId === null) {
      return;
    }
    const values = current.values;
    const linkId = current.linkId;
    const urlError = localUrlError(values.url);
    if (urlError !== null) {
      update((state2) => ({ ...state2, error: `链接地址不可用：${urlError}`, notice: null }));
      return;
    }
    const updated = await write<{ link: NavLink }>({
      prefix: '保存链接失败',
      run: () =>
        api.updateLink(linkId, {
          operationId: newOperationId(),
          // 提交的是**用户开始编辑时看到的**修订：服务端据此判断是否真并发。
          expectedRevision: current.baseRevision,
          title: values.title,
          url: values.url,
          description: values.description,
          tags: splitTagInput(values.tags),
          aliases: splitTagInput(values.aliases),
          icon: values.icon,
          openMode: values.openMode,
          region: values.region,
          status: values.status,
          isFavorite: values.isFavorite,
          groupIds: [...values.groupIds],
        }),
      onSuccess: (data) => {
        const snapshot = ref.current.snapshot;
        if (snapshot !== null) {
          update((state2) => ({ ...state2, snapshot: replaceLink(snapshot, data.link) }));
        }
        setDraftState(null);
        update((state2) => ({ ...state2, notice: `已保存「${data.link.title}」。` }));
      },
    });
    if (updated === null) {
      return;
    }
    await refresh();
  }, [api, refresh, replaceLink, setDraftState, update, write]);

  const deleteLink = useCallback(
    async (linkId: string): Promise<void> => {
      const snapshot = ref.current.snapshot;
      const link = snapshot?.links.find((candidate) => candidate.id === linkId);
      if (snapshot === null || link === undefined) {
        return;
      }
      const deleted = await write<{ deletedId: string; revision: number }>({
        prefix: '删除链接失败',
        optimistic: (current) => ({
          ...current,
          /**
           * 本地按**墓碑**处理（`deletedAt` 非空），而不是把行从数组里拿掉：
           * 共享投影函数据此排除它，同时「我删的是哪一行」在快照里仍然可见，
           * 这与服务端的删除语义（墓碑，不物理删除）保持一致。
           *
           * 刻意**不**在这里动 `current.revision`：乐观阶段无从得知新的工作空间修订，
           * 服务端会在响应里给出权威值（`data.revision`）。
           */
          links: current.links.map((candidate) =>
            candidate.id === linkId
              ? { ...candidate, deletedAt: Date.now(), revision: candidate.revision + 1 }
              : candidate,
          ),
        }),
        run: () => api.deleteLink(linkId, { operationId: newOperationId(), expectedRevision: link.revision }),
        onSuccess: (data) => {
          adoptRevision(data.revision);
          update((state2) => ({ ...state2, lastDeletedLinkId: data.deletedId, notice: `已删除「${link.title}」。` }));
        },
      });
      if (deleted !== null) {
        await refresh();
      }
    },
    [adoptRevision, api, refresh, update, write],
  );

  const toggleFavorite = useCallback(
    async (linkId: string): Promise<void> => {
      const snapshot = ref.current.snapshot;
      const link = snapshot?.links.find((candidate) => candidate.id === linkId);
      if (snapshot === null || link === undefined) {
        return;
      }
      const nextFavorite = !link.isFavorite;
      const updated = await write<{ link: NavLink }>({
        prefix: '切换收藏失败',
        optimistic: (current) => ({
          ...current,
          links: current.links.map((candidate) =>
            candidate.id === linkId
              ? { ...candidate, isFavorite: nextFavorite, revision: candidate.revision + 1 }
              : candidate,
          ),
        }),
        run: () =>
          api.updateLink(linkId, {
            operationId: newOperationId(),
            expectedRevision: link.revision,
            isFavorite: nextFavorite,
          }),
        onSuccess: (data) => {
          const latest = ref.current.snapshot;
          if (latest !== null) {
            // 服务端返回的行是权威值，就用它替换乐观值（不自己做加法，避免与服务端漂移）。
            update((state2) => ({ ...state2, snapshot: replaceLink(latest, data.link) }));
          }
        },
      });
      if (updated !== null) {
        // 行级写响应不带工作空间修订，因此刷新一次拿权威快照（否则下一次重排会 409）。
        await refresh();
      }
    },
    [api, refresh, replaceLink, update, write],
  );

  /**
   * 个人排序（上下移动一格）。
   *
   * 发送**全部**活跃链接的期望顺序：共享契约 `reorderNavLinksRequestSchema` 是整体替换，
   * 这样「部分重排」的歧义不存在。顺序基于当前快照的 `manual` 排序（共享纯函数），
   * 因此与服务端理解完全一致。
   *
   * `expectedRevision` 用的是**快照里的工作空间修订**——它只由服务端 `meta.navRevision`
   * 或服务端写响应给出，绝不是从行修订推导出来的（复核缺陷 P1-2 的修复点）。
   */
  const moveLink = useCallback(
    async (linkId: string, direction: -1 | 1): Promise<void> => {
      // 排空期间禁止全局 CAS 写（见 `rejectWriteWhileSyncing`）：绝不静默用旧/新修订提交。
      if (rejectWriteWhileSyncing()) {
        return;
      }
      const snapshot = ref.current.snapshot;
      if (snapshot === null) {
        return;
      }
      const ordered = projectNavLinks({
        links: snapshot.links,
        groups: snapshot.groups,
        memberships: snapshot.memberships,
        filter: { sort: 'manual' },
      });
      const index = ordered.findIndex((link) => link.id === linkId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) {
        return;
      }
      const ids = ordered.map((link) => link.id);
      const moved = ids[index];
      const swapped = ids[target];
      if (moved === undefined || swapped === undefined) {
        return;
      }
      ids[index] = swapped;
      ids[target] = moved;
      await write<{ revision: number }>({
        prefix: '调整顺序失败',
        optimistic: (current) => ({
          ...current,
          links: current.links.map((candidate) => {
            const position = ids.indexOf(candidate.id);
            return position < 0 ? candidate : { ...candidate, sortOrder: position };
          }),
        }),
        run: () =>
          api.reorderLinks({
            operationId: newOperationId(),
            orderedIds: ids,
            expectedRevision: snapshot.revision,
          }),
        // 服务端写响应里的工作空间修订是权威值，直接采用（下一次重排就不会 409）。
        onSuccess: (data) => {
          adoptRevision(data.revision);
        },
      });
    },
    [adoptRevision, api, rejectWriteWhileSyncing, write],
  );

  // -------------------------------------------------------------------------
  // 分组
  // -------------------------------------------------------------------------

  const createGroup = useCallback(
    async (name: string): Promise<void> => {
      const created = await write<NavGroup>({
        prefix: '新建分组失败',
        run: () =>
          api.createGroup({
            operationId: newOperationId(),
            name,
            sortOrder: activeGroups.length,
          }),
        onSuccess: (group) => update((state2) => ({ ...state2, notice: `已新建分组「${group.name}」。` })),
      });
      if (created !== null) {
        await refresh();
      }
    },
    [activeGroups.length, api, refresh, update, write],
  );

  const renameGroup = useCallback(
    async (groupId: string, name: string): Promise<void> => {
      const group = ref.current.snapshot?.groups.find((candidate) => candidate.id === groupId);
      if (group === undefined) {
        return;
      }
      const renamed = await write<NavGroup>({
        prefix: '重命名分组失败',
        optimistic: (current) => ({
          ...current,
          groups: current.groups.map((candidate) =>
            candidate.id === groupId ? { ...candidate, name, revision: candidate.revision + 1 } : candidate,
          ),
        }),
        run: () =>
          api.updateGroup(groupId, {
            operationId: newOperationId(),
            expectedRevision: group.revision,
            name,
          }),
        onSuccess: (updated) => {
          const snapshot = ref.current.snapshot;
          if (snapshot === null) {
            return;
          }
          update((state2) => ({
            ...state2,
            snapshot: {
              ...snapshot,
              groups: snapshot.groups.map((item) => (item.id === updated.id ? updated : item)),
            },
          }));
        },
      });
      if (renamed !== null) {
        // 更新分组的响应只有行本身，不带工作空间修订；刷新一次拿权威修订与行版本。
        await refresh();
      }
    },
    [api, refresh, update, write],
  );

  const deleteGroup = useCallback(
    async (groupId: string): Promise<void> => {
      const group = ref.current.snapshot?.groups.find((candidate) => candidate.id === groupId);
      if (group === undefined) {
        return;
      }
      const deleted = await write<{ deletedId: string; revision: number }>({
        prefix: '删除分组失败',
        optimistic: (current) => ({
          ...current,
          groups: current.groups.map((candidate) =>
            candidate.id === groupId
              ? { ...candidate, deletedAt: Date.now(), revision: candidate.revision + 1 }
              : candidate,
          ),
        }),
        run: () => api.deleteGroup(groupId, { operationId: newOperationId(), expectedRevision: group.revision }),
        onSuccess: (data) => {
          // 写响应里的工作空间修订是权威值（绝不从行修订推）。
          adoptRevision(data.revision);
          update((state2) => ({ ...state2, notice: `已删除分组「${group.name}」（链接本身保留）。` }));
        },
      });
      if (deleted !== null) {
        // 成员关系由服务端一并处理，因此刷新一次拿到权威的归属结果。
        await refresh();
      }
    },
    [adoptRevision, api, refresh, update, write],
  );

  const moveGroup = useCallback(
    async (groupId: string, direction: -1 | 1): Promise<void> => {
      // 排空期间禁止全局 CAS 写：分组顺序同样是整体替换，必须基于完整集合。
      if (rejectWriteWhileSyncing()) {
        return;
      }
      const snapshot = ref.current.snapshot;
      if (snapshot === null) {
        return;
      }
      const ids = activeGroups.map((group) => group.id);
      const index = ids.indexOf(groupId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ids.length) {
        return;
      }
      const moved = ids[index];
      const swapped = ids[target];
      if (moved === undefined || swapped === undefined) {
        return;
      }
      ids[index] = swapped;
      ids[target] = moved;
      await write<{ revision: number }>({
        prefix: '调整分组顺序失败',
        optimistic: (current) => ({
          ...current,
          groups: current.groups.map((candidate) => {
            const position = ids.indexOf(candidate.id);
            return position < 0 ? candidate : { ...candidate, sortOrder: position };
          }),
        }),
        run: () =>
          api.reorderGroups({
            operationId: newOperationId(),
            orderedIds: ids,
            expectedRevision: snapshot.revision,
          }),
        onSuccess: (data) => {
          adoptRevision(data.revision);
        },
      });
    },
    [activeGroups, adoptRevision, api, rejectWriteWhileSyncing, write],
  );

  // -------------------------------------------------------------------------
  // 推荐目录
  // -------------------------------------------------------------------------

  const loadCatalog = useCallback(async (): Promise<void> => {
    update((current) => ({ ...current, catalogError: null }));
    const result = await api.readCatalog();
    if (!mountedRef.current) {
      return;
    }
    if (!result.ok) {
      update((current) => ({ ...current, catalogError: failureText(result, '加载推荐目录失败') }));
      return;
    }
    update((current) => ({
      ...current,
      catalog: result.data.entries,
      catalogError: null,
    }));
  }, [api, failureText, update]);

  const importCatalog = useCallback(
    async (input: {
      readonly catalogIds: readonly string[];
      readonly explicitReimport: boolean;
      readonly overwriteUserEdits: boolean;
    }): Promise<void> => {
      if (input.catalogIds.length === 0) {
        update((current) => ({ ...current, error: '请先勾选要导入的目录条目。' }));
        return;
      }
      // 排空期间禁止全局 CAS 写（目录导入会整体改动集合与顺序）。
      if (rejectWriteWhileSyncing()) {
        return;
      }
      const done = await write<{
        importedCount: number;
        restoredLinkIds: readonly string[];
        skippedCatalogIds: readonly string[];
      }>({
        prefix: '目录导入失败',
        run: () =>
          api.importCatalog({
            operationId: newOperationId(),
            catalogIds: [...input.catalogIds],
            explicitReimport: input.explicitReimport,
            overwriteUserEdits: input.overwriteUserEdits,
          }),
        onSuccess: (data) =>
          update((state2) => ({
            ...state2,
            notice:
              `目录导入完成：新增/更新 ${String(data.importedCount)} 条` +
              (data.restoredLinkIds.length > 0
                ? `，其中恢复了 ${String(data.restoredLinkIds.length)} 条你删除过的条目`
                : '') +
              (data.skippedCatalogIds.length > 0
                ? `；${String(data.skippedCatalogIds.length)} 条因「已被你修改」未覆盖`
                : ''),
          })),
      });
      if (done !== null) {
        await refresh();
        await loadCatalog();
      }
    },
    [api, loadCatalog, refresh, rejectWriteWhileSyncing, update, write],
  );

  // -------------------------------------------------------------------------
  // 通用导入（书签 HTML / 链接 JSON / 恢复完整配置）
  // -------------------------------------------------------------------------

  const previewLocalImport = useCallback(
    (input: { readonly kind: 'bookmarks' | 'json'; readonly sourceName: string; readonly text: string }): void => {
      update((current) => ({
        ...current,
        localImport: parseLocalImport(input),
        // 换了文件/文本 = 上一次的预览已经不代表用户确认过的内容。
        importPreview: null,
        error: null,
      }));
    },
    [update],
  );

  const clearLocalImport = useCallback((): void => {
    update((current) => ({ ...current, localImport: null, importPreview: null }));
  }, [update]);

  /**
   * 提交服务端预览。
   *
   * 两种模式**绝不能混**（复核发现的真实缺陷）：
   * - `links`：提交客户端解析出的 `items` / `skipped`（服务端会重新校验）；
   * - `restore`：提交**原样**的版本化文档（含 groups 与 memberships），**不**提交 items——
   *   否则分组、多对多归属、收藏、状态与顺序会被静默丢掉。
   *
   * 本地解析失败（未来版本 / 引用不完整 / 危险 URL / 非法 JSON）时**不发任何请求**。
   */
  const previewImport = useCallback(async (): Promise<void> => {
    const current = ref.current;
    const local = current.localImport;
    if (local === null || local.error !== null || current.snapshot === null) {
      return;
    }
    update((state2) => ({ ...state2, busy: true, error: null }));
    const result =
      local.kind === 'restore' && local.document !== null
        ? await api.previewImport({ mode: 'restore', document: local.document })
        : await api.previewImport({
            mode: 'links',
            items: [...local.items],
            skipped: [...local.skipped],
            ...(importTargetGroupId === null ? {} : { targetGroupId: importTargetGroupId }),
          });
    if (!mountedRef.current) {
      return;
    }
    update((state2) => ({ ...state2, busy: false }));
    if (!result.ok) {
      update((state2) => ({ ...state2, error: failureText(result, '导入预览失败') }));
      return;
    }
    update((state2) => ({
      ...state2,
      importPreview: {
        preview: result.data,
        // 记录**预览时**的修订（服务端回传的权威值）：apply 必须回显它，
        // 服务端据此拒绝按旧预览覆盖。这里不做任何本地推算。
        expectedRevision: result.data.revision,
        source: local,
        targetGroupId: local.kind === 'restore' ? null : importTargetGroupId,
      },
    }));
  }, [api, failureText, importTargetGroupId, update]);

  const applyImport = useCallback(async (): Promise<void> => {
    const preview = ref.current.importPreview;
    if (preview === null) {
      return;
    }
    // 排空期间禁止导入落地：`expectedRevision` 语义上基于整份集合，此时本地集合还不完整。
    if (rejectWriteWhileSyncing()) {
      return;
    }
    const local = preview.source;
    const isRestore = local.kind === 'restore' && local.document !== null;
    const applied = await write<NavImportApplyResponse>({
      prefix: isRestore ? '恢复完整配置失败' : '导入失败',
      run: () =>
        isRestore
          ? api.applyImport({
              operationId: newOperationId(),
              mode: 'restore',
              document: local.document,
              expectedRevision: preview.expectedRevision,
            })
          : api.applyImport({
              operationId: newOperationId(),
              mode: 'links',
              items: [...preview.preview.items],
              ...(preview.targetGroupId === null ? {} : { targetGroupId: preview.targetGroupId }),
              expectedRevision: preview.expectedRevision,
            }),
      onSuccess: (data) =>
        update((state2) => ({
          ...state2,
          importPreview: null,
          localImport: null,
          notice: isRestore ? describeRestoreOutcome(data, local) : describeLinkImportOutcome(data),
        })),
    });
    if (applied !== null) {
      // 恢复会改动分组与成员关系，因此刷新一次拿到权威快照（本地不做任何推断）。
      await refresh();
    }
  }, [api, refresh, rejectWriteWhileSyncing, update, write]);

  // -------------------------------------------------------------------------
  // 导出与读回校验
  // -------------------------------------------------------------------------

  const exportDocument = useCallback(async (): Promise<void> => {
    if (ref.current.snapshot === null) {
      return;
    }
    update((current) => ({ ...current, busy: true, error: null, exportNotice: null }));
    const result = await api.exportDocument();
    if (!mountedRef.current) {
      return;
    }
    update((current) => ({ ...current, busy: false }));
    if (!result.ok) {
      update((current) => ({ ...current, error: failureText(result, '导出失败') }));
      return;
    }
    const text = JSON.stringify(result.data.document, null, 2);
    // 人眼可核对的只读回显与真实下载同时存在：前者便于断言，后者是用户要的文件。
    update((current) => ({
      ...current,
      exportedJson: text,
      exportNotice:
        `已导出 ${String(result.data.document.links.length)} 条链接 / ` +
        `${String(result.data.document.groups.length)} 个分组` +
        `（schemaVersion ${String(result.data.document.schemaVersion)}），不含任何凭证。`,
    }));
    triggerDownload(text);
  }, [api, failureText, update]);

  const readBackExport = useCallback(
    (text: string): void => {
      const parsed = parseNavExportDocument(text);
      if (!parsed.ok) {
        update((current) => ({ ...current, exportReadBack: `读回失败：${parsed.reason}`, error: null }));
        return;
      }
      const document = parsed.document;
      // 用共享构造函数重建一次文档，证明「导出 → 读回 → 再序列化」往返稳定。
      const rebuilt = buildNavExportDocument({
        links: document.links,
        groups: document.groups,
        memberships: document.memberships,
        catalogSourceVersion: document.catalogSourceVersion,
        exportedAt: document.exportedAt,
      });
      update((current) => ({
        ...current,
        exportReadBack:
          `读回成功：schemaVersion ${String(document.schemaVersion)} · 链接 ${String(document.links.length)} 条 · ` +
          `分组 ${String(document.groups.length)} 个 · 成员关系 ${String(document.memberships.length)} 条 · ` +
          `再次序列化${JSON.stringify(rebuilt) === JSON.stringify(document) ? '完全一致（往返稳定）' : '存在差异'}`,
      }));
    },
    [update],
  );

  // -------------------------------------------------------------------------
  // 过滤与提示
  // -------------------------------------------------------------------------

  const patchFilter = useCallback((patch: Partial<NavFilter>): void => {
    setFilter((current) => {
      const next: NavFilter = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete next[key as keyof NavFilter];
        } else {
          Object.assign(next, { [key]: value });
        }
      }
      return next;
    });
  }, []);

  const setNotice = useCallback(
    (notice: string | null): void => {
      update((current) => ({ ...current, notice }));
    },
    [update],
  );

  return {
    ...state,
    visibleLinks,
    activeGroups,
    filter: effectiveFilter,
    sort,
    draft,
    catalogRows,
    importTargetGroupId,
    reload,
    syncNow: poller.syncNow,
    setNotice,
    patchFilter,
    setSort: setSortMode,
    startCreateLink,
    startEditLink,
    updateDraft,
    cancelDraft,
    acknowledgeConflict,
    createLink,
    updateLink,
    deleteLink,
    toggleFavorite,
    moveLink,
    createGroup,
    renameGroup,
    deleteGroup,
    moveGroup,
    loadCatalog,
    importCatalog,
    previewLocalImport,
    clearLocalImport,
    setImportTargetGroup,
    previewImport,
    applyImport,
    discardImportPreview,
    exportDocument,
    readBackExport,
  };
}
