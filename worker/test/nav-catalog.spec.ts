/**
 * 系统推荐目录（HUB-047 / ADR-0004 D1）验收。
 *
 * 证据标准：
 * 1. **种子自身可核对**：每条（表驱动）都有 https 的 `url` 与 `sourceUrl`、核对时间、
 *    合法区服与唯一 ID，且整体能过共享 `navCatalogEntrySchema`（严格）。
 * 2. **匿名只读**：`GET /api/v1/navigation/catalog` 无凭证可读，且响应里**没有**任何
 *    个人字段（工作空间 ID / 收藏 / 墓碑 / 修订号都不应出现）。
 * 3. **版本化 upsert 可重入、只升不降**：重复应用 0 行变化、内容逐字节不变；
 *    库里版本更低 → 被种子覆盖；库里版本更高 → **不降级**。
 * 4. **目录只读**：个人 CRUD（新建链接 / 分组 / 收藏 / 删除）之后，目录行逐字节不变。
 */
import { NAV_REGIONS, navCatalogEntrySchema, validateNavUrl } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_CATALOG_SEED, NAV_CATALOG_SOURCE_VERSION, applyCatalogSeed } from '../modules/nav/catalog';
import {
  URLS,
  errorBodyOf,
  jsonDelete,
  jsonPatch,
  jsonPost,
  navLinkUrl,
  opId,
  resetIdentityState,
  seedAuth,
} from './helpers';

/** 目录行的原始快照（**含所有列**，用于断言「逐字节未变」）。 */
async function catalogRowSnapshot(): Promise<string> {
  const result = await env.DB.prepare('SELECT * FROM nav_catalog_links ORDER BY id ASC').all();
  return JSON.stringify(result.results);
}

async function catalogRowCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM nav_catalog_links').first<{ count: number }>();
  return row?.count ?? -1;
}

/** 读取一条目录行的标题与版本。 */
async function readCatalogRow(id: string): Promise<{ title: string; source_version: number } | null> {
  return await env.DB.prepare('SELECT title, source_version FROM nav_catalog_links WHERE id = ?')
    .bind(id)
    .first<{ title: string; source_version: number }>();
}

/** 目录响应里的条目形状。 */
interface CatalogResponse {
  readonly entries: readonly Record<string, unknown>[];
  readonly sourceVersion: number;
  readonly updatedAt: number;
}

async function readCatalogViaApi(query = ''): Promise<{ status: number; body: CatalogResponse | null; text: string }> {
  const response = await SELF.fetch(`${URLS.navCatalog}${query}`);
  const text = await response.text();
  const body = response.status === 200 ? (JSON.parse(text) as CatalogResponse) : null;
  return { status: response.status, body, text };
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('目录种子与公开目录端点', () => {
  it('种子每条都有可核对的来源、https 地址、核对时间、合法区服与唯一 ID', () => {
    expect(NAV_CATALOG_SEED.length).toBeGreaterThanOrEqual(3);
    expect(NAV_CATALOG_SEED.length).toBeLessThanOrEqual(8);
    const ids = new Set<string>();
    for (const entry of NAV_CATALOG_SEED) {
      // 整体形状：共享 Schema 是唯一口径（严格，多字段/少字段都失败）。
      expect(navCatalogEntrySchema.safeParse(entry).success, `条目不符合契约：${entry.id}`).toBe(true);
      expect(validateNavUrl(entry.url).ok, `url 必须是 https：${entry.id}`).toBe(true);
      expect(entry.url.startsWith('https://'), `url 必须是 https：${entry.id}`).toBe(true);
      expect(validateNavUrl(entry.sourceUrl).ok, `sourceUrl 必须是 https：${entry.id}`).toBe(true);
      expect(entry.sourceUrl.startsWith('https://'), `sourceUrl 必须是 https：${entry.id}`).toBe(true);
      // 核对时间是固定常量（可复现），不是取当前时刻。
      expect(entry.verifiedAt).toBeGreaterThan(0);
      expect(Number.isInteger(entry.verifiedAt)).toBe(true);
      expect(NAV_REGIONS).toContain(entry.region);
      // 来源名字与核对状态必须显式给出（verificationStatus 只描述来源条目本身）。
      expect(entry.sourceName.length).toBeGreaterThan(0);
      expect(['verified', 'unverified']).toContain(entry.verificationStatus);
      expect(entry.sourceVersion).toBe(NAV_CATALOG_SOURCE_VERSION);
      expect(ids.has(entry.id), `目录 ID 重复：${entry.id}`).toBe(false);
      ids.add(entry.id);
    }
    // 种子 ID 唯一且与条数一致。
    expect(ids.size).toBe(NAV_CATALOG_SEED.length);
  });

  it('GET /navigation/catalog 匿名可读，只返回目录字段，不泄露任何个人字段', async () => {
    const { status, body, text } = await readCatalogViaApi();
    expect(status).toBe(200);
    expect(body).not.toBeNull();
    const entries = body?.entries ?? [];
    expect(entries.length).toBe(NAV_CATALOG_SEED.length);
    expect(body?.sourceVersion).toBe(NAV_CATALOG_SOURCE_VERSION);
    expect(body?.updatedAt).toBeGreaterThan(0);

    const allowedKeys = Object.keys(navCatalogEntrySchema.shape).sort();
    for (const entry of entries) {
      expect(navCatalogEntrySchema.safeParse(entry).success).toBe(true);
      // 字段集合必须**恰好**是目录契约的字段：多一个「个人字段」都算泄露。
      expect(Object.keys(entry).sort()).toEqual(allowedKeys);
    }
    // 响应文本里不允许出现个人导航的字段名。
    for (const forbidden of ['workspaceId', 'workspace_id', 'isFavorite', 'deletedAt', 'health']) {
      expect(text.includes(`"${forbidden}"`), `目录响应不应包含个人字段 ${forbidden}`).toBe(false);
    }
  });

  it('区服 / 分类筛选可用；非法查询参数返回 422', async () => {
    const all = await readCatalogViaApi();
    const cn = await readCatalogViaApi('?region=cn');
    expect(cn.status).toBe(200);
    for (const entry of cn.body?.entries ?? []) {
      // 与个人链接的区服口径一致：命中该区服，或条目是「与区服无关」的 both。
      expect(['cn', 'both']).toContain(entry['region']);
    }
    expect((cn.body?.entries.length ?? 0)).toBeLessThanOrEqual(all.body?.entries.length ?? 0);

    const category = await readCatalogViaApi('?category=%E5%AE%98%E6%96%B9');
    expect(category.status).toBe(200);
    expect((category.body?.entries.length ?? 0)).toBeGreaterThan(0);
    for (const entry of category.body?.entries ?? []) {
      expect(entry['category']).toBe('官方');
    }

    const invalidRegion = await SELF.fetch(`${URLS.navCatalog}?region=mars`);
    expect(invalidRegion.status).toBe(422);
    expect(errorBodyOf(await invalidRegion.text()).code).toBe('validation_failed');
    const unknownParam = await SELF.fetch(`${URLS.navCatalog}?nope=1`);
    expect(unknownParam.status).toBe(422);
  });

  it('重复应用种子 0 行变化，行数与内容逐字节不变（可重入）', async () => {
    // 目录表不属于 `resetIdentityState()`（它由种子独占写入，跨用例保留），
    // 因此这里显式清空一次，才能断言「首次应用真的插入了 N 行」。
    await env.DB.prepare('DELETE FROM nav_catalog_links').run();

    const first = await applyCatalogSeed({ db: env.DB, now: 1_760_000_000_000 });
    expect(first.entryCount).toBe(NAV_CATALOG_SEED.length);
    expect(first.changedRows).toBe(NAV_CATALOG_SEED.length);
    expect(await catalogRowCount()).toBe(NAV_CATALOG_SEED.length);
    const snapshot = await catalogRowSnapshot();

    const second = await applyCatalogSeed({ db: env.DB, now: 1_760_000_000_001 });
    expect(second.changedRows).toBe(0);
    expect(await catalogRowCount()).toBe(NAV_CATALOG_SEED.length);
    expect(await catalogRowSnapshot()).toBe(snapshot);

    // 懒应用路径（公开端点）也不会改变任何行。
    expect((await readCatalogViaApi()).status).toBe(200);
    expect(await catalogRowSnapshot()).toBe(snapshot);
  });

  it('只有更高的 source_version 才覆盖：库里版本更低 → 覆盖；更高 → 不降级', async () => {
    await applyCatalogSeed({ db: env.DB, now: 1_760_000_000_000 });
    const target = NAV_CATALOG_SEED[0];
    if (target === undefined) {
      throw new Error('种子为空');
    }

    // 情况一：库内版本更低（合法的最小值 1）+ 被篡改的内容 → 种子的更高版本覆盖回去。
    await env.DB.prepare('UPDATE nav_catalog_links SET source_version = 1, title = ? WHERE id = ?')
      .bind('被篡改的标题', target.id)
      .run();
    const upgraded = await applyCatalogSeed({ db: env.DB, now: 1_760_000_000_002 });
    expect(upgraded.changedRows).toBe(1);
    expect(await readCatalogRow(target.id)).toEqual({
      title: target.title,
      source_version: target.sourceVersion,
    });

    // 情况二：库内版本更高（未来版本）+ 不同内容 → 种子**不降级**、也不改内容。
    await env.DB.prepare('UPDATE nav_catalog_links SET source_version = ?, title = ? WHERE id = ?')
      .bind(NAV_CATALOG_SOURCE_VERSION + 1, '未来版本的标题', target.id)
      .run();
    const downgraded = await applyCatalogSeed({ db: env.DB, now: 1_760_000_000_003 });
    expect(downgraded.changedRows).toBe(0);
    expect(await readCatalogRow(target.id)).toEqual({
      title: '未来版本的标题',
      source_version: NAV_CATALOG_SOURCE_VERSION + 1,
    });

    // 复原：把这一行改回种子内容，避免影响同文件后续用例。
    await env.DB.prepare('UPDATE nav_catalog_links SET source_version = ?, title = ? WHERE id = ?')
      .bind(target.sourceVersion, target.title, target.id)
      .run();
    expect((await readCatalogViaApi()).body?.sourceVersion).toBe(NAV_CATALOG_SOURCE_VERSION);
  });

  it('目录只读：个人链接 / 分组 / 收藏 / 删除都不会改变目录行', async () => {
    const auth = await seedAuth();
    await applyCatalogSeed({ db: env.DB, now: 1_760_000_000_000 });
    const before = await catalogRowSnapshot();

    const created = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        {
          operationId: opId('catalog-readonly-link'),
          title: '个人链接',
          url: 'https://example.test/personal',
          isFavorite: true,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ link: { id: string; revision: number } }>();

    const group = await SELF.fetch(
      URLS.meNavigationGroups,
      jsonPost({ operationId: opId('catalog-readonly-group'), name: '个人分组' }, { Authorization: auth.authorization }),
    );
    expect(group.status).toBe(201);

    const patched = await SELF.fetch(
      navLinkUrl(createdBody.link.id),
      jsonPatch(
        { operationId: opId('catalog-readonly-patch'), expectedRevision: 0, isFavorite: false },
        { Authorization: auth.authorization },
      ),
    );
    expect(patched.status).toBe(200);

    const deleted = await SELF.fetch(
      navLinkUrl(createdBody.link.id),
      jsonDelete({ operationId: opId('catalog-readonly-delete'), expectedRevision: 1 }, { Authorization: auth.authorization }),
    );
    expect(deleted.status).toBe(200);

    // 目录行逐字节未变，且仍可通过公开端点读到同样内容。
    expect(await catalogRowSnapshot()).toBe(before);
    const after = await readCatalogViaApi();
    expect(after.status).toBe(200);
    expect(after.body?.entries.length).toBe(NAV_CATALOG_SEED.length);
  });
});
