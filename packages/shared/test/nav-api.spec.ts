/**
 * 自由导航契约测试（阶段 04：HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009）。
 *
 * 这里测的是**唯一的判定实现**：URL 策略、文本/图标/标签规范化、筛选/排序/投影、
 * 目录升级判定、书签 HTML 与结构化 JSON 导入、导出往返，以及 Manifest 与 Widget 契约。
 * 服务端查询端点与前端 Widget 调用的是同一份代码，因此这些用例就是两端行为的共同基线。
 *
 * 相对导入 `../src/nav-api` 而不是 `../src/index`：本文件要能独立验证新契约，
 * 不依赖 barrel（`index.ts`）是否已经接线。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_NAV_ALIAS_LENGTH,
  MAX_NAV_ALIASES,
  MAX_NAV_ICON_LENGTH,
  MAX_NAV_GROUP_NAME_LENGTH,
  MAX_NAV_URL_LENGTH,
  MAX_NAV_IMPORT_ITEMS,
  MAX_NAV_TAG_LENGTH,
  MAX_NAV_TAGS,
  MAX_NAV_TITLE_LENGTH,
  NAV_DEFAULT_ICON,
  NAV_EXPORT_SCHEMA_VERSION,
  NAV_SORT_MODES,
  buildNavExportDocument,
  catalogUpgradePlan,
  decideCatalogImport,
  filterNavLinks,
  navCatalogEntrySchema,
  navCatalogEntryState,
  navGroupSchema,
  navLinkSchema,
  navMembershipSchema,
  navUrlSchema,
  normalizeNavAliases,
  normalizeNavTags,
  normalizeNavText,
  parseBookmarkHtml,
  parseNavExportDocument,
  parseNavImportJson,
  projectNavLinks,
  sanitizeNavIcon,
  sortNavLinks,
  validateNavUrl,
  type NavCatalogEntry,
  type NavCatalogEntryState,
  type NavCatalogImportDecision,
  type NavFilter,
  type NavGroup,
  type NavLink,
  type NavMembership,
} from '../src/nav-api';
import {normalizeNavText as sourceNormalize} from '../src/nav-normalize';
import {parseBookmarkHtmlWithDependencies} from '../src/nav-bookmark-parser';
import {filterNavLinks as sourceFilter,sortNavLinks as sourceSort,projectNavLinks as sourceProject} from '../src/nav-projection';
import {navCatalogEntryState as sourceState,catalogUpgradePlan as sourcePlan,decideCatalogImport as sourceDecision} from '../src/nav-catalog-decisions';


it('keeps the public bookmark parser equivalent to the extracted scanner',()=>{
  const sample='<DL><DT><H3>攻略</H3><DT><A HREF="https://example.com/?a=1&amp;b=2">FF14 &amp; 指南</A></DL>';
  const extracted=parseBookmarkHtmlWithDependencies(sample,undefined,{
    MAX_NAV_GROUP_NAME_LENGTH,MAX_NAV_TITLE_LENGTH,MAX_NAV_URL_LENGTH,MAX_NAV_IMPORT_ITEMS,validateNavUrl,
  });
  expect(parseBookmarkHtml(sample)).toEqual(extracted);
  expect(extracted.items).toHaveLength(1);
  expect(extracted.items[0]?.url).toBe('https://example.com/?a=1&b=2');
});

// Facade must preserve public references; no second implementation in the legacy entrypoint.
it('keeps the nav-api exports identical to the extracted pure modules',()=>{
  expect(normalizeNavText).toBe(sourceNormalize);
  expect(filterNavLinks).toBe(sourceFilter);
  expect(sortNavLinks).toBe(sourceSort);
  expect(projectNavLinks).toBe(sourceProject);
  expect(navCatalogEntryState).toBe(sourceState);
  expect(catalogUpgradePlan).toBe(sourcePlan);
  expect(decideCatalogImport).toBe(sourceDecision);
});

const T0 = 1_700_000_000_000;

/** URL 判定失败原因（与 `NavUrlValidation` 的联合成员一一对应）。 */
type NavUrlFailReason = 'scheme' | 'credentials' | 'host' | 'length';

/**
 * 构造一条形状合法的导航行（一律经 `navLinkSchema.parse`，避免手写对象与契约漂移）。
 * 只覆盖测试关心的字段，其余用最小合法值。
 */
function makeLink(overrides: Partial<NavLink> & { readonly id: string }): NavLink {
  return navLinkSchema.parse({
    sourceCatalogId: null,
    importedSourceVersion: null,
    title: '示例链接',
    url: 'https://example.com/a',
    description: '',
    tags: [],
    aliases: [],
    icon: NAV_DEFAULT_ICON,
    openMode: 'new_tab',
    region: 'cn',
    status: 'active',
    isFavorite: false,
    sortOrder: 0,
    health: 'unknown',
    healthCheckedAt: null,
    revision: 1,
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

function makeGroup(overrides: Partial<NavGroup> & { readonly id: string }): NavGroup {
  return navGroupSchema.parse({
    name: '分组',
    sortOrder: 0,
    revision: 1,
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

function makeMembership(linkId: string, groupId: string, overrides?: Partial<NavMembership>): NavMembership {
  return navMembershipSchema.parse({
    linkId,
    groupId,
    sortOrder: 0,
    deletedAt: null,
    updatedAt: T0,
    ...overrides,
  });
}

function makeCatalogEntry(overrides: Partial<NavCatalogEntry> & { readonly id: string }): NavCatalogEntry {
  return navCatalogEntrySchema.parse({
    sourceVersion: 1,
    title: '示例链接',
    url: 'https://example.com/a',
    description: '',
    category: '官方',
    tags: [],
    aliases: [],
    icon: NAV_DEFAULT_ICON,
    openMode: 'new_tab',
    region: 'cn',
    sortOrder: 0,
    sourceUrl: 'https://catalog.example.com/source',
    sourceName: '推荐目录',
    verifiedAt: T0,
    verificationStatus: 'verified',
    updatedAt: T0,
    ...overrides,
  });
}

function idsOf(rows: readonly NavLink[]): string[] {
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// 1. URL 策略
// ---------------------------------------------------------------------------

describe('validateNavUrl / navUrlSchema：只放行 https（ADR-0004 D3）', () => {
  it('合法 https 通过，并回传已 trim 的地址', () => {
    expect(validateNavUrl('https://example.com/x')).toEqual({ ok: true, url: 'https://example.com/x' });
    expect(validateNavUrl('  https://example.com/x  ')).toEqual({ ok: true, url: 'https://example.com/x' });
  });

  const rejected: readonly {
    readonly label: string;
    readonly raw: unknown;
    readonly reason: NavUrlFailReason;
  }[] = [
    { label: 'http 明确拒绝（本阶段不授予任何 http 例外）', raw: 'http://example.com', reason: 'scheme' },
    { label: 'javascript: 伪协议', raw: 'javascript:alert(1)', reason: 'scheme' },
    { label: 'data: 伪协议', raw: 'data:text/html,x', reason: 'scheme' },
    { label: 'file: 本地文件', raw: 'file:///c:/x', reason: 'scheme' },
    { label: 'blob: 协议', raw: 'blob:https://x/y', reason: 'scheme' },
    { label: '缺授权机构', raw: 'https://', reason: 'host' },
    { label: '主机没有点号', raw: 'https://nohost', reason: 'host' },
    { label: '内嵌凭证', raw: 'https://user:pass@example.com/', reason: 'credentials' },
    { label: '超过长度上限', raw: `https://example.com/${'a'.repeat(2048)}`, reason: 'length' },
    { label: '含空格', raw: 'https://exa mple.com', reason: 'length' },
    { label: '含控制字符（CRLF 注入形态）', raw: 'https://example.com/\nHost: evil', reason: 'length' },
    { label: '非字符串（数字）', raw: 42, reason: 'length' },
    { label: '非字符串（null）', raw: null, reason: 'length' },
    { label: '非字符串（undefined）', raw: undefined, reason: 'length' },
    { label: '非字符串（对象）', raw: { href: 'https://example.com/' }, reason: 'length' },
  ];

  for (const testCase of rejected) {
    it(`拒绝：${testCase.label} → ${testCase.reason}`, () => {
      expect(validateNavUrl(testCase.raw)).toEqual({ ok: false, reason: testCase.reason });
      if (typeof testCase.raw === 'string') {
        expect(navUrlSchema.safeParse(testCase.raw).success).toBe(false);
      }
    });
  }

  it('Schema 与函数是同一判定：http 拒绝、https 通过', () => {
    expect(navUrlSchema.safeParse('http://x.com').success).toBe(false);
    expect(navUrlSchema.safeParse('https://x.com').success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 文本 / 图标 / 标签 / 别名
// ---------------------------------------------------------------------------

describe('normalizeNavText：NFKC + 小写 + 折叠空白', () => {
  it('全角转半角、大小写归一、空白折叠并去首尾', () => {
    expect(normalizeNavText('ＡＣＴ 零式')).toBe('act 零式');
    expect(normalizeNavText('  Act\t零式\n  攻略 ')).toBe('act 零式 攻略');
    expect(normalizeNavText('ＦＦ１４')).toBe('ff14');
    expect(normalizeNavText('   ')).toBe('');
  });

  it('非字符串一律返回空串（不抛错、不猜内容）', () => {
    for (const raw of [undefined, null, 42, true, {}, [], ['a']]) {
      expect(normalizeNavText(raw)).toBe('');
    }
  });
});

describe('sanitizeNavIcon：图标是纯文本', () => {
  it('trim 与去控制字符，可见字符与 emoji 原样保留', () => {
    expect(sanitizeNavIcon('  🔗  ')).toBe('🔗');
    expect(sanitizeNavIcon('★')).toBe('★');
    expect(sanitizeNavIcon('a\u0000b\u001fc\u007f')).toBe('abc');
  });

  it('超长截断到 MAX_NAV_ICON_LENGTH', () => {
    const long = 'x'.repeat(MAX_NAV_ICON_LENGTH + 50);
    const cleaned = sanitizeNavIcon(long);
    expect(cleaned).toHaveLength(MAX_NAV_ICON_LENGTH);
    expect(cleaned).toBe(long.slice(0, MAX_NAV_ICON_LENGTH));
  });

  it('空值（空串 / 全空白 / 全是控制字符 / 非字符串）回落到默认图标', () => {
    for (const raw of ['', '   ', '\u0001\u0002\u007f', undefined, null, 0, false, {}]) {
      expect(sanitizeNavIcon(raw)).toBe(NAV_DEFAULT_ICON);
    }
  });
});

describe('normalizeNavTags / normalizeNavAliases：去空、去重保序、超限截断', () => {
  it('标签：去空、去控制字符、非字符串项丢弃、保序', () => {
    expect(normalizeNavTags(['b', 'a', '', '   ', '\u0000', 1, null])).toEqual(['b', 'a']);
    expect(normalizeNavTags(['攻略', '副本', '攻略'])).toEqual(['攻略', '副本']);
  });

  it('标签去重把大小写与全角差异视为同一项（保留首次出现的写法）', () => {
    expect(normalizeNavTags(['FF14', 'ff14', 'ＦＦ１４'])).toEqual(['FF14']);
    // 去重键经过 NFKC + 折叠空白，因此 trim 与全角差异不会产生重复项；
    // 但存储值保留首次出现的原样写法（内部连续空白不折叠）。
    expect(normalizeNavTags(['攻略', ' 攻略 ', '攻 略'])).toEqual(['攻略', '攻 略']);
    expect(normalizeNavTags(['攻  略'])).toEqual(['攻  略']);
  });

  it('标签超长先截断再判重', () => {
    const long = 'x'.repeat(MAX_NAV_TAG_LENGTH + 10);
    expect(normalizeNavTags([long, long.slice(0, MAX_NAV_TAG_LENGTH)])).toEqual([long.slice(0, MAX_NAV_TAG_LENGTH)]);
  });

  it('标签数量上限 MAX_NAV_TAGS：多余的被截断', () => {
    const many = Array.from({ length: MAX_NAV_TAGS + 5 }, (_unused, index) => `tag-${String(index)}`);
    const result = normalizeNavTags(many);
    expect(result).toHaveLength(MAX_NAV_TAGS);
    expect(result[MAX_NAV_TAGS - 1]).toBe(`tag-${String(MAX_NAV_TAGS - 1)}`);
  });

  it('非数组输入返回空数组', () => {
    for (const raw of [undefined, null, '攻略', 42, {}]) {
      expect(normalizeNavTags(raw)).toEqual([]);
      expect(normalizeNavAliases(raw)).toEqual([]);
    }
  });

  it('别名：与标签同规则，但长度上限更大、数量上限更小', () => {
    expect(MAX_NAV_ALIAS_LENGTH).toBeGreaterThan(MAX_NAV_TAG_LENGTH);
    expect(MAX_NAV_ALIASES).toBeLessThan(MAX_NAV_TAGS);
    expect(normalizeNavAliases(['ＦＦ14', 'ff14', '  最终幻想  ', ''])).toEqual(['ＦＦ14', '最终幻想']);

    const thirty = 'z'.repeat(30);
    expect(normalizeNavTags([thirty])[0]).toHaveLength(MAX_NAV_TAG_LENGTH);
    expect(normalizeNavAliases([thirty])[0]).toHaveLength(30);

    const twelve = Array.from({ length: 12 }, (_unused, index) => `alias-${String(index)}`);
    expect(normalizeNavTags(twelve)).toHaveLength(12);
    expect(normalizeNavAliases(twelve)).toHaveLength(MAX_NAV_ALIASES);
  });
});

// ---------------------------------------------------------------------------
// 3. 筛选 / 排序 / 投影
// ---------------------------------------------------------------------------

/** 夹具：5 条活跃链接 + 1 条归档 + 1 条墓碑（墓碑 id 固定为 l5）。 */
const links: readonly NavLink[] = [
  makeLink({
    id: 'l1',
    title: 'FF14 官方',
    url: 'https://ff14.example.com/',
    description: '国服官网',
    tags: ['官方', '攻略', 'FF14'],
    aliases: ['最终幻想'],
    region: 'cn',
    isFavorite: true,
    sortOrder: 0,
    updatedAt: T0 + 100,
  }),
  makeLink({
    id: 'l2',
    title: 'ＡＣＴ 攻略站',
    url: 'https://act.example.com/',
    description: '战斗日志',
    tags: ['攻略'],
    region: 'global',
    sortOrder: 0,
    updatedAt: T0 + 300,
  }),
  makeLink({
    id: 'l3',
    title: '通用工具',
    url: 'https://tools.example.com/',
    tags: ['工具'],
    region: 'both',
    sortOrder: 1,
    updatedAt: T0,
  }),
  makeLink({
    id: 'l4',
    title: '归档条目',
    url: 'https://archive.example.com/',
    tags: ['官方'],
    status: 'archived',
    sortOrder: 2,
    updatedAt: T0 + 50,
  }),
  makeLink({
    id: 'l5',
    title: '已删除条目',
    url: 'https://deleted.example.com/',
    tags: ['官方'],
    sortOrder: 5,
    deletedAt: T0 + 400,
    updatedAt: T0 + 400,
  }),
  makeLink({
    id: 'l6',
    title: '另一收藏',
    url: 'https://fav.example.com/',
    region: 'global',
    isFavorite: true,
    sortOrder: -1,
    updatedAt: T0 + 200,
  }),
];

describe('filterNavLinks：文本 / 标签 / 区服 / 收藏 / 状态', () => {
  it('text 多词是 AND，命中范围覆盖标题、描述、标签与别名', () => {
    expect(idsOf(filterNavLinks(links, { text: 'act 攻略' }))).toEqual(['l2']);
    expect(idsOf(filterNavLinks(links, { text: '官方 攻略' }))).toEqual(['l1']);
    expect(idsOf(filterNavLinks(links, { text: '官方 act' }))).toEqual([]);
    expect(idsOf(filterNavLinks(links, { text: '最终幻想' }))).toEqual(['l1']);
    expect(idsOf(filterNavLinks(links, { text: '  ＡＣＴ   ' }))).toEqual(['l2']);
    expect(idsOf(filterNavLinks(links, { text: '   ' }))).toEqual(['l1', 'l2', 'l3', 'l6']);
  });

  it('tag 精确匹配（大小写与全角不敏感），不做部分匹配', () => {
    expect(idsOf(filterNavLinks(links, { tag: 'ff14' }))).toEqual(['l1']);
    expect(idsOf(filterNavLinks(links, { tag: 'ＦＦ１４' }))).toEqual(['l1']);
    expect(idsOf(filterNavLinks(links, { tag: '官' }))).toEqual([]);
    expect(idsOf(filterNavLinks(links, { tag: ' 攻略 ' }))).toEqual(['l1', 'l2']);
  });

  it('region 命中该值或 both', () => {
    expect(idsOf(filterNavLinks(links, { region: 'cn' }))).toEqual(['l1', 'l3']);
    // 通用条目（region='both'）在任一区服筛选下都可见。
    expect(idsOf(filterNavLinks(links, { region: 'global' }))).toEqual(['l2', 'l3', 'l6']);
    // 反过来，region='both' 不是通配符：只返回真正与区服无关的条目。
    expect(idsOf(filterNavLinks(links, { region: 'both' }))).toEqual(['l3']);
  });

  it('favoritesOnly=true 只看收藏；false 或缺省不筛选', () => {
    expect(idsOf(filterNavLinks(links, { favoritesOnly: true }))).toEqual(['l1', 'l6']);
    expect(idsOf(filterNavLinks(links, { favoritesOnly: false }))).toEqual(['l1', 'l2', 'l3', 'l6']);
    expect(idsOf(filterNavLinks(links, {}))).toEqual(['l1', 'l2', 'l3', 'l6']);
  });

  it('status 缺省只看 active，显式 archived 才看归档', () => {
    expect(idsOf(filterNavLinks(links, { status: 'active' }))).toEqual(['l1', 'l2', 'l3', 'l6']);
    expect(idsOf(filterNavLinks(links, { status: 'archived' }))).toEqual(['l4']);
  });

  it('墓碑在任何筛选组合下都不出现，且不修改入参数组', () => {
    const combos: readonly NavFilter[] = [
      {},
      { status: 'active' },
      { status: 'archived' },
      { favoritesOnly: true },
      { text: '已删除' },
      { tag: '官方' },
      { region: 'cn' },
      { text: '官方', tag: '官方', region: 'cn', favoritesOnly: false },
    ];
    const before = idsOf(links);
    for (const filter of combos) {
      for (const link of filterNavLinks(links, filter)) {
        expect(link.id).not.toBe('l5');
        expect(link.deletedAt).toBeNull();
      }
    }
    expect(idsOf(links)).toEqual(before);
  });
});

describe('sortNavLinks：四种模式的确定性', () => {
  it('manual：sortOrder 升序，同序用规范化标题、再用品 id 兜底', () => {
    expect(idsOf(sortNavLinks(links, 'manual'))).toEqual(['l6', 'l2', 'l1', 'l3', 'l4', 'l5']);
  });

  it('title：按规范化标题升序', () => {
    expect(idsOf(sortNavLinks(links, 'title'))).toEqual(['l2', 'l1', 'l6', 'l5', 'l4', 'l3']);
  });

  it('recent：updatedAt 降序', () => {
    expect(idsOf(sortNavLinks(links, 'recent'))).toEqual(['l5', 'l2', 'l6', 'l1', 'l4', 'l3']);
  });

  it('favorite：收藏优先，组内仍按 manual 规则', () => {
    expect(idsOf(sortNavLinks(links, 'favorite'))).toEqual(['l6', 'l1', 'l2', 'l3', 'l4', 'l5']);
  });

  it('同 sortOrder 且同标题时用品 id 兜底（与输入顺序无关）', () => {
    const tied: readonly NavLink[] = [
      makeLink({ id: 'b-link', title: '同名条目', sortOrder: 0 }),
      makeLink({ id: 'a-link', title: '同名条目', sortOrder: 0 }),
    ];
    expect(idsOf(sortNavLinks(tied, 'manual'))).toEqual(['a-link', 'b-link']);
    expect(idsOf(sortNavLinks([...tied].reverse(), 'manual'))).toEqual(['a-link', 'b-link']);
  });

  it('同一输入连续两次结果完全相同，返回新数组且不修改入参', () => {
    const before = idsOf(links);
    for (const mode of NAV_SORT_MODES) {
      const first = idsOf(sortNavLinks(links, mode));
      const second = idsOf(sortNavLinks(links, mode));
      expect(second).toEqual(first);
      expect(sortNavLinks(links, mode)).not.toBe(links);
    }
    expect(idsOf(links)).toEqual(before);
  });
});

describe('projectNavLinks：分组投影与筛选排序组合', () => {
  const groups: readonly NavGroup[] = [
    makeGroup({ id: 'g1', name: '攻略', sortOrder: 0 }),
    makeGroup({ id: 'g2', name: '工具', sortOrder: 1 }),
    makeGroup({ id: 'g3', name: '已删除分组', sortOrder: 2, deletedAt: T0 }),
  ];
  const memberships: readonly NavMembership[] = [
    makeMembership('l1', 'g1'),
    makeMembership('l1', 'g2'),
    makeMembership('l1', 'g3'),
    makeMembership('l2', 'g1', { deletedAt: T0 }),
    makeMembership('l2', 'g2'),
    makeMembership('l3', 'g1'),
  ];

  it('groupIds / groupNames 忽略已删除成员关系与已删除分组', () => {
    const views = projectNavLinks({ links, groups, memberships });
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get('l1')?.groupIds).toEqual(['g1', 'g2']);
    expect(byId.get('l1')?.groupNames).toEqual(['攻略', '工具']);
    expect(byId.get('l2')?.groupIds).toEqual(['g2']);
    expect(byId.get('l3')?.groupIds).toEqual(['g1']);
    expect(byId.get('l6')?.groupIds).toEqual([]);
    expect(views.flatMap((view) => view.groupNames)).not.toContain('已删除分组');
  });

  it('按 groupId 筛选只取该分组下未删除的成员关系', () => {
    expect(idsOf(projectNavLinks({ links, groups, memberships, filter: { groupId: 'g1' } }))).toEqual(['l1', 'l3']);
    // l2 在 g1 的成员关系是墓碑，因此不出现在结果里；它在 g2 里可见。
    expect(idsOf(projectNavLinks({ links, groups, memberships, filter: { groupId: 'g2' } }))).toEqual(['l2', 'l1']);
    expect(idsOf(projectNavLinks({ links, groups, memberships, filter: { groupId: 'g3' } }))).toEqual([]);
  });

  it('filter 与 sort 组合：先筛区服再按标题排序，投影字段仍完整', () => {
    const views = projectNavLinks({ links, groups, memberships, filter: { region: 'global', sort: 'title' } });
    // region='global' 同时命中通用条目 l3；排序按规范化标题：act < 另 < 通。
    expect(idsOf(views)).toEqual(['l2', 'l6', 'l3']);
    expect(views[0]?.title).toBe('ＡＣＴ 攻略站');
    expect(views[0]?.groupIds).toEqual(['g2']);
    expect(views[1]?.groupNames).toEqual([]);
  });

  it('默认只看活跃条目：归档与墓碑都不进投影结果', () => {
    expect(idsOf(projectNavLinks({ links, groups, memberships }))).toEqual(['l6', 'l2', 'l1', 'l3']);
    expect(idsOf(projectNavLinks({ links, groups, memberships, filter: { status: 'archived' } }))).toEqual(['l4']);
  });
});

// ---------------------------------------------------------------------------
// 4. 目录升级判定
// ---------------------------------------------------------------------------

/** 与目录条目内容完全一致的个人副本（用于 unchanged / user_modified 判定）。 */
const catalogBaseLink: NavLink = makeLink({
  id: 'l-cat',
  sourceCatalogId: 'cat-1',
  importedSourceVersion: 1,
  title: '推荐条目',
  url: 'https://catalog.example.com/entry',
  description: '说明',
  tags: ['官方', '攻略'],
  aliases: ['别名'],
  icon: NAV_DEFAULT_ICON,
  openMode: 'new_tab',
  region: 'cn',
  isFavorite: false,
});

const catalogBaseEntry: NavCatalogEntry = makeCatalogEntry({
  id: 'cat-1',
  title: '推荐条目',
  url: 'https://catalog.example.com/entry',
  description: '说明',
  tags: ['官方', '攻略'],
  aliases: ['别名'],
  icon: NAV_DEFAULT_ICON,
  openMode: 'new_tab',
  region: 'cn',
});

describe('navCatalogEntryState：四种状态', () => {
  it('link 缺失 → new', () => {
    expect(navCatalogEntryState({ entry: catalogBaseEntry, link: undefined })).toBe('new');
  });

  it('墓碑 → tombstoned（墓碑优先于一切，即使内容与目录一致）', () => {
    const tombstone = makeLink({ ...catalogBaseLink, deletedAt: T0 + 5 });
    expect(navCatalogEntryState({ entry: catalogBaseEntry, link: tombstone })).toBe('tombstoned');
  });

  it('标题 / URL / 描述 / 标签 / 别名 / 图标 / 区服 / 打开方式 / 收藏任一被改 → user_modified', () => {
    const cases: readonly { readonly label: string; readonly link: NavLink }[] = [
      { label: '改标题', link: makeLink({ ...catalogBaseLink, title: '我改过的标题' }) },
      { label: '改 URL', link: makeLink({ ...catalogBaseLink, url: 'https://my.example.com/x' }) },
      { label: '改描述', link: makeLink({ ...catalogBaseLink, description: '我的备注' }) },
      { label: '改标签内容', link: makeLink({ ...catalogBaseLink, tags: ['官方'] }) },
      { label: '改标签顺序', link: makeLink({ ...catalogBaseLink, tags: ['攻略', '官方'] }) },
      { label: '改别名', link: makeLink({ ...catalogBaseLink, aliases: [] }) },
      { label: '改图标', link: makeLink({ ...catalogBaseLink, icon: '⭐' }) },
      { label: '改区服', link: makeLink({ ...catalogBaseLink, region: 'global' }) },
      { label: '改打开方式', link: makeLink({ ...catalogBaseLink, openMode: 'same_tab' }) },
      { label: '加收藏', link: makeLink({ ...catalogBaseLink, isFavorite: true }) },
    ];
    for (const testCase of cases) {
      expect(navCatalogEntryState({ entry: catalogBaseEntry, link: testCase.link }), testCase.label).toBe(
        'user_modified',
      );
    }
  });

  it('完全一致 → unchanged；只改分组归属不算修改', () => {
    expect(navCatalogEntryState({ entry: catalogBaseEntry, link: catalogBaseLink })).toBe('unchanged');

    // 只改分组归属：成员关系把同一链接放进用户自己的分组，内容字段一字未动。
    const groups = [makeGroup({ id: 'g1', name: '我的分组' })];
    const memberships = [makeMembership(catalogBaseLink.id, 'g1')];
    const views = projectNavLinks({ links: [catalogBaseLink], groups, memberships });
    expect(views[0]?.groupNames).toEqual(['我的分组']);
    expect(navCatalogEntryState({ entry: catalogBaseEntry, link: catalogBaseLink })).toBe('unchanged');
  });
});

describe('catalogUpgradePlan：稳定排序与 linkId 映射', () => {
  it('按 catalogId 升序输出，并把源目录 ID 映射到个人副本', () => {
    const catalog: readonly NavCatalogEntry[] = [
      makeCatalogEntry({ id: 'cat-b', title: 'B 条目' }),
      makeCatalogEntry({ id: 'cat-a', title: 'A 条目' }),
    ];
    const plan = catalogUpgradePlan({
      catalog,
      links: [makeLink({ id: 'l-a', sourceCatalogId: 'cat-a', title: 'A 条目' })],
    });
    expect(plan.map((entry) => entry.catalogId)).toEqual(['cat-a', 'cat-b']);
    expect(plan[0]).toEqual({ state: 'unchanged', catalogId: 'cat-a', linkId: 'l-a' });
    expect(plan[1]).toEqual({ state: 'new', catalogId: 'cat-b', linkId: null });
  });

  it('墓碑副本仍映射 linkId 但状态为 tombstoned；sourceCatalogId=null 不参与匹配', () => {
    const plan = catalogUpgradePlan({
      catalog: [makeCatalogEntry({ id: 'cat-a', title: 'A 条目' })],
      links: [
        makeLink({ id: 'l-tomb', sourceCatalogId: 'cat-a', title: 'A 条目', deletedAt: T0 + 9 }),
        makeLink({ id: 'l-orphan', sourceCatalogId: null, title: 'A 条目' }),
      ],
    });
    expect(plan).toEqual([{ state: 'tombstoned', catalogId: 'cat-a', linkId: 'l-tomb' }]);
  });

  it('排序稳定：两次结果相同，且不修改入参数组顺序', () => {
    const catalog: readonly NavCatalogEntry[] = [makeCatalogEntry({ id: 'cat-b' }), makeCatalogEntry({ id: 'cat-a' })];
    const before = catalog.map((entry) => entry.id);
    const first = catalogUpgradePlan({ catalog, links: [] });
    const second = catalogUpgradePlan({ catalog, links: [] });
    expect(second).toEqual(first);
    expect(catalog.map((entry) => entry.id)).toEqual(before);
  });
});

describe('decideCatalogImport：四条规则逐条覆盖', () => {
  const cases: readonly {
    readonly label: string;
    readonly input: {
      readonly state: NavCatalogEntryState;
      readonly explicitReimport?: boolean;
      readonly overwriteUserEdits?: boolean;
    };
    readonly expected: NavCatalogImportDecision['action'];
  }[] = [
    { label: 'new → insert', input: { state: 'new' }, expected: 'insert' },
    {
      label: 'new 恒为 insert（显式再导入不改变新条目语义）',
      input: { state: 'new', explicitReimport: true, overwriteUserEdits: true },
      expected: 'insert',
    },
    { label: '墓碑 + 缺省 → skip', input: { state: 'tombstoned' }, expected: 'skip' },
    {
      label: '墓碑 + explicitReimport=false → skip',
      input: { state: 'tombstoned', explicitReimport: false },
      expected: 'skip',
    },
    {
      label: '墓碑 + overwriteUserEdits=true 但非显式 → skip',
      input: { state: 'tombstoned', overwriteUserEdits: true },
      expected: 'skip',
    },
    {
      label: '墓碑 + explicitReimport=true → restore_tombstone',
      input: { state: 'tombstoned', explicitReimport: true },
      expected: 'restore_tombstone',
    },
    {
      label: '墓碑 + explicitReimport=true + overwriteUserEdits=false → restore_tombstone',
      input: { state: 'tombstoned', explicitReimport: true, overwriteUserEdits: false },
      expected: 'restore_tombstone',
    },
    { label: 'user_modified + 缺省 → skip', input: { state: 'user_modified' }, expected: 'skip' },
    {
      label: 'user_modified + overwriteUserEdits=false → skip',
      input: { state: 'user_modified', explicitReimport: true, overwriteUserEdits: false },
      expected: 'skip',
    },
    {
      label: 'user_modified + explicitReimport=true + overwriteUserEdits=true → update',
      input: { state: 'user_modified', explicitReimport: true, overwriteUserEdits: true },
      expected: 'update',
    },
    { label: 'unchanged（非显式）→ skip', input: { state: 'unchanged' }, expected: 'skip' },
    {
      label: 'unchanged + explicitReimport=true + overwriteUserEdits=true → update',
      input: { state: 'unchanged', explicitReimport: true, overwriteUserEdits: true },
      expected: 'update',
    },
  ];

  it('四条规则覆盖全部目录条目状态', () => {
    expect([...new Set(cases.map((testCase) => testCase.input.state))].sort((a, b) => a.localeCompare(b))).toEqual(
      ['new', 'tombstoned', 'unchanged', 'user_modified'].sort((a, b) => a.localeCompare(b)),
    );
  });

  for (const testCase of cases) {
    it(testCase.label, () => {
      const decision = decideCatalogImport(testCase.input);
      expect(decision.action).toBe(testCase.expected);
      expect(decision.reason.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. 书签 HTML 解析
// ---------------------------------------------------------------------------

/** Chrome / Firefox 导出的真实形态：`<DT>` 不闭合，且 `<DT>` 包裹 `<A>`。 */
const REAL_BOOKMARK_HTML = [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
  '<!-- This is an automatically generated file. -->',
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  '<TITLE>Bookmarks</TITLE>',
  '<H1>Bookmarks</H1>',
  '<DL><p>',
  '    <DT><H3 ADD_DATE="1699999999" LAST_MODIFIED="1700000000">FF14 工具</H3>',
  '    <DL><p>',
  '        <DT><A HREF="https://tools.example.com/a" ADD_DATE="1700000001">工具 &amp; 站点</A>',
  '        <DT><A HREF="https://tools.example.com/b" ADD_DATE="1700000002">攻略 &#39;站&#39;</A>',
  '        <DT><A HREF="javascript:alert(1)" ADD_DATE="1700000003">危险脚本</A>',
  '        <DT><A HREF="https://tools.example.com/c" ADD_DATE="1700000004"></A>',
  '        <DT><A HREF="https://tools.example.com/a" ADD_DATE="1700000005">重复 URL</A>',
  '        <DT><A HREF="https://tools.example.com/d" ADD_DATE="1700000006">收藏 &lt;3 站点</A>',
  '        <SCRIPT>',
  '          var injected = "https://evil.example.com/from-script";',
  '          document.write(\'<a href="https://evil.example.com/from-script-2">x</a>\');',
  '        </SCRIPT>',
  '        <STYLE>',
  '          .x { background-image: url("https://evil.example.com/from-style"); }',
  '        </STYLE>',
  '    </DL><p>',
  '</DL><p>',
].join('\n');

/**
 * 同一份内容的「解析器当前可处理」形态：仅把 `<DT>` 补上闭合、并让 `<A>` 不被 `<DT>` 包裹
 * （见下面「（根因定位）<DT> 不包裹 <A> 时…」用例）。这里的每个条目在真实形态里也存在，
 * 用来证明「实体解码 / 去重 / 协议白名单 / script-style 丢弃」这些逻辑本身是对的。
 */
const PARSEABLE_BOOKMARK_HTML = [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
  '<DL><p>',
  '    <DT><H3 ADD_DATE="1699999999">FF14 工具</H3></DT>',
  '    <DL><p>',
  '        <A HREF="https://tools.example.com/a" ADD_DATE="1700000001">工具 &amp; 站点</A>',
  '        <A HREF="https://tools.example.com/b" ADD_DATE="1700000002">攻略 &#39;站&#39;</A>',
  '        <A HREF="javascript:alert(1)" ADD_DATE="1700000003">危险脚本</A>',
  '        <A HREF="https://tools.example.com/c" ADD_DATE="1700000004"></A>',
  '        <A HREF="https://tools.example.com/a" ADD_DATE="1700000005">重复 URL</A>',
  '        <A HREF="https://tools.example.com/d" ADD_DATE="1700000006">收藏 &lt;3 站点</A>',
  '        <SCRIPT>var injected = "https://evil.example.com/from-script";</SCRIPT>',
  '        <STYLE>.x { background-image: url("https://evil.example.com/from-style"); }</STYLE>',
  '    </DL><p>',
  '</DL><p>',
].join('\n');

describe('parseBookmarkHtml：书签 HTML 解析（关键安全性质）', () => {
  /**
   * 已知实现缺陷（本用例当前为红，断言刻意不删、不弱化）：
   * 扫描器把 `<DT>` 当成分组名载体，一路读到 `</DT>` 为止；而 Netscape 书签文件里
   * `<DT>` 既**没有**闭合标签，又**包裹**着 `<A>`，于是：
   *   - 找不到 `</dt>` 时 cursor 直接跳到文档末尾 —— 整份文件被静默丢弃（items / skipped 均为空），
   *     直接违反本文件「每一项要么进 items、要么进 skipped 并带原因」的约定；
   *   - 即使人为补上 `</dt>`，`<A>…</A>` 也会被当作分组名吃掉，条目同样不会进 items；
   *   - 只有「`<A>` 不被 `<DT>` 包裹」的形态才解析得动（见下面的根因定位用例）。
   * 后果：浏览器导出的书签 HTML 全部导入为空，且协议白名单、实体解码、去重、script/style
   * 丢弃等逻辑在真实输入上根本无法被触达。
   * 修复方向（未实施：按任务要求不修改被测实现）：先判 `a` 再判分组，或只把 `<H3>` 当分组名、
   * 把 `<DT>` 当无内容标签跳过。
   */
  it('真实 Netscape 形态：items 只含合法 https 条目，skipped 逐项说明原因，且不泄露标签片段', () => {
    const result = parseBookmarkHtml(REAL_BOOKMARK_HTML);

    // items：只保留合法 https 条目（javascript: / 无标题 / 重复 URL 都不进 items）。
    expect(result.items.map((item) => item.title)).toEqual(['工具 & 站点', "攻略 '站'", '收藏 <3 站点']);
    expect(result.items.map((item) => item.url)).toEqual([
      'https://tools.example.com/a',
      'https://tools.example.com/b',
      'https://tools.example.com/d',
    ]);
    expect(result.items.every((item) => validateNavUrl(item.url).ok)).toBe(true);
    expect(result.items.map((item) => item.groupName)).toEqual(['FF14 工具', 'FF14 工具', 'FF14 工具']);

    // 每一项要么进 items，要么进 skipped 并带原因：不存在静默丢弃。
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['unsupported_scheme', 'missing_title', 'duplicate']);

    // 返回值是纯数据，不含任何标签片段。
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('<script');
    expect(serialized).not.toContain('<style');
    expect(serialized).not.toContain('<a ');
    // script / style 里的 URL 绝不被采集。
    expect(serialized).not.toContain('evil.example.com');
  });

  it('（根因定位）<DT> 不包裹 <A> 时，同一份内容可被正确解析', () => {
    const result = parseBookmarkHtml(PARSEABLE_BOOKMARK_HTML);

    expect(result.items.map((item) => item.title)).toEqual(['工具 & 站点', "攻略 '站'", '收藏 <3 站点']);
    expect(result.items.map((item) => item.url)).toEqual([
      'https://tools.example.com/a',
      'https://tools.example.com/b',
      'https://tools.example.com/d',
    ]);
    expect(result.items.map((item) => item.groupName)).toEqual(['FF14 工具', 'FF14 工具', 'FF14 工具']);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['unsupported_scheme', 'missing_title', 'duplicate']);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('<script');
    expect(serialized).not.toContain('<style');
    expect(serialized).not.toContain('<a ');
    expect(serialized).not.toContain('evil.example.com');
  });

  it('defaultRegion 决定导入条目的区服（缺省 cn）', () => {
    expect(parseBookmarkHtml(PARSEABLE_BOOKMARK_HTML).items[0]?.region).toBe('cn');
    expect(parseBookmarkHtml(PARSEABLE_BOOKMARK_HTML, { defaultRegion: 'global' }).items[0]?.region).toBe('global');
  });

  it('非字符串输入返回空结果且不抛错', () => {
    for (const raw of [undefined, null, 42, true, {}, [], { html: REAL_BOOKMARK_HTML }]) {
      expect(parseBookmarkHtml(raw)).toEqual({ items: [], skipped: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// 5b. 实体解码 / href 取值：线性扫描改写后的边界语义（SonarCloud S5852）
// ---------------------------------------------------------------------------

/**
 * 这一组用例把**手写线性扫描**与改写前正则的等价性钉死。
 *
 * `decodeHtmlEntities` 与 `extractHref` 都是模块私有函数，只能经 `parseBookmarkHtml` 观察：
 * - 标题片段经 `textOfFragment` 解成纯文本 → 观察实体解码；
 * - `<a href>` 的取值就是条目的 url（被跳过时给出 skip 原因） → 观察 href 取值。
 *
 * 覆盖：`&;` / `&` 结尾 / `&#;` / `&#x;` / 码点 0 / 超上限截断 / 名字大小写不敏感 /
 * 前导零与超长数字 / 单引号、裸值、大写 `HREF`、带 `&amp;` 的查询串 / 无 `=` / 引号不配对。
 */
describe('parseBookmarkHtml：实体解码与 href 取值的边界（线性扫描的等价性锁）', () => {
  /** 让片段走一遍标题解码（片段里不含 `<`/`>`，不会被标签剥离干扰）；标题为空时返回 undefined。 */
  function decodedTitle(fragment: string): string | undefined {
    return parseBookmarkHtml(`<A HREF="https://entity.example.com/">${fragment}</A>`).items[0]?.title;
  }

  /** 观察 href 取值：返回解析出的 url，未解析出来时返回 `skipped:<原因>`。 */
  function hrefOutcome(attributes: string): string {
    const result = parseBookmarkHtml(`<A ${attributes}>标题</A>`);
    const item = result.items[0];
    return item === undefined ? `skipped:${result.skipped[0]?.reason ?? 'none'}` : item.url;
  }

  const entityCases: readonly {
    readonly label: string;
    readonly fragment: string;
    readonly expected: string | undefined;
  }[] = [
    { label: '&amp; → &', fragment: '工具 &amp; 站点', expected: '工具 & 站点' },
    { label: '&lt; → <', fragment: '&lt;', expected: '<' },
    { label: '&#39; → 单引号', fragment: '&#39;', expected: "'" },
    { label: '&#x27; → 单引号', fragment: '&#x27;', expected: "'" },
    // `#x` 的 x 在原正则里**区分大小写**（原式没有 i 标志），大写 X 不属于十六进制分支：
    // 这条用例把「原样保留」的既有语义钉住，避免改造顺手扩大了解码范围。
    { label: '&#X27; 原样保留（x 标记区分大小写）', fragment: '&#X27;', expected: '&#X27;' },
    { label: '&unknown; 原样保留', fragment: '&unknown;', expected: '&unknown;' },
    { label: '&; 原样保留', fragment: '&;', expected: '&;' },
    { label: '& 结尾原样保留（不吞字符）', fragment: 'a&', expected: 'a&' },
    { label: '&#; 原样保留', fragment: '&#;', expected: '&#;' },
    { label: '&#x; 原样保留', fragment: '&#x;', expected: '&#x;' },
    { label: '&#0; 码点为 0 → 原样保留', fragment: '&#0;', expected: '&#0;' },
    {
      label: '&#x110000; 超出上限 → 截到 U+10FFFF',
      fragment: '&#x110000;',
      expected: String.fromCodePoint(0x10ffff),
    },
    { label: '&AMP; 名字大小写不敏感', fragment: '&AMP;', expected: '&' },
    // `&nbsp;` 解成空格，随后被空白折叠 + trim 吃掉 → 标题为空（正好证明它**被解码**了）。
    { label: '&nbsp; 解成空格后被折叠为空标题', fragment: '&nbsp;', expected: undefined },
    { label: '&nbsp; 在中间 → 折叠成一个空格', fragment: 'a&nbsp;b', expected: 'a b' },
    // 前导零 / 超长数字必须与 parseInt 语义一致：手写扫描因此不做长度截断。
    { label: '&#x0000000041; 前导零 → A', fragment: '&#x0000000041;', expected: 'A' },
    { label: '&#00000000000000065; 前导零 → A', fragment: '&#00000000000000065;', expected: 'A' },
    { label: '&amp;lt; 只解码一层', fragment: '&amp;lt;', expected: '&lt;' },
  ];

  for (const testCase of entityCases) {
    it(`实体：${testCase.label}`, () => {
      expect(decodedTitle(testCase.fragment)).toBe(testCase.expected);
    });
  }

  it('实体：超长且没有分号的串原样保留，且不吞掉两侧字符', () => {
    const fragment = `x&${'a'.repeat(20_000)}y`;
    expect(decodedTitle(fragment)).toBe(fragment.slice(0, MAX_NAV_TITLE_LENGTH));
  });

  const hrefCases: readonly { readonly label: string; readonly attributes: string; readonly expected: string }[] = [
    {
      label: '双引号 + 大写 HREF + 查询串里的 &amp;',
      attributes: 'HREF="https://q.example.com/?a=1&amp;b=2"',
      expected: 'https://q.example.com/?a=1&b=2',
    },
    { label: '单引号', attributes: "href='https://s.example.com/x'", expected: 'https://s.example.com/x' },
    {
      label: '裸值（属性串在 `>` 处结束，值随之结束）',
      attributes: 'HREF=https://bare.example.com/x',
      expected: 'https://bare.example.com/x',
    },
    {
      label: '`=` 两侧任意空白',
      attributes: 'HrEf \t= \u00a0"https://ws.example.com/z"',
      expected: 'https://ws.example.com/z',
    },
    {
      label: '前一个 href 没有 `=` 时继续找下一个',
      attributes: 'hrefx="https://no.example.com/" href="https://yes.example.com/"',
      expected: 'https://yes.example.com/',
    },
    // 原正则不要求单词边界，`data-href=` 里的 `href` 同样命中：改造后必须保持一致。
    {
      label: '不要求单词边界（data-href= 同样命中）',
      attributes: 'data-href="https://data.example.com/"',
      expected: 'https://data.example.com/',
    },
    { label: 'href 后没有 `=`', attributes: 'hrefx="https://noeq.example.com/"', expected: 'skipped:invalid_url' },
    { label: '空值 → 返回 null', attributes: 'href=""', expected: 'skipped:invalid_url' },
    {
      label: '引号不配对 → 返回 null',
      attributes: 'href="https://unterminated.example.com/',
      expected: 'skipped:invalid_url',
    },
    { label: '裸值为空（后面就是标签结束）', attributes: 'href=', expected: 'skipped:invalid_url' },
  ];

  for (const testCase of hrefCases) {
    it(`href：${testCase.label}`, () => {
      expect(hrefOutcome(testCase.attributes)).toBe(testCase.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. JSON 导入解析
// ---------------------------------------------------------------------------

describe('parseNavImportJson：结构化 JSON 导入', () => {
  const objectForm = {
    links: [
      {
        title: '官方站',
        url: 'https://official.example.com/',
        region: 'global',
        openMode: 'same_tab',
        groupName: '常用',
        tags: ['官方'],
      },
    ],
  };

  it('支持 { links: [...] } 与裸数组两种形态（含 JSON 字符串）', () => {
    const fromObject = parseNavImportJson(objectForm);
    const fromArray = parseNavImportJson(objectForm.links);
    expect(fromObject.items).toHaveLength(1);
    expect(fromObject.skipped).toEqual([]);
    expect(fromArray.items).toEqual(fromObject.items);

    expect(parseNavImportJson(JSON.stringify(objectForm)).items).toEqual(fromObject.items);
    expect(parseNavImportJson(JSON.stringify(objectForm.links)).items).toEqual(fromObject.items);
  });

  it('非法 JSON 字符串 → 恰一条 skipped，不抛错', () => {
    const result = parseNavImportJson('{ 这不是 JSON');
    expect(result.items).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('invalid_url');
    expect(result.skipped[0]?.detail.length).toBeGreaterThan(0);
  });

  it('缺 title / 缺 url / 非 https 逐项 skipped 且原因正确', () => {
    const result = parseNavImportJson({
      links: [
        { url: 'https://no-title.example.com/' },
        { title: '没有 URL' },
        { title: 'http 链接', url: 'http://plain.example.com/' },
        { title: '脚本链接', url: 'javascript:alert(1)' },
        { title: '重复条目', url: 'https://ok.example.com/' },
        { title: '重复条目副本', url: 'https://ok.example.com/' },
        { title: '合法条目', url: 'https://ok.example.com/other' },
      ],
    });
    expect(result.items.map((item) => item.title)).toEqual(['重复条目', '合法条目']);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      'missing_title',
      'invalid_url',
      'unsupported_scheme',
      'unsupported_scheme',
      'duplicate',
    ]);
  });

  it('region / openMode / groupName 合法值保留、非法值被忽略（不报错）', () => {
    const result = parseNavImportJson({
      links: [
        {
          title: '合法枚举',
          url: 'https://enum.example.com/',
          region: 'both',
          openMode: 'same_tab',
          groupName: '  常用分组  ',
        },
        {
          title: '非法枚举',
          url: 'https://bad-enum.example.com/',
          region: 'jp',
          openMode: 'popup',
          groupName: 42,
        },
      ],
    });
    expect(result.skipped).toEqual([]);

    const kept = result.items[0];
    expect(kept?.region).toBe('both');
    expect(kept?.openMode).toBe('same_tab');
    expect(kept?.groupName).toBe('常用分组');
    expect(kept?.tags).toEqual([]);

    // 非法值被忽略 → 结果里是缺省行为（字段不存在），而不是被硬塞进去的值。
    const ignored = result.items[1];
    expect(ignored?.title).toBe('非法枚举');
    expect(ignored?.region).toBeUndefined();
    expect(ignored?.openMode).toBeUndefined();
    expect(ignored?.groupName).toBeUndefined();
  });

  it('超过 MAX_NAV_IMPORT_ITEMS 的条目进 too_many_items', () => {
    const bulk = Array.from({ length: MAX_NAV_IMPORT_ITEMS + 3 }, (_unused, index) => ({
      title: `条目 ${String(index)}`,
      url: `https://bulk.example.com/${String(index)}`,
    }));
    const result = parseNavImportJson({ links: bulk });
    expect(result.items).toHaveLength(MAX_NAV_IMPORT_ITEMS);
    expect(result.skipped).toHaveLength(3);
    expect([...new Set(result.skipped.map((entry) => entry.reason))]).toEqual(['too_many_items']);
    expect(result.skipped[0]?.title).toBe(`条目 ${String(MAX_NAV_IMPORT_ITEMS)}`);
  });
});

// ---------------------------------------------------------------------------
// 7. 导出往返
// ---------------------------------------------------------------------------

describe('buildNavExportDocument / parseNavExportDocument：往返与拒绝', () => {
  const document = buildNavExportDocument({
    links: [...links, makeLink({ id: 'l-deleted-only', deletedAt: T0 + 6 })],
    groups: [makeGroup({ id: 'g1', name: '攻略' }), makeGroup({ id: 'g-dead', deletedAt: T0 })],
    memberships: [makeMembership('l1', 'g1'), makeMembership('l2', 'g1', { deletedAt: T0 })],
    catalogSourceVersion: 7,
    exportedAt: T0,
  });

  it('导出文档过滤掉全部墓碑，且版本号取自同一常量', () => {
    expect(document.schemaVersion).toBe(NAV_EXPORT_SCHEMA_VERSION);
    expect(document.catalogSourceVersion).toBe(7);
    expect(document.exportedAt).toBe(T0);
    expect(document.links.map((link) => link.id)).not.toContain('l5');
    expect(document.links.map((link) => link.id)).not.toContain('l-deleted-only');
    expect(document.groups.map((group) => group.id)).toEqual(['g1']);
    expect(document.memberships).toHaveLength(1);
    expect(document.memberships[0]?.linkId).toBe('l1');
  });

  it('往返：parseNavExportDocument 读回同一份文档', () => {
    expect(parseNavExportDocument(document)).toEqual({ ok: true, document });
    expect(parseNavExportDocument(JSON.stringify(document))).toEqual({ ok: true, document });
  });

  it('未来版本（schemaVersion=99）明确拒绝，不尝试猜测', () => {
    const future = parseNavExportDocument({ ...document, schemaVersion: 99 });
    expect(future.ok).toBe(false);
    if (!future.ok) {
      expect(future.reason).toContain('99');
    }
  });

  it('损坏结构 / 非法 JSON / 非对象都返回 ok:false', () => {
    for (const raw of [
      { schemaVersion: NAV_EXPORT_SCHEMA_VERSION, exportedAt: T0 },
      { ...document, links: 'not-an-array' },
      { ...document, exportedAt: -1 },
      { ...document, extra: 1 },
      'not json',
      null,
      42,
    ]) {
      expect(parseNavExportDocument(raw).ok).toBe(false);
    }
  });

  it('导出结果不含任何敏感键', () => {
    const serialized = JSON.stringify(document);
    for (const forbidden of ['token', 'secret', 'password']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Manifest 与 Widget 契约
// ---------------------------------------------------------------------------
