/**
 * 自由导航契约（阶段 04：HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009）——前后端**共用**。
 *
 * 定位：只放**纯类型与纯函数**。无 DOM、无 D1、无 React、无网络。
 * 当前浏览器与 Worker 使用**同一份**规则，因此「搜索/筛选/排序/升级判定」
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
import { operationIdSchema } from './operation-id';
import {normalizeNavText} from './nav-normalize';
import {parseBookmarkHtmlWithDependencies,skipOf} from './nav-bookmark-parser';
export {normalizeNavText} from './nav-normalize';
export {filterNavLinks,sortNavLinks,projectNavLinks} from './nav-projection';
export type {ProjectNavLinksInput} from './nav-projection';
export {navCatalogEntryState,catalogUpgradePlan,decideCatalogImport} from './nav-catalog-decisions';
export type {CatalogUpgradePlanEntry,NavCatalogImportDecision} from './nav-catalog-decisions';

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




// 书签解析实现移至 nav-bookmark-parser.ts，导入依赖由共享契约显式传入。
export function parseBookmarkHtml(html: unknown, options?: { readonly defaultRegion?: NavRegion }): NavParseResult {
  return parseBookmarkHtmlWithDependencies(html,options,{
    MAX_NAV_GROUP_NAME_LENGTH,MAX_NAV_TITLE_LENGTH,MAX_NAV_URL_LENGTH,MAX_NAV_IMPORT_ITEMS,validateNavUrl,
  });
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
