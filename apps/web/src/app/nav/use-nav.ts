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
 * ── 跨设备同步：日志只作失效信号，状态只由原子快照发布（第四轮复核收口）──────────
 * A. **绝不把变更逐条应用到本地状态**。变更流的 `payload` 是**当前**实体内容，而日志条目是
 *    **历史事件**：「导入 → 删除 → 显式恢复」之后重放那条历史 `delete` 会把已恢复的链接
 *    连同成员关系一起删掉。本文件因此**没有**「按 seq 回放」这条路径（它已被删除）。
 * B. **竞态 A 的收口**：先前「先用 `reset` 拿水位 W，再单独读快照 S」的写法在
 *    「删除(W+1) → 恢复(W+2)」时会用 W+1 的历史 delete 覆盖已含恢复内容的快照 S——
 *    **请求发起序号不能证明数据库的观察顺序**。现在水位只取自与内容**同批读出**的
 *    `snapshot.watermark`，游标 = `v2:snapshot.watermark`。
 * C. **竞态 B 的收口**：`hasMore` / 出错 / 页上限期间不再放行全局写。`syncing` 只在
 *    「一轮里快照已发布且确认无更多变更」时清除，`finally` 不参与（见 `useSyncChangesPoller`）。
 * D. **行级写不受影响**：编辑 / 删除 / 收藏用**行修订** CAS，与集合完整性无关；
 *    只有整体操作（重排 / 分组重排 / 目录导入 / restore 导入）在 `syncing` 期间被拒绝。
 */
import {
  buildNavExportDocument,
  catalogUpgradePlan,
  decodeSyncCursor,
  decideCatalogImport,
  encodeSyncCursor,
  navCatalogEntryState,
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
  type NavRegion,
  type NavSnapshot,
  type NavSortMode,
  type SyncChangesResponse,
  type SyncConflict,
  type SyncEntityType,
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
   * 跨设备同步是否**尚未确认完成**（界面据此拒绝全局 CAS 写并提示「正在同步」）。
   *
   * 为什么必须让界面知道：这段时间里本地状态还没有换到「权威快照已发布 + 无更多变更」的
   * 确认态，提交「全局 CAS 写」（重排 / 分组重排 / 目录导入 / restore 导入这类带
   * `expectedRevision` 的整体操作）等于拿一份可能不完整的集合去覆盖服务端。
   *
   * 它**只**在一轮「快照已发布且确认无更多变更」之后恢复：出错 / 页上限 / 快照读取失败 /
   * 游标被拒都必须保持禁止（`finally` 不参与清除，这正是第四轮复核收口的 P1）。
   * 行级写（编辑 / 删除 / 收藏，用行修订 CAS）**不受**它影响。
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
   * 同步机制的可恢复提示：正在同步（「快照 + 无更多变更」确认之前）或
   * 「服务端拒绝本地游标 → 已丢弃并重建水位」。
   *
   * 与 `error` 分开：后者是失败，前者是**已经自动恢复**的事实，必须让用户看得见
   * （静默丢游标会让用户以为「数据一直是最新的」）。下一轮确认同步完成后自动清除。
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
  /** 正在同步（快照 + 无更多变更确认之前，见 `NavController.syncing`）。 */
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
   * 「发现 `hasMore` 立即续取下一页」以及「排空前后的写闸门」。
   */
  readonly syncLimit?: number | undefined;
  /**
   * 一次同步最多连续取回多少页（默认 `SYNC_MAX_PAGES_PER_SYNC`）。
   *
   * 只在测试里注入小值（例如 1）以验证「页上限 → 不发布半份状态、保持 `syncing`」。
   */
  readonly syncMaxPages?: number | undefined;
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

/**
 * 「同步未完成」的可见文案（全局 CAS 写被拒绝时复用同一条）。
 *
 * 措辞说明**为什么**被拒绝：本地状态还没有换到「权威快照已发布且确认无更多变更」的确认态，
 * 此时提交整体操作等于用一份可能不完整的集合覆盖服务端。
 */
export const SYNC_DRAINING_NOTICE =
  '正在同步其它设备的改动：在权威快照发布并确认没有更多变更之前，重排 / 导入等整体操作暂时不可用，' +
  '以免用不完整的本地集合覆盖服务端。';

/**
 * 草稿冲突的用户可见文案。
 *
 * 刻意说清三件事：远端发生了什么、草稿还在、草稿在第几行。
 * 绝不含「已自动合并」这类说法——本模块**不会**自动合并草稿。
 */
export function describeRemoteDraftConflict(input: {
  readonly reason: string;
  readonly rowNumber: number | null;
  readonly title: string | null;
}): string {
  const row = input.rowNumber === null ? '' : `你的草稿保留在第 ${String(input.rowNumber)} 行，`;
  const label = input.title === null ? '' : `「${input.title}」`;
  return `${input.reason}${label === '' ? '' : `：${label}`}；${row}未保存。`;
}

/**
 * 失效信号被权威快照消费之后的可见说明（可见、不静默）。
 *
 * 为什么必须让用户看见：本轮的变更日志**没有**被逐条应用（日志条目是历史事件，`payload`
 * 是**当前**内容），本地状态是被整份快照替换的。静默替换会让「为什么刚才那条删除没生效」
 * 无从解释。
 */
export function describeSnapshotPublished(signalCount: number): string {
  return (
    `已收到 ${String(signalCount)} 条变更信号，并按服务端权威快照整体刷新本地状态。` +
    '变更日志只作失效信号，不会逐条重放到当前状态上。'
  );
}

/**
 * 「远端是否动了正在编辑的那一行」→ 可见提示文案（没有变化时返回 `null`）。
 *
 * 判定口径与行级 CAS 完全一致（`nav_link.revision`）：草稿记的 `baseRevision` 就是用户
 * 开始时看到的行修订，因此行修订一变（或该行已不在快照里）就说明远端动过它。
 *
 * 它只影响**提示**：草稿的 `values` / `baseRevision` 一个字节都不动，
 * 用户仍然显式选择「基于最新修订保存」或「放弃草稿重新载入」。
 */
export function draftRemoteNoticeOf(input: {
  readonly draft: NavLinkDraft | null;
  readonly snapshot: NavSnapshot;
}): string | null {
  const current = input.draft;
  if (current === null || current.mode !== 'edit' || current.linkId === null) {
    return null;
  }
  const link = input.snapshot.links.find((candidate) => candidate.id === current.linkId);
  if (link !== undefined && link.revision === current.baseRevision) {
    return null;
  }
  // 行号用**共享投影**算（与服务端/视图同一份排序口径），不自己写第二套。
  const ordered = projectNavLinks({
    links: input.snapshot.links,
    groups: input.snapshot.groups,
    memberships: input.snapshot.memberships,
    filter: { sort: 'manual' },
  });
  const index = ordered.findIndex((candidate) => candidate.id === current.linkId);
  return describeRemoteDraftConflict({
    reason: link === undefined ? '该链接在其它设备上被删除' : '该链接在其它设备上被更新',
    rowNumber: index < 0 ? null : index + 1,
    title: link?.title ?? null,
  });
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

/**
 * 一轮同步里最多连续做多少次「读快照 → 再确认没有新变更」。
 *
 * 为什么需要上限：快照读完之后又有写入是**正常现象**（协议要求下一轮继续），但一个持续写入
 * 的服务端会让这一轮永远收不了口。到上限时**保持「同步中」**（全局 CAS 写继续被拒绝）
 * 并在下一个轮询间隔继续，绝不假装已经同步完成。
 */
export const SYNC_MAX_REFRESH_ROUNDS = 3;

export interface SyncChangesPollerOptions {
  readonly enabled: boolean;
  /** 真实环境下读取设备凭证；注入 `api` 替身时不需要它。 */
  readonly getToken?: (() => string | null) | undefined;
  readonly api?: SyncChangesApi | undefined;
  /** 轮询间隔；`<= 0` 表示只在挂载与窗口获得焦点时同步。 */
  readonly intervalMs?: number | undefined;
  readonly limit?: number | undefined;
  /** 一次同步最多连续取回多少页（默认 `SYNC_MAX_PAGES_PER_SYNC`）；测试注入小值以验证页上限。 */
  readonly maxPagesPerSync?: number | undefined;
  /**
   * 本上下文关心的实体类型：只有这些类型的变更才算「失效信号」。
   *
   * 导航与工作台共用同一个变更流，但各自只关心自己那几类实体（导航不会因为别的设备
   * 拖了一个组件就去重读导航快照）。**游标推进不受它影响**：不关心的行同样会被消费掉，
   * 否则每一轮都会重新收到它们。
   */
  readonly relevantEntityTypes?: readonly SyncEntityType[] | undefined;
  /**
   * 读一次权威快照并**原子替换**本地状态。这是**唯一**的状态发布路径。
   *
   * `knownWatermarkSeq` 是轮询器已经确认消费到的水位。注意它只是一个**下界**：
   * 日志只作失效信号，因此「请求发起顺序」和「日志顺序」都不能证明数据库的观察顺序。
   * 快照自带水位时一律以快照为准（见共享 `navSnapshotSchema.watermark` 的注释）；
   * 旧服务端的工作台快照可能没有水位，此时才用这个下界兜底——偏低只会多读一次快照，
   * **绝不会**跳过任何变更。
   *
   * 返回该快照的同步水位；读取失败返回 `null`（此时本轮**不发布任何状态、也不推进游标**）。
   */
  readonly readSnapshot: (knownWatermarkSeq: number) => Promise<number | null>;
  /**
   * 本地**已经发布的快照水位**（只增不减；没有快照时为 0）。
   *
   * 为什么需要它：手动 / 写入后的 `reload()` 也会发布更新的快照，而轮询器的游标只认快照。
   * 若不在每轮开始时抬到「已发布水位」，下一轮就会把**已经包含在快照里**的变更当成新信号
   * 再取一次（多一次无谓读，且可能在持续写入时反复触发）。它同时再次强调：水位是**事实**
   * （哪份内容已落地），不是「我们发过哪些请求」的推断。
   */
  readonly publishedWatermark?: (() => number) | undefined;
  readonly onUnauthorized?: (() => void) | undefined;
  readonly onError?: ((message: string) => void) | undefined;
  /**
   * 服务端**拒绝本地游标**（`422` + `details.reason`）时的可见回调。
   *
   * 为什么单列一条：这不是失败而是**已自动恢复**（游标已丢弃，下一轮重新读一次权威快照
   * 并重建水位），必须让用户看得见；静默重来会让用户以为「本地数据一直是最新的」。
   */
  readonly onCursorReset?: ((message: string) => void) | undefined;
  /**
   * 「同步未完成」的可见状态（界面据此**拒绝全局 CAS 写**）。
   *
   * 何时为 true：收到失效信号还没换到权威快照、变更页没取完、快照读取失败、页上限、
   * 传输失败、游标被拒。何时为 false：**只有**一轮「快照已发布且确认没有更多变更」之后。
   *
   * 出错 / 页上限 / 快照读取失败的路径**不得**在 `finally` 里复位它——那正是第四轮复核
   * 收口的 P1：`finally { setDraining(false) }` 会在数据并没有排空时恢复全局写能力。
   */
  readonly onSyncingChange?: ((syncing: boolean) => void) | undefined;
  /** 收到失效信号（相关变更条数非空）时的可见提示钩子。 */
  readonly onInvalidated?: ((changeCount: number) => void) | undefined;
  /** 一轮「快照已发布且确认无更多变更」的回调（清掉「正在同步 / 已自动恢复」这类提示）。 */
  readonly onSettled?: (() => void) | undefined;
}

export interface SyncChangesPoller {
  /** 立刻同步一次（轮询之外的显式入口，便于测试与「手动刷新」）。 */
  readonly syncNow: () => Promise<void>;
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
 * 变更轮询（HUB-051 客户端侧，导航与工作台**共用同一份**实现）。
 *
 * ── 协议（第四轮复核收口）：日志只作失效信号，状态只由原子快照发布 ────────────────
 * 变更流的条目是**历史事件**（`payload` 却是**当前**内容），把它按 seq 重放到本地状态上
 * 会改错数据：「导入 → 删除 → 显式恢复」之后重放历史里的那条 `delete` 会把**已恢复**的链接
 * 连同成员关系一起删掉。
 *
 * 更根本的是，客户端先前「先用 `reset` 拿到水位 W，再单独读快照 S」这组请求存在竞态：
 * 若两者之间发生「删除(W+1) → 恢复(W+2)」，S 已经包含恢复后的链接，而客户端仍会收到并应用
 * W+1 的历史 `delete`——**请求发起序号不能证明数据库的观察顺序**，只有「内容 + revision +
 * 水位同批读出」才能证明。
 *
 * 因此本实现严格按下面的顺序执行，任何一步都不能交换：
 *   ① `since` 缺省 → 只接受 `resetRequired`，**不应用任何 changes**；
 *   ② 只要本轮的 changes 里有相关变更（或 `resetRequired`）→ 标记「需要刷新」；
 *   ③ 排空后**一次性**读取权威快照，用该快照**整体替换**本地状态（原子发布一次），
 *      并把游标设为 `snapshot.watermark`；
 *   ④ 快照之后若又有写入 → 下一轮继续（有界循环 `SYNC_MAX_REFRESH_ROUNDS`；到上限则
 *      **保持「同步中」**，下一个间隔继续）；
 *   ⑤ **绝不**把 changes 的 op/payload 逐条应用到本地状态。
 *
 * 触发时机：**挂载**、**窗口获得焦点**、以及**固定间隔**。
 * 为什么必须有焦点触发：合盖、切走标签页之后定时器可能被节流甚至暂停，回到页面时如果只等
 * 下一次定时器，用户会看到过期数据任意长的时间。
 *
 * 游标处理：`since` 是服务端给出的字符串；每轮用共享 `decodeSyncCursor` 校验**再**用
 * `encodeSyncCursor` 编回去（往返一次，证明拿到的确实是本版本能理解的游标）。
 * 解析失败（损坏或来自更新的版本）时把游标清空，下一轮重新走一次初始化。
 * 服务端**拒绝**我们的游标（`422` + `details.reason`）时同样丢弃本地游标并重新初始化，
 * 但会额外给出一条可见提示（`onCursorReset`），不静默。
 */
export function useSyncChangesPoller(options: SyncChangesPollerOptions): SyncChangesPoller {
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  /**
   * 「已经收到失效信号，但还没换到权威快照」。
   *
   * 为什么必须是**跨轮次**的 ref：游标在排空过程中会前移，若中途失败（页上限 / 传输错误），
   * 下一轮可能已经收不到那些变更了；没有这个标记就会把「这一轮没收到变更」误判成
   * 「已经同步完成」，从而在一份过期状态上放行全局 CAS 写。
   */
  const pendingInvalidationRef = useRef(false);
  /**
   * 「服务端已经拒绝过我们的游标 / 本地游标不可解析」→ 必须重新走一次初始化
   * （`since` 缺省 → `resetRequired` → 读权威快照 → 用**快照水位**重建游标）。
   *
   * 为什么必须单列一个标记：已发布的快照水位通常会把游标抬回去，但在这种情况下
   * 「抬回去」等于拿一个刚刚被服务端拒绝的游标继续请求——那会原地失败直到永远。
   * 因此这个标记优先于「已发布水位」，只在初始化成功（快照落地）之后清除。
   */
  const pendingResetRef = useRef(false);
  /** 界面可见的「同步中」当前值（只在真正变化时回调，避免无谓重渲染）。 */
  const syncingRef = useRef(false);
  const handlersRef = useRef({
    readSnapshot: options.readSnapshot,
    publishedWatermark: options.publishedWatermark,
    onError: options.onError,
    onCursorReset: options.onCursorReset,
    onSyncingChange: options.onSyncingChange,
    onInvalidated: options.onInvalidated,
    onSettled: options.onSettled,
  });
  const unauthorizedRef = useRef(options.onUnauthorized);

  useEffect(() => {
    handlersRef.current = {
      readSnapshot: options.readSnapshot,
      publishedWatermark: options.publishedWatermark,
      onError: options.onError,
      onCursorReset: options.onCursorReset,
      onSyncingChange: options.onSyncingChange,
      onInvalidated: options.onInvalidated,
      onSettled: options.onSettled,
    };
    unauthorizedRef.current = options.onUnauthorized;
  });

  const enabled = options.enabled;
  const limit = options.limit;
  const maxPages = options.maxPagesPerSync ?? SYNC_MAX_PAGES_PER_SYNC;
  const relevantTypes = options.relevantEntityTypes;
  const injectedApi = options.api;
  /**
   * 凭证读取器在**首次渲染时记录一次**。
   *
   * 为什么不用 ref 承载它：`createSyncChangesApi` 是在渲染期被调用的，把「读 ref 的函数」
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
    /**
     * 「同步中」状态：一旦置位，**只有本轮确认「快照已发布且无更多变更」才复位**。
     * 出错 / 页上限 / 快照读取失败 / 游标被拒一律保持禁止（绝不放在 `finally` 里复位）。
     */
    const setSyncing = (next: boolean): void => {
      if (syncingRef.current === next) {
        return;
      }
      syncingRef.current = next;
      handlersRef.current.onSyncingChange?.(next);
    };
    const isRelevant = (entityType: SyncEntityType): boolean =>
      relevantTypes === undefined || relevantTypes.includes(entityType);

    if (!enabled) {
      // 轮询未启用：不存在「正在同步」这回事，写闸门必须放行（否则会永久卡住）。
      setSyncing(false);
      return;
    }
    if (api === undefined || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    try {
      /**
       * 游标 = 「本地状态已经覆盖到哪一个水位」。
       *
       * 它不是「我们发过哪些请求」的推断：起点只来自**快照水位**（初始化 / 失效信号那一轮
       * 由 `readSnapshot` 返回）与 `publishedWatermark`（手动 reload / 写入后刷新发布的新快照
       * 水位）。这样「先用 reset 拿水位、再单独读快照」那条竞态在结构上不存在——游标只可能
       * 等于某份**已经落地**的内容所对应的水位。
       */
      let cursor = cursorRef.current;
      let knownSeq = 0;
      if (cursor !== null) {
        const decoded = decodeSyncCursor(cursor);
        if (decoded.ok) {
          knownSeq = decoded.seq;
        } else {
          // 本地游标不可解析（损坏 / 来自更新的版本）：丢弃并强制重新初始化。
          cursor = null;
          cursorRef.current = null;
          pendingResetRef.current = true;
        }
      }
      /**
       * 每轮开始先把游标抬到「**已经发布**的快照水位」（只增不减）。
       *
       * 手动 reload / 写入后的刷新都会发布更新的快照；不抬就会把它们再当一次新信号。
       * 反过来，游标绝不允许高于这个水位——那等于跳过「快照里还没有的内容」。
       * 例外：`pendingResetRef` 为真时**不抬**（刚被服务端拒绝的游标不能又被抬回来）。
       */
      const publishedNow = handlersRef.current.publishedWatermark?.() ?? 0;
      if (!pendingResetRef.current && publishedNow > knownSeq) {
        cursor = encodeSyncCursor(publishedNow);
        cursorRef.current = cursor;
        knownSeq = publishedNow;
      }

      for (let round = 0; round < SYNC_MAX_REFRESH_ROUNDS; round += 1) {
        /** 本轮（排空期间的所有页）里与本上下文相关的变更条数。 */
        let signalCount = 0;
        let aborted = false;

        for (let page = 0; ; page += 1) {
          if (page >= maxPages) {
            handlersRef.current.onError?.(
              `一次同步连续取回了 ${String(page)} 页仍未排空，已暂停本轮（游标已前移，下一个间隔从断点继续）。`,
            );
            aborted = true;
            break;
          }
          const result = await api.readChanges({ since: cursor, limit: limit ?? SYNC_DEFAULT_LIMIT });
          if (!result.ok) {
            aborted = true;
            if (result.error.code === 'unauthorized') {
              unauthorizedRef.current?.();
              break;
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
              cursor = null;
              pendingResetRef.current = true;
              pendingInvalidationRef.current = true;
              handlersRef.current.onCursorReset?.(describeSyncCursorReset(cursorFailure));
              break;
            }
            handlersRef.current.onError?.(`同步变更失败：${describeNavError(result.error)}`);
            break;
          }
          const parsed = syncChangesResponseSchema.safeParse(result.data);
          if (!parsed.success) {
            // 形状不符的响应一律不用：宁可不刷新，也不用半可信数据。
            handlersRef.current.onError?.('同步响应不符合契约，本轮结果已忽略。');
            aborted = true;
            break;
          }
          const response = parsed.data;

          if (response.resetRequired) {
            /**
             * 初始化（①②）：`since` 缺省（或服务端要求重置）时**不应用任何 changes**。
             *
             * 状态水位仍然只认快照（见 `readSnapshot`）；这里把服务端给的 `nextCursor` 记进
             * `knownSeq` **只作为下界兜底**——它来自读快照**之前**的响应，因此必然
             * ≤ 随后那份快照的真实水位。用它当游标只会多重读一次快照，**绝不会**跳过变更。
             * 导航侧的快照水位是必填的，因此不受这个兜底影响；工作台（水位在共享契约里可选、
             * 且控制器不暴露快照对象）靠它避免从 `v2:0` 把整段历史当失效信号重取一遍。
             */
            pendingInvalidationRef.current = true;
            const hinted = response.nextCursor === null ? null : decodeSyncCursor(response.nextCursor);
            if (hinted !== null && hinted.ok) {
              knownSeq = Math.max(knownSeq, hinted.seq);
            }
            break;
          }
          if (cursor === null) {
            /**
             * 没有可用游标却收到了变更：绝不应用。这是「禁止历史回放」的最后一道闸门。
             */
            handlersRef.current.onError?.(
              '服务端在没有可用同步游标时返回了变更，本轮已忽略（不会在没有权威快照的情况下回放历史变更）。',
            );
            aborted = true;
            break;
          }
          const requested = decodeSyncCursor(cursor);
          if (!requested.ok) {
            handlersRef.current.onError?.(
              '本地的同步游标无法解析，本轮已忽略（不会在没有可用水位的情况下应用变更）。',
            );
            aborted = true;
            break;
          }

          // 日志只是失效信号：只数条数与推进水位，**绝不**读取或应用 payload。
          knownSeq = Math.max(knownSeq, response.meta.watermark);
          for (const change of response.changes) {
            knownSeq = Math.max(knownSeq, change.seq);
            if (isRelevant(change.entityType)) {
              signalCount += 1;
            }
          }
          if (signalCount > 0) {
            pendingInvalidationRef.current = true;
            /**
             * 写闸门要**在排空过程中**就抬起来，而不是等排空结束才抬。
             *
             * 为什么（P1-B）：`hasMore === true` 时还有页没取完，本地状态此刻已经确定落后于
             * 服务端；若此时放行全局 CAS 写，用户提交的就是一份已知不完整的集合。
             * 旧实现只在排空**结束后**才采用修订号，却让写入在整个排空期间保持可用。
             */
            setSyncing(true);
          }

          const advanced = advanceSyncCursor({
            response,
            requestSince: cursor,
            requestSeq: requested.seq,
            limit: limit ?? SYNC_DEFAULT_LIMIT,
          });
          cursorRef.current = advanced.cursor;
          cursor = advanced.cursor;
          if (advanced.invalid) {
            cursorRef.current = null;
            cursor = null;
            pendingResetRef.current = true;
            pendingInvalidationRef.current = true;
            handlersRef.current.onCursorReset?.('同步游标不可用，下一轮将做一次完整同步。');
            aborted = true;
            break;
          }

          if (!response.hasMore || cursor === null) {
            // 排空完成（或游标已不可用：下一轮重新初始化，继续排空只会拿到空游标）。
            break;
          }
        }

        if (aborted) {
          // 出错 / 页上限：**保持**「同步中」——数据并没有被确认已同步。
          setSyncing(true);
          return;
        }

        if (pendingInvalidationRef.current) {
          /**
           * ③ 唯一的原子发布：读一次权威快照并整份替换本地状态，游标设为**快照的水位**。
           * 只要这一步没成功，就绝不推进游标、也绝不放行全局写。
           */
          setSyncing(true);
          if (signalCount > 0) {
            handlersRef.current.onInvalidated?.(signalCount);
          }
          const published = await handlersRef.current.readSnapshot(knownSeq);
          if (published === null) {
            handlersRef.current.onError?.(
              '读取权威快照失败：本轮不发布任何状态、也不推进同步水位（保持「同步中」，下一个间隔重试）。',
            );
            setSyncing(true);
            return;
          }
          cursorRef.current = encodeSyncCursor(published);
          cursor = cursorRef.current;
          knownSeq = Math.max(knownSeq, published);
          // 快照已发布：失效信号被消费掉；若本轮是「被拒绝后重新初始化」，标记也就完成了。
          pendingInvalidationRef.current = false;
          pendingResetRef.current = false;
          continue;
        }

        // 已经确认「权威快照已发布 + 没有更多变更」：这是唯一可以恢复全局写能力的状态。
        setSyncing(false);
        handlersRef.current.onSettled?.();
        return;
      }

      handlersRef.current.onError?.(
        `连续 ${String(SYNC_MAX_REFRESH_ROUNDS)} 轮都读到了新的变更信号，仍未确认同步完成；` +
          '已保持「同步中」，下一个轮询间隔继续。',
      );
      setSyncing(true);
      return;
    } finally {
      // 只释放「本轮在途」标记；「同步中」的清除**只**发生在上面确认完成那一支。
      inFlightRef.current = false;
    }
  }, [api, enabled, limit, maxPages, relevantTypes]);

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
   * 已收到、但还没被权威快照「消费掉」的失效信号条数（只用于可见文案）。
   *
   * 变更日志在本版本里**只作失效信号**，状态完全由快照决定，因此这里不再需要任何
   * per-entity 的墓碑 / 已应用序号簿记：「把 payload 逐条重放到当前状态」这条错误路径
   * 在结构上已被删除（第四轮复核收口的 P1-A）。
   */
  const pendingSignalsRef = useRef(0);

  /**
   * **本地已发布的快照水位**：当前这份状态已经覆盖到 `seq <= watermark`。
   *
   * 为什么必须有它：手动 / 写入后的 `reload()` 也会发布更新的快照，轮询器的游标必须跟着抬，
   * 否则下一轮会把已经包含在快照里的变更再取一次；更重要的是游标绝不能**低于**它
   * ——那会把「已经包含在快照里的变更」当成新增量来处理。
   *
   * 它只由「快照成功落地」抬高（见 `readAuthoritativeSnapshot`），因此它是一条**事实**，
   * 不是「我们发过哪些请求」的推断——请求发起序号不能证明数据库的观察顺序。
   */
  const publishedWatermarkRef = useRef(0);

  /**
   * 权威快照请求的**发起序号**：只用于「同一时刻多个失败里只显示最后发起那次的原因」。
   *
   * **不**用它决定哪份快照内容可以落地（第五轮复核修正）：请求发起顺序不能证明数据库
   * 观察顺序——后发起的请求完全可能在服务端**先**读到较旧状态，先发起的请求反而读到较新状态。
   * 因此「谁更新」的唯一依据是快照自带的 `watermark`（事实），不是请求序号。
   */
  const snapshotRequestSeqRef = useRef(0);

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
   * 读一次**权威快照**并整份替换本地状态；返回该快照的**同步水位**（失败时 `null`）。
   *
   * 这是本模块**唯一**的状态发布路径：变更日志只作失效信号，绝不逐条应用（见
   * `useSyncChangesPoller` 的协议注释）。水位取自快照本身（服务端把内容 + revision +
   * watermark 在**同一批**读出），因此「先用 reset 拿水位、再单独读快照」那条竞态在结构上
   * 不存在：游标只可能等于**已经落地的那份内容**所对应的水位。
   *
   * 草稿与冲突（硬要求）：
   * - 替换快照时**只**写 `snapshot` / `status` / `error` 与远端变化提示；草稿的 `values`
   *   与 `baseRevision` 一个字节都不动，「替换快照清空草稿输入」在结构上不可能发生；
   * - 远端动了草稿那一行时只置位提示（`draftRemoteNotice` + 草稿上的 `conflicted`，
   *   后者由 `remoteRowRevision` 那条 effect 统一置位），冲突横幅因此不会被刷新隐藏。
   *
   * 并发：快照是整份替换，「更早发起、更晚返回」的响应绝不能覆盖更新的那份。
   * 因此给每次请求发一个**递增的发起序号**，只允许不早于「已落地序号」的结果写状态；
   * 被更新的请求落地的旧结果只用于回答「快照是否可用」，不写状态、不抬水位、不报错
   * （避免把界面标红）。
   */
  const readAuthoritativeSnapshot = useCallback(async (): Promise<number | null> => {
    // 发起序号只用于「多个失败里显示最后发起那次的原因」，**不**参与「谁的内容更新」的判定。
    const requestSeq = snapshotRequestSeqRef.current + 1;
    snapshotRequestSeqRef.current = requestSeq;
    const result = await api.readSnapshot();
    if (!mountedRef.current) {
      return null;
    }
    if (!result.ok) {
      if (requestSeq === snapshotRequestSeqRef.current) {
        update((current) => ({ ...current, status: 'error', error: failureText(result, '加载导航快照失败') }));
      }
      return null;
    }
    const publishedWatermark = publishedWatermarkRef.current;
    if (result.data.watermark < publishedWatermark) {
      /**
       * **按事实单调发布**（第五轮复核修正）：这份响应观察到的是**更旧**的数据库状态
       * （并发下的两个请求在服务端可以任意交错：后发起的先读到旧状态、先发起的后读到新状态）。
       * 因此：
       * - 绝不覆盖本地内容（本地内容对应更高的水位）；
       * - 对外**只回答已发布的水位**，绝不把这份「未发布的水位」交给轮询器——
       *   否则游标会被设成一个本地状态并未覆盖到的位置，等于跳过变更。
       */
      return publishedWatermark;
    }
    /**
     * 水位在**快照落地这一刻**抬高，只增不减。
     *
     * 它证明的是「本地这份状态已经覆盖到 `seq <= watermark`」——这正是游标可以设为该值的
     * 唯一依据；任何「请求发起的先后」都不构成这个证明。
     * `watermark` 相等时两份内容语义一致（同一个 seq 对应同一个状态），因此允许落地以刷新派生提示。
     */
    publishedWatermarkRef.current = result.data.watermark;

    const snapshot = result.data;
    const draftNotice = draftRemoteNoticeOf({ draft: draftRef.current, snapshot });
    update((current) => ({
      ...current,
      status: 'ready',
      snapshot,
      error: null,
      // 没有新的事实时保留已有提示，避免每轮刷新都把同一条文案重写一遍。
      draftRemoteNotice: draftNotice ?? current.draftRemoteNotice,
    }));
    return snapshot.watermark;
  }, [api, failureText, update]);

  /**
   * 变更轮询（导航侧装配）。
   *
   * ── 本版本的三条硬规则（第四轮复核收口的两个 P1）──────────────────────────────
   * 1. **日志只作失效信号**：轮询器只数「有多少条相关变更」，`changes` 的 op/payload
   *    一个字节都不进本地状态（见 `useSyncChangesPoller`）。这里因此**没有**逐条应用函数。
   * 2. **状态只由原子快照发布**：唯一的发布路径是 `readAuthoritativeSnapshot()`，
   *    它把服务端与内容同批读出的 `watermark` 记进 `publishedWatermarkRef`，轮询器据此设游标。
   * 3. **写闸门**：`onSyncingChange` 是界面可见的「同步中」事实，全局 CAS 写据此被拒绝
   *    （见 `rejectWriteWhileSyncing`）。它**只在**一轮「快照已发布且确认无更多变更」后清除。
   */
  const poller = useSyncChangesPoller({
    enabled: options.enabled,
    ...(options.syncApi === undefined ? {} : { api: options.syncApi }),
    getToken: options.getToken,
    ...(options.syncIntervalMs === undefined ? {} : { intervalMs: options.syncIntervalMs }),
    ...(options.syncLimit === undefined ? {} : { limit: options.syncLimit }),
    ...(options.syncMaxPages === undefined ? {} : { maxPagesPerSync: options.syncMaxPages }),
    // 只有导航实体的变更才是本上下文的失效信号（别的设备拖一个组件不该让导航重读快照）。
    relevantEntityTypes: NAV_SYNC_ENTITY_TYPES,
    /**
     * 唯一的发布路径：整份替换本地状态并返回快照自带的水位。
     * 失败返回 `null` → 轮询器不推进游标、不发布状态，并**保持「同步中」**。
     */
    readSnapshot: () => readAuthoritativeSnapshot(),
    // 手动 reload / 写入后的刷新一旦发布新快照，游标必须跟着抬（见 `publishedWatermark`）。
    publishedWatermark: () => publishedWatermarkRef.current,
    onSyncingChange: (syncing) => {
      update((current) => ({
        ...current,
        syncing,
        syncNotice: syncing
          ? // 「正在同步」；但不覆盖更具体的那条（例如「游标已被拒绝，下一轮完整同步」）。
            (current.syncNotice ?? SYNC_DRAINING_NOTICE)
          : current.syncNotice === SYNC_DRAINING_NOTICE
            ? null
            : current.syncNotice,
      }));
    },
    onInvalidated: (changeCount) => {
      // 只记条数用于可见文案：**不**缓存任何 change 对象（它们的 payload 是当前内容，
      // 而日志条目是历史事件，缓存下来只会诱导「稍后重放」这条错误路径）。
      pendingSignalsRef.current += changeCount;
    },
    onSettled: () => {
      // 「已确认同步完成」是唯一可以清掉「正在同步 / 已自动恢复」提示的时机。
      const signals = pendingSignalsRef.current;
      pendingSignalsRef.current = 0;
      update((current) => ({
        ...current,
        syncNotice: null,
        notice: signals > 0 ? describeSnapshotPublished(signals) : current.notice,
      }));
    },
    ...(options.onUnauthorized === undefined ? {} : { onUnauthorized: options.onUnauthorized }),
    onCursorReset: (message) => {
      // 可见提示（不静默）：游标已丢弃，下一轮重新走初始化（读权威快照 + 新水位）。
      update((current) => ({ ...current, syncNotice: message }));
    },
    onError: (message) => {
      // 同步失败**不**清空已有数据，也不显示成致命错误：它只是「这次没拿到变更」。
      update((current) => ({ ...current, error: current.error ?? message }));
    },
  });

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /**
   * 重新读一次权威快照（挂载、写入之后、用户点「重新加载」）。
   *
   * 它与同步轮询走**同一个**发布路径（`readAuthoritativeSnapshot`），因此刷新后
   * `publishedWatermarkRef` 会跟着抬高：旧增量（`seq` 小于新快照水位）不会再被当成新增量。
   * 这里刻意不做任何别的状态推断——状态只能由快照发布。
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
   * **同步未完成**期间的全局 CAS 写闸门：拒绝提交并给出「正在同步」的可见提示。
   *
   * 为什么只拦这一类（重排链接 / 重排分组 / 目录导入 / restore 导入）：它们提交的是
   * **工作空间级** `expectedRevision`，语义是「基于我看到的整份集合」。`syncing === true`
   * 意味着本地状态还没有换到「权威快照 + 无更多变更」的确认态，此时提交等于用一份可能
   * 不完整的集合覆盖服务端。也**绝不**改用服务端最新修订号提交——那更糟：等于按一个
   * 本地并未见过的修订号批准写入。
   *
   * 行级写（编辑 / 删除 / 收藏 / 分组增删改）用的是**行修订** CAS，与集合完整性无关，
   * 因此不受此闸门影响。
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
      // 同步未完成时禁止全局 CAS 写（见 `rejectWriteWhileSyncing`）：绝不静默用旧/新修订提交。
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
      // 同步未完成时禁止全局 CAS 写：分组顺序同样是整体替换，必须基于完整集合。
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
      // 同步未完成时禁止全局 CAS 写（目录导入会整体改动集合与顺序）。
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
    // 同步未完成时禁止导入落地：`expectedRevision` 语义上基于整份集合，此时集合可能不完整。
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
