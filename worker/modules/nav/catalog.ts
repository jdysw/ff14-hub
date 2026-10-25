/** Public catalog seeds only advance versions; owner edits and source blocking remain separate. */
import {
  navCatalogEntrySchema,
  type NavCatalogEntry,
  type NavRegion,
} from '@ff14-hub/shared';
import { readDirectoryRecords } from './directory-editor';
import importedDirectory from '../../../data/navigation/catalog.json';
import { canonicalNavUrl } from '@ff14-hub/shared';

/**
 * 种子版本。**单调递增**：改种子内容时必须把它 +1，否则旧的（已写入的）行不会被覆盖。
 *
 * 为什么首次发布的种子从 2 而不是 1 开始：迁移里 `source_version >= 1` 是硬约束，
 * 因此「库内版本比种子更低」这一分支在版本 1 时**根本无法构造**，也就无法在真实 D1 上
 * 验证「更高版本才覆盖 / 更低不降级」这条规则（只能靠读代码相信它）。
 * 从 2 开始，库内版本可以被改小到 1（合法）来做验证——这是把不变量变成可测行为的代价，
 * 而不是把版本号当成装饰。
 */
export const NAV_CATALOG_SOURCE_VERSION = 4;

/**
 * 本阶段核对时间（UTC 毫秒，固定常量：核对时间必须可复现，不能在每次请求时取 `Date.now()`）。
 * 取 2026-10-18T00:00:00Z —— 阶段 04 实现当日。
 */
export const NAV_CATALOG_VERIFIED_AT = Date.parse('2026-10-19T16:00:00Z');

/** Stable built-in entries retain their original IDs and source attribution. */
const LEGACY_CATALOG_SEED: readonly NavCatalogEntry[] = [
  {
    // 来源：Square Enix 运营的 FINAL FANTASY XIV 官方门户（www.finalfantasyxiv.com）
    // 及其 Lodestone 分区（na./eu./jp.finalfantasyxiv.com/lodestone/，本条目取北美入口）。
    id: 'catalog.lodestone.global',
    sourceVersion: NAV_CATALOG_SOURCE_VERSION,
    title: 'The Lodestone（全球官方社区）',
    url: 'https://na.finalfantasyxiv.com/lodestone/',
    description: '官方社区与新闻入口（国际服）：公告、更新日志、角色与部队页面。',
    category: '官方与账号 / 官网与公告',
    tags: ['官方', '新闻', '社区'],
    aliases: ['Lodestone', '石之家'],
    icon: '📰',
    openMode: 'new_tab',
    region: 'global',
    sortOrder: 10,
    sourceUrl: 'https://www.finalfantasyxiv.com/',
    sourceName: 'FINAL FANTASY XIV 官方网站（Square Enix）',
    verifiedAt: NAV_CATALOG_VERIFIED_AT,
    verificationStatus: 'verified',
    updatedAt: NAV_CATALOG_VERIFIED_AT,
  },
  {
    // 来源：国服官网根地址。复核时（2026-10-18）实际请求 `https://ff.web.sdo.com/` 得到 HTTP 200，
    // 页面即《最终幻想14》国服官方站点，据此确认域名与运营主体。
    //
    // 诚实记录一处修正：早先这里写的是一条更"具体"的公告深链
    // （`web6/news/newsDetail.asp?page=27&id=327884`），但**无法独立核实**该深链仍然存在
    // （抓取返回的内容类型无法判定），因此改成站点根地址——宁可留痕弱一点，
    // 也不把一条没核实的深链当成"来源证据"。来源留痕的价值在于可复核，不在于看起来精确。
    id: 'catalog.official.cn',
    sourceVersion: NAV_CATALOG_SOURCE_VERSION,
    title: '最终幻想14（国服）官方网站',
    url: 'https://ff.web.sdo.com/',
    description: '国服官方站点：公告、活动与客户端下载入口。',
    category: '官方与账号 / 官网与公告',
    tags: ['官方', '国服', '新闻'],
    aliases: ['国服官网', '最终幻想14国服'],
    icon: '🏠',
    openMode: 'new_tab',
    region: 'cn',
    sortOrder: 20,
    sourceUrl: 'https://ff.web.sdo.com/',
    sourceName: '《最终幻想14》国服官方网站（盛趣游戏）',
    verifiedAt: NAV_CATALOG_VERIFIED_AT,
    verificationStatus: 'verified',
    updatedAt: NAV_CATALOG_VERIFIED_AT,
  },
  {
    // 来源：作者站点自身发布页（garlandtools.org 为 Garland Tools 的官方入口，
    // 条目即该站根地址，因此以它为作者页面留痕）。
    id: 'catalog.garlandtools',
    sourceVersion: NAV_CATALOG_SOURCE_VERSION,
    title: 'Garland Tools（迦兰德数据库）',
    url: 'https://garlandtools.org/',
    description: '物品、任务、采集位置与成就的社区数据库（作者站点）。',
    category: '入门与资料 / 百科与数据库',
    tags: ['数据', '采集', '物品'],
    aliases: ['Garland', '迦兰德'],
    icon: '📚',
    openMode: 'new_tab',
    // 「与区服无关的通用条目」：数据库本身不绑定某个区服（INV-08 只禁止把国服/国际服规则混用）。
    region: 'both',
    sortOrder: 30,
    sourceUrl: 'https://garlandtools.org/',
    sourceName: 'Garland Tools 作者站点',
    verifiedAt: NAV_CATALOG_VERIFIED_AT,
    verificationStatus: 'verified',
    updatedAt: NAV_CATALOG_VERIFIED_AT,
  },
  {
    // 来源：Universalis 作者站点/API 入口（universalis.app）。
    id: 'catalog.universalis',
    sourceVersion: NAV_CATALOG_SOURCE_VERSION,
    title: 'Universalis（市场板价格）',
    url: 'https://universalis.app/',
    description: '社区维护的市场板价格查询服务（国际服）。',
    category: '生产与采集 / 市场与物价',
    tags: ['市场板', '价格'],
    aliases: ['Universalis', '市场板价格'],
    icon: '📈',
    openMode: 'new_tab',
    // 市场板数据源只覆盖国际服大区，因此是 global 而不是 both。
    region: 'global',
    sortOrder: 40,
    sourceUrl: 'https://universalis.app/',
    sourceName: 'Universalis 作者站点',
    verifiedAt: NAV_CATALOG_VERIFIED_AT,
    verificationStatus: 'verified',
    updatedAt: NAV_CATALOG_VERIFIED_AT,
  },
  {
    // 来源：Teamcraft 官方代码仓库（github.com/ffxiv-teamcraft/ffxiv-teamcraft），
    // 它同时是作者发布渠道与「这个站点是谁的」的权威证据。
    id: 'catalog.teamcraft',
    sourceVersion: NAV_CATALOG_SOURCE_VERSION,
    title: 'Teamcraft（生产与配装协作）',
    url: 'https://ffxivteamcraft.com/',
    description: '生产模拟、配装与协作清单工具（作者站点）。',
    category: '生产与采集 / 制作与配方',
    tags: ['生产', '配装', '协作'],
    aliases: ['Teamcraft'],
    icon: '🛠️',
    openMode: 'new_tab',
    region: 'both',
    sortOrder: 50,
    sourceUrl: 'https://github.com/ffxiv-teamcraft/ffxiv-teamcraft',
    sourceName: 'Teamcraft 官方仓库',
    verifiedAt: NAV_CATALOG_VERIFIED_AT,
    verificationStatus: 'verified',
    updatedAt: NAV_CATALOG_VERIFIED_AT,
  },
];

/** Reviewed multi-source snapshot. Stable legacy IDs survive the expansion. */
export const NAV_CATALOG_SEED: readonly NavCatalogEntry[] = (() => {
  const entries = new Map(LEGACY_CATALOG_SEED.map(entry => [canonicalNavUrl(entry.url),entry]));
  for (const imported of importedDirectory) {
    const key=canonicalNavUrl(imported.url);
    const old=entries.get(key);
    const origin=imported.sources[0];
    if(!origin) throw new Error('目录导入缺少来源');
    entries.set(key,navCatalogEntrySchema.parse({
      id:old?.id??imported.id, sourceVersion:NAV_CATALOG_SOURCE_VERSION,
      title:old?.title??imported.title,url:old?.url??imported.url,
      description:old?.description??imported.description,category:imported.category,
      tags:[...new Set([...(old?.tags??[]),...imported.tags])].slice(0,20),
      aliases:[...new Set([...(old?.aliases??[]),...imported.aliases,...(old?[imported.title]:[])])].slice(0,10),
      icon:old?.icon??imported.icon,openMode:old?.openMode??imported.openMode,
      region:old?.region??imported.region,sortOrder:old?.sortOrder??imported.sortOrder,
      sourceUrl:origin.url,sourceName:imported.sources.map(source=>source.name).filter((name,index,list)=>list.indexOf(name)===index).join(' / '),
      verifiedAt:NAV_CATALOG_VERIFIED_AT,verificationStatus:'verified',updatedAt:NAV_CATALOG_VERIFIED_AT,
    }));
  }
  return [...entries.values()];
})();

/**
 * 目录行（与 `migrations/0008_navigation.sql` 的列一一对应）。
 * 读出来的是**原始行**，投影成契约形状在 `toCatalogEntry` 里做。
 */
export interface NavCatalogRow {
  readonly id: string;
  readonly source_version: number;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly category: string;
  readonly tags_json: string;
  readonly aliases_json: string;
  readonly icon: string;
  readonly open_mode: string;
  readonly region: string;
  readonly sort_order: number;
  readonly source_url: string;
  readonly source_name: string;
  readonly verified_at: number;
  readonly verification_status: string;
  readonly updated_at: number;
}

const CATALOG_COLUMNS =
  'id, source_version, title, url, description, category, tags_json, aliases_json, icon, ' +
  'open_mode, region, sort_order, source_url, source_name, verified_at, verification_status, updated_at';

/**
 * 版本化 upsert（**只升不降**）。
 *
 * 为什么用 `INSERT ... SELECT ... WHERE 1 = 1 ON CONFLICT ...`：
 * `guardedStatements`/批处理之外的场景里，`INSERT ... VALUES ... ON CONFLICT` 无法带
 * 「版本更高才覆盖」的条件，而 `INSERT ... SELECT` 形式可以（`WHERE 1 = 1` 是为了让
 * SQLite 解析器不会把 `ON CONFLICT` 当成 SELECT 的一部分，见 SQLite upsert 文档的注意事项）。
 * `DO UPDATE ... WHERE excluded.source_version > nav_catalog_links.source_version`
 * 让「同版本重放」与「更低版本」都变成 0 行变化，因此重复调用不产生任何变化。
 */
const UPSERT_CATALOG_SQL = `INSERT INTO nav_catalog_links
    (id, source_version, title, url, description, category, tags_json, aliases_json, icon,
     open_mode, region, sort_order, source_url, source_name, verified_at, verification_status, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
   WHERE 1 = 1
  ON CONFLICT (id) DO UPDATE SET
    source_version = excluded.source_version,
    title = excluded.title,
    url = excluded.url,
    description = excluded.description,
    category = excluded.category,
    tags_json = excluded.tags_json,
    aliases_json = excluded.aliases_json,
    icon = excluded.icon,
    open_mode = excluded.open_mode,
    region = excluded.region,
    sort_order = excluded.sort_order,
    source_url = excluded.source_url,
    source_name = excluded.source_name,
    verified_at = excluded.verified_at,
    verification_status = excluded.verification_status,
    updated_at = excluded.updated_at
   WHERE excluded.source_version > nav_catalog_links.source_version`;

/**
 * 解析一个 JSON 字符串数组列。
 *
 * 目录表由本文件的种子独占写入，因此这里只做**防御性**解析：格式不合法就是数据损坏，
 * 返回空数组会让「筛选/展示」静默丢字段，所以调用方（`toCatalogEntry`）拿到空数组后
 * 仍会走契约校验；这里的取舍是「不因为一个坏值抛异常」，与工作台 `internal.ts` 的
 * 防御性解析一致。
 */
function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 行 → 契约对象。
 *
 * 用共享 Schema 做**严格**校验：目录行只由本文件的种子写入，若读出来的行不符合契约，
 * 说明数据被外部改动或种子写错了——此时宁可让请求失败（500，只记服务端日志），
 * 也不要把一条字段可疑的推荐当作事实返回给所有匿名用户。
 */
function toCatalogEntry(row: NavCatalogRow): NavCatalogEntry {
  const parsed = navCatalogEntrySchema.safeParse({
    id: row.id,
    sourceVersion: row.source_version,
    title: row.title,
    url: row.url,
    description: row.description,
    category: row.category,
    tags: parseStringArray(row.tags_json),
    aliases: parseStringArray(row.aliases_json),
    icon: row.icon,
    openMode: row.open_mode,
    region: row.region,
    sortOrder: row.sort_order,
    sourceUrl: row.source_url,
    sourceName: row.source_name,
    verifiedAt: row.verified_at,
    verificationStatus: row.verification_status,
    updatedAt: row.updated_at,
  });
  if (!parsed.success) {
    // 不把行内容写进错误消息（可能被日志链路带出去），只给出 ID。
    throw new Error(`目录行不符合契约：${row.id}`);
  }
  return parsed.data;
}

export interface CatalogSeedResult {
  /** 种子版本（= `NAV_CATALOG_SOURCE_VERSION`）。 */
  readonly sourceVersion: number;
  /** 种子条目数。 */
  readonly entryCount: number;
  /**
   * 本次实际写入（插入或覆盖）的行数。重复调用时为 0 —— 这就是「可重入」的可见证据，
   * 测试不必依赖「再读一遍比对」，因为行数变化本身就是幂等性的直接断言。
   */
  readonly changedRows: number;
}

/**
 * 懒应用目录种子（版本化、可重入）。
 *
 * 在 `GET /api/v1/navigation/catalog` 读取前调用（懒应用），因此不需要迁移里写 INSERT，
 * 也不需要在部署流程里额外跑一次种子脚本——第一次读目录时自然完成。
 *
 * 并发：两个 isolate 同时应用同一种子时，`ON CONFLICT DO NOTHING/DO UPDATE ... WHERE`
 * 让后到者变成 0 行变化，不会互相覆盖、也不会报错。
 */
export async function applyCatalogSeed(input: {
  readonly db: D1Database;
  readonly now: number;
}): Promise<CatalogSeedResult> {
  // 先校验种子自身：种子是代码常量，不合法就是编程错误，必须响亮地失败（而不是写坏库）。
  for (const entry of NAV_CATALOG_SEED) {
    const parsed = navCatalogEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`目录种子条目不符合契约：${entry.id}`);
    }
  }

  const existing = await input.db.prepare('SELECT id,source_version FROM nav_catalog_links').all<{id:string;source_version:number}>();
  const versions=new Map(existing.results.map(row=>[row.id,row.source_version]));
  const pending=NAV_CATALOG_SEED.filter(entry=>(versions.get(entry.id)??0)<entry.sourceVersion);
  if(pending.length===0)return {sourceVersion:NAV_CATALOG_SOURCE_VERSION,entryCount:NAV_CATALOG_SEED.length,changedRows:0};
  const statements = pending.map((entry) =>
    input.db
      .prepare(UPSERT_CATALOG_SQL)
      .bind(
        entry.id,
        entry.sourceVersion,
        entry.title,
        entry.url,
        entry.description,
        entry.category,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.aliases),
        entry.icon,
        entry.openMode,
        entry.region,
        entry.sortOrder,
        entry.sourceUrl,
        entry.sourceName,
        entry.verifiedAt,
        entry.verificationStatus,
        // updated_at 用「本阶段核对时间」而不是调用时刻：目录内容的更新时间是种子事实，
        // 不是请求时间，否则每次懒应用都会让 updated_at 变化（可重入性就不可断言了）。
        entry.updatedAt,
      ),
  );

  const results = await input.db.batch(statements);
  const changedRows = results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  return {
    sourceVersion: NAV_CATALOG_SOURCE_VERSION,
    entryCount: NAV_CATALOG_SEED.length,
    changedRows,
  };
}

/**
 * 读取目录当前版本（行缺失等价于 0，与 `workspace_nav_state` 的约定一致）。
 * 客户端的 `catalogSourceVersion` 与「目录有没有升级」的判断都取自它。
 */
export async function readCatalogSourceVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS value FROM (
      SELECT source_version AS version FROM nav_catalog_links
      UNION ALL SELECT json_extract(payload,'$.sourceVersion') AS version FROM nav_catalog_edits)`)
    .first<{ value: number }>();
  return row?.value ?? 0;
}

/**
 * 只读查询目录。
 *
 * - `region` 语义与个人链接筛选**一致**（共享 `filterNavLinks` 的口径）：
 *   命中该区服，或条目是「与区服无关」的 `both`。
 * - `category` 精确匹配（分类是种子里的固定短标签）。
 * - 排序固定为 `(sort_order, id)`：同一份数据在任何设备上的顺序必然一致。
 *
 * SQL 里**没有**任何字符串拼接：可选条件用 `? IS NULL OR ...`，因此不存在注入面。
 */
export async function readCatalog(input: {
  readonly db: D1Database;
  readonly region?: NavRegion;
  readonly category?: string;
}): Promise<NavCatalogEntry[]> {
  const records = await readDirectoryRecords(input.db, await readBaseCatalog(input.db));
  return records.filter(record => !record.hidden).map(record => record.entry).filter(entry =>
    (input.category === undefined || entry.category === input.category) &&
    (input.region === undefined || entry.region === input.region || entry.region === 'both'));
}

/** Raw imported data for the owner overlay; public callers use readCatalog. */
export async function readBaseCatalog(db: D1Database): Promise<NavCatalogEntry[]> {
  const result = await db
    .prepare(
      `SELECT ${CATALOG_COLUMNS} FROM nav_catalog_links
        ORDER BY sort_order ASC, id ASC`,
    )
    .all<NavCatalogRow>();
  return result.results.map(toCatalogEntry);
}
