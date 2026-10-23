/**
 * 自由导航服务（HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009；ADR-0004 D1–D6 / D11）。
 *
 * 安全前提（与工作台服务同一套，越权一律 404，不泄露存在性）：
 * - 每个方法都要求显式传入 `workspaceId`，它**只能**来自认证中间件；
 *   路径参数与正文里的关联 ID（linkId / groupId / sourceCatalogId）只用于**过滤**，
 *   不参与作用域判定：**每条 SQL 都带 `workspace_id`**。
 * - 关联 ID 必须在**同一工作空间**内校验：链接 × 分组的成员关系写入用
 *   `FROM workspace_nav_links l JOIN workspace_nav_groups g ON l.workspace_id = g.workspace_id`
 *   在同一事务内取行，认领前置条件也复查「这些分组都属于本工作空间且活跃」。
 *   **外键不能替代**这项检查：`workspace_nav_memberships` 分别外键到 links 与 groups，
 *   但它证明不了三者 workspace 相同（迁移文件头也这么写）。
 * - 陈旧写一律 409：行级冲突返回结构化 `details.conflict`（共享 `navConflictSchema` 形状）。
 *
 * 事务与幂等：所有写入都经 `runOperation` → `runIdempotentWrite`，
 * 即「认领 + 变更 + 收尾」同一个 D1 batch（原子，失败整体回滚）。
 *
 * 读一致性（复核发现的真实缺陷）：任何**一次决策或一次输出**所依赖的全部导航行
 * （活跃 links / groups / memberships、`workspace_nav_state.revision`、
 * `workspace_nav_catalog` 版本与目录条目、目录关联行含墓碑）必须在**同一个 `db.batch([...])`**
 * 里读出。分别读（`Promise.all` 若干独立查询）在并发写入下会组合出「旧行 + 新 revision」：
 * 目录导入会据此误判「用户有没有改过 / 是否墓碑」，导出则会产出**悬空成员关系**
 * （指向已墓碑化的链接或分组）。因此：
 *   - 快照 / 导出 / 导入规划 / 目录导入规划的读取各自只有**一个** batch；
 *   - 写入的 CAS（`expectedRevision` / `navRevisionCondition`）一律绑定**该批里读到的**
 *     revision，绝不二次读取。
 *
 * 删除语义：链接 / 分组 / 成员关系一律**墓碑**（`deleted_at`），不做硬删除、不做 GC。
 * 所有导航写入都 bump `workspace_nav_state.revision`（行缺失等价于 0，先插 0 再 +1）。
 *
 * 筛选 / 排序 / 投影**只有一份实现**：服务端在 SQL 里只做「本工作空间 + 未删除」，
 * 之后一律调用共享的 `projectNavLinks`（内部含 `filterNavLinks` / `sortNavLinks`），
 * 因此不可能与前端漂移（ADR-0004 D5）。
 */
import {
  MAX_NAV_DESCRIPTION_LENGTH,
  MAX_NAV_GROUP_NAME_LENGTH,
  MAX_NAV_GROUPS_PER_LINK,
  MAX_NAV_GROUPS_PER_WORKSPACE,
  MAX_NAV_IMPORT_ITEMS,
  MAX_NAV_LINKS_PER_WORKSPACE,
  MAX_NAV_TITLE_LENGTH,
  NAV_LIMITS,
  buildNavExportDocument,
  catalogUpgradePlan,
  decideCatalogImport,
  navConflictSchema,
  normalizeNavAliases,
  normalizeNavTags,
  normalizeNavText,
  projectNavLinks,
  sanitizeNavIcon,
  validateNavExportIntegrity,
  validateNavUrl,
  type NavConflict,
  type NavCatalogEntry,
  type NavExportDocument,
  type NavFilter,
  type NavGroup,
  type NavImportItem,
  type NavImportSkipReason,
  type NavImportSkipped,
  type NavLink,
  type NavLinkStatus,
  type NavLinkView,
  type NavMembership,
  type NavOpenMode,
  type NavRegion,
  type NavSnapshot,
} from '@ff14-hub/shared';
import {
  NAV_OP_KINDS,
  fingerprintOf,
  guardedStatements,
  navFailure,
  readNavReplay,
  runIdempotentWrite,
  type IdempotencyGuard,
  type NavFailure,
  type NavResult,
  type NavStatement,
} from './tx';

import {
  parseStringArray,
  toNavLink,
  toNavGroup,
  toNavMembership,
  readLinkRow,
  readGroupRows,
  readGroupRow,
  readNavStateRevision,
  readSnapshotBatch,
  readImportPlanBatch,
  readWritePrecondition,
  readCatalogImportBatch,
  bumpNavStateStatements,
  insertLinkStatement,
  updateLinkContentStatement,
  tombstoneLinkStatement,
  insertGroupStatement,
  updateGroupStatement,
  tombstoneGroupStatement,
  tombstoneMembershipsOfLinkStatement,
  tombstoneMembershipsOfGroupStatement,
  tombstoneMembershipStatement,
  insertMembershipStatement,
  addMembershipStatements,
  syncMembershipOrderStatement,
  MEMBERSHIP_COLUMNS,
} from './persistence';
import type {NavLinkRow,NavGroupRow,NavMembershipRow} from './persistence';
export type {NavLinkRow,NavGroupRow,NavMembershipRow} from './persistence';

export interface NavServiceDeps {
  readonly db: D1Database;
  /** 可注入时钟（UTC 毫秒），便于测试确定性时间戳。 */
  readonly now?: () => number;
}

// SQL、行投影与导航读写语句已独立到 persistence.ts，业务接口保持不变。
// ---------------------------------------------------------------------------
// 输入 / 输出类型
// ---------------------------------------------------------------------------

/**
 * 链接可编辑字段（与共享 `updateNavLinkRequestSchema` 的字段集合一致）。
 *
 * 每个可选字段都显式写成 `T | undefined`：`exactOptionalPropertyTypes` 下
 * 「键存在但值为 undefined」与「键不存在」是两种类型，而路由层是把 Zod 解析结果
 * 直接展开进来的（Zod 的 `.optional()` 推断出 `T | undefined`）。
 * 写成 `| undefined` 让「展开一个已校验的请求体」成为类型安全的常规写法，
 * 而不需要在每个路由里手工逐字段做条件展开。
 */
export interface NavLinkPatch {
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly icon?: string | undefined;
  readonly openMode?: NavOpenMode | undefined;
  readonly region?: NavRegion | undefined;
  readonly status?: NavLinkStatus | undefined;
  readonly isFavorite?: boolean | undefined;
  readonly sortOrder?: number | undefined;
  /** 存在时**整体替换**该链接的分组归属（多分组）。 */
  readonly groupIds?: readonly string[] | undefined;
}

export interface CreateNavLinkInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly title: string;
  readonly url: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly icon?: string | undefined;
  readonly openMode?: NavOpenMode | undefined;
  readonly region?: NavRegion | undefined;
  readonly status?: NavLinkStatus | undefined;
  readonly isFavorite?: boolean | undefined;
  readonly sortOrder?: number | undefined;
  readonly groupIds?: readonly string[] | undefined;
}

export interface UpdateNavLinkInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly linkId: string;
  readonly expectedRevision: number;
  readonly patch: NavLinkPatch;
}

export interface NavImportApplyResult {
  readonly importedCount: number;
  readonly importedLinkIds: readonly string[];
  readonly skipped: readonly NavImportSkipped[];
  readonly revision: number;
}

export interface NavImportPreviewResult {
  readonly items: readonly NavImportItem[];
  readonly skipped: readonly NavImportSkipped[];
  readonly revision: number;
}

// ---------------------------------------------------------------------------
// restore 导入（完整配置恢复：HUB-047 复核修复）
// ---------------------------------------------------------------------------

/**
 * 完整配置恢复时**逐条不导入**的原因（不允许静默丢弃）。
 *
 * 只列真正可能发生的两种：与目标工作空间已有活跃 URL 重复（跳过该链接及其全部成员关系）、
 * 以及链接容量上限（整批已在规划前被拒，这里只作为逐项明细的兜底）。
 * 「文档结构 / 引用完整性 / 危险 URL / 未来版本」不属于逐项原因——它们是**整份文档**
 * 被拒绝（413/422），因为只导入一部分版本化配置等于静默丢数据。
 */
export type NavRestoreSkipReason = 'duplicate_url' | 'link_limit_reached';

export interface NavRestoreSkipped {
  readonly reason: NavRestoreSkipReason;
  readonly detail: string;
}

export interface NavRestoreIdMaps {
  /** 外部 link ID → 本工作空间新 link ID（memberships 已按这份映射重写）。 */
  readonly links: Readonly<Record<string, string>>;
  /** 外部 group ID → 本工作空间新 group ID。 */
  readonly groups: Readonly<Record<string, string>>;
}

export interface NavRestorePreviewResult {
  readonly links: number;
  readonly groups: number;
  readonly memberships: number;
  readonly conflicts: readonly NavRestoreSkipped[];
  readonly expectedRevision: number;
}

export interface NavRestoreApplyResult {
  readonly importedLinks: number;
  readonly importedGroups: number;
  readonly importedMemberships: number;
  readonly skipped: readonly NavRestoreSkipped[];
  readonly idMaps: NavRestoreIdMaps;
  readonly revision: number;
}

/** 逐条目录导入结果（界面据此解释「这条被跳过是因为你自己改过 / 你删过它」）。 */
export interface NavCatalogImportItemResult {
  readonly catalogId: string;
  readonly action: 'insert' | 'update' | 'restore_tombstone' | 'skip';
  readonly reason: string;
  /**
   * 该目录条目对应的个人副本行 ID：写入时是被写入的行；`skip` 时若已存在副本也给出
   * （便于界面指出是哪一条），完全没有副本时为 null。
   */
  readonly linkId: string | null;
}

export interface NavCatalogImportResult {
  readonly decisions: readonly NavCatalogImportItemResult[];
  readonly importedCount: number;
  readonly importedLinkIds: readonly string[];
  /** 被显式恢复的墓碑行 ID（「这会恢复你删除过的条目」的可见证据）。 */
  readonly restoredLinkIds: readonly string[];
  readonly skippedCatalogIds: readonly string[];
  readonly revision: number;
}

export interface NavService {
  /** 快照：活跃链接 + 活跃分组 + 活跃成员关系 + 工作空间修订号 + 目录版本 + 上限。 */
  readSnapshot(workspaceId: string): Promise<NavSnapshot>;
  /** 工作空间级导航修订号（重排 / 导入的 CAS 基准）。 */
  readRevision(workspaceId: string): Promise<number>;
  /** 服务端筛选 / 排序视图（用共享 `projectNavLinks` 计算，绝不在 SQL 里重写规则）。 */
  listViews(workspaceId: string, filter: NavFilter): Promise<NavLinkView[]>;
  createLink(input: CreateNavLinkInput): Promise<NavResult<{ readonly link: NavLink }>>;
  updateLink(input: UpdateNavLinkInput): Promise<NavResult<{ readonly link: NavLink }>>;
  deleteLink(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly linkId: string;
    readonly expectedRevision: number;
  }): Promise<NavResult<{ readonly deletedId: string; readonly revision: number }>>;
  reorderLinks(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly orderedIds: readonly string[];
    readonly expectedRevision: number;
  }): Promise<NavResult<{ readonly revision: number }>>;
  setLinkGroups(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly linkId: string;
    readonly groupIds: readonly string[];
    readonly expectedRevision: number;
  }): Promise<NavResult<{ readonly revision: number }>>;
  createGroup(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly name: string;
    readonly sortOrder?: number | undefined;
  }): Promise<NavResult<{ readonly group: NavGroup }>>;
  updateGroup(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly groupId: string;
    readonly expectedRevision: number;
    readonly name?: string | undefined;
    readonly sortOrder?: number | undefined;
  }): Promise<NavResult<{ readonly group: NavGroup }>>;
  deleteGroup(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly groupId: string;
    readonly expectedRevision: number;
  }): Promise<NavResult<{ readonly deletedId: string; readonly revision: number }>>;
  reorderGroups(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly orderedIds: readonly string[];
    readonly expectedRevision: number;
  }): Promise<NavResult<{ readonly revision: number }>>;
  /**
   * 导出（只含活跃行、不含任何凭证；可被共享 `parseNavExportDocument` 读回）。
   *
   * 返回 `NavResult`：若**同一批**读出的行组合出的文档过不了共享
   * `validateNavExportIntegrity`（例如出现悬空成员关系），则**如实失败**，
   * 绝不产出一份自相矛盾的导出（`export_integrity_failed`）。
   */
  exportDocument(workspaceId: string): Promise<NavResult<NavExportDocument>>;
  /** 导入**预览**（只读）：服务端重新校验条目，并给出「与现有 URL 重复」等逐项跳过原因。 */
  previewImport(input: {
    readonly workspaceId: string;
    readonly items: readonly NavImportItem[];
    readonly targetGroupId?: string | undefined;
  }): Promise<NavResult<NavImportPreviewResult>>;
  /** `restore` 预览（只读）：按**已校验的完整配置文档**给出计数与冲突，绝不写入。 */
  previewRestore(input: {
    readonly workspaceId: string;
    readonly document: NavExportDocument;
  }): Promise<NavResult<NavRestorePreviewResult>>;
  /** `restore` 落地：重映射 ID、保留全部功能字段与多对多归属，单事务 + operationId 幂等。 */
  importRestoreItems(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly document: NavExportDocument;
    readonly expectedRevision: number;
  }): Promise<NavResult<NavRestoreApplyResult>>;
  /** 导入落地（单事务、按 operationId 幂等；`expectedRevision` 是预览新鲜度令牌）。 */
  importItems(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly items: readonly NavImportItem[];
    readonly targetGroupId?: string | undefined;
    readonly expectedRevision: number;
  }): Promise<NavResult<NavImportApplyResult>>;
  /** 目录导入（逐条决策；墓碑只在 `explicitReimport` 时恢复，个人修改默认不被覆盖）。 */
  importCatalogEntries(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly catalogIds: readonly string[];
    readonly explicitReimport?: boolean | undefined;
    readonly overwriteUserEdits?: boolean | undefined;
  }): Promise<NavResult<NavCatalogImportResult>>;
}

// ---------------------------------------------------------------------------
// 共享小工具
// ---------------------------------------------------------------------------

/** 去重但保持顺序（同一分组在数组里出现两次只是同一个成员关系，重排语义不受影响）。 */
function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 构造逐项跳过记录；detail 刻意**不含**用户数据（标题 / URL 已有专门字段，且长度受限）。 */
function skipOf(
  reason: NavImportSkipReason,
  detail: string,
  title: string | null,
  url: string | null,
): NavImportSkipped {
  return { reason, detail, title, url };
}

/**
 * 行级并发冲突（结构化 details，ADR-0004 D7 / D11）。
 *
 * 用共享 `navConflictSchema` 校验一次：details 的形状是**对外契约**，
 * 手工拼一个形状可疑的对象就等于让客户端拿到无法执行的冲突。
 * 这里的取值全部来自服务端自己（枚举 + 整数 + 本空间的实体 ID），校验只是把不变量写死。
 */
function revisionConflict(input: {
  readonly entityType: 'nav_link' | 'nav_group';
  readonly entityId: string;
  readonly field: string | null;
  readonly baseRevision: number;
  readonly currentRevision: number;
}): NavFailure {
  const conflict: NavConflict = navConflictSchema.parse({
    reason: 'revision_conflict',
    entityType: input.entityType,
    entityId: input.entityId,
    field: input.field,
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    resolutionOptions: ['local', 'server'],
  });
  return navFailure(
    'revision_conflict',
    `${input.entityType} 的修订号已从 ${String(input.baseRevision)} 变为 ${String(input.currentRevision)}`,
    conflict,
  );
}

/** 从 patch 里挑出「冲突字段」：只有一个字段时给出字段名，多字段/整体操作为 null（不猜）。 */
function conflictFieldOf(patch: NavLinkPatch): string | null {
  const keys = Object.keys(patch);
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

/** 规范化导入条目（预览与落地**共用同一份**，因此两者的判定必然一致）。 */
function normalizeImportItem(item: NavImportItem): NavImportItem {
  return {
    title: item.title.trim().slice(0, MAX_NAV_TITLE_LENGTH),
    url: item.url.trim(),
    ...(item.description === undefined
      ? {}
      : { description: item.description.slice(0, MAX_NAV_DESCRIPTION_LENGTH) }),
    tags: normalizeNavTags(item.tags ?? []),
    aliases: normalizeNavAliases(item.aliases ?? []),
    icon: sanitizeNavIcon(item.icon ?? ''),
    openMode: item.openMode ?? 'new_tab',
    // 区服默认取迁移里的默认值 `cn`；与共享书签解析器（`parseBookmarkHtml` 的
    // `defaultRegion: 'cn'`）一致，避免同一个书签文件在两条路径上落到不同区服。
    region: item.region ?? 'cn',
    ...(item.groupName === undefined
      ? {}
      : { groupName: item.groupName.trim().slice(0, MAX_NAV_GROUP_NAME_LENGTH) }),
  };
}

/**
 * 「这些分组都属于本工作空间且活跃」的认领前置条件。
 *
 * 为什么每条都是独立 `EXISTS` 而不是拼 `IN (?, ?, …)`：条件 SQL 的**结构**是常量，
 * 只有占位符数量随分组数变化；值全部走绑定参数，因此没有注入面，也不需要拼接用户数据。
 * 数量上限是 `MAX_NAV_GROUPS_PER_LINK`（20），语句长度可控。
 */
function groupsActiveCondition(input: {
  readonly workspaceId: string;
  readonly groupIds: readonly string[];
}): { readonly sql: string; readonly binds: readonly unknown[] } {
  const clauses = input.groupIds.map(
    () => 'EXISTS (SELECT 1 FROM workspace_nav_groups g WHERE g.id = ? AND g.workspace_id = ? AND g.deleted_at IS NULL)',
  );
  const binds: unknown[] = [];
  for (const groupId of input.groupIds) {
    binds.push(groupId, input.workspaceId);
  }
  return { sql: clauses.join(' AND '), binds };
}

/** 组合若干前置条件片段（空片段被忽略，因此不会产生 `AND ` 悬空）。 */
function allOf(...conditions: readonly { readonly sql: string; readonly binds: readonly unknown[] }[]): {
  readonly sql: string;
  readonly binds: readonly unknown[];
} {
  const parts = conditions.filter((condition) => condition.sql.length > 0);
  const binds: unknown[] = [];
  for (const part of parts) {
    binds.push(...part.binds);
  }
  return { sql: parts.map((part) => part.sql).join(' AND '), binds };
}

/** 「工作空间导航修订号等于给定值」的前置条件（集合级 CAS）。 */
function navRevisionCondition(workspaceId: string, revision: number): {
  readonly sql: string;
  readonly binds: readonly unknown[];
} {
  return {
    sql: 'COALESCE((SELECT s.revision FROM workspace_nav_state s WHERE s.workspace_id = ?), 0) = ?',
    binds: [workspaceId, revision],
  };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

interface PlannedImportItem {
  readonly item: NavImportItem;
  readonly groupId: string | null;
  readonly sortOrder: number;
}

interface ImportPlan {
  readonly accepted: readonly PlannedImportItem[];
  readonly skipped: readonly NavImportSkipped[];
  readonly newGroups: readonly { readonly id: string; readonly name: string; readonly sortOrder: number }[];
  /** 规划所依据的**那个批**里读到的工作空间修订号（CAS 必须绑定它，不再二次读取）。 */
  readonly revision: number;
}

/** 一条被跳过的 restore 链接（连同它的全部成员关系一起不导入）。 */
interface RestoreSkippedLink {
  readonly oldId: string;
  readonly skip: NavRestoreSkipped;
}

/** restore 的执行计划：**只**由同一次批次读取 + 校验过的文档算出。 */
interface RestoreExecutionPlan {
  readonly links: readonly NavLink[];
  readonly groups: readonly NavGroup[];
  /** 只含两端都在本次导入里、且按「链接 / 分组」重映射后的成员关系。 */
  readonly memberships: readonly NavMembership[];
  readonly importedLinkIds: readonly string[];
  readonly importedGroupIds: readonly string[];
  /** 被导入的链接真正用到的分组 ID（文档里的空分组不算「有成员关系」）。 */
  readonly usedGroupIds: ReadonlySet<string>;
  readonly skippedLinks: readonly RestoreSkippedLink[];
  /** 外部 link ID → 新 link ID（与 `links` 同序生成，成员关系已按它重写）。 */
  readonly linkIdMap: Readonly<Record<string, string>>;
  /** 外部 group ID → 新 group ID。 */
  readonly groupIdMap: Readonly<Record<string, string>>;
}

export function createNavService(deps: NavServiceDeps): NavService {
  const now = deps.now ?? ((): number => Date.now());

  /** 统一的写入入口：组装认领语句、构造带守卫的变更语句、执行原子幂等事务。 */
  function runOperation<T>(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    readonly requestFingerprint: string;
    readonly preconditionSql: string;
    readonly preconditionBinds: readonly unknown[];
    readonly build: () => readonly NavStatement[];
    readonly result: T;
    readonly explain: () => Promise<NavFailure | null>;
  }): Promise<NavResult<T>> {
    const timestamp = now();
    return runIdempotentWrite<T>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: input.requestFingerprint,
      now: timestamp,
      preconditionSql: input.preconditionSql,
      preconditionBinds: input.preconditionBinds,
      buildStatements: (guard: IdempotencyGuard) => guardedStatements(deps.db, guard, input.build()),
      result: input.result,
      explain: input.explain,
    });
  }

  /**
   * 幂等入口守卫：先算本次意图的指纹，再看是否已有同 ID 的成功记录。
   *
   * 两件事必须成对出现——只查 ID 不查指纹会把「同 ID 换 body」当重放放行；
   * 只算指纹不先短路会让「响应丢失后原样重试」被前置条件（revision / 计数 / 新鲜度）早退成 409。
   */
  async function replayGuard<T>(input: {
    readonly workspaceId: string;
    readonly operationId: string;
    readonly kind: string;
    readonly intent: unknown;
  }): Promise<{ readonly fingerprint: string; readonly replay: NavResult<T> | null }> {
    const fingerprint = await fingerprintOf(input.kind, input.intent);
    const replay = await readNavReplay<T>({
      db: deps.db,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      requestFingerprint: fingerprint,
    });
    return { fingerprint, replay };
  }

  /** 读「活跃分组表」，用于校验关联 ID 与复用同名分组。 */
  async function resolveGroups(workspaceId: string, groupIds: readonly string[]): Promise<{
    readonly rows: NavGroupRow[];
    readonly missing: string[];
  }> {
    const rows = await readGroupRows(deps.db, workspaceId);
    const known = new Set(rows.map((row) => row.id));
    return { rows, missing: groupIds.filter((id) => !known.has(id)) };
  }

  /**
   * 成员关系整体替换语句（`groupIds` 是目标集合，顺序即链接内的分组展示顺序基准）。
   *
   * `currentGroupIds` 来自同一请求内的读；被移除的走墓碑，被加回/新增的走
   * `addMembershipStatements`（复活墓碑或补插缺失行）。
   */
  function membershipReplaceStatements(input: {
    readonly workspaceId: string;
    readonly linkId: string;
    readonly currentGroupIds: readonly string[];
    readonly groupIds: readonly string[];
    readonly sortOrder: number;
    readonly timestamp: number;
  }): NavStatement[] {
    const target = new Set(input.groupIds);
    const statements: NavStatement[] = [];
    for (const groupId of input.currentGroupIds) {
      if (!target.has(groupId)) {
        statements.push(
          tombstoneMembershipStatement({
            linkId: input.linkId,
            groupId,
            workspaceId: input.workspaceId,
            now: input.timestamp,
          }),
        );
      }
    }
    for (const groupId of input.groupIds) {
      statements.push(
        ...addMembershipStatements({
          linkId: input.linkId,
          groupId,
          workspaceId: input.workspaceId,
          sortOrder: input.sortOrder,
          now: input.timestamp,
        }),
      );
    }
    return statements;
  }

  /**
   * 导入计划（预览与落地共用）：逐条判定 accepted / skipped。
   *
   * 判定顺序是刻意的：先形态（URL / 标题），再重复（批内 → 工作空间内），
   * 再容量（链接 → 分组）。这样「被跳过的原因」总是最具体的那一个，
   * 而不会因为容量已满就把一条本来就非法的 URL 报成「超限」。
   */
  async function planImport(input: {
    readonly workspaceId: string;
    readonly items: readonly NavImportItem[];
    readonly targetGroupId?: string;
    /**
     * 已经读到的修订号（可选）。给定时只做一次 batch 读「活跃链接 + 活跃分组」，
     * 判定与 CAS 基准仍来自同一时刻——`importItems` 用它保证「新鲜度检查」与
     * 「规划」看到的是同一批数据，而不是两次独立读取。
     */
    readonly revision?: number;
  }): Promise<NavResult<ImportPlan>> {
    // 一次 batch 读出「活跃链接 + 活跃分组 + 修订号」：判定与 CAS 基准来自**同一时刻**。
    const batch = await readImportPlanBatch({ db: deps.db, workspaceId: input.workspaceId });
    const links = batch.linkRows;
    const groups = batch.groupRows;
    // 调用方已经读过修订号时以它为准（同一批数据里读到的值），避免「读两次」产生组合。
    const revision = input.revision ?? batch.revision;

    // 目标分组必须属于本工作空间（越权 → 404，且整批零写入）。
    let targetGroup: NavGroupRow | null = null;
    if (input.targetGroupId !== undefined) {
      targetGroup = groups.find((group) => group.id === input.targetGroupId) ?? null;
      if (targetGroup === null) {
        return navFailure('group_not_found', '目标分组不存在或不属于本工作空间');
      }
    }

    const existingUrls = new Set(links.map((link) => normalizeNavText(link.url)));
    // 同名分组复用：按规范化名称取第一个（分组已按 sort_order, created_at, id 稳定排序，
    // 因此「有两个同名分组时复用哪一个」是确定性的，而不是随数据库返回顺序变化）。
    const groupByNormalizedName = new Map<string, NavGroupRow>();
    for (const group of groups) {
      const key = normalizeNavText(group.name);
      if (!groupByNormalizedName.has(key)) {
        groupByNormalizedName.set(key, group);
      }
    }

    let linkSortOrder = links.reduce((max, link) => Math.max(max, link.sort_order + 1), 0);
    let activeCount = links.length;
    const groupSortOrder = groups.reduce((max, group) => Math.max(max, group.sort_order + 1), 0);

    const accepted: PlannedImportItem[] = [];
    const skipped: NavImportSkipped[] = [];
    const newGroups: { id: string; name: string; sortOrder: number }[] = [];
    const newGroupByKey = new Map<string, { id: string; name: string; sortOrder: number }>();
    const seenInBatch = new Set<string>();

    for (const raw of input.items.slice(0, MAX_NAV_IMPORT_ITEMS)) {
      const item = normalizeImportItem(raw);
      if (item.title.length === 0) {
        skipped.push(skipOf('missing_title', '条目没有可用标题，无法作为导航条目', null, item.url));
        continue;
      }
      const validation = validateNavUrl(item.url);
      if (!validation.ok) {
        const scheme = validation.reason === 'scheme';
        skipped.push(
          skipOf(
            scheme ? 'unsupported_scheme' : 'invalid_url',
            scheme
              ? '只允许 https:// 链接，已跳过非 https 地址'
              : 'URL 形态不可用（缺少主机、含凭证或超长）',
            item.title,
            item.url,
          ),
        );
        continue;
      }
      const urlKey = normalizeNavText(validation.url);
      if (seenInBatch.has(urlKey)) {
        skipped.push(skipOf('duplicate', '同一批导入里出现了重复 URL', item.title, validation.url));
        continue;
      }
      if (existingUrls.has(urlKey)) {
        skipped.push(skipOf('duplicate', '工作空间里已存在同一 URL 的链接，已跳过', item.title, validation.url));
        continue;
      }
      if (activeCount >= MAX_NAV_LINKS_PER_WORKSPACE) {
        skipped.push(
          skipOf(
            'too_many_items',
            `已达单工作空间链接上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}`,
            item.title,
            validation.url,
          ),
        );
        continue;
      }

      let groupId = targetGroup?.id ?? null;
      if (targetGroup === null && item.groupName !== undefined && item.groupName.length > 0) {
        const groupKey = normalizeNavText(item.groupName);
        const existing = groupByNormalizedName.get(groupKey);
        const planned = newGroupByKey.get(groupKey);
        if (existing !== undefined) {
          groupId = existing.id;
        } else if (planned !== undefined) {
          groupId = planned.id;
        } else if (groups.length + newGroups.length >= MAX_NAV_GROUPS_PER_WORKSPACE) {
          skipped.push(
            skipOf(
              'too_many_items',
              `分组数量已达上限 ${String(MAX_NAV_GROUPS_PER_WORKSPACE)}，无法为同名分组新建`,
              item.title,
              validation.url,
            ),
          );
          continue;
        } else {
          const created = { id: crypto.randomUUID(), name: item.groupName, sortOrder: groupSortOrder + newGroups.length };
          newGroups.push(created);
          newGroupByKey.set(groupKey, created);
          groupId = created.id;
        }
      }

      seenInBatch.add(urlKey);
      activeCount += 1;
      accepted.push({ item: { ...item, url: validation.url }, groupId, sortOrder: linkSortOrder });
      linkSortOrder += 1;
    }

    return { ok: true, replayed: false, value: { accepted, skipped, newGroups, revision } };
  }

  /** 为一个目录条目确定初始分组（分类名复用 / 新建），返回分组 ID。 */
  function planCategoryGroup(input: {
    readonly category: string;
    readonly groups: readonly NavGroupRow[];
    readonly newGroups: { id: string; name: string; sortOrder: number }[];
  }): string | null {
    const key = normalizeNavText(input.category);
    for (const group of input.groups) {
      if (normalizeNavText(group.name) === key) {
        return group.id;
      }
    }
    for (const group of input.newGroups) {
      if (normalizeNavText(group.name) === key) {
        return group.id;
      }
    }
    if (input.groups.length + input.newGroups.length >= MAX_NAV_GROUPS_PER_WORKSPACE) {
      return null;
    }
    const sortOrder = input.groups.reduce((max, group) => Math.max(max, group.sort_order + 1), 0) + input.newGroups.length;
    const created = { id: crypto.randomUUID(), name: input.category, sortOrder };
    input.newGroups.push(created);
    return created.id;
  }

  /**
   * 目标工作空间里已有的活跃 URL 集合（规范化后比较，与普通导入「与现有 URL 重复」同一口径）。
   * 只用来**跳过重复链接**，绝不参与任何 ID 判定。
   */
  function urlKeysOf(rows: readonly NavLinkRow[]): ReadonlySet<string> {
    return new Set(rows.map((row) => normalizeNavText(row.url)));
  }

  /** 逐条不导入记录：detail 只含可安全回显的计数 / 文本，绝不含凭证。 */
  function restoreSkipOf(reason: NavRestoreSkipReason, detail: string): NavRestoreSkipped {
    return { reason, detail };
  }

  /**
   * `restore` 的**唯一**规划实现（预览与落地共用，因此在预览里看到的计数与冲突就是落地时的行为）：
   *
   * ① 为每个 link / group **重映射新 ID** —— 外部 ID 一律不采用，否则一份别的
   *    工作空间（甚至别的用户）的导出文件就能引用本空间的既有行；
   * ② 插入 groups（name / sortOrder，逐个保留文档顺序）；
   * ③ 插入 links（**保留全部功能字段**：title/url/description/tags/aliases/icon/openMode/
   *    region/status/isFavorite/sortOrder/sourceCatalogId/importedSourceVersion）；
   * ④ 插入 memberships（用重映射后的两端 ID + 各自的 sortOrder）；
   * ⑤ 与目标工作空间已有活跃 URL 重复的链接：**跳过该链接及其全部成员关系**，逐条记录原因
   *    （不静默丢弃）。
   *
   * 容量（链接 / 分组数）与既有常量一致：超限时**整份请求拒绝**（返回失败），
   * 绝不做「导入一半」。
   */
  function planRestore(input: {
    readonly document: NavExportDocument;
    readonly existingLinkUrls: ReadonlySet<string>;
  }): NavResult<RestoreExecutionPlan> {
    const document = input.document;
    if (document.links.length > MAX_NAV_LINKS_PER_WORKSPACE) {
      return navFailure(
        'link_limit_reached',
        `待恢复链接 ${String(document.links.length)} 条，超过单工作空间上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}`,
      );
    }
    if (document.groups.length > MAX_NAV_GROUPS_PER_WORKSPACE) {
      return navFailure(
        'group_limit_reached',
        `待恢复分组 ${String(document.groups.length)} 个，超过单工作空间上限 ${String(MAX_NAV_GROUPS_PER_WORKSPACE)}`,
      );
    }

    const groupIdMap: Record<string, string> = {};
    const groups: NavGroup[] = document.groups.map((group) => {
      const id = crypto.randomUUID();
      groupIdMap[group.id] = id;
      return { id, name: group.name, sortOrder: group.sortOrder } as NavGroup;
    });

    const linkIdMap: Record<string, string> = {};
    const links: NavLink[] = [];
    const importedLinkIds: string[] = [];
    const skippedLinks: RestoreSkippedLink[] = [];
    const takenUrls = new Set(input.existingLinkUrls);

    for (const link of document.links) {
      if (links.length >= MAX_NAV_LINKS_PER_WORKSPACE) {
        skippedLinks.push({
          oldId: link.id,
          skip: restoreSkipOf(
            'link_limit_reached',
            `已达单工作空间链接上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}，该链接及其成员关系未导入`,
          ),
        });
        continue;
      }
      const urlKey = normalizeNavText(link.url);
      if (takenUrls.has(urlKey)) {
        // 同一 URL 已在目标工作空间（或本文件更前面）出现：跳过它**和**它的全部成员关系。
        skippedLinks.push({
          oldId: link.id,
          skip: restoreSkipOf('duplicate_url', `URL 已存在，已跳过该链接及其成员关系：${link.url}`),
        });
        continue;
      }
      takenUrls.add(urlKey);

      const id = crypto.randomUUID();
      linkIdMap[link.id] = id;
      // 逐个字段复制（显式列出，**不含** row id → 保证「不采用外部 ID」不是靠遗漏实现的）。
      links.push({
        id,
        sourceCatalogId: link.sourceCatalogId,
        importedSourceVersion: link.importedSourceVersion,
        title: link.title,
        url: link.url,
        description: link.description,
        tags: normalizeNavTags(link.tags),
        aliases: normalizeNavAliases(link.aliases),
        icon: sanitizeNavIcon(link.icon),
        openMode: link.openMode,
        region: link.region,
        status: link.status,
        isFavorite: link.isFavorite,
        sortOrder: link.sortOrder,
        health: 'unknown',
        healthCheckedAt: null,
        revision: 0,
        deletedAt: null,
        createdAt: 0,
        updatedAt: 0,
      });
      importedLinkIds.push(id);
    }

    // 成员关系：两端都在本次导入里的才建立（其余按「链接被跳过」逐条已在上面记录，
    // 文档自身的引用完整性已由共享 `validateNavExportIntegrity` 保证）。
    const memberships: NavMembership[] = [];
    const usedGroupIds = new Set<string>();
    for (const membership of document.memberships) {
      const linkId = linkIdMap[membership.linkId];
      const groupId = groupIdMap[membership.groupId];
      if (linkId === undefined || groupId === undefined) {
        continue;
      }
      usedGroupIds.add(groupId);
      memberships.push({ linkId, groupId, sortOrder: membership.sortOrder, deletedAt: null, updatedAt: 0 });
    }

    return {
      ok: true,
      replayed: false,
      value: {
        links,
        groups,
        memberships,
        importedLinkIds,
        importedGroupIds: groups.map((group) => group.id),
        usedGroupIds,
        skippedLinks,
        linkIdMap,
        groupIdMap,
      },
    };
  }

  const service: NavService = {
    async readSnapshot(workspaceId) {
      // **一个** batch：链接 / 分组 / 成员关系 / 修订号 / 目录版本 / 水位 / 目录条目 / 目录关联行
      // 全部来自同一时刻，因此快照里不会出现「指向已墓碑化分组的成员关系」这类组合，
      // 也不会出现「内容已是恢复后的、水位却停在删除之前」这种协议级竞态（见 readSnapshotBatch）。
      const snapshot = await readSnapshotBatch({ db: deps.db, workspaceId, withCatalog: true });
      return {
        links: snapshot.linkRows.map(toNavLink),
        groups: snapshot.groupRows.map(toNavGroup),
        memberships: snapshot.membershipRows.map(toNavMembership),
        revision: snapshot.revision,
        // 客户端**只**用快照发布状态，并把游标设成这个水位（与内容同批读出，因此 W+1 的历史
        // delete 一定落在它之后，不会被应用到已恢复的数据上）。
        watermark: snapshot.watermark,
        catalogSourceVersion: snapshot.catalogSourceVersion,
        limits: NAV_LIMITS,
        // 目录状态投影：**由服务端**用共享 `catalogUpgradePlan` 计算（含墓碑行），
        // 因此界面能正确显示 `user_modified` / `tombstoned`，并与服务端导入决策同源。
        catalogPlan: catalogUpgradePlan({
          catalog: snapshot.catalogRows,
          links: snapshot.catalogLinkedRows.map(toNavLink),
        }),
      };
    },

    async readRevision(workspaceId) {
      return await readNavStateRevision(deps.db, workspaceId);
    },

    async listViews(workspaceId, filter) {
      // 同一批读出三张表：投影里不可能出现「链接在、分组已删」的半旧组合。
      const batch = await readSnapshotBatch({ db: deps.db, workspaceId, withCatalog: false });
      // 筛选 / 排序 / 投影**全部**走共享纯函数：服务端只负责「本工作空间 + 未删除」。
      return projectNavLinks({
        links: batch.linkRows.map(toNavLink),
        groups: batch.groupRows.map(toNavGroup),
        memberships: batch.membershipRows.map(toNavMembership),
        filter,
      });
    },

    async createLink(input) {
      const groupIds = uniqueIds(input.groupIds ?? []);
      const intent = {
        title: input.title,
        url: input.url,
        description: input.description ?? null,
        tags: input.tags ?? [],
        aliases: input.aliases ?? [],
        icon: input.icon ?? null,
        openMode: input.openMode ?? null,
        region: input.region ?? null,
        status: input.status ?? null,
        isFavorite: input.isFavorite ?? false,
        sortOrder: input.sortOrder ?? null,
        groupIds,
      };
      const guard = await replayGuard<{ link: NavLink }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkCreate,
        intent,
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const validation = validateNavUrl(input.url);
      if (!validation.ok) {
        return navFailure('invalid_url', 'URL 必须是以 https:// 开头的合法地址');
      }
      if (groupIds.length > MAX_NAV_GROUPS_PER_LINK) {
        return navFailure(
          'too_many_groups_per_link',
          `单个链接最多属于 ${String(MAX_NAV_GROUPS_PER_LINK)} 个分组`,
        );
      }
      // 容量判定与「分组是否属于本工作空间」必须来自**同一个快照**（CAS 基准同源）。
      const capacityPlan = await readWritePrecondition({ db: deps.db, workspaceId: input.workspaceId });
      const links = capacityPlan.linkRows;
      const knownGroupIds = new Set(capacityPlan.groupRows.map((row) => row.id));
      const missingGroups = groupIds.filter((id) => !knownGroupIds.has(id));
      if (missingGroups.length > 0) {
        return navFailure('group_not_found', '分组不存在或不属于本工作空间');
      }
      if (links.length >= MAX_NAV_LINKS_PER_WORKSPACE) {
        return navFailure(
          'link_limit_reached',
          `已达单工作空间链接上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}`,
        );
      }

      const timestamp = now();
      const linkId = crypto.randomUUID();
      const sortOrder = input.sortOrder ?? links.reduce((max, link) => Math.max(max, link.sort_order + 1), 0);
      const link: NavLink = {
        id: linkId,
        sourceCatalogId: null,
        importedSourceVersion: null,
        title: input.title,
        url: validation.url,
        description: input.description ?? '',
        tags: normalizeNavTags(input.tags ?? []),
        aliases: normalizeNavAliases(input.aliases ?? []),
        icon: sanitizeNavIcon(input.icon ?? ''),
        openMode: input.openMode ?? 'new_tab',
        region: input.region ?? 'cn',
        status: input.status ?? 'active',
        isFavorite: input.isFavorite === true,
        sortOrder,
        // 阶段 04 不做服务端探测：健康状态一律 unknown（ADR-0004 D4）。
        health: 'unknown',
        healthCheckedAt: null,
        revision: 0,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const linksCondition = {
        sql: '(SELECT COUNT(*) FROM workspace_nav_links c WHERE c.workspace_id = ? AND c.deleted_at IS NULL) = ?',
        binds: [input.workspaceId, links.length],
      };
      const groupsCondition = groupsActiveCondition({ workspaceId: input.workspaceId, groupIds });
      const precondition = allOf(linksCondition, groupsCondition);

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkCreate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: precondition.sql,
        preconditionBinds: precondition.binds,
        build: () => {
          const statements: NavStatement[] = [
            insertLinkStatement({
              id: linkId,
              workspaceId: input.workspaceId,
              sourceCatalogId: null,
              importedSourceVersion: null,
              title: link.title,
              url: link.url,
              description: link.description,
              tags: link.tags,
              aliases: link.aliases,
              icon: link.icon,
              openMode: link.openMode,
              region: link.region,
              status: link.status,
              isFavorite: link.isFavorite,
              sortOrder,
              now: timestamp,
            }),
          ];
          for (const groupId of groupIds) {
            statements.push(
              ...addMembershipStatements({
                linkId,
                groupId,
                workspaceId: input.workspaceId,
                sortOrder,
                now: timestamp,
              }),
            );
          }
          statements.push(...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }));
          return statements;
        },
        result: { link },
        explain: async () => {
          // 失败原因必须用同一快照重读（否则会给出与实际拒绝条件不一致的解释）。
          const recheckPlan = await readWritePrecondition({ db: deps.db, workspaceId: input.workspaceId });
          const current = recheckPlan.linkRows;
          const knownNow = new Set(recheckPlan.groupRows.map((row) => row.id));
          if (groupIds.some((id) => !knownNow.has(id))) {
            return navFailure('group_not_found', '分组不存在或不属于本工作空间');
          }
          if (current.length >= MAX_NAV_LINKS_PER_WORKSPACE) {
            return navFailure(
              'link_limit_reached',
              `已达单工作空间链接上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}`,
            );
          }
          return navFailure('revision_conflict', '工作空间导航数据在写入前发生了变化，请重新读取后再试');
        },
      });
    },

    async updateLink(input) {
      const patch = input.patch;
      const guard = await replayGuard<{ link: NavLink }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkUpdate,
        intent: { linkId: input.linkId, expectedRevision: input.expectedRevision, patch },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const current = await readLinkRow(deps.db, input.workspaceId, input.linkId);
      if (current === null) {
        // 不存在**或属于别的工作空间**：同一个 404，不泄露存在性（ADR-0004 D2）。
        return navFailure('link_not_found', '链接不存在或不属于本工作空间');
      }
      // URL 只有在被 patch 时才替换；替换值必须先过唯一判定（`validateNavUrl`）。
      let nextUrl = current.url;
      if (patch.url !== undefined) {
        const validation = validateNavUrl(patch.url);
        if (!validation.ok) {
          return navFailure('invalid_url', 'URL 必须是以 https:// 开头的合法地址');
        }
        nextUrl = validation.url;
      }
      const groupIds = patch.groupIds === undefined ? null : uniqueIds(patch.groupIds);
      if (groupIds !== null && groupIds.length > MAX_NAV_GROUPS_PER_LINK) {
        return navFailure(
          'too_many_groups_per_link',
          `单个链接最多属于 ${String(MAX_NAV_GROUPS_PER_LINK)} 个分组`,
        );
      }
      const field = conflictFieldOf(patch);
      if (current.revision !== input.expectedRevision) {
        return revisionConflict({
          entityType: 'nav_link',
          entityId: input.linkId,
          field,
          baseRevision: input.expectedRevision,
          currentRevision: current.revision,
        });
      }
      if (groupIds !== null) {
        const resolved = await resolveGroups(input.workspaceId, groupIds);
        if (resolved.missing.length > 0) {
          return navFailure('group_not_found', '分组不存在或不属于本工作空间');
        }
      }

      const currentLink = toNavLink(current);
      const timestamp = now();
      const next: NavLink = {
        ...currentLink,
        title: patch.title ?? current.title,
        url: nextUrl,
        description: patch.description ?? current.description,
        tags: patch.tags === undefined ? parseStringArray(current.tags_json) : normalizeNavTags(patch.tags),
        aliases: patch.aliases === undefined ? parseStringArray(current.aliases_json) : normalizeNavAliases(patch.aliases),
        icon: patch.icon === undefined ? current.icon : sanitizeNavIcon(patch.icon),
        openMode: patch.openMode ?? currentLink.openMode,
        region: patch.region ?? currentLink.region,
        status: patch.status ?? currentLink.status,
        isFavorite: patch.isFavorite ?? current.is_favorite === 1,
        sortOrder: patch.sortOrder ?? current.sort_order,
        revision: current.revision + 1,
        // 响应必须带上**这一写**落库的 updatedAt：回显旧值会让客户端以为自己手上的
        // 副本是最新的，进而跳过必要的刷新（同步水位也以该字段为准）。
        updatedAt: timestamp,
      };

      const linkCondition = {
        sql: 'EXISTS (SELECT 1 FROM workspace_nav_links l WHERE l.id = ? AND l.workspace_id = ? AND l.deleted_at IS NULL AND l.revision = ?)',
        binds: [input.linkId, input.workspaceId, input.expectedRevision],
      };
      const groupsCondition = groupIds === null ? { sql: '', binds: [] } : groupsActiveCondition({
        workspaceId: input.workspaceId,
        groupIds,
      });
      const precondition = allOf(linkCondition, groupsCondition);
      const currentGroupIds =
        groupIds === null
          ? []
          : (
              await deps.db
                .prepare(
                  `SELECT ${MEMBERSHIP_COLUMNS} FROM workspace_nav_memberships
                    WHERE workspace_id = ? AND link_id = ? AND deleted_at IS NULL
                    ORDER BY sort_order ASC, group_id ASC`,
                )
                .bind(input.workspaceId, input.linkId)
                .all<NavMembershipRow>()
            ).results.map((row) => row.group_id);

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkUpdate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: precondition.sql,
        preconditionBinds: precondition.binds,
        build: () => {
          const statements: NavStatement[] = [
            updateLinkContentStatement({
              id: input.linkId,
              workspaceId: input.workspaceId,
              expectedRevision: input.expectedRevision,
              title: next.title,
              url: next.url,
              description: next.description,
              tags: next.tags,
              aliases: next.aliases,
              icon: next.icon,
              openMode: next.openMode,
              region: next.region,
              status: next.status,
              isFavorite: next.isFavorite,
              sortOrder: next.sortOrder,
              now: timestamp,
            }),
          ];
          if (groupIds !== null) {
            statements.push(
              ...membershipReplaceStatements({
                workspaceId: input.workspaceId,
                linkId: input.linkId,
                currentGroupIds,
                groupIds,
                sortOrder: next.sortOrder,
                timestamp,
              }),
            );
          }
          statements.push(...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }));
          return statements;
        },
        result: { link: next },
        explain: async () => {
          const latest = await readLinkRow(deps.db, input.workspaceId, input.linkId);
          if (latest === null) {
            return navFailure('link_not_found', '链接不存在或不属于本工作空间');
          }
          if (groupIds !== null) {
            const resolvedNow = await resolveGroups(input.workspaceId, groupIds);
            if (resolvedNow.missing.length > 0) {
              return navFailure('group_not_found', '分组不存在或不属于本工作空间');
            }
          }
          return revisionConflict({
            entityType: 'nav_link',
            entityId: input.linkId,
            field,
            baseRevision: input.expectedRevision,
            currentRevision: latest.revision,
          });
        },
      });
    },

    async deleteLink(input) {
      const guard = await replayGuard<{ deletedId: string; revision: number }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkDelete,
        intent: { linkId: input.linkId, expectedRevision: input.expectedRevision },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const current = await readLinkRow(deps.db, input.workspaceId, input.linkId);
      if (current === null) {
        return navFailure('link_not_found', '链接不存在或不属于本工作空间');
      }
      if (current.revision !== input.expectedRevision) {
        return revisionConflict({
          entityType: 'nav_link',
          entityId: input.linkId,
          field: null,
          baseRevision: input.expectedRevision,
          currentRevision: current.revision,
        });
      }
      const timestamp = now();
      const revision = (await readNavStateRevision(deps.db, input.workspaceId)) + 1;
      const linkCondition = {
        sql: 'EXISTS (SELECT 1 FROM workspace_nav_links l WHERE l.id = ? AND l.workspace_id = ? AND l.deleted_at IS NULL AND l.revision = ?)',
        binds: [input.linkId, input.workspaceId, input.expectedRevision],
      };
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkDelete,
        requestFingerprint: guard.fingerprint,
        preconditionSql: linkCondition.sql,
        preconditionBinds: linkCondition.binds,
        build: () => [
          // 成员关系与链接一并墓碑化：删除链接后不应留下幽灵分组归属。
          tombstoneMembershipsOfLinkStatement({
            linkId: input.linkId,
            workspaceId: input.workspaceId,
            now: timestamp,
          }),
          tombstoneLinkStatement({
            id: input.linkId,
            workspaceId: input.workspaceId,
            expectedRevision: input.expectedRevision,
            now: timestamp,
          }),
          ...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { deletedId: input.linkId, revision },
        explain: async () => {
          const latest = await readLinkRow(deps.db, input.workspaceId, input.linkId);
          if (latest === null) {
            return navFailure('link_not_found', '链接不存在或不属于本工作空间');
          }
          return revisionConflict({
            entityType: 'nav_link',
            entityId: input.linkId,
            field: null,
            baseRevision: input.expectedRevision,
            currentRevision: latest.revision,
          });
        },
      });
    },

    async reorderLinks(input) {
      const orderedIds = uniqueIds(input.orderedIds);
      const guard = await replayGuard<{ revision: number }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkReorder,
        intent: { orderedIds, expectedRevision: input.expectedRevision },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      // 集合判定与 CAS 基准必须同源：否则并发下可能「按旧集合放行」或「按旧 revision 拒绝」。
      const reorderPlan = await readWritePrecondition({ db: deps.db, workspaceId: input.workspaceId });
      const links = reorderPlan.linkRows;
      const revision = reorderPlan.revision;
      if (revision !== input.expectedRevision) {
        return navFailure(
          'revision_conflict',
          `工作空间导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(revision)}`,
        );
      }
      // 整体替换：给出的集合必须**恰好等于**当前活跃链接集合，否则零写入（绝不部分应用）。
      if (orderedIds.length !== links.length || orderedIds.length !== input.orderedIds.length) {
        return navFailure(
          'reorder_set_mismatch',
          `需要给出全部 ${String(links.length)} 条活跃链接（且不重复），收到 ${String(input.orderedIds.length)} 条`,
        );
      }
      const currentIds = new Set(links.map((link) => link.id));
      const unknown = orderedIds.filter((id) => !currentIds.has(id));
      if (unknown.length > 0) {
        return navFailure(
          'reorder_set_mismatch',
          `给出的顺序里包含 ${String(unknown.length)} 条不属于本工作空间（或已删除）的链接`,
        );
      }

      const timestamp = now();
      const byId = new Map(links.map((link) => [link.id, link] as const));
      const statements: NavStatement[] = [];
      orderedIds.forEach((linkId, index) => {
        const row = byId.get(linkId);
        if (row === undefined || row.sort_order === index) {
          return;
        }
        statements.push({
          sql: `UPDATE workspace_nav_links
                   SET sort_order = ?, revision = revision + 1, updated_at = ?
                 WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
          binds: [index, timestamp, linkId, input.workspaceId],
        });
        // 组内顺序是「链接手动顺序在该分组内的快照」，重排时必须同步刷新。
        statements.push(
          syncMembershipOrderStatement({
            linkId,
            workspaceId: input.workspaceId,
            sortOrder: index,
            now: timestamp,
          }),
        );
      });
      statements.push(...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }));

      const revisionCondition = navRevisionCondition(input.workspaceId, input.expectedRevision);
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkReorder,
        requestFingerprint: guard.fingerprint,
        preconditionSql: revisionCondition.sql,
        preconditionBinds: revisionCondition.binds,
        build: () => statements,
        result: { revision: revision + 1 },
        explain: async () => {
          const latest = await readNavStateRevision(deps.db, input.workspaceId);
          if (latest !== input.expectedRevision) {
            return navFailure(
              'revision_conflict',
              `工作空间导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(latest)}`,
            );
          }
          return navFailure('reorder_set_mismatch', '链接集合在写入前发生了变化，请重新读取后再试');
        },
      });
    },

    async setLinkGroups(input) {
      const groupIds = uniqueIds(input.groupIds);
      const guard = await replayGuard<{ revision: number }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkSetGroups,
        intent: {
          linkId: input.linkId,
          groupIds,
          expectedRevision: input.expectedRevision,
        },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      if (groupIds.length > MAX_NAV_GROUPS_PER_LINK) {
        return navFailure(
          'too_many_groups_per_link',
          `单个链接最多属于 ${String(MAX_NAV_GROUPS_PER_LINK)} 个分组`,
        );
      }
      const current = await readLinkRow(deps.db, input.workspaceId, input.linkId);
      if (current === null) {
        return navFailure('link_not_found', '链接不存在或不属于本工作空间');
      }
      if (current.revision !== input.expectedRevision) {
        return revisionConflict({
          entityType: 'nav_link',
          entityId: input.linkId,
          field: 'groupIds',
          baseRevision: input.expectedRevision,
          currentRevision: current.revision,
        });
      }
      const resolved = await resolveGroups(input.workspaceId, groupIds);
      if (resolved.missing.length > 0) {
        return navFailure('group_not_found', '分组不存在或不属于本工作空间');
      }
      const currentRows = await deps.db
        .prepare(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM workspace_nav_memberships
            WHERE workspace_id = ? AND link_id = ? AND deleted_at IS NULL
            ORDER BY sort_order ASC, group_id ASC`,
        )
        .bind(input.workspaceId, input.linkId)
        .all<NavMembershipRow>();

      const timestamp = now();
      const revision = (await readNavStateRevision(deps.db, input.workspaceId)) + 1;
      const linkCondition = {
        sql: 'EXISTS (SELECT 1 FROM workspace_nav_links l WHERE l.id = ? AND l.workspace_id = ? AND l.deleted_at IS NULL AND l.revision = ?)',
        binds: [input.linkId, input.workspaceId, input.expectedRevision],
      };
      const groupsCondition = groupsActiveCondition({ workspaceId: input.workspaceId, groupIds });
      const precondition = allOf(linkCondition, groupsCondition);
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.linkSetGroups,
        requestFingerprint: guard.fingerprint,
        preconditionSql: precondition.sql,
        preconditionBinds: precondition.binds,
        build: () => [
          ...membershipReplaceStatements({
            workspaceId: input.workspaceId,
            linkId: input.linkId,
            currentGroupIds: currentRows.results.map((row) => row.group_id),
            groupIds,
            sortOrder: current.sort_order,
            timestamp,
          }),
          // 归属变化也是链接状态的一部分：推进它的修订号与更新时间，
          // 否则客户端拿着一份「分组归还是旧的」的链接 revision 仍会被判定为最新。
          {
            sql: `UPDATE workspace_nav_links SET revision = revision + 1, updated_at = ?
                   WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL AND revision = ?`,
            binds: [timestamp, input.linkId, input.workspaceId, input.expectedRevision],
          },
          ...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { revision },
        explain: async () => {
          const latest = await readLinkRow(deps.db, input.workspaceId, input.linkId);
          if (latest === null) {
            return navFailure('link_not_found', '链接不存在或不属于本工作空间');
          }
          const resolvedNow = await resolveGroups(input.workspaceId, groupIds);
          if (resolvedNow.missing.length > 0) {
            return navFailure('group_not_found', '分组不存在或不属于本工作空间');
          }
          return revisionConflict({
            entityType: 'nav_link',
            entityId: input.linkId,
            field: 'groupIds',
            baseRevision: input.expectedRevision,
            currentRevision: latest.revision,
          });
        },
      });
    },

    async createGroup(input) {
      const guard = await replayGuard<{ group: NavGroup }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupCreate,
        intent: { name: input.name, sortOrder: input.sortOrder ?? null },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const groups = await readGroupRows(deps.db, input.workspaceId);
      if (groups.length >= MAX_NAV_GROUPS_PER_WORKSPACE) {
        return navFailure(
          'group_limit_reached',
          `已达单工作空间分组上限 ${String(MAX_NAV_GROUPS_PER_WORKSPACE)}`,
        );
      }
      const timestamp = now();
      const groupId = crypto.randomUUID();
      const sortOrder = input.sortOrder ?? groups.reduce((max, group) => Math.max(max, group.sort_order + 1), 0);
      const group: NavGroup = {
        id: groupId,
        name: input.name,
        sortOrder,
        revision: 0,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const countCondition = {
        sql: '(SELECT COUNT(*) FROM workspace_nav_groups c WHERE c.workspace_id = ? AND c.deleted_at IS NULL) = ?',
        binds: [input.workspaceId, groups.length],
      };
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupCreate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: countCondition.sql,
        preconditionBinds: countCondition.binds,
        build: () => [
          insertGroupStatement({
            id: groupId,
            workspaceId: input.workspaceId,
            name: group.name,
            sortOrder,
            now: timestamp,
          }),
          ...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { group },
        explain: async () => {
          const current = await readGroupRows(deps.db, input.workspaceId);
          if (current.length >= MAX_NAV_GROUPS_PER_WORKSPACE) {
            return navFailure(
              'group_limit_reached',
              `已达单工作空间分组上限 ${String(MAX_NAV_GROUPS_PER_WORKSPACE)}`,
            );
          }
          return navFailure('revision_conflict', '工作空间导航数据在写入前发生了变化，请重新读取后再试');
        },
      });
    },

    async updateGroup(input) {
      const guard = await replayGuard<{ group: NavGroup }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupUpdate,
        intent: {
          groupId: input.groupId,
          expectedRevision: input.expectedRevision,
          name: input.name ?? null,
          sortOrder: input.sortOrder ?? null,
        },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const current = await readGroupRow(deps.db, input.workspaceId, input.groupId);
      if (current === null) {
        return navFailure('group_not_found', '分组不存在或不属于本工作空间');
      }
      const field =
        input.name !== undefined && input.sortOrder !== undefined
          ? null
          : input.name !== undefined
            ? 'name'
            : input.sortOrder !== undefined
              ? 'sortOrder'
              : null;
      if (current.revision !== input.expectedRevision) {
        return revisionConflict({
          entityType: 'nav_group',
          entityId: input.groupId,
          field,
          baseRevision: input.expectedRevision,
          currentRevision: current.revision,
        });
      }
      const timestamp = now();
      const group: NavGroup = {
        ...toNavGroup(current),
        name: input.name ?? current.name,
        sortOrder: input.sortOrder ?? current.sort_order,
        revision: current.revision + 1,
        updatedAt: timestamp,
      };
      // 名称不是标识：迁移刻意没有名称唯一约束，因此改名到已有名称是允许的
      // （「同名分组复用」只作用于导入路径，见 planImport / planCategoryGroup）。
      const groupCondition = {
        sql: 'EXISTS (SELECT 1 FROM workspace_nav_groups g WHERE g.id = ? AND g.workspace_id = ? AND g.deleted_at IS NULL AND g.revision = ?)',
        binds: [input.groupId, input.workspaceId, input.expectedRevision],
      };
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupUpdate,
        requestFingerprint: guard.fingerprint,
        preconditionSql: groupCondition.sql,
        preconditionBinds: groupCondition.binds,
        build: () => [
          updateGroupStatement({
            id: input.groupId,
            workspaceId: input.workspaceId,
            expectedRevision: input.expectedRevision,
            name: group.name,
            sortOrder: group.sortOrder,
            now: timestamp,
          }),
          ...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { group },
        explain: async () => {
          const latest = await readGroupRow(deps.db, input.workspaceId, input.groupId);
          if (latest === null) {
            return navFailure('group_not_found', '分组不存在或不属于本工作空间');
          }
          return revisionConflict({
            entityType: 'nav_group',
            entityId: input.groupId,
            field,
            baseRevision: input.expectedRevision,
            currentRevision: latest.revision,
          });
        },
      });
    },

    async deleteGroup(input) {
      const guard = await replayGuard<{ deletedId: string; revision: number }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupDelete,
        intent: { groupId: input.groupId, expectedRevision: input.expectedRevision },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      const current = await readGroupRow(deps.db, input.workspaceId, input.groupId);
      if (current === null) {
        return navFailure('group_not_found', '分组不存在或不属于本工作空间');
      }
      if (current.revision !== input.expectedRevision) {
        return revisionConflict({
          entityType: 'nav_group',
          entityId: input.groupId,
          field: null,
          baseRevision: input.expectedRevision,
          currentRevision: current.revision,
        });
      }
      const timestamp = now();
      const revision = (await readNavStateRevision(deps.db, input.workspaceId)) + 1;
      const groupCondition = {
        sql: 'EXISTS (SELECT 1 FROM workspace_nav_groups g WHERE g.id = ? AND g.workspace_id = ? AND g.deleted_at IS NULL AND g.revision = ?)',
        binds: [input.groupId, input.workspaceId, input.expectedRevision],
      };
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupDelete,
        requestFingerprint: guard.fingerprint,
        preconditionSql: groupCondition.sql,
        preconditionBinds: groupCondition.binds,
        build: () => [
          // 成员关系一并墓碑化；**链接本身保留**（删除分组不等于删除用户收藏的链接）。
          tombstoneMembershipsOfGroupStatement({
            groupId: input.groupId,
            workspaceId: input.workspaceId,
            now: timestamp,
          }),
          tombstoneGroupStatement({
            id: input.groupId,
            workspaceId: input.workspaceId,
            expectedRevision: input.expectedRevision,
            now: timestamp,
          }),
          ...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }),
        ],
        result: { deletedId: input.groupId, revision },
        explain: async () => {
          const latest = await readGroupRow(deps.db, input.workspaceId, input.groupId);
          if (latest === null) {
            return navFailure('group_not_found', '分组不存在或不属于本工作空间');
          }
          return revisionConflict({
            entityType: 'nav_group',
            entityId: input.groupId,
            field: null,
            baseRevision: input.expectedRevision,
            currentRevision: latest.revision,
          });
        },
      });
    },

    async reorderGroups(input) {
      const orderedIds = uniqueIds(input.orderedIds);
      const guard = await replayGuard<{ revision: number }>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupReorder,
        intent: { orderedIds, expectedRevision: input.expectedRevision },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      // 同 reorderLinks：集合判定与 CAS 基准来自同一个事务快照。
      const groupReorderPlan = await readWritePrecondition({ db: deps.db, workspaceId: input.workspaceId });
      const groups = groupReorderPlan.groupRows;
      const revision = groupReorderPlan.revision;
      if (revision !== input.expectedRevision) {
        return navFailure(
          'revision_conflict',
          `工作空间导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(revision)}`,
        );
      }
      if (orderedIds.length !== groups.length || orderedIds.length !== input.orderedIds.length) {
        return navFailure(
          'reorder_set_mismatch',
          `需要给出全部 ${String(groups.length)} 个活跃分组（且不重复），收到 ${String(input.orderedIds.length)} 个`,
        );
      }
      const currentIds = new Set(groups.map((group) => group.id));
      const unknown = orderedIds.filter((id) => !currentIds.has(id));
      if (unknown.length > 0) {
        return navFailure(
          'reorder_set_mismatch',
          `给出的顺序里包含 ${String(unknown.length)} 个不属于本工作空间（或已删除）的分组`,
        );
      }

      const timestamp = now();
      const byId = new Map(groups.map((group) => [group.id, group] as const));
      const statements: NavStatement[] = [];
      orderedIds.forEach((groupId, index) => {
        const row = byId.get(groupId);
        if (row === undefined || row.sort_order === index) {
          return;
        }
        statements.push({
          sql: `UPDATE workspace_nav_groups
                   SET sort_order = ?, revision = revision + 1, updated_at = ?
                 WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
          binds: [index, timestamp, groupId, input.workspaceId],
        });
      });
      statements.push(...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }));
      const revisionCondition = navRevisionCondition(input.workspaceId, input.expectedRevision);
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.groupReorder,
        requestFingerprint: guard.fingerprint,
        preconditionSql: revisionCondition.sql,
        preconditionBinds: revisionCondition.binds,
        build: () => statements,
        result: { revision: revision + 1 },
        explain: async () => {
          const latest = await readNavStateRevision(deps.db, input.workspaceId);
          if (latest !== input.expectedRevision) {
            return navFailure(
              'revision_conflict',
              `工作空间导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(latest)}`,
            );
          }
          return navFailure('reorder_set_mismatch', '分组集合在写入前发生了变化，请重新读取后再试');
        },
      });
    },

    async exportDocument(workspaceId) {
      // 一个 batch 读出全部行；再交给共享构造函数（只导出两端都活跃的成员关系）。
      const snapshot = await readSnapshotBatch({ db: deps.db, workspaceId, withCatalog: false });
      const document = buildNavExportDocument({
        links: snapshot.linkRows.map(toNavLink),
        groups: snapshot.groupRows.map(toNavGroup),
        memberships: snapshot.membershipRows.map(toNavMembership),
        catalogSourceVersion: snapshot.catalogSourceVersion,
        exportedAt: now(),
      });
      // 防御性复核（与导入端**同一份**判定）：导出文档是用户会存起来、再导入回来的东西，
      // 一旦它自相矛盾（悬空成员关系 / ID 重复 / URL 不合策略），宁可让这次导出失败，
      // 也不产出一份「导回来会少一半关系」的文档。正常路径下必须通过。
      const integrity = validateNavExportIntegrity(document);
      if (!integrity.ok) {
        return navFailure(
          'export_integrity_failed',
          `导出数据自检未通过（未产出文档）：${integrity.problems.slice(0, 3).join('；')}`,
        );
      }
      return { ok: true, replayed: false, value: document };
    },

    async previewImport(input) {
      const plan = await planImport({
        workspaceId: input.workspaceId,
        items: input.items,
        ...(input.targetGroupId === undefined ? {} : { targetGroupId: input.targetGroupId }),
      });
      if (!plan.ok) {
        return plan;
      }
      return {
        ok: true,
        replayed: false,
        value: {
          items: plan.value.accepted.map((accepted) => accepted.item),
          skipped: plan.value.skipped,
          revision: plan.value.revision,
        },
      };
    },

    async previewRestore(input) {
      // 只读：与 apply 共用同一个规划函数，因此预览里不会出现「预览能过、落地不行」的玄学差异。
      const batch = await readImportPlanBatch({ db: deps.db, workspaceId: input.workspaceId });
      const plan = planRestore({ document: input.document, existingLinkUrls: urlKeysOf(batch.linkRows) });
      if (!plan.ok) {
        return plan;
      }
      return {
        ok: true,
        replayed: false,
        value: {
          links: plan.value.links.length,
          groups: plan.value.groups.length,
          memberships: plan.value.memberships.length,
          conflicts: plan.value.skippedLinks.map((skipped) => skipped.skip),
          expectedRevision: batch.revision,
        },
      };
    },

    async importRestoreItems(input) {
      const guard = await replayGuard<NavRestoreApplyResult>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.importRestore,
        intent: {
          document: input.document,
          expectedRevision: input.expectedRevision,
        },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      // 读取 / 判定 / CAS 基准全部来自**同一个** batch（不再二次读取修订号）。
      const batch = await readImportPlanBatch({ db: deps.db, workspaceId: input.workspaceId });
      const revision = batch.revision;
      if (revision !== input.expectedRevision) {
        return navFailure(
          'import_preview_stale',
          `恢复预览已过期：导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(revision)}`,
        );
      }
      const plan = planRestore({ document: input.document, existingLinkUrls: urlKeysOf(batch.linkRows) });
      if (!plan.ok) {
        return plan;
      }

      const timestamp = now();
      const statements: NavStatement[] = [];
      for (const group of plan.value.groups) {
        statements.push(
          insertGroupStatement({
            id: group.id,
            workspaceId: input.workspaceId,
            name: group.name,
            sortOrder: group.sortOrder,
            now: timestamp,
          }),
        );
      }
      for (const link of plan.value.links) {
        statements.push(
          insertLinkStatement({
            id: link.id,
            workspaceId: input.workspaceId,
            sourceCatalogId: link.sourceCatalogId,
            importedSourceVersion: link.importedSourceVersion,
            title: link.title,
            url: link.url,
            description: link.description,
            tags: link.tags,
            aliases: link.aliases,
            icon: link.icon,
            openMode: link.openMode,
            region: link.region,
            status: link.status,
            isFavorite: link.isFavorite,
            sortOrder: link.sortOrder,
            // 健康状态是唯一不保留的字段：阶段 04 没有任何服务端探测结论，
            // 因此导入永远落 unknown / null，绝不把「上一次探测」当成事实带进新工作空间。
            health: 'unknown',
            healthCheckedAt: null,
            now: timestamp,
          }),
        );
      }
      for (const membership of plan.value.memberships) {
        statements.push(
          insertMembershipStatement({
            linkId: membership.linkId,
            groupId: membership.groupId,
            workspaceId: input.workspaceId,
            sortOrder: membership.sortOrder,
            now: timestamp,
          }),
        );
      }
      statements.push(...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }));
      const revisionCondition = navRevisionCondition(input.workspaceId, revision);

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.importRestore,
        requestFingerprint: guard.fingerprint,
        preconditionSql: revisionCondition.sql,
        preconditionBinds: revisionCondition.binds,
        build: () => statements,
        result: {
          importedLinks: plan.value.links.length,
          importedGroups: plan.value.groups.length,
          importedMemberships: plan.value.memberships.length,
          skipped: plan.value.skippedLinks.map((skipped) => skipped.skip),
          idMaps: { links: plan.value.linkIdMap, groups: plan.value.groupIdMap },
          revision: revision + 1,
        },
        explain: async () => {
          const latest = await readNavStateRevision(deps.db, input.workspaceId);
          if (latest !== revision) {
            return navFailure(
              'import_preview_stale',
              `恢复预览已过期：导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(latest)}`,
            );
          }
          return navFailure('revision_conflict', '导航数据在恢复写入前发生了变化，请重新预览后再试');
        },
      });
    },

    async importItems(input) {
      const items = input.items.slice(0, MAX_NAV_IMPORT_ITEMS).map(normalizeImportItem);
      const guard = await replayGuard<NavImportApplyResult>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.importApply,
        intent: {
          items,
          targetGroupId: input.targetGroupId ?? null,
          expectedRevision: input.expectedRevision,
        },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }
      // 新鲜度 + 规划 + CAS 基准全部来自**同一个** batch 读（不再二次读取修订号）。
      const plan = await planImport({
        workspaceId: input.workspaceId,
        items,
        ...(input.targetGroupId === undefined ? {} : { targetGroupId: input.targetGroupId }),
      });
      if (!plan.ok) {
        return plan;
      }
      // 预览新鲜度：客户端必须回显预览时看到的修订号，否则拒绝（不按旧预览覆盖）。
      const revision = plan.value.revision;
      if (revision !== input.expectedRevision) {
        return navFailure(
          'import_preview_stale',
          `导入预览已过期：导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(revision)}`,
        );
      }

      const timestamp = now();
      const linkIds = plan.value.accepted.map(() => crypto.randomUUID());
      const statements: NavStatement[] = [];
      for (const group of plan.value.newGroups) {
        statements.push(
          insertGroupStatement({
            id: group.id,
            workspaceId: input.workspaceId,
            name: group.name,
            sortOrder: group.sortOrder,
            now: timestamp,
          }),
        );
      }
      plan.value.accepted.forEach((accepted, index) => {
        const linkId = linkIds[index] ?? crypto.randomUUID();
        statements.push(
          insertLinkStatement({
            id: linkId,
            workspaceId: input.workspaceId,
            sourceCatalogId: null,
            importedSourceVersion: null,
            title: accepted.item.title,
            url: accepted.item.url,
            description: accepted.item.description ?? '',
            tags: accepted.item.tags ?? [],
            aliases: accepted.item.aliases ?? [],
            icon: sanitizeNavIcon(accepted.item.icon ?? ''),
            openMode: accepted.item.openMode ?? 'new_tab',
            region: accepted.item.region ?? 'cn',
            status: 'active',
            isFavorite: false,
            sortOrder: accepted.sortOrder,
            now: timestamp,
          }),
        );
        if (accepted.groupId !== null) {
          statements.push(
            ...addMembershipStatements({
              linkId,
              groupId: accepted.groupId,
              workspaceId: input.workspaceId,
              sortOrder: accepted.sortOrder,
              now: timestamp,
            }),
          );
        }
      });
      statements.push(...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }));

      const revisionCondition = navRevisionCondition(input.workspaceId, input.expectedRevision);
      const targetCondition =
        input.targetGroupId === undefined
          ? { sql: '', binds: [] }
          : groupsActiveCondition({ workspaceId: input.workspaceId, groupIds: [input.targetGroupId] });
      const precondition = allOf(revisionCondition, targetCondition);

      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.importApply,
        requestFingerprint: guard.fingerprint,
        preconditionSql: precondition.sql,
        preconditionBinds: precondition.binds,
        build: () => statements,
        result: {
          importedCount: linkIds.length,
          importedLinkIds: linkIds,
          skipped: plan.value.skipped,
          revision: revision + 1,
        },
        explain: async () => {
          const latest = await readNavStateRevision(deps.db, input.workspaceId);
          if (latest !== input.expectedRevision) {
            return navFailure(
              'import_preview_stale',
              `导入预览已过期：导航修订号已从 ${String(input.expectedRevision)} 变为 ${String(latest)}`,
            );
          }
          if (input.targetGroupId !== undefined) {
            const resolved = await resolveGroups(input.workspaceId, [input.targetGroupId]);
            if (resolved.missing.length > 0) {
              return navFailure('group_not_found', '目标分组不存在或不属于本工作空间');
            }
          }
          return navFailure('revision_conflict', '导入数据在写入前发生了变化，请重新预览后再试');
        },
      });
    },

    async importCatalogEntries(input) {
      const guard = await replayGuard<NavCatalogImportResult>({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.catalogImport,
        intent: {
          catalogIds: input.catalogIds,
          explicitReimport: input.explicitReimport === true,
          overwriteUserEdits: input.overwriteUserEdits === true,
        },
      });
      if (guard.replay !== null) {
        return guard.replay;
      }

      // 一次 batch：目录条目 + 目录关联行（含墓碑）+ 活跃分组 + 活跃链接 + 修订号。
      // 决策（用户是否改过 / 是否墓碑）与 CAS 基准必须来自同一批，否则会写出
      // 「按旧墓碑判定、却以新 revision 为前提」的不一致结果。
      const batch = await readCatalogImportBatch({
        db: deps.db,
        workspaceId: input.workspaceId,
        catalogIds: input.catalogIds,
      });
      const catalogById = batch.catalogById;
      const sourcedRows = batch.sourcedRows;
      const groups = batch.groupRows;
      const links = batch.linkRows;
      const revision = batch.revision;

      /**
       * 同一目录 ID 在一次请求里重复出现时只处理一次：它指向同一条目录条目，
       * 处理两次会撞上「每个条目至多一条活跃副本」的部分唯一索引（整个事务回滚）。
       * 每个**唯一** ID 在结果里恰好得到一条决策。
       */
      const catalogIds = uniqueIds(input.catalogIds);

      // 每个目录条目取一条「代表副本」：活跃行优先，其次按 updated_at 最新的墓碑。
      // 为什么要有确定性的选择：部分唯一索引只约束活跃行，一个条目理论上可以留下多条墓碑
      // （导入 → 删除 → 显式再导入 → 再删除）。选择规则固定，结果才可复现。
      const rowsByCatalogId = new Map<string, NavLinkRow[]>();
      for (const row of sourcedRows) {
        const catalogId = row.source_catalog_id;
        if (catalogId === null) {
          continue;
        }
        const list = rowsByCatalogId.get(catalogId) ?? [];
        list.push(row);
        rowsByCatalogId.set(catalogId, list);
      }
      const representativeOf = (catalogId: string): NavLinkRow | undefined => {
        const list = rowsByCatalogId.get(catalogId) ?? [];
        return list.find((row) => row.deleted_at === null) ?? list[0];
      };

      // 目录条目相对个人副本的状态一律走共享纯函数（ADR-0004 D1 / D5）。
      const plan = catalogUpgradePlan({
        catalog: [...catalogById.values()],
        links: sourcedRows.map(toNavLink),
      });
      const stateByCatalogId = new Map(plan.map((entry) => [entry.catalogId, entry.state] as const));

      const timestamp = now();
      let linkSortOrder = links.reduce((max, link) => Math.max(max, link.sort_order + 1), 0);
      let activeCount = links.length;
      const newGroups: { id: string; name: string; sortOrder: number }[] = [];
      const decisions: NavCatalogImportItemResult[] = [];
      const statements: NavStatement[] = [];
      /** 成员关系语句单独收集：必须排在「新建分组」的 INSERT 之后（见循环内的注释）。 */
      const membershipStatements: NavStatement[] = [];
      const importedLinkIds: string[] = [];
      const restoredLinkIds: string[] = [];
      const skippedCatalogIds: string[] = [];

      for (const catalogId of catalogIds) {
        const entry = catalogById.get(catalogId);
        if (entry === undefined) {
          // 目录条目可能已经下线：逐项报告，而不是让整批失败（目录与个人副本刻意解耦）。
          decisions.push({
            catalogId,
            action: 'skip',
            reason: '目录中没有该条目（可能已下线），未写入任何数据',
            linkId: representativeOf(catalogId)?.id ?? null,
          });
          skippedCatalogIds.push(catalogId);
          continue;
        }
        const existing = representativeOf(catalogId);
        const state = stateByCatalogId.get(catalogId) ?? 'new';
        const decision = decideCatalogImport({
          state,
          explicitReimport: input.explicitReimport === true,
          overwriteUserEdits: input.overwriteUserEdits === true,
        });

        if (decision.action === 'skip') {
          decisions.push({
            catalogId,
            action: 'skip',
            reason: decision.reason,
            linkId: existing?.id ?? null,
          });
          skippedCatalogIds.push(catalogId);
          continue;
        }

        if (decision.action === 'insert') {
          if (activeCount >= MAX_NAV_LINKS_PER_WORKSPACE) {
            decisions.push({
              catalogId,
              action: 'skip',
              reason: `已达单工作空间链接上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}`,
              linkId: null,
            });
            skippedCatalogIds.push(catalogId);
            continue;
          }
          // 初始归属：目录自带的分类名复用或新建一个同名分组（新建受分组上限约束）。
          const groupId = planCategoryGroup({ category: entry.category, groups, newGroups });
          const linkId = crypto.randomUUID();
          statements.push(
            insertLinkStatement({
              id: linkId,
              workspaceId: input.workspaceId,
              sourceCatalogId: entry.id,
              importedSourceVersion: entry.sourceVersion,
              title: entry.title,
              url: entry.url,
              description: entry.description,
              tags: entry.tags,
              aliases: entry.aliases,
              icon: sanitizeNavIcon(entry.icon),
              openMode: entry.openMode,
              region: entry.region,
              status: 'active',
              isFavorite: false,
              sortOrder: linkSortOrder,
              now: timestamp,
            }),
          );
          if (groupId !== null) {
            // 归属语句**不能**立刻入批：分组本身可能在本次循环里才被 `planCategoryGroup` 新建，
            // 而成员关系的 INSERT 带 `JOIN workspace_nav_groups` 条件（用于在同一事务内证明
            // 链接与分组属于同一 workspace）——若分组 INSERT 排在它后面，这条会静默插 0 行，
            // 结果是「分组建好了但里面是空的」。因此先收集、稍后统一排在分组 INSERT 之后。
            membershipStatements.push(
              ...addMembershipStatements({
                linkId,
                groupId,
                workspaceId: input.workspaceId,
                sortOrder: linkSortOrder,
                now: timestamp,
              }),
            );
          }
          linkSortOrder += 1;
          activeCount += 1;
          importedLinkIds.push(linkId);
          decisions.push({
            catalogId,
            action: 'insert',
            // 分组上限已满时如实说明「分类分组没建起来」，而不是静默丢归属。
            reason:
              groupId === null
                ? `${decision.reason}（分组数量已达上限，未建立分类分组）`
                : decision.reason,
            linkId,
          });
          continue;
        }

        if (existing === undefined) {
          // 不可能发生：insert 是唯一没有 existing 的分支。真出现就如实报告，不猜。
          decisions.push({
            catalogId,
            action: 'skip',
            reason: '个人副本状态与目录判定不一致，已跳过',
            linkId: null,
          });
          skippedCatalogIds.push(catalogId);
          continue;
        }

        if (decision.action === 'restore_tombstone') {
          if (activeCount >= MAX_NAV_LINKS_PER_WORKSPACE) {
            decisions.push({
              catalogId,
              action: 'skip',
              reason: `已达单工作空间链接上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}，无法恢复该条目`,
              linkId: existing.id,
            });
            skippedCatalogIds.push(catalogId);
            continue;
          }
          // 恢复归属：墓碑化时成员关系一并被墓碑化，因此这里重新建立分类分组归属。
          const groupId = planCategoryGroup({ category: entry.category, groups, newGroups });
          statements.push({
            sql: `UPDATE workspace_nav_links
                     SET deleted_at = NULL, source_catalog_id = ?, imported_source_version = ?,
                         title = ?, url = ?, description = ?, tags_json = ?, aliases_json = ?,
                         icon = ?, open_mode = ?, region = ?, revision = revision + 1, updated_at = ?
                   WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL`,
            binds: [
              entry.id,
              entry.sourceVersion,
              entry.title,
              entry.url,
              entry.description,
              JSON.stringify(entry.tags),
              JSON.stringify(entry.aliases),
              sanitizeNavIcon(entry.icon),
              entry.openMode,
              entry.region,
              timestamp,
              existing.id,
              input.workspaceId,
            ],
          });
          if (groupId !== null) {
            // 同上：先收集，等分组 INSERT 入批之后再排（否则成员关系会静默插 0 行）。
            membershipStatements.push(
              ...addMembershipStatements({
                linkId: existing.id,
                groupId,
                workspaceId: input.workspaceId,
                sortOrder: existing.sort_order,
                now: timestamp,
              }),
            );
          }
          activeCount += 1;
          importedLinkIds.push(existing.id);
          restoredLinkIds.push(existing.id);
          decisions.push({
            catalogId,
            action: 'restore_tombstone',
            reason:
              groupId === null
                ? `${decision.reason}（分组数量已达上限，未恢复分类分组）`
                : decision.reason,
            linkId: existing.id,
          });
          continue;
        }

        // update：覆盖目录内容（**不**触碰分组归属、收藏、状态与顺序——那些是个人组织方式）。
        statements.push({
          sql: `UPDATE workspace_nav_links
                   SET source_catalog_id = ?, imported_source_version = ?, title = ?, url = ?,
                       description = ?, tags_json = ?, aliases_json = ?, icon = ?, open_mode = ?,
                       region = ?, revision = revision + 1, updated_at = ?
                 WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
          binds: [
            entry.id,
            entry.sourceVersion,
            entry.title,
            entry.url,
            entry.description,
            JSON.stringify(entry.tags),
            JSON.stringify(entry.aliases),
            sanitizeNavIcon(entry.icon),
            entry.openMode,
            entry.region,
            timestamp,
            existing.id,
            input.workspaceId,
          ],
        });
        importedLinkIds.push(existing.id);
        decisions.push({ catalogId, action: 'update', reason: decision.reason, linkId: existing.id });
      }

      // 批内顺序（**不要**调换）：链接/分组/内容变更 → 新建分组 → 成员关系 → 工作空间修订。
      for (const group of newGroups) {
        statements.push(
          insertGroupStatement({
            id: group.id,
            workspaceId: input.workspaceId,
            name: group.name,
            sortOrder: group.sortOrder,
            now: timestamp,
          }),
        );
      }
      statements.push(...membershipStatements);

      /**
       * 只有**真的改动了个人数据**时才推进工作空间修订号。
       *
       * 复核发现的缺陷：全跳过的导入（例如对所有条目都判为「用户改过 / 已删除」）也会
       * bump 一次 `workspace_nav_state.revision`，于是其它设备收到一次「工作空间已变」的
       * 无意义信号，并可能让正在编辑的草稿被标记为冲突。没有任何行变化就不该推进水位。
       */
      const wroteAnything =
        importedLinkIds.length > 0 || restoredLinkIds.length > 0 || newGroups.length > 0;
      if (wroteAnything) {
        statements.push(...bumpNavStateStatements({ workspaceId: input.workspaceId, now: timestamp }));
      }

      const result: NavCatalogImportResult = {
        decisions,
        importedCount: importedLinkIds.length,
        importedLinkIds,
        restoredLinkIds,
        skippedCatalogIds,
        // 与库里的实际情况一致：没有写入就不假装 revision 变了。
        revision: wroteAnything ? revision + 1 : revision,
      };
      const revisionCondition = navRevisionCondition(input.workspaceId, revision);
      return await runOperation({
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        kind: NAV_OP_KINDS.catalogImport,
        requestFingerprint: guard.fingerprint,
        preconditionSql: revisionCondition.sql,
        preconditionBinds: revisionCondition.binds,
        build: () => statements,
        result,
        explain: async () => {
          const latest = await readNavStateRevision(deps.db, input.workspaceId);
          if (latest !== revision) {
            return navFailure(
              'revision_conflict',
              `目录导入期间导航数据发生了变化（修订号 ${String(revision)} → ${String(latest)}），请重新读取后再试`,
            );
          }
          return navFailure('persist_failed', '目录导入未能应用（内部不一致）');
        },
      });
    },
  };

  return service;
}
