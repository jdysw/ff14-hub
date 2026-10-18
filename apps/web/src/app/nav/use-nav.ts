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
 * 5. **导入先预览、再显式 apply**：本地解析（书签 HTML / JSON）用共享纯函数；
 *    apply 回显预览时的工作空间修订，期间数据被改动则由服务端 409 拒绝。
 */
import {
  buildNavExportDocument,
  catalogUpgradePlan,
  decodeSyncCursor,
  decideCatalogImport,
  encodeSyncCursor,
  navCatalogEntryState,
  navGroupSchema,
  navLinkSchema,
  navMembershipSchema,
  navUrlSchema,
  parseBookmarkHtml,
  parseNavImportJson,
  parseNavExportDocument,
  projectNavLinks,
  SYNC_DEFAULT_LIMIT,
  syncChangesResponseSchema,
  NAV_DEFAULT_ICON,
  type NavCatalogEntry,
  type NavCatalogEntryState,
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
  type SyncConflict,
  type SyncEntityType,
} from '@ff14-hub/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createNavApi,
  createNavTransport,
  createSyncChangesApi,
  describeNavError,
  newOperationId,
  type NavApi,
  type NavApiErrorInfo,
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

/** 本地解析出的待导入内容（来自书签文件或粘贴的 JSON 文本）。 */
export interface NavLocalImport {
  readonly kind: 'bookmarks' | 'json';
  readonly sourceName: string;
  readonly items: readonly NavImportItem[];
  readonly skipped: readonly NavImportSkipped[];
}

/** 服务端预览结果 + apply 需要的一切（修订与目标分组）。 */
export interface NavImportPreviewState {
  readonly preview: {
    readonly items: readonly NavImportItem[];
    readonly skipped: readonly NavImportSkipped[];
    readonly revision: number;
  };
  /** 预览时的工作空间修订；apply 必须回显它。 */
  readonly expectedRevision: number;
  readonly source: NavLocalImport;
  readonly targetGroupId: string | null;
}

export interface NavController {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly notice: string | null;
  readonly busy: boolean;
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
  readonly snapshot: NavSnapshot | null;
  readonly catalog: readonly NavCatalogEntry[] | null;
  readonly catalogError: string | null;
  readonly localImport: NavLocalImport | null;
  readonly importPreview: NavImportPreviewState | null;
  readonly conflict: NavConflictState | null;
  readonly draftRemoteNotice: string | null;
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
  snapshot: null,
  catalog: null,
  catalogError: null,
  localImport: null,
  importPreview: null,
  conflict: null,
  draftRemoteNotice: null,
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
// 三条硬规则（都在下面用纯函数表达，便于单测与双上下文验收）：
// 1. **删除即删除**：`op:'delete'` 必须移除本地对应的行/关系，并被记进墓碑表；
//    任何**晚到的旧 upsert**（`updatedAt <= 墓碑时间`）都被丢弃，
//    因此不存在「因为增量里没出现就复活」的路径。
// 2. **草稿优先于远端**：正在编辑的实体收到远端变化时**不动本地、不丢草稿**，
//    只产生一条明确的提示，由用户决定放弃草稿或重新载入。
// 3. **不做无谓刷新**：只有真正需要应用的变更才会产生新快照。
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

export interface NavSyncApplyResult {
  readonly snapshot: NavSnapshot;
  readonly tombstones: Readonly<Record<string, number>>;
  /** 因形状不符或晚于已知墓碑而被丢弃的变更条数（界面据此诚实说明）。 */
  readonly ignored: number;
}

/**
 * 把变更应用到快照（**纯函数**）。
 *
 * 只有 `upsert` 会新增行；`delete` 与「墓碑形状的 upsert」都会移除行**并记墓碑**。
 * 墓碑表随结果返回，由调用方在下一轮继续带上，因此「删除后又被旧增量加回来」
 * 在结构上不可能发生。
 */
export function applyNavSyncChanges(input: {
  readonly snapshot: NavSnapshot;
  readonly changes: readonly SyncChange[];
  readonly tombstones: Readonly<Record<string, number>>;
}): NavSyncApplyResult {
  let links = [...input.snapshot.links];
  let groups = [...input.snapshot.groups];
  let memberships = [...input.snapshot.memberships];
  const tombstones: Record<string, number> = { ...input.tombstones };
  let ignored = 0;
  let revision = input.snapshot.revision;

  /** 同毫秒内也要有确定顺序：先按 `updatedAt`，再按 `entityId`（与服务端排序同源）。 */
  const ordered = [...input.changes].sort((a, b) =>
    a.updatedAt !== b.updatedAt ? a.updatedAt - b.updatedAt : a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0,
  );

  for (const change of ordered) {
    const key = syncTombstoneKey(change);
    const tombstonedAt = tombstones[key];

    if (change.op === 'delete') {
      tombstones[key] = Math.max(tombstonedAt ?? 0, change.updatedAt);
      if (change.entityType === 'nav_link') {
        links = links.filter((link) => link.id !== change.entityId);
        // 链接被删 → 它的成员关系也一并移除（服务端同样会墓碑化它们）。
        memberships = memberships.filter((membership) => membership.linkId !== change.entityId);
      } else if (change.entityType === 'nav_group') {
        groups = groups.filter((group) => group.id !== change.entityId);
        memberships = memberships.filter((membership) => membership.groupId !== change.entityId);
      } else if (change.entityType === 'nav_membership') {
        const parts = membershipPartsOf(change.entityId);
        memberships = memberships.filter(
          (membership) =>
            parts === null || membership.linkId !== parts.linkId || membership.groupId !== parts.groupId,
        );
      }
      revision = Math.max(revision, change.revision);
      continue;
    }

    if (tombstonedAt !== undefined && change.updatedAt <= tombstonedAt) {
      // 墓碑之后到达的旧 upsert 一律丢弃：这是「不复活删除」的第二道闸门。
      ignored += 1;
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
        tombstones[key] = Math.max(tombstonedAt ?? 0, change.updatedAt);
        links = links.filter((link) => link.id !== row.id);
        memberships = memberships.filter((membership) => membership.linkId !== row.id);
      } else {
        links = links.some((link) => link.id === row.id)
          ? links.map((link) => (link.id === row.id ? row : link))
          : [...links, row];
      }
      revision = Math.max(revision, change.revision);
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
        tombstones[key] = Math.max(tombstonedAt ?? 0, change.updatedAt);
        groups = groups.filter((group) => group.id !== row.id);
        memberships = memberships.filter((membership) => membership.groupId !== row.id);
      } else {
        groups = groups.some((group) => group.id === row.id)
          ? groups.map((group) => (group.id === row.id ? row : group))
          : [...groups, row];
      }
      revision = Math.max(revision, change.revision);
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
      tombstones[key] = Math.max(tombstonedAt ?? 0, change.updatedAt);
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
    }
    revision = Math.max(revision, change.revision);
  }

  return {
    snapshot: { ...input.snapshot, links, groups, memberships, revision },
    tombstones,
    ignored,
  };
}

/** 默认轮询间隔（毫秒）：30 秒。测试可注入更短的值，注入 0 表示不轮询。 */
export const NAV_SYNC_DEFAULT_INTERVAL_MS = 30_000;

export interface SyncChangesPollerOptions {
  readonly enabled: boolean;
  /** 真实环境下读取设备凭证；注入 `api` 替身时不需要它。 */
  readonly getToken?: (() => string | null) | undefined;
  readonly api?: SyncChangesApi | undefined;
  /** 轮询间隔；`<= 0` 表示只在挂载与窗口获得焦点时同步。 */
  readonly intervalMs?: number | undefined;
  readonly limit?: number | undefined;
  readonly onChanges: (changes: readonly SyncChange[], serverTimeMs: number) => void;
  readonly onUnauthorized?: (() => void) | undefined;
  readonly onError?: ((message: string) => void) | undefined;
}

export interface SyncChangesPoller {
  /** 立刻同步一次（轮询之外的显式入口，便于测试与「手动刷新」）。 */
  readonly syncNow: () => Promise<void>;
}

/**
 * 变更轮询（HUB-051 客户端侧，导航与工作台布局共用）。
 *
 * 触发时机：**挂载**、**窗口获得焦点**、以及**固定间隔**。
 * 为什么必须有焦点触发：笔记本合盖、切走标签页之后定时器可能被节流甚至暂停，
 * 回到页面时如果只等下一次定时器，用户会看到过期数据任意长的时间。
 *
 * 游标处理：`since` 是服务端给出的字符串；每轮用共享 `decodeSyncCursor` 校验
 * **再**用 `encodeSyncCursor` 编回去（往返一次，证明拿到的确实是本版本能理解的游标）。
 * 解析失败（损坏或来自更新的版本）时把游标清空，下一轮做一次完整同步——
 * 这比「猜一个值继续增量」安全：漏掉的变更不会自己回来。
 */
export function useSyncChangesPoller(options: SyncChangesPollerOptions): SyncChangesPoller {
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const handlersRef = useRef({ onChanges: options.onChanges, onError: options.onError });
  const unauthorizedRef = useRef(options.onUnauthorized);

  useEffect(() => {
    handlersRef.current = { onChanges: options.onChanges, onError: options.onError };
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
    try {
      const result = await api.readChanges({
        since: cursorRef.current,
        limit: limit ?? SYNC_DEFAULT_LIMIT,
      });
      if (!result.ok) {
        if (result.error.code === 'unauthorized') {
          unauthorizedRef.current?.();
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
      if (response.nextCursor === null) {
        cursorRef.current = null;
      } else {
        const decoded = decodeSyncCursor(response.nextCursor);
        cursorRef.current = decoded.ok ? encodeSyncCursor(decoded.updatedAtMs) : null;
        if (!decoded.ok) {
          handlersRef.current.onError?.('同步游标不可用，下一轮将做一次完整同步。');
        }
      }
      handlersRef.current.onChanges(response.changes, response.serverTimeMs);
    } finally {
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
   * 已见墓碑（`实体类型:实体ID` → 墓碑的 `updatedAt`）。
   *
   * 为什么必须**跨轮次**保留：一轮增量里先收到 delete、后收到一个更早的 upsert 时，
   * 只靠当轮数据无法判断「这是旧数据」；保留墓碑后，任何晚到的旧 upsert 都会被丢弃，
   * 因此不存在「删除过的行被后续合并加回来」的路径。
   */
  const tombstonesRef = useRef<Readonly<Record<string, number>>>({});

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

  /**
   * 变更在**快照还没加载完**时到达的暂存区。
   *
   * 为什么必须有它：挂载时的首次同步与首次快照加载是并发的，增量可能先到。
   * 直接丢弃是**错的**——游标已经前进了（服务端不会再发一次），丢掉的变更不会自己回来。
   * 因此先暂存，等快照落地后立刻补应用。
   */
  const pendingChangesRef = useRef<SyncChange[]>([]);

  /**
   * 把一批变更应用到给定快照上（纯判定 + 纯应用，本函数只负责把结果落到状态里）。
   *
   * 顺序刻意如此：
   * 1. 先逐条判定（`resolveRemoteChange`）：与草稿冲突的**不进入应用集合**；
   * 2. 只对可应用的子集调用 `applyNavSyncChanges`（含墓碑防复活）；
   * 3. 最后写状态：草稿内容一个字段都不会被改写，只置位「远端变了」的提示。
   */
  const applyChangesTo = useCallback(
    (snapshot: NavSnapshot, changes: readonly SyncChange[]): void => {
      const draftNow = draftRef.current;
      const draftLinkId = draftNow !== null && draftNow.mode === 'edit' ? draftNow.linkId : null;

      const applicable: SyncChange[] = [];
      let conflictVerdict: RemoteChangeVerdict | null = null;
      for (const change of changes) {
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

      if (applicable.length === 0) {
        if (remoteNotice !== null) {
          update((current) => ({ ...current, draftRemoteNotice: remoteNotice }));
          const current = draftRef.current;
          if (current !== null) {
            setDraftState({ ...current, conflicted: true });
          }
        }
        return;
      }

      const applied = applyNavSyncChanges({
        snapshot,
        changes: applicable,
        tombstones: tombstonesRef.current,
      });
      tombstonesRef.current = applied.tombstones;
      update((current) => ({
        ...current,
        snapshot: applied.snapshot,
        draftRemoteNotice: remoteNotice ?? current.draftRemoteNotice,
        notice:
          `已应用其它设备的 ${String(applicable.length)} 条导航变更` +
          (applied.ignored > 0 ? `（另有 ${String(applied.ignored)} 条因形状或已删除被忽略）` : '') +
          '。',
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
    (changes: readonly SyncChange[]): void => {
      const snapshot = ref.current.snapshot;
      if (snapshot === null) {
        // 快照还没到：暂存，等它落地后立刻补应用（绝不静默丢弃增量）。
        pendingChangesRef.current = [...pendingChangesRef.current, ...changes];
        return;
      }
      applyChangesTo(snapshot, changes);
    },
    [applyChangesTo],
  );

  const poller = useSyncChangesPoller({
    enabled: options.enabled,
    ...(options.syncApi === undefined ? {} : { api: options.syncApi }),
    getToken: options.getToken,
    ...(options.syncIntervalMs === undefined ? {} : { intervalMs: options.syncIntervalMs }),
    onChanges: (changes) => {
      handleSyncChanges(changes);
    },
    ...(options.onUnauthorized === undefined ? {} : { onUnauthorized: options.onUnauthorized }),
    onError: (message) => {
      // 同步失败**不**清空已有数据，也不显示成致命错误：它只是「这次没拿到增量」。
      update((current) => ({ ...current, error: current.error ?? message }));
    },
  });

  // -------------------------------------------------------------------------
  // 读取
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

  const refresh = useCallback(async (): Promise<void> => {
    update((current) => ({
      ...current,
      // 已经渲染出内容后不回退到「加载中」：否则每次写入后的刷新都会让整页闪一下。
      status: current.snapshot === null ? 'loading' : current.status,
      error: null,
    }));
    const result = await api.readSnapshot();
    if (!mountedRef.current) {
      return;
    }
    if (!result.ok) {
      update((current) => ({ ...current, status: 'error', error: failureText(result, '加载导航快照失败') }));
      return;
    }
    update((current) => ({ ...current, status: 'ready', snapshot: result.data, error: null }));
    /**
     * 补应用「快照还没到时先到达」的增量。
     *
     * 必须在 `update` 之后：`applyChangesTo` 读的是刚写下的状态镜像，
     * 而它产生的快照要建立在这份**刚拿到**的服务端快照之上。
     */
    const pending = pendingChangesRef.current;
    if (pending.length > 0) {
      pendingChangesRef.current = [];
      applyChangesTo(result.data, pending);
    }
  }, [api, applyChangesTo, failureText, update]);

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

  /** 就地替换一条链接（保留其余行的引用）。 */
  const replaceLink = useCallback(
    (snapshot: NavSnapshot, link: NavLink): NavSnapshot => ({
      ...snapshot,
      revision: Math.max(snapshot.revision, link.revision),
      links: snapshot.links.map((candidate) => (candidate.id === link.id ? link : candidate)),
    }),
    [],
  );

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
          revision: Math.max(current.revision, link.revision),
          /**
           * 本地按**墓碑**处理（`deletedAt` 非空），而不是把行从数组里拿掉：
           * 共享投影函数据此排除它，同时「我删的是哪一行」在快照里仍然可见，
           * 这与服务端的删除语义（墓碑，不物理删除）保持一致。
           */
          links: current.links.map((candidate) =>
            candidate.id === linkId
              ? { ...candidate, deletedAt: Date.now(), revision: candidate.revision + 1 }
              : candidate,
          ),
        }),
        run: () => api.deleteLink(linkId, { operationId: newOperationId(), expectedRevision: link.revision }),
        onSuccess: (data) =>
          update((state2) => ({ ...state2, lastDeletedLinkId: data.deletedId, notice: `已删除「${link.title}」。` })),
      });
      if (deleted !== null) {
        await refresh();
      }
    },
    [api, refresh, update, write],
  );

  const toggleFavorite = useCallback(
    async (linkId: string): Promise<void> => {
      const snapshot = ref.current.snapshot;
      const link = snapshot?.links.find((candidate) => candidate.id === linkId);
      if (snapshot === null || link === undefined) {
        return;
      }
      const nextFavorite = !link.isFavorite;
      await write<{ link: NavLink }>({
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
    },
    [api, replaceLink, update, write],
  );

  /**
   * 个人排序（上下移动一格）。
   *
   * 发送**全部**活跃链接的期望顺序：共享契约 `reorderNavLinksRequestSchema` 是整体替换，
   * 这样「部分重排」的歧义不存在。顺序基于当前快照的 `manual` 排序（共享纯函数），
   * 因此与服务端理解完全一致。
   */
  const moveLink = useCallback(
    async (linkId: string, direction: -1 | 1): Promise<void> => {
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
      });
    },
    [api, write],
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
      await write<NavGroup>({
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
    },
    [api, update, write],
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
        onSuccess: () =>
          update((state2) => ({ ...state2, notice: `已删除分组「${group.name}」（链接本身保留）。` })),
      });
      if (deleted !== null) {
        // 成员关系由服务端一并处理，因此刷新一次拿到权威的归属结果。
        await refresh();
      }
    },
    [api, refresh, update, write],
  );

  const moveGroup = useCallback(
    async (groupId: string, direction: -1 | 1): Promise<void> => {
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
      });
    },
    [activeGroups, api, write],
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
    [api, loadCatalog, refresh, update, write],
  );

  // -------------------------------------------------------------------------
  // 通用导入（书签 HTML / JSON 文本）
  // -------------------------------------------------------------------------

  const previewLocalImport = useCallback(
    (input: { readonly kind: 'bookmarks' | 'json'; readonly sourceName: string; readonly text: string }): void => {
      // 本地解析用共享纯函数：只把 `<A HREF>` 与文件夹名当**数据**读，
      // 解析结果里没有任何 HTML，因此页面里永远不会出现外来标签文本。
      const parsed = input.kind === 'bookmarks' ? parseBookmarkHtml(input.text) : parseNavImportJson(input.text);
      update((current) => ({
        ...current,
        localImport: {
          kind: input.kind,
          sourceName: input.sourceName,
          items: parsed.items,
          skipped: parsed.skipped,
        },
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

  const previewImport = useCallback(async (): Promise<void> => {
    const current = ref.current;
    const local = current.localImport;
    if (local === null || current.snapshot === null) {
      return;
    }
    update((state2) => ({ ...state2, busy: true, error: null }));
    const result = await api.previewImport({
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
        // 记录**预览时**的修订：apply 必须回显它，服务端据此拒绝按旧预览覆盖。
        expectedRevision: result.data.revision,
        source: local,
        targetGroupId: importTargetGroupId,
      },
    }));
  }, [api, failureText, importTargetGroupId, update]);

  const applyImport = useCallback(async (): Promise<void> => {
    const preview = ref.current.importPreview;
    if (preview === null) {
      return;
    }
    const applied = await write<{ importedCount: number; skipped: readonly NavImportSkipped[] }>({
      prefix: '导入失败',
      run: () =>
        api.applyImport({
          operationId: newOperationId(),
          items: [...preview.preview.items],
          ...(preview.targetGroupId === null ? {} : { targetGroupId: preview.targetGroupId }),
          expectedRevision: preview.expectedRevision,
        }),
      onSuccess: (data) =>
        update((state2) => ({
          ...state2,
          importPreview: null,
          localImport: null,
          notice: `导入完成：写入 ${String(data.importedCount)} 条，跳过 ${String(data.skipped.length)} 条。`,
        })),
    });
    if (applied !== null) {
      await refresh();
    }
  }, [api, refresh, update, write]);

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
