/**
 * 自由导航契约（阶段 04：HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009）——前后端**共用**。
 *
 * 定位：只放**纯类型与纯函数**。无 DOM、无 D1、无 React、无网络。
 * 服务端查询端点与前端 Widget 调用**同一份**实现，因此「搜索/筛选/排序/升级判定」
 * 不可能出现两套规则互相漂移（这是阶段 04 的明确要求，见 ADR-0004 D5）。
 *
 * ── 为什么 URL 只允许 https（D3）──────────────────────────────────────────────
 * 导航条目会被渲染成可点击链接，也可能被用户从浏览器书签导入。若允许 `javascript:` /
 * `data:`，一个导入文件就能把任意脚本塞进页面上下文（比 XSS 更糟：它是用户自己"授权"的）。
 * 因此这里**只放行 https**，并明确拒绝 http：本阶段不授予任何 http 例外；将来若确有理由
 * 放行某个 http 站点，必须逐条记录在 ADR 里，而不是在这里偷偷放宽。
 * 判定实现只有 `validateNavUrl` 一处（`navUrlSchema` 也调用它）。
 *
 * ── 为什么图标是纯文本（D3）───────────────────────────────────────────────────
 * `icon` 是用户可控字符串，如果被当成 HTML/URL 使用就等于把注入面重新打开。
 * 它只作为**文本**渲染（emoji 或短标识），空值回落到 `NAV_DEFAULT_ICON`。
 *
 * ── 为什么目录升级不等于"再导入"（D1）─────────────────────────────────────────
 * 用户导入一条推荐条目后，那条数据就**完全属于用户**。目录版本升级只更新系统目录表，
 * 绝不写个人表；已删除的条目也不会因为目录升级而复活。只有用户对同一条目录条目
 * **显式再次导入**时才可能写个人行，且默认不覆盖用户改动。
 */
import { z } from 'zod';
// 纯类型导入（WidgetConfigContract）：运行时被擦除，因此 builtin-modules ↔ nav-api 之间
// 不存在运行时循环依赖；类型层互相引用是刻意的（契约集中在同一处）。
import type { WidgetConfigContract } from './builtin-modules';
import type { ModuleManifest } from './module-manifest';
import { syncConflictSchema } from './sync-api';
import { operationIdSchema } from './workbench-api';

// ---------------------------------------------------------------------------
// 常量（单一来源：上限与迁移里的 CHECK 保持一致）
// ---------------------------------------------------------------------------

/** 真实业务模块 ID（不是 `demo.*`）。 */
export const NAV_MODULE_ID = 'ff14.navigation';

/** 导航模块对外提供的 Widget 类型 ID。 */
export const NAV_WIDGET_IDS = {
  quickLinks: 'nav-quick-links',
  search: 'nav-search',
} as const;

export type NavWidgetId = (typeof NAV_WIDGET_IDS)[keyof typeof NAV_WIDGET_IDS];

export const MAX_NAV_LINKS_PER_WORKSPACE = 500;
export const MAX_NAV_GROUPS_PER_WORKSPACE = 100;
export const MAX_NAV_GROUPS_PER_LINK = 20;
export const MAX_NAV_TITLE_LENGTH = 80;
export const MAX_NAV_URL_LENGTH = 2048;
export const MAX_NAV_DESCRIPTION_LENGTH = 500;
export const MAX_NAV_TAGS = 20;
export const MAX_NAV_TAG_LENGTH = 24;
export const MAX_NAV_ALIASES = 10;
export const MAX_NAV_ALIAS_LENGTH = 60;
export const MAX_NAV_ICON_LENGTH = 200;
export const MAX_NAV_IMPORT_ITEMS = 500;
export const MAX_NAV_GROUP_NAME_LENGTH = 40;

/** 快照里回传的容量上限（服务端派生，不是客户端可配置项）。 */
export const NAV_LIMITS = {
  maxLinks: MAX_NAV_LINKS_PER_WORKSPACE,
  maxGroups: MAX_NAV_GROUPS_PER_WORKSPACE,
  maxGroupsPerLink: MAX_NAV_GROUPS_PER_LINK,
} as const;

export const NAV_OPEN_MODES = ['new_tab', 'same_tab'] as const;
export type NavOpenMode = (typeof NAV_OPEN_MODES)[number];

export const NAV_LINK_STATUSES = ['active', 'archived'] as const;
export type NavLinkStatus = (typeof NAV_LINK_STATUSES)[number];

/** 区服：`both` 只用于「与区服无关」的通用条目（INV-08：国服/国际服规则不混用）。 */
export const NAV_REGIONS = ['cn', 'global', 'both'] as const;
export type NavRegion = (typeof NAV_REGIONS)[number];

/**
 * 健康状态。阶段 04 **不做服务端探测**，默认 `unknown`；
 * 403 只能映射为 `maybe_blocked`，绝不映射为「永久失效」（枚举里刻意没有 blocked）。
 */
export const NAV_HEALTH_STATUSES = ['ok', 'maybe_blocked', 'unreachable', 'unknown'] as const;
export type NavHealthStatus = (typeof NAV_HEALTH_STATUSES)[number];

export const NAV_SORT_MODES = ['manual', 'title', 'recent', 'favorite'] as const;
export type NavSortMode = (typeof NAV_SORT_MODES)[number];

export const NAV_DEFAULT_ICON = '🔗';

/** 目录条目相对「我的副本」的状态（决定升级时能做什么）。 */
export const NAV_CATALOG_ENTRY_STATES = ['new', 'unchanged', 'user_modified', 'tombstoned'] as const;
export type NavCatalogEntryState = (typeof NAV_CATALOG_ENTRY_STATES)[number];

/** 导入时逐项跳过原因（必须逐项说明，不允许静默丢弃）。 */
export const NAV_IMPORT_SKIP_REASONS = [
  'invalid_url',
  'unsupported_scheme',
  'missing_title',
  'too_many_items',
  'duplicate',
  /**
   * 输入是**版本化导航配置**（带 `schemaVersion`），却被当成普通链接列表解析。
   * 这种情况必须**明确拒绝**而不是把 `links` 抽出来用——那会静默丢掉分组、多对多归属、
   * 收藏、状态与自定义顺序（复核发现的真实缺陷）。
   */
  'unsupported_document',
] as const;
export type NavImportSkipReason = (typeof NAV_IMPORT_SKIP_REASONS)[number];

/** 导出文档的版本号（导入端据此拒绝未来版本）。 */
export const NAV_EXPORT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 基础判定：URL / 文本 / 图标
// ---------------------------------------------------------------------------

export type NavUrlValidation =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'scheme' | 'credentials' | 'host' | 'length' };

/** 控制字符与空白检测：逐码元判断，避免 `no-control-regex` 与正则回退歧义。 */
function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * 导航 URL 的**唯一**判定。
 *
 * 刻意不使用全局 `URL`：Shared 层要能在 Worker 与浏览器之外（纯 Node 测试、类型检查）运行，
 * 因此这里只做「前缀 + authority」的保守解析——不接受解析不出来的输入，
 * 而不是把它交给某个环境的宽松解析器去猜。
 */
export function validateNavUrl(raw: unknown): NavUrlValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'length' };
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_NAV_URL_LENGTH) {
    return { ok: false, reason: 'length' };
  }
  if (hasControlOrSpace(value)) {
    return { ok: false, reason: 'length' };
  }
  // scheme 按 RFC 3986 **不区分大小写**：`HTTPS://` 必须与 `https://` 同等接受，
  // 否则同一份书签文件会因为大小写写法不同而解析结果不同（复核发现的真实差异）。
  const scheme = value.slice(0, 8).toLowerCase();
  if (scheme !== 'https://') {
    // http 与其他所有协议（javascript: / data: / file: / blob: / vbscript: …）都在这里被拒绝。
    return { ok: false, reason: 'scheme' };
  }
  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority.length === 0) {
    return { ok: false, reason: 'host' };
  }
  if (authority.includes('@')) {
    // user:pass@host 形式：既可能是钓鱼，也会把凭证写进配置与日志。
    return { ok: false, reason: 'credentials' };
  }
  const host = authority.split(':')[0] ?? '';
  if (host.length === 0 || !host.includes('.')) {
    return { ok: false, reason: 'host' };
  }
  return { ok: true, url: value };
}

export const navUrlSchema = z.string().refine((value) => validateNavUrl(value).ok, {
  message: '导航 URL 必须是以 https:// 开头的合法地址（不允许 http 与危险协议，不允许内嵌凭证）',
});

export const navOpenModeSchema = z.enum(NAV_OPEN_MODES);
export const navLinkStatusSchema = z.enum(NAV_LINK_STATUSES);
export const navRegionSchema = z.enum(NAV_REGIONS);
export const navHealthStatusSchema = z.enum(NAV_HEALTH_STATUSES);
export const navSortModeSchema = z.enum(NAV_SORT_MODES);
export const navCatalogEntryStateSchema = z.enum(NAV_CATALOG_ENTRY_STATES);
export const navImportSkipReasonSchema = z.enum(NAV_IMPORT_SKIP_REASONS);

/** 规范化文本：NFKC + 小写 + 折叠空白。搜索匹配的唯一口径。 */
export function normalizeNavText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** 去掉控制字符（保留可见字符与 emoji）。 */
function stripControl(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    result += character;
  }
  return result;
}

/** 图标是**纯文本**：trim、去控制字符、截断、空值回落默认图标。 */
export function sanitizeNavIcon(raw: unknown): string {
  if (typeof raw !== 'string') {
    return NAV_DEFAULT_ICON;
  }
  const cleaned = stripControl(raw).trim();
  if (cleaned.length === 0) {
    return NAV_DEFAULT_ICON;
  }
  return cleaned.length > MAX_NAV_ICON_LENGTH ? cleaned.slice(0, MAX_NAV_ICON_LENGTH) : cleaned;
}

/** 标签：去空、去控制字符、按规范化值去重保序、超限截断。 */
export function normalizeNavTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      continue;
    }
    const cleaned = stripControl(item).trim();
    if (cleaned.length === 0) {
      continue;
    }
    const value = cleaned.length > MAX_NAV_TAG_LENGTH ? cleaned.slice(0, MAX_NAV_TAG_LENGTH) : cleaned;
    const key = normalizeNavText(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_NAV_TAGS) {
      break;
    }
  }
  return result;
}

/** 别名：与标签同规则，但上限与长度不同（别名用于搜索匹配）。 */
export function normalizeNavAliases(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      continue;
    }
    const cleaned = stripControl(item).trim();
    if (cleaned.length === 0) {
      continue;
    }
    const value = cleaned.length > MAX_NAV_ALIAS_LENGTH ? cleaned.slice(0, MAX_NAV_ALIAS_LENGTH) : cleaned;
    const key = normalizeNavText(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_NAV_ALIASES) {
      break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 行形状（与 migrations/0008_navigation.sql 的列一一对应）
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(64);
const utcMsSchema = z.number().int().nonnegative();

export const navLinkSchema = z
  .object({
    id: idSchema,
    /** 弱关联：目录条目下线后个人副本仍然存在（刻意无外键）。 */
    sourceCatalogId: z.string().min(1).max(80).nullable(),
    importedSourceVersion: z.number().int().positive().nullable(),
    title: z.string().min(1).max(MAX_NAV_TITLE_LENGTH),
    url: navUrlSchema,
    description: z.string().max(MAX_NAV_DESCRIPTION_LENGTH),
    tags: z.array(z.string().min(1).max(MAX_NAV_TAG_LENGTH)).max(MAX_NAV_TAGS),
    aliases: z.array(z.string().min(1).max(MAX_NAV_ALIAS_LENGTH)).max(MAX_NAV_ALIASES),
    icon: z.string().max(MAX_NAV_ICON_LENGTH),
    openMode: navOpenModeSchema,
    region: navRegionSchema,
    status: navLinkStatusSchema,
    isFavorite: z.boolean(),
    sortOrder: z.number().int(),
    health: navHealthStatusSchema,
    healthCheckedAt: utcMsSchema.nullable(),
    revision: z.number().int().nonnegative(),
    deletedAt: utcMsSchema.nullable(),
    createdAt: utcMsSchema,
    updatedAt: utcMsSchema,
  })
  .strict();

export type NavLink = z.infer<typeof navLinkSchema>;

export const navGroupSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(MAX_NAV_GROUP_NAME_LENGTH),
    sortOrder: z.number().int(),
    revision: z.number().int().nonnegative(),
    deletedAt: utcMsSchema.nullable(),
    createdAt: utcMsSchema,
    updatedAt: utcMsSchema,
  })
  .strict();

export type NavGroup = z.infer<typeof navGroupSchema>;

export const navMembershipSchema = z
  .object({
    linkId: idSchema,
    groupId: idSchema,
    sortOrder: z.number().int(),
    deletedAt: utcMsSchema.nullable(),
    updatedAt: utcMsSchema,
  })
  .strict();

export type NavMembership = z.infer<typeof navMembershipSchema>;

/**
 * 系统推荐目录条目（只读）。
 * `sourceUrl` + `verifiedAt` 是「这条推荐来自哪里、什么时候核对过」的留痕；
 * `verificationStatus` 只描述**来源条目本身**是否核对过，绝不代表网站当前在线状态。
 */
export const navCatalogEntrySchema = z
  .object({
    id: idSchema,
    sourceVersion: z.number().int().positive(),
    title: z.string().min(1).max(MAX_NAV_TITLE_LENGTH),
    url: navUrlSchema,
    description: z.string().max(MAX_NAV_DESCRIPTION_LENGTH),
    category: z.string().min(1).max(MAX_NAV_GROUP_NAME_LENGTH),
    tags: z.array(z.string().min(1).max(MAX_NAV_TAG_LENGTH)).max(MAX_NAV_TAGS),
    aliases: z.array(z.string().min(1).max(MAX_NAV_ALIAS_LENGTH)).max(MAX_NAV_ALIASES),
    icon: z.string().max(MAX_NAV_ICON_LENGTH),
    openMode: navOpenModeSchema,
    region: navRegionSchema,
    sortOrder: z.number().int(),
    sourceUrl: navUrlSchema,
    sourceName: z.string().max(80),
    verifiedAt: utcMsSchema,
    verificationStatus: z.enum(['verified', 'unverified']),
    updatedAt: utcMsSchema,
  })
  .strict();

export type NavCatalogEntry = z.infer<typeof navCatalogEntrySchema>;

/** Public directory response, independent of private navigation transport. */
export const navCatalogResponseSchema=z.object({entries:z.array(navCatalogEntrySchema),sourceVersion:z.number().int().nonnegative(),updatedAt:z.number().int().nonnegative()});

/** 单条目录条目的状态投影（服务端计算；含墓碑行，因此 `tombstoned` 在界面上可达）。 */
export const navCatalogPlanEntrySchema = z
  .object({
    catalogId: z.string().min(1).max(80),
    state: navCatalogEntryStateSchema,
    linkId: idSchema.nullable(),
  })
  .strict();

export type NavCatalogPlanEntry = z.infer<typeof navCatalogPlanEntrySchema>;

export const navSnapshotSchema = z
  .object({
    links: z.array(navLinkSchema).max(MAX_NAV_LINKS_PER_WORKSPACE),
    groups: z.array(navGroupSchema).max(MAX_NAV_GROUPS_PER_WORKSPACE),
    memberships: z.array(navMembershipSchema),
    /** 工作空间级导航修订号（新鲜度令牌）。 */
    revision: z.number().int().nonnegative(),
    /**
     * 快照的**原子同步水位**（`workspace_changes.seq` 的当前最大值，与该快照在**同一个 D1 batch** 读出）。
     *
     * 为什么必须由快照自己带（第三轮复核修正）：客户端此前先用「reset」拿水位 W，再单独读快照 S；
     * 若在这两个请求之间发生「删除(W+1) → 显式恢复(W+2)」，S 已经包含恢复后的链接，但客户端仍会
     * 收到并应用 W+1 的历史 `delete`——把已恢复的数据删掉。请求发起顺序**不能**证明数据库观察顺序，
     * 只有「内容 + revision + 水位同批读出」才能证明。
     *
     * 协议：客户端**只**用快照发布状态，并把游标设为该 `watermark`；日志仅作**失效信号**
     * （有变更就重读快照），不再把历史事件逐条重放到当前状态上。
     */
    watermark: z.number().int().nonnegative(),
    /** 系统目录当前版本（客户端据此判断「目录有没有升级」）。 */
    catalogSourceVersion: z.number().int().nonnegative(),
    /**
     * 目录状态投影（可选）。
     *
     * `links` 刻意只含活跃行（墓碑属于同步机制，不属于用户快照），因此客户端**无法**只靠
     * 快照判断「这条目录条目被我删过」——那会让被删条目显示成「尚未导入」。
     * 服务端因此额外给出这份投影（由共享 `catalogUpgradePlan` 计算，与服务端导入决策同源）。
     * 标为可选是为了兼容阶段 04 之前的快照读取方（缺失时客户端退化为本地计算）。
     */
    catalogPlan: z.array(navCatalogPlanEntrySchema).optional(),
    limits: z
      .object({
        maxLinks: z.number().int().positive(),
        maxGroups: z.number().int().positive(),
        maxGroupsPerLink: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type NavSnapshot = z.infer<typeof navSnapshotSchema>;

/** 服务端筛选参数（路由查询串与前端本地筛选共用同一形状）。 */
export const navFilterSchema = z
  .object({
    text: z.string().max(200).optional(),
    groupId: idSchema.optional(),
    region: navRegionSchema.optional(),
    status: navLinkStatusSchema.optional(),
    favoritesOnly: z.boolean().optional(),
    tag: z.string().min(1).max(MAX_NAV_TAG_LENGTH).optional(),
    sort: navSortModeSchema.optional(),
  })
  .strict();

export type NavFilter = z.infer<typeof navFilterSchema>;

/** 投影视图：链接 + 它所属的未删除分组。 */
export const navLinkViewSchema = navLinkSchema
  .extend({
    groupIds: z.array(idSchema).max(MAX_NAV_GROUPS_PER_LINK),
    groupNames: z.array(z.string().max(MAX_NAV_GROUP_NAME_LENGTH)).max(MAX_NAV_GROUPS_PER_LINK),
  })
  .strict();

export type NavLinkView = z.infer<typeof navLinkViewSchema>;

// ---------------------------------------------------------------------------
// 写请求（全部严格；写操作必须带 operationId 与 expectedRevision）
// ---------------------------------------------------------------------------

const navLinkEditableFields = {
  title: z.string().min(1).max(MAX_NAV_TITLE_LENGTH).optional(),
  url: navUrlSchema.optional(),
  description: z.string().max(MAX_NAV_DESCRIPTION_LENGTH).optional(),
  tags: z.array(z.string().min(1).max(MAX_NAV_TAG_LENGTH)).max(MAX_NAV_TAGS).optional(),
  aliases: z.array(z.string().min(1).max(MAX_NAV_ALIAS_LENGTH)).max(MAX_NAV_ALIASES).optional(),
  icon: z.string().max(MAX_NAV_ICON_LENGTH).optional(),
  openMode: navOpenModeSchema.optional(),
  region: navRegionSchema.optional(),
  status: navLinkStatusSchema.optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  /** 整体替换该链接的分组归属（多分组）。 */
  groupIds: z.array(idSchema).max(MAX_NAV_GROUPS_PER_LINK).optional(),
} as const;

export const createNavLinkRequestSchema = z
  .object({
    operationId: operationIdSchema,
    title: z.string().min(1).max(MAX_NAV_TITLE_LENGTH),
    url: navUrlSchema,
    description: z.string().max(MAX_NAV_DESCRIPTION_LENGTH).optional(),
    tags: z.array(z.string().min(1).max(MAX_NAV_TAG_LENGTH)).max(MAX_NAV_TAGS).optional(),
    aliases: z.array(z.string().min(1).max(MAX_NAV_ALIAS_LENGTH)).max(MAX_NAV_ALIASES).optional(),
    icon: z.string().max(MAX_NAV_ICON_LENGTH).optional(),
    openMode: navOpenModeSchema.optional(),
    region: navRegionSchema.optional(),
    status: navLinkStatusSchema.optional(),
    isFavorite: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    groupIds: z.array(idSchema).max(MAX_NAV_GROUPS_PER_LINK).optional(),
  })
  .strict();

export const updateNavLinkRequestSchema = z
  .object({
    operationId: operationIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    ...navLinkEditableFields,
  })
  .strict();

export const deleteNavLinkRequestSchema = z
  .object({
    operationId: operationIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

/** 重排：给出**全部**活跃链接的期望顺序（整体替换，避免部分重排产生歧义）。 */
export const reorderNavLinksRequestSchema = z
  .object({
    operationId: operationIdSchema,
    orderedIds: z.array(idSchema).max(MAX_NAV_LINKS_PER_WORKSPACE),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const setNavLinkGroupsRequestSchema = z
  .object({
    operationId: operationIdSchema,
    groupIds: z.array(idSchema).max(MAX_NAV_GROUPS_PER_LINK),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const createNavGroupRequestSchema = z
  .object({
    operationId: operationIdSchema,
    name: z.string().min(1).max(MAX_NAV_GROUP_NAME_LENGTH),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateNavGroupRequestSchema = z
  .object({
    operationId: operationIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().min(1).max(MAX_NAV_GROUP_NAME_LENGTH).optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const deleteNavGroupRequestSchema = z
  .object({
    operationId: operationIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const reorderNavGroupsRequestSchema = z
  .object({
    operationId: operationIdSchema,
    orderedIds: z.array(idSchema).max(MAX_NAV_GROUPS_PER_WORKSPACE),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 目录导入 / 通用导入导出
// ---------------------------------------------------------------------------

/**
 * 从推荐目录导入一条（或一批）条目。
 *
 * `explicitReimport` 是**用户显式点击**「再次导入」时才可为 true：它是复活墓碑的唯一入口。
 * `overwriteUserEdits` 默认 false：目录升级绝不覆盖用户已修改的副本。
 */
export const navCatalogImportRequestSchema = z
  .object({
    operationId: operationIdSchema,
    catalogIds: z.array(idSchema).min(1).max(MAX_NAV_IMPORT_ITEMS),
    explicitReimport: z.boolean().optional(),
    overwriteUserEdits: z.boolean().optional(),
  })
  .strict();

export const navImportItemSchema = z
  .object({
    title: z.string().min(1).max(MAX_NAV_TITLE_LENGTH),
    url: navUrlSchema,
    description: z.string().max(MAX_NAV_DESCRIPTION_LENGTH).optional(),
    tags: z.array(z.string().min(1).max(MAX_NAV_TAG_LENGTH)).max(MAX_NAV_TAGS).optional(),
    aliases: z.array(z.string().min(1).max(MAX_NAV_ALIAS_LENGTH)).max(MAX_NAV_ALIASES).optional(),
    icon: z.string().max(MAX_NAV_ICON_LENGTH).optional(),
    openMode: navOpenModeSchema.optional(),
    region: navRegionSchema.optional(),
    /** 扁平化导入时的分组名（导入器会把同名分组复用/创建为用户分组）。 */
    groupName: z.string().min(1).max(MAX_NAV_GROUP_NAME_LENGTH).optional(),
  })
  .strict();

export type NavImportItem = z.infer<typeof navImportItemSchema>;

export const navImportSkippedSchema = z
  .object({
    reason: navImportSkipReasonSchema,
    /** 可安全回显的说明（含被跳过的标题/URL 片段，绝不含凭证）。 */
    detail: z.string().min(1).max(300),
    title: z.string().max(MAX_NAV_TITLE_LENGTH).nullable(),
    url: z.string().max(MAX_NAV_URL_LENGTH).nullable(),
  })
  .strict();

export type NavImportSkipped = z.infer<typeof navImportSkippedSchema>;

export interface NavParseResult {
  readonly items: readonly NavImportItem[];
  readonly skipped: readonly NavImportSkipped[];
}

export const navExportDocumentSchema = z
  .object({
    schemaVersion: z.literal(NAV_EXPORT_SCHEMA_VERSION),
    exportedAt: utcMsSchema,
    catalogSourceVersion: z.number().int().nonnegative(),
    /** 只导出活跃（未删除）行；墓碑属于同步机制，不属于用户导出。 */
    links: z.array(navLinkSchema).max(MAX_NAV_LINKS_PER_WORKSPACE),
    groups: z.array(navGroupSchema).max(MAX_NAV_GROUPS_PER_WORKSPACE),
    memberships: z.array(navMembershipSchema),
  })
  .strict();

export type NavExportDocument = z.infer<typeof navExportDocumentSchema>;
/**
 * 导入模式。**必须显式区分**（复核发现的真实缺陷）：
 *
 * - `links`：普通链接列表 / 浏览器书签。只有「标题 + URL + 可选描述/标签/分组名」这类字段，
 *   天然不含本应用的分类、多对多归属、收藏、状态与自定义顺序。
 * - `restore`：**本应用导出的版本化导航配置**（`NavExportDocument`）。它包含 links（含
 *   isFavorite/status/sortOrder/icon/aliases/region 等全部功能字段）、groups 与 memberships。
 *   用它做恢复时必须保留全部字段与关系，**绝不能**退化成"只取 links 数组"而静默丢分组/多对多/排序。
 *
 * 两种模式都不允许按外部 ID 引用其他工作空间的数据：恢复时服务端会把 link/group ID
 * 重新映射到当前工作空间（memberships 跟着重映射），`sourceCatalogId` 只是弱关联字符串。
 */
export const NAV_IMPORT_MODES = ['links', 'restore'] as const;
export type NavImportMode = (typeof NAV_IMPORT_MODES)[number];
export const navImportModeSchema = z.enum(NAV_IMPORT_MODES);

export const navImportPreviewRequestSchema = z
  .object({
    /** 省略等价于 `links`（向后兼容既有的书签/链接导入调用方）。 */
    mode: navImportModeSchema.optional(),
    /** `links` 模式：客户端解析后的结构化条目（服务端会**重新校验**，绝不相信"已校验"）。 */
    items: z.array(navImportItemSchema).max(MAX_NAV_IMPORT_ITEMS).optional(),
    skipped: z.array(navImportSkippedSchema).max(MAX_NAV_IMPORT_ITEMS).optional(),
    /** 目标分组（可选）：把本批全部条目归入该分组。 */
    targetGroupId: idSchema.optional(),
    /** `restore` 模式：完整版本化导出文档（含 groups 与 memberships）。 */
    document: navExportDocumentSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const mode = value.mode ?? 'links';
    if (mode === 'restore') {
      if (value.document === undefined) {
        ctx.addIssue({ code: 'custom', path: ['document'], message: 'restore 模式必须提供 document' });
      }
      if (value.items !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['items'],
          message: 'restore 模式不接受 items（完整配置必须走 document，避免静默丢字段）',
        });
      }
      return;
    }
    if (value.items === undefined) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'links 模式必须提供 items' });
    }
    if (value.document !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['document'],
        message: 'links 模式不接受 document；请用 mode=restore 恢复完整配置',
      });
    }
  });

export const navImportApplyRequestSchema = z
  .object({
    operationId: operationIdSchema,
    mode: navImportModeSchema.optional(),
    items: z.array(navImportItemSchema).min(1).max(MAX_NAV_IMPORT_ITEMS).optional(),
    targetGroupId: idSchema.optional(),
    document: navExportDocumentSchema.optional(),
    /** 预览令牌：预览与落库之间若数据被改动则拒绝（避免按旧预览覆盖）。 */
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const mode = value.mode ?? 'links';
    if (mode === 'restore') {
      if (value.document === undefined) {
        ctx.addIssue({ code: 'custom', path: ['document'], message: 'restore 模式必须提供 document' });
      }
      if (value.items !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['items'], message: 'restore 模式不接受 items' });
      }
      return;
    }
    if (value.items === undefined) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'links 模式必须提供 items' });
    }
    if (value.document !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['document'], message: 'links 模式不接受 document' });
    }
  });



/** 结构化冲突（复用同步契约里的同一形状：谁在哪个字段上冲突、如何选择）。 */
export const navConflictSchema = syncConflictSchema;
export type NavConflict = z.infer<typeof navConflictSchema>;

// ---------------------------------------------------------------------------
// 筛选 / 排序 / 投影（唯一实现）
// ---------------------------------------------------------------------------

/** 关键词分词：规范化后按空白切分，全部命中才算匹配（AND）。 */
function textTokens(text: string | undefined): string[] {
  const normalized = normalizeNavText(text);
  return normalized.length === 0 ? [] : normalized.split(' ').filter((token) => token.length > 0);
}

function haystackOf(link: NavLink): string {
  return [
    normalizeNavText(link.title),
    normalizeNavText(link.description),
    link.tags.map((tag) => normalizeNavText(tag)).join(' '),
    link.aliases.map((alias) => normalizeNavText(alias)).join(' '),
  ].join('\n');
}

/**
 * 按筛选条件过滤链接（不含分组筛选：分组需要成员关系，见 `projectNavLinks`）。
 *
 * 规则：只考虑未删除链接；`status` 默认只看 `active`；`region` 命中该值或 `both`；
 * `tag` 按规范化值精确匹配；`favoritesOnly` 只看收藏。
 */
export function filterNavLinks(links: readonly NavLink[], filter: NavFilter): NavLink[] {
  const tokens = textTokens(filter.text);
  const status = filter.status ?? 'active';
  const tag = filter.tag === undefined ? null : normalizeNavText(filter.tag);
  return links.filter((link) => {
    if (link.deletedAt !== null) {
      return false;
    }
    if (link.status !== status) {
      return false;
    }
    if (filter.region !== undefined && link.region !== filter.region && link.region !== 'both') {
      return false;
    }
    if (filter.favoritesOnly === true && !link.isFavorite) {
      return false;
    }
    if (tag !== null && !link.tags.some((value) => normalizeNavText(value) === tag)) {
      return false;
    }
    if (tokens.length > 0) {
      const haystack = haystackOf(link);
      if (!tokens.every((token) => haystack.includes(token))) {
        return false;
      }
    }
    return true;
  });
}

/**
 * 排序（确定性）：同分时一律用 id 兜底打破平局，避免同一份数据在不同设备上顺序不同。
 * 返回新数组，绝不修改入参。
 */
export function sortNavLinks(links: readonly NavLink[], mode: NavSortMode): NavLink[] {
  const byId = (a: NavLink, b: NavLink): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byName = (a: NavLink, b: NavLink): number => {
    const left = normalizeNavText(a.title);
    const right = normalizeNavText(b.title);
    return left < right ? -1 : left > right ? 1 : byId(a, b);
  };
  const byManual = (a: NavLink, b: NavLink): number =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : byName(a, b);
  const sorted = [...links];
  switch (mode) {
    case 'title':
      sorted.sort(byName);
      break;
    case 'recent':
      sorted.sort((a, b) => (b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : byId(a, b)));
      break;
    case 'favorite':
      sorted.sort((a, b) => (a.isFavorite === b.isFavorite ? byManual(a, b) : a.isFavorite ? -1 : 1));
      break;
    case 'manual':
      sorted.sort(byManual);
      break;
  }
  return sorted;
}

export interface ProjectNavLinksInput {
  readonly links: readonly NavLink[];
  readonly groups: readonly NavGroup[];
  readonly memberships: readonly NavMembership[];
  readonly filter?: NavFilter;
}

/**
 * 投影：把链接、分组、成员关系合成前端直接可渲染的视图。
 *
 * 只使用**未删除**的链接与成员关系，以及未删除的分组；因此「删掉的分组」不会作为幽灵分组
 * 出现在界面上。
 */
export function projectNavLinks(input: ProjectNavLinksInput): NavLinkView[] {
  const filter = input.filter ?? {};
  const groupById = new Map(
    input.groups.filter((group) => group.deletedAt === null).map((group) => [group.id, group] as const),
  );
  const groupIdsByLink = new Map<string, string[]>();
  for (const membership of input.memberships) {
    if (membership.deletedAt !== null || !groupById.has(membership.groupId)) {
      continue;
    }
    const list = groupIdsByLink.get(membership.linkId) ?? [];
    list.push(membership.groupId);
    groupIdsByLink.set(membership.linkId, list);
  }

  const candidates = filterNavLinks(input.links, filter).filter((link) => {
    if (filter.groupId === undefined) {
      return true;
    }
    return (groupIdsByLink.get(link.id) ?? []).includes(filter.groupId);
  });

  return sortNavLinks(candidates, filter.sort ?? 'manual').map((link) => {
    const groupIds = groupIdsByLink.get(link.id) ?? [];
    return {
      ...link,
      groupIds,
      groupNames: groupIds
        .map((groupId) => groupById.get(groupId)?.name ?? '')
        .filter((name) => name.length > 0),
    };
  });
}

// ---------------------------------------------------------------------------
// 目录升级判定（D1：升级 ≠ 再导入）
// ---------------------------------------------------------------------------

/**
 * 判定「用户是否改过这条副本」时**只**比较可编辑内容字段（下面逐个列出）；
 * 分组归属不算——它属于个人组织方式，不是对目录内容的修改。
 */
function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => normalizeNavText(value) === normalizeNavText(right[index] ?? ''));
}

export function navCatalogEntryState(input: {
  readonly entry: NavCatalogEntry;
  readonly link: NavLink | undefined;
}): NavCatalogEntryState {
  const { entry, link } = input;
  if (link === undefined) {
    return 'new';
  }
  if (link.deletedAt !== null) {
    // 墓碑优先于一切：用户删掉了它，目录升级不能把它变成"已修改"或"未变化"。
    return 'tombstoned';
  }
  const modified =
    link.title !== entry.title ||
    link.url !== entry.url ||
    link.description !== entry.description ||
    link.openMode !== entry.openMode ||
    link.region !== entry.region ||
    link.isFavorite ||
    link.icon !== entry.icon ||
    !sameStringList(link.tags, entry.tags) ||
    !sameStringList(link.aliases, entry.aliases);
  return modified ? 'user_modified' : 'unchanged';
}

export interface CatalogUpgradePlanEntry {
  readonly state: NavCatalogEntryState;
  readonly catalogId: string;
  readonly linkId: string | null;
}

/** 目录 → 个人副本的升级计划（只读报告，不写任何数据）。排序稳定：按目录 ID。 */
export function catalogUpgradePlan(input: {
  readonly catalog: readonly NavCatalogEntry[];
  readonly links: readonly NavLink[];
}): CatalogUpgradePlanEntry[] {
  const byCatalogId = new Map<string, NavLink>();
  for (const link of input.links) {
    if (link.sourceCatalogId !== null && !byCatalogId.has(link.sourceCatalogId)) {
      byCatalogId.set(link.sourceCatalogId, link);
    }
  }
  return [...input.catalog]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => {
      const link = byCatalogId.get(entry.id);
      return {
        state: navCatalogEntryState({ entry, link }),
        catalogId: entry.id,
        linkId: link?.id ?? null,
      };
    });
}

export interface NavCatalogImportDecision {
  readonly action: 'insert' | 'update' | 'restore_tombstone' | 'skip';
  readonly reason: string;
}

/**
 * 单条目录条目的导入决策。
 *
 * 四条规则（缺一不可）：
 * - 墓碑 + 非显式再导入 → `skip`：**目录升级绝不复活用户删掉的条目**；
 * - 墓碑 + 显式再导入 → `restore_tombstone`：这是唯一复活入口，且必须是用户点出来的；
 * - 用户改过 + 未显式允许覆盖 → `skip`：**目录升级不覆盖个人修改**；
 * - 未变化 → `skip`；不存在 → `insert`；存在且改动未被用户改过且允许覆盖 → `update`。
 */
export function decideCatalogImport(input: {
  readonly state: NavCatalogEntryState;
  readonly explicitReimport?: boolean;
  readonly overwriteUserEdits?: boolean;
}): NavCatalogImportDecision {
  const explicit = input.explicitReimport === true;
  const overwrite = input.overwriteUserEdits === true;
  switch (input.state) {
    case 'new':
      return { action: 'insert', reason: '目录条目尚未导入' };
    case 'tombstoned':
      return explicit
        ? { action: 'restore_tombstone', reason: '用户显式再次导入：恢复该条目的墓碑行' }
        : { action: 'skip', reason: '该条目已被用户删除；只有显式再次导入才会恢复' };
    case 'user_modified':
      return explicit && overwrite
        ? { action: 'update', reason: '用户显式再次导入并确认覆盖个人修改' }
        : { action: 'skip', reason: '该条目已被用户修改；目录升级不覆盖个人修改' };
    case 'unchanged':
      return explicit && overwrite
        ? { action: 'update', reason: '用户显式再次导入并确认以目录内容刷新' }
        : { action: 'skip', reason: '与目录内容一致，无需变更' };
  }
}

// ---------------------------------------------------------------------------
// 书签 HTML / JSON 导入（严格解析为数据，绝不执行外来 HTML）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 一次成功的实体扫描：`text` 是解码结果，`end` 指向结束分号之后。 */
interface DecodedEntity {
  readonly text: string;
  readonly end: number;
}

/** `\s` 的精确字符集（ECMA-262 的 WhiteSpace + LineTerminator）：手写扫描必须逐码元对齐它。 */
function isSpaceCode(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** ASCII 大小写不敏感比较：等价于原正则的 `i` 标志（此处只涉及 ASCII 字母）。 */
function matchesAsciiIgnoreCase(value: string, start: number, expected: string): boolean {
  for (let offset = 0; offset < expected.length; offset += 1) {
    const code = value.charCodeAt(start + offset);
    const folded = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (folded !== expected.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isDigitCodeFor(code: number, radix: 10 | 16): boolean {
  if (code >= 0x30 && code <= 0x39) {
    return true;
  }
  return radix === 16 && ((code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66));
}

/**
 * 取 `#x<hex>` / `#<decimal>` 形态的码点。
 *
 * 原实现用 `Number.parseInt` + `Number.isFinite(code) && code > 0` 把关，这里逐条保留：
 * `&#0;` 与位数多到 parseInt 溢出成 `Infinity` 的写法都原样保留（返回 `null` ⇒ 调用方原样输出）。
 * 数字位数**不设上限**：`&#x0000000041;` 这类前导零写法在原实现里同样解码成 `A`，
 * 人为截断会造成行为差异；而扫描只向前推进、每个字符最多被读一次，天然是 O(n)。
 */
function decodeNumericEntityAt(value: string, digitStart: number, radix: 10 | 16): DecodedEntity | null {
  let end = digitStart;
  while (end < value.length && isDigitCodeFor(value.charCodeAt(end), radix)) {
    end += 1;
  }
  if (end === digitStart || value.charCodeAt(end) !== 0x3b /* ; */) {
    return null;
  }
  const code = Number.parseInt(value.slice(digitStart, end), radix);
  if (!Number.isFinite(code) || code <= 0) {
    return null;
  }
  return { text: String.fromCodePoint(Math.min(code, 0x10ffff)), end: end + 1 };
}

/** 取 `<alpha>` 形态的命名实体；查不到就返回 `null`（原样保留 `&…;`）。 */
function decodeNamedEntityAt(value: string, amp: number): DecodedEntity | null {
  let end = amp + 1;
  while (end < value.length && isAsciiLetterCode(value.charCodeAt(end))) {
    end += 1;
  }
  if (end === amp + 1 || value.charCodeAt(end) !== 0x3b /* ; */) {
    return null;
  }
  // 与原实现逐字相同的查表（名称大小写不敏感）。
  const text = NAMED_ENTITIES[value.slice(amp + 1, end).toLowerCase()];
  return text === undefined ? null : { text, end: end + 1 };
}

/**
 * 尝试解码 `value` 中位置 `amp`（必须是 `&`）处的一个实体；`null` 表示此处不构成实体。
 *
 * 等价性依据：原正则的每个分支都以 `;` 收尾，因此"能否匹配"只由**局部字符形态**决定；
 * 返回 `null` 时调用方只复制这个 `&` 并前进一个字符——正是原正则匹配失败时不吞字符的行为。
 *
 * 分支对应关系（原式 `/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g`）：
 * - `#x<hex>`：注意原正则**没有** `i` 标志，`&#X27;` 不落在这个分支
 *   （旧回调里 `body.startsWith('#X')` 那一段因此不可达），这里刻意保持同一判定；
 * - `#<decimal>`；
 * - `<alpha>`：不要求单词边界、不做长度截断（超长名字必然查表失败，结果与原样保留相同）。
 */
function decodeEntityAt(value: string, amp: number): DecodedEntity | null {
  if (value.charCodeAt(amp + 1) === 0x23 /* # */) {
    if (value.charCodeAt(amp + 2) === 0x78 /* x */) {
      return decodeNumericEntityAt(value, amp + 3, 16);
    }
    return decodeNumericEntityAt(value, amp + 2, 10);
  }
  return decodeNamedEntityAt(value, amp);
}

/**
 * 解码书签文件里的实体。
 *
 * 注意方向：这里把 `.html` 文件里的 `&amp;lt;` 还原成**数据**里的 `&lt;` 文本，
 * 绝不会把它塞回 DOM。解码结果只用于标题与分组名（纯文本）。
 *
 * ── 为什么用线性扫描而不是正则（SonarCloud S5852）─────────────────────────────
 * 原实现是 `/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g`：**多个分支各自带量词**，
 * 且分支前缀互相重叠（`#x…` / `#…` / 字母名）。这种"分支 + 量词"结构在匹配失败时
 * 会让引擎在每个 `&` 位置把全部分支重试一遍，是 S5852 判定的 ReDoS 形态
 * （对 `&aaaa…`、`&#xxxx…` 这类长串输入代价随长度增长）。
 * 下面的扫描只向前推进：失败时前进一个字符，成功时直接跳过整个 `&…;`，
 * 每个字符最多被读常数次，因此对任意输入都是 O(n)，行为与上面逐分支注释一一对应。
 */
function decodeHtmlEntities(value: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const amp = value.indexOf('&', cursor);
    if (amp < 0) {
      return result + value.slice(cursor);
    }
    result += value.slice(cursor, amp);
    const entity = decodeEntityAt(value, amp);
    if (entity === null) {
      // 不构成实体：原样保留这个 `&`，只前进一个字符（不吞掉后面的文本）。
      result += '&';
      cursor = amp + 1;
      continue;
    }
    // 跳过整个 `&…;`，解码结果不会被二次解码（`&amp;lt;` → `&lt;`，与原实现一致）。
    result += entity.text;
    cursor = entity.end;
  }
  return result;
}

/**
 * 去掉所有标签，只留下文本（用于标题/分组名）。
 *
 * 这里的两个正则**刻意保留**：`<[^>]*>` 的字符类排除了 `>`（不可能与自身重叠）、
 * 没有分支嵌套，匹配与扫描都是线性的；`\s+` 只是单个量词、无嵌套量词、无分支。
 * 二者都不是 S5852 的形态，换成手写扫描只会引入无谓的等价性风险。
 */
function textOfFragment(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/gu, ' ').trim();
}

/** 移除 script/style 内容：它们不是数据，也绝不参与解析（更不允许被执行）。 */
function stripNonDataBlocks(html: string): string {
  let result = html;
  for (const tag of ['script', 'style']) {
    let cursor = 0;
    for (;;) {
      const lower = result.toLowerCase();
      const open = lower.indexOf(`<${tag}`, cursor);
      if (open < 0) {
        break;
      }
      const close = lower.indexOf(`</${tag}>`, open);
      if (close < 0) {
        result = result.slice(0, open);
        break;
      }
      const end = close + tag.length + 3;
      result = `${result.slice(0, open)} ${result.slice(end)}`;
      cursor = open;
    }
  }
  return result;
}

/**
 * 按引号形态取一个属性值；`null` 表示"该起点不匹配"（调用方继续找下一个 `href`）。
 *
 * 对应原正则取值部分的三个分支：`"([^"]*)"` / `'([^']*)'` / `([^\s"'>]+)`。
 * 两个引号分支都要求**配对**：不配对时原正则的三个分支（字符类都排除引号）全不匹配，
 * 因此这里同样返回 `null` 而不是把剩余文本当成值。裸值分支要求至少一个字符（原 `+`）。
 */
function readHrefOperand(rawAttributes: string, start: number): string | null {
  const opener = rawAttributes.charCodeAt(start);
  if (opener === 0x22 /* " */ || opener === 0x27 /* ' */) {
    const closer = rawAttributes.indexOf(opener === 0x22 ? '"' : "'", start + 1);
    return closer < 0 ? null : rawAttributes.slice(start + 1, closer);
  }
  let end = start;
  while (end < rawAttributes.length) {
    const code = rawAttributes.charCodeAt(end);
    if (isSpaceCode(code) || code === 0x22 /* " */ || code === 0x27 /* ' */ || code === 0x3e /* > */) {
      break;
    }
    end += 1;
  }
  return end === start ? null : rawAttributes.slice(start, end);
}

/**
 * 在属性串里找 `href` 并取出它的原始值（尚未做实体解码）。
 *
 * ── 为什么用线性扫描而不是正则（SonarCloud S5852）─────────────────────────────
 * 原实现是 `/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/iu`：取值部分是**三个分支**，
 * 其中两个分支内部还带 `*` 量词——"分支内含量词"正是 S5852 的判定形态。
 * 这里把"找 `href` → 跳空白 → 必须 `=` → 跳空白 → 按形态取值"写成一次向前推进的扫描：
 * 每个起点只判定一次，失败就右移一个字符，因此是 O(n)。
 *
 * 与原正则逐条对齐的判定细节：
 * - 大小写不敏感（原 `i` 标志；只涉及 ASCII 字母，用 `matchesAsciiIgnoreCase` 对齐）；
 * - 空白集用 `isSpaceCode` 逐码元对齐 `\s`（含 NBSP、全角空格等）；
 * - `href` **不要求单词边界**：`data-href=`、`hhref=` 里的 `href` 同样命中（原正则如此）；
 * - 失败后起点**右移一个字符**而不是跳过 4 个：`hrefhref="x"` 仍能命中第二个（原正则的回溯顺序）。
 */
function readHrefValue(rawAttributes: string): string | null {
  const name = 'href';
  for (let start = 0; start < rawAttributes.length; start += 1) {
    if (!matchesAsciiIgnoreCase(rawAttributes, start, name)) {
      continue;
    }
    let cursor = start + name.length;
    while (cursor < rawAttributes.length && isSpaceCode(rawAttributes.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (rawAttributes.charCodeAt(cursor) !== 0x3d /* = */) {
      continue;
    }
    cursor += 1;
    while (cursor < rawAttributes.length && isSpaceCode(rawAttributes.charCodeAt(cursor))) {
      cursor += 1;
    }
    const value = readHrefOperand(rawAttributes, cursor);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** 从 `<a ...>` 的原始属性串里取 href（支持双引号/单引号/裸值），并解码实体。 */
function extractHref(rawAttributes: string): string | null {
  const value = readHrefValue(rawAttributes);
  if (value === null) {
    return null;
  }
  // 真实书签里查询串普遍写成 `?a=1&amp;b=2`；不解码就会把字面 `&amp;` 写进个人链接。
  const decoded = decodeHtmlEntities(value).trim();
  return decoded.length === 0 ? null : decoded;
}

function skipOf(
  reason: NavImportSkipReason,
  detail: string,
  title: string | null,
  url: string | null,
): NavImportSkipped {
  return { reason, detail, title, url };
}

/**
 * 解析浏览器导出的 Netscape 书签 HTML。
 *
 * 设计选择（复核要求：严格解析为数据、逐项说明跳过、不执行或直接插入外来 HTML）：
 * - **手写扫描器**，不用 `DOMParser`（Shared 层没有 DOM，Worker 里更没有）。
 * - 只把 `<a href>` 与 `<h3>`/`<dt>` 当数据读，其余标签一律忽略；script/style 整体丢弃。
 * - 每一项要么进 `items`，要么进 `skipped` 并带原因——不存在"静默丢弃"。
 */
export function parseBookmarkHtml(html: unknown, options?: { readonly defaultRegion?: NavRegion }): NavParseResult {
  const region = options?.defaultRegion ?? 'cn';
  const source = stripNonDataBlocks(typeof html === 'string' ? html.slice(0, 4 * 1024 * 1024) : '');
  const lower = source.toLowerCase();
  const items: NavImportItem[] = [];
  const skipped: NavImportSkipped[] = [];
  const seen = new Set<string>();

  let cursor = 0;
  let currentGroup: string | null = null;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) {
      break;
    }
    const close = source.indexOf('>', open);
    if (close < 0) {
      break;
    }
    const rawTag = source.slice(open + 1, close);
    cursor = close + 1;
    const tagName = (rawTag.trim().split(/[\s/]/, 1)[0] ?? '').toLowerCase();

    // 只有 `<h3>` 是「文件夹名」的载体：它在真实导出里成对出现。
    // `<dt>` 必须**单独当作无内容标签跳过**——真实浏览器导出的 `<DT>` 既不闭合、
    // 又包裹着 `<A>`，把它当成"分组名直到 </DT>"会把整份文件吃掉（复核发现的真实缺陷：
    // 之前对真实书签文件解析结果恒为空且静默丢弃）。
    if (tagName === 'h3') {
      const closeTag = '</h3>';
      const end = lower.indexOf(closeTag, cursor);
      const fragment = end < 0 ? '' : source.slice(cursor, end);
      cursor = end < 0 ? source.length : end + closeTag.length;
      const name = textOfFragment(fragment);
      if (name.length > 0) {
        currentGroup = name.slice(0, MAX_NAV_GROUP_NAME_LENGTH);
      }
      continue;
    }

    if (tagName !== 'a') {
      continue;
    }

    const end = lower.indexOf('</a>', cursor);
    const fragment = end < 0 ? '' : source.slice(cursor, end);
    cursor = end < 0 ? source.length : end + 4;

    const href = extractHref(rawTag);
    const title = textOfFragment(fragment).slice(0, MAX_NAV_TITLE_LENGTH);
    if (href === null) {
      skipped.push(skipOf('invalid_url', '链接没有可用的 href', title.length > 0 ? title : null, null));
      continue;
    }
    const validation = validateNavUrl(href);
    if (!validation.ok) {
      skipped.push(
        skipOf(
          validation.reason === 'scheme' ? 'unsupported_scheme' : 'invalid_url',
          validation.reason === 'scheme'
            ? '只允许 https:// 链接，已跳过非 https 地址'
            : 'URL 形态不可用（缺少主机、含凭证或超长）',
          title.length > 0 ? title : null,
          href.slice(0, MAX_NAV_URL_LENGTH),
        ),
      );
      continue;
    }
    if (title.length === 0) {
      skipped.push(skipOf('missing_title', '链接没有标题，无法作为导航条目', null, validation.url));
      continue;
    }
    const key = normalizeNavText(validation.url);
    if (seen.has(key)) {
      skipped.push(skipOf('duplicate', '同一 URL 已在本次导入中出现过', title, validation.url));
      continue;
    }
    if (items.length >= MAX_NAV_IMPORT_ITEMS) {
      skipped.push(skipOf('too_many_items', `单次导入上限为 ${String(MAX_NAV_IMPORT_ITEMS)} 条`, title, validation.url));
      continue;
    }
    seen.add(key);
    items.push({
      title,
      url: validation.url,
      region,
      ...(currentGroup === null ? {} : { groupName: currentGroup }),
    });
  }

  return { items, skipped };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * 解析结构化 JSON 导入（`{ "links": [...] }` 或裸数组）——**仅限普通链接列表**。
 *
 * 只接受**明确的字段**，不猜形状：任何不满足契约的条目都进 `skipped` 并给出原因。
 *
 * 复核修正：输入若是**版本化导航配置**（含 `schemaVersion`），这里**拒绝**并把原因写清楚
 * （`unsupported_document`），而不是抽出 `links` 当成普通列表——那会静默丢掉分组/多对多/
 * 收藏/状态/顺序。完整配置必须走 `parseNavImportDocument` 的 `restore` 分支。
 */
export function parseNavImportJson(raw: unknown): NavParseResult {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return {
        items: [],
        skipped: [skipOf('invalid_url', 'JSON 无法解析（不是合法 JSON）', null, null)],
      };
    }
  }
  const container = asRecord(parsed);
  if (Object.hasOwn(container, 'schemaVersion')) {
    return {
      items: [],
      skipped: [
        skipOf(
          'unsupported_document',
          '这是本应用导出的版本化导航配置：请用「恢复完整配置」导入，普通链接导入不会保留分组与多对多归属',
          null,
          null,
        ),
      ],
    };
  }
  const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(container['links']) ? container['links'] : [];
  const items: NavImportItem[] = [];
  const skipped: NavImportSkipped[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    const record = asRecord(entry);
    const title = typeof record['title'] === 'string' ? record['title'].trim().slice(0, MAX_NAV_TITLE_LENGTH) : '';
    const urlValue = record['url'];
    const validation = validateNavUrl(urlValue);
    if (!validation.ok) {
      skipped.push(
        skipOf(
          validation.reason === 'scheme' ? 'unsupported_scheme' : 'invalid_url',
          validation.reason === 'scheme'
            ? '只允许 https:// 链接，已跳过非 https 地址'
            : 'URL 形态不可用（缺少主机、含凭证或超长）',
          title.length > 0 ? title : null,
          typeof urlValue === 'string' ? urlValue.slice(0, MAX_NAV_URL_LENGTH) : null,
        ),
      );
      continue;
    }
    if (title.length === 0) {
      skipped.push(skipOf('missing_title', '条目缺少 title', null, validation.url));
      continue;
    }
    const key = normalizeNavText(validation.url);
    if (seen.has(key)) {
      skipped.push(skipOf('duplicate', '同一 URL 已在本次导入中出现过', title, validation.url));
      continue;
    }
    if (items.length >= MAX_NAV_IMPORT_ITEMS) {
      skipped.push(skipOf('too_many_items', `单次导入上限为 ${String(MAX_NAV_IMPORT_ITEMS)} 条`, title, validation.url));
      continue;
    }
    seen.add(key);

    const candidate: Record<string, unknown> = {
      title,
      url: validation.url,
      tags: normalizeNavTags(record['tags']),
      aliases: normalizeNavAliases(record['aliases']),
      ...(typeof record['description'] === 'string'
        ? { description: record['description'].slice(0, MAX_NAV_DESCRIPTION_LENGTH) }
        : {}),
      ...(typeof record['icon'] === 'string' ? { icon: record['icon'].slice(0, MAX_NAV_ICON_LENGTH) } : {}),
      ...(NAV_REGIONS.includes(record['region'] as NavRegion) ? { region: record['region'] } : {}),
      ...(NAV_OPEN_MODES.includes(record['openMode'] as NavOpenMode) ? { openMode: record['openMode'] } : {}),
      ...(typeof record['groupName'] === 'string' && record['groupName'].trim().length > 0
        ? { groupName: record['groupName'].trim().slice(0, MAX_NAV_GROUP_NAME_LENGTH) }
        : {}),
    };
    const parsedItem = navImportItemSchema.safeParse(candidate);
    if (parsedItem.success) {
      items.push(parsedItem.data);
    } else {
      skipped.push(skipOf('invalid_url', '条目字段不符合导入契约', title, validation.url));
    }
  }

  return { items, skipped };
}

/** 构造可 roundtrip 的导出文档（只含活跃行，不含任何凭证）。 */
/**
 * 构造可 roundtrip 的导出文档（只含活跃行，不含任何凭证）。
 *
 * 复核修正（引用完整性）：成员关系只导出**两端都活跃**的那些。
 * 否则文档里会出现「指向已删链接/已删分组」的悬空成员关系——那种文档导入回来会把
 * 用户面丢掉的关系又"复活"一半，而且导出的 schema 自身也不自洽。
 */
export function buildNavExportDocument(input: {
  readonly links: readonly NavLink[];
  readonly groups: readonly NavGroup[];
  readonly memberships: readonly NavMembership[];
  readonly catalogSourceVersion: number;
  readonly exportedAt: number;
}): NavExportDocument {
  const links = input.links.filter((link) => link.deletedAt === null);
  const groups = input.groups.filter((group) => group.deletedAt === null);
  const linkIds = new Set(links.map((link) => link.id));
  const groupIds = new Set(groups.map((group) => group.id));
  const memberships = input.memberships.filter(
    (membership) =>
      membership.deletedAt === null && linkIds.has(membership.linkId) && groupIds.has(membership.groupId),
  );
  return {
    schemaVersion: NAV_EXPORT_SCHEMA_VERSION,
    exportedAt: input.exportedAt,
    catalogSourceVersion: input.catalogSourceVersion,
    links,
    groups,
    memberships,
  };
}

export type NavExportParseResult =
  | { readonly ok: true; readonly document: NavExportDocument }
  | { readonly ok: false; readonly reason: string };

/**
 * 导出文档的**引用完整性**检查（导出与恢复共用同一判定）。
 *
 * 检查项（任何一项失败都必须拒绝，而不是"导入时跳过几条"）：
 * - link / group 的 ID 在本文件内唯一；
 * - membership 的两端都必须在文件的活跃 links / groups 里（禁止悬空）；
 * - 数量不超过容量上限；
 * - 每个 URL 仍满足 https 策略（文档可能被手工编辑过）。
 */
export function validateNavExportIntegrity(document: NavExportDocument): {
  readonly ok: boolean;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const seenLinkIds = new Set<string>();
  for (const link of document.links) {
    if (seenLinkIds.has(link.id)) {
      problems.push(`链接 ID 重复：${link.id}`);
    }
    seenLinkIds.add(link.id);
    const validation = validateNavUrl(link.url);
    if (!validation.ok) {
      problems.push(`链接 URL 不符合策略：${link.id}`);
    }
  }
  const seenGroupIds = new Set<string>();
  for (const group of document.groups) {
    if (seenGroupIds.has(group.id)) {
      problems.push(`分组 ID 重复：${group.id}`);
    }
    seenGroupIds.add(group.id);
  }
  const seenPairs = new Set<string>();
  for (const membership of document.memberships) {
    const pair = `${membership.linkId}\u0000${membership.groupId}`;
    if (seenPairs.has(pair)) {
      problems.push(`成员关系重复：${membership.linkId} ↔ ${membership.groupId}`);
    }
    seenPairs.add(pair);
    if (!seenLinkIds.has(membership.linkId)) {
      problems.push(`成员关系指向不存在的链接：${membership.linkId}`);
    }
    if (!seenGroupIds.has(membership.groupId)) {
      problems.push(`成员关系指向不存在的分组：${membership.groupId}`);
    }
  }
  if (document.links.length > MAX_NAV_LINKS_PER_WORKSPACE) {
    problems.push(`链接数量超过上限 ${String(MAX_NAV_LINKS_PER_WORKSPACE)}`);
  }
  if (document.groups.length > MAX_NAV_GROUPS_PER_WORKSPACE) {
    problems.push(`分组数量超过上限 ${String(MAX_NAV_GROUPS_PER_WORKSPACE)}`);
  }
  return { ok: problems.length === 0, problems };
}

/** 读回导出文档。未来版本（schemaVersion 更大）必须**明确拒绝**，不尝试猜测。 */
export function parseNavExportDocument(raw: unknown): NavExportParseResult {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, reason: '导出文档不是合法 JSON' };
    }
  }
  const version = asRecord(parsed)['schemaVersion'];
  if (typeof version !== 'number') {
    return { ok: false, reason: '导出文档缺少 schemaVersion（不是本应用的版本化配置）' };
  }
  if (version > NAV_EXPORT_SCHEMA_VERSION) {
    return { ok: false, reason: `导出文档版本 ${String(version)} 高于当前支持的 ${String(NAV_EXPORT_SCHEMA_VERSION)}` };
  }
  const result = navExportDocumentSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: '导出文档结构不符合契约' };
  }
  const integrity = validateNavExportIntegrity(result.data);
  if (!integrity.ok) {
    return { ok: false, reason: `导出文档引用不完整：${integrity.problems.slice(0, 3).join('；')}` };
  }
  return { ok: true, document: result.data };
}

/**
 * 导入内容的**类型判定**（唯一入口，界面与测试都用它）。
 *
 * - 带 `schemaVersion` 的对象 → 版本化导航配置 → `restore`（保留全部字段与关系）；
 * - 数组或 `{links: [...]}` → 普通链接列表 → `links`（浏览器书签/结构化链接）。
 *
 * 未来版本、损坏 JSON、引用不完整的文档一律返回 `error`，由调用方明确展示，
 * **不允许**降级成 links 数组静默丢字段。
 */
export type NavImportDocumentParseResult =
  | { readonly kind: 'links'; readonly items: readonly NavImportItem[]; readonly skipped: readonly NavImportSkipped[] }
  | { readonly kind: 'restore'; readonly document: NavExportDocument }
  | { readonly kind: 'error'; readonly reason: string };

export function parseNavImportDocument(raw: unknown): NavImportDocumentParseResult {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { kind: 'error', reason: 'JSON 无法解析（不是合法 JSON）' };
    }
  }
  if (Object.hasOwn(asRecord(parsed), 'schemaVersion')) {
    const restored = parseNavExportDocument(parsed);
    return restored.ok ? { kind: 'restore', document: restored.document } : { kind: 'error', reason: restored.reason };
  }
  const links = parseNavImportJson(parsed);
  return { kind: 'links', items: links.items, skipped: links.skipped };
}

// ---------------------------------------------------------------------------
// 模块 Manifest 与 Widget 配置契约
// ---------------------------------------------------------------------------

export const NAV_QUICK_LINKS_CONFIG_VERSION = 1;
export const NAV_SEARCH_CONFIG_VERSION = 1;

/** `nav-quick-links`：常用/收藏网站（配置只影响**展示**，不改变数据）。 */
export const navQuickLinksConfigSchema = z
  .object({
    title: z.string().min(1).max(40).default('常用网站'),
    groupId: z.string().min(1).max(64).nullable().default(null),
    favoritesOnly: z.boolean().default(true),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();

/** `nav-search`：搜索与分类筛选。 */
export const navSearchConfigSchema = z
  .object({
    title: z.string().min(1).max(40).default('导航搜索'),
    groupId: z.string().min(1).max(64).nullable().default(null),
    region: navRegionSchema.default('both'),
    tag: z.string().min(1).max(MAX_NAV_TAG_LENGTH).nullable().default(null),
    sort: navSortModeSchema.default('manual'),
  })
  .strict();

export type NavQuickLinksConfig = z.infer<typeof navQuickLinksConfigSchema>;
export type NavSearchConfig = z.infer<typeof navSearchConfigSchema>;

export const NAV_WIDGET_CONFIG_CONTRACTS: readonly WidgetConfigContract[] = [
  {
    widgetId: NAV_WIDGET_IDS.quickLinks,
    configSchemaVersion: NAV_QUICK_LINKS_CONFIG_VERSION,
    schema: navQuickLinksConfigSchema,
    defaultConfig: { title: '常用网站', groupId: null, favoritesOnly: true, limit: 8 },
    migrations: {},
  },
  {
    widgetId: NAV_WIDGET_IDS.search,
    configSchemaVersion: NAV_SEARCH_CONFIG_VERSION,
    schema: navSearchConfigSchema,
    defaultConfig: { title: '导航搜索', groupId: null, region: 'both', tag: null, sort: 'manual' },
    migrations: {},
  },
];

export function findNavWidgetConfigContract(widgetId: string): WidgetConfigContract | null {
  return NAV_WIDGET_CONFIG_CONTRACTS.find((contract) => contract.widgetId === widgetId) ?? null;
}

/**
 * 导航模块 Manifest。
 *
 * 能力声明是**权限面**，不是装饰：`storage:own` 表示读写自己的表，
 * `navigation:read-catalog` 表示允许读取系统推荐目录。注册表会把「声明 ⊆ 授予」校验一遍，
 * 前端 Host 也会在渲染前比对，缺少能力就降级而不是照常执行。
 */
export const NAV_MODULE_MANIFEST: ModuleManifest = {
  id: NAV_MODULE_ID,
  version: '1.0.0',
  displayName: 'FF14 导航（个人链接与推荐目录）',
  capabilities: ['storage:own', 'navigation:read-catalog'],
  widgets: [
    {
      id: NAV_WIDGET_IDS.quickLinks,
      moduleId: NAV_MODULE_ID,
      displayName: '常用网站（收藏与分组）',
      allowMultiple: true,
      defaultSize: { w: 4, h: 4 },
      minSize: { w: 2, h: 2 },
      configSchemaVersion: NAV_QUICK_LINKS_CONFIG_VERSION,
    },
    {
      id: NAV_WIDGET_IDS.search,
      moduleId: NAV_MODULE_ID,
      displayName: '导航搜索与分类',
      allowMultiple: true,
      defaultSize: { w: 4, h: 3 },
      minSize: { w: 2, h: 2 },
      configSchemaVersion: NAV_SEARCH_CONFIG_VERSION,
    },
  ],
  routes: [{ path: '/nav', viewId: 'nav' }],
  settingsSchemaVersion: 1,
  lifecycle: {
    onEnable: 'ff14.navigation.enable',
    onDisable: 'ff14.navigation.disable',
    onUninstall: 'ff14.navigation.uninstall',
  },
};
