/**
 * 导入验收（HUB-007 / HUB-047 / ADR-0004 D1 / D6）。
 *
 * 核心场景（必须一条不落地证明）：
 *   导入目录条目 → 改个人副本（改标题）→ 删除（墓碑）→ 目录升级 →
 *   个人修改保留、墓碑仍是删除、没有新增重复行；
 *   `explicitReimport=false` 时墓碑**不被复活**、`user_modified` **不被覆盖**；
 *   `explicitReimport=true` 时墓碑复活为**一行**（仍只有一行）；
 *   同一 operationId 重放幂等（行数不变）。
 *
 * 书签导入：重复 URL **逐项**跳过、http / javascript: 条目被拒（逐项说明 + 422）、
 * 预览新鲜度过期 → 409 且零写入。
 */
import {
  navImportSkippedSchema,
  parseBookmarkHtml,
  parseNavExportDocument,
  validateNavUrl,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_CATALOG_SEED, NAV_CATALOG_SOURCE_VERSION, applyCatalogSeed } from '../modules/nav/catalog';
import {
  URLS,
  errorBodyOf,
  jsonDelete,
  jsonPost,
  navLinkUrl,
  opId,
  resetIdentityState,
  seedAuth,
  type AuthedWorkspace,
} from './helpers';

// ---------------------------------------------------------------------------
// 本地行读取器
// ---------------------------------------------------------------------------

interface NavLinkDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly source_catalog_id: string | null;
  readonly imported_source_version: number | null;
  readonly title: string;
  readonly url: string;
  readonly region: string;
  readonly sort_order: number;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly updated_at: number;
}

const LINK_COLUMNS =
  'id, workspace_id, source_catalog_id, imported_source_version, title, url, region, ' +
  'sort_order, revision, deleted_at, updated_at';

/** **含墓碑**的全部链接行（导入决策要看的正是「墓碑还在不在」）。 */
async function readAllLinkRows(workspaceId: string): Promise<NavLinkDbRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${LINK_COLUMNS} FROM workspace_nav_links WHERE workspace_id = ? ORDER BY url ASC, id ASC`,
  )
    .bind(workspaceId)
    .all<NavLinkDbRow>();
  return result.results;
}

async function readLinksByCatalogId(workspaceId: string, catalogId: string): Promise<NavLinkDbRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${LINK_COLUMNS} FROM workspace_nav_links
      WHERE workspace_id = ? AND source_catalog_id = ? ORDER BY updated_at DESC, id ASC`,
  )
    .bind(workspaceId, catalogId)
    .all<NavLinkDbRow>();
  return result.results;
}

async function readActiveLinkRows(workspaceId: string): Promise<NavLinkDbRow[]> {
  return (await readAllLinkRows(workspaceId)).filter((row) => row.deleted_at === null);
}

async function readGroupNames(workspaceId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    'SELECT name FROM workspace_nav_groups WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC',
  )
    .bind(workspaceId)
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

async function readStateRevision(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT revision FROM workspace_nav_state WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

/** 目录升级：把某条目录条目的版本抬高并改写内容（模拟「系统目录发布了新版本」）。 */
async function upgradeCatalogEntry(catalogId: string, newTitle: string): Promise<void> {
  await env.DB.prepare('UPDATE nav_catalog_links SET source_version = ?, title = ? WHERE id = ?')
    .bind(NAV_CATALOG_SOURCE_VERSION + 1, newTitle, catalogId)
    .run();
}

interface CatalogImportResponse {
  readonly decisions: readonly {
    readonly catalogId: string;
    readonly action: string;
    readonly reason: string;
    readonly linkId: string | null;
  }[];
  readonly importedCount: number;
  readonly importedLinkIds: readonly string[];
  readonly restoredLinkIds: readonly string[];
  readonly skippedCatalogIds: readonly string[];
  readonly revision: number;
  readonly replayed?: boolean;
}

async function importCatalogViaApi(
  auth: AuthedWorkspace,
  body: { readonly catalogIds: readonly string[]; readonly operationId: string; readonly explicitReimport?: boolean; readonly overwriteUserEdits?: boolean },
): Promise<{ status: number; body: CatalogImportResponse | null; text: string }> {
  const response = await SELF.fetch(
    URLS.meNavigationCatalogImport,
    jsonPost(body, { Authorization: auth.authorization }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: response.status === 200 ? (JSON.parse(text) as CatalogImportResponse) : null,
    text,
  };
}

async function applyImportViaApi(
  auth: AuthedWorkspace,
  body: {
    readonly items: readonly unknown[];
    readonly expectedRevision: number;
    readonly operationId: string;
    readonly targetGroupId?: string;
  },
): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const response = await SELF.fetch(URLS.meNavigationImportApply, jsonPost(body, { Authorization: auth.authorization }));
  const text = await response.text();
  return {
    status: response.status,
    body: response.status === 200 ? (JSON.parse(text) as Record<string, unknown>) : null,
    text,
  };
}

beforeEach(async () => {
  await resetIdentityState();
  // 每个用例都从「刚发布」的目录开始：本文件会刻意篡改目录行来模拟升级。
  await env.DB.prepare('DELETE FROM nav_catalog_links').run();
  await applyCatalogSeed({ db: env.DB, now: 1_760_000_000_000 });
});

describe('目录导入的升级语义（核心验收）', () => {
  it('个人修改保留、墓碑不被复活、没有重复行；显式再导入只复活墓碑', async () => {
    const auth = await seedAuth();
    const entryKeep = NAV_CATALOG_SEED.find((entry) => entry.category === '官方');
    const entryTool = NAV_CATALOG_SEED.find((entry) => entry.category === '数据工具');
    if (entryKeep === undefined || entryTool === undefined) {
      throw new Error('目录种子缺少预期分类');
    }

    // 1) 导入两条目录条目（同一次请求，逐条报告）。
    const imported = await importCatalogViaApi(auth, {
      catalogIds: [entryKeep.id, entryTool.id],
      operationId: opId('catalog-import'),
    });
    expect(imported.status).toBe(200);
    expect(imported.body?.importedCount).toBe(2);
    expect(imported.body?.decisions.map((decision) => decision.action)).toEqual(['insert', 'insert']);
    const linkKeepId = imported.body?.decisions[0]?.linkId ?? '';
    const linkToolId = imported.body?.decisions[1]?.linkId ?? '';
    expect(linkKeepId.length).toBeGreaterThan(0);
    expect(linkToolId.length).toBeGreaterThan(0);

    // 导入即完全独立：`source_catalog_id` + `imported_source_version` 落在个人行上。
    const rowsAfterImport = await readActiveLinkRows(auth.workspaceId);
    expect(rowsAfterImport.length).toBe(2);
    const keepRow = rowsAfterImport.find((row) => row.id === linkKeepId);
    expect(keepRow?.source_catalog_id).toBe(entryKeep.id);
    expect(keepRow?.imported_source_version).toBe(entryKeep.sourceVersion);
    // 目录自带的分类在个人侧复用/新建为同名分组。
    expect(new Set(await readGroupNames(auth.workspaceId))).toEqual(new Set(['官方', '数据工具']));

    // 2) 个人修改（改标题）与个人删除（墓碑）。
    const patched = await SELF.fetch(
      navLinkUrl(linkKeepId),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
        body: JSON.stringify({ operationId: opId('catalog-import-rename'), expectedRevision: 0, title: '我改过的标题' }),
      },
    );
    expect(patched.status).toBe(200);
    const deleted = await SELF.fetch(
      navLinkUrl(linkToolId),
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: auth.authorization },
        body: JSON.stringify({ operationId: opId('catalog-import-delete'), expectedRevision: 0 }),
      },
    );
    expect(deleted.status).toBe(200);
    expect((await readLinksByCatalogId(auth.workspaceId, entryTool.id))[0]?.deleted_at).not.toBeNull();

    // 3) 目录升级：系统目录发布了更高版本（内容也变了）。个人副本一个字节都不该被动。
    await upgradeCatalogEntry(entryKeep.id, '目录升级后的新标题');
    await upgradeCatalogEntry(entryTool.id, '目录升级后的新标题');

    // 4) 非显式导入：`user_modified` 不被覆盖、墓碑不被复活、不产生新行。
    const upgradeImport = await importCatalogViaApi(auth, {
      catalogIds: [entryKeep.id, entryTool.id],
      operationId: opId('catalog-import-upgrade'),
    });
    expect(upgradeImport.status).toBe(200);
    expect(upgradeImport.body?.importedCount).toBe(0);
    expect(upgradeImport.body?.skippedCatalogIds).toEqual([entryKeep.id, entryTool.id]);
    const decisions = upgradeImport.body?.decisions ?? [];
    expect(decisions[0]?.action).toBe('skip');
    expect(decisions[0]?.reason).toContain('个人修改');
    expect(decisions[1]?.action).toBe('skip');
    expect(decisions[1]?.reason).toContain('删除');

    // 个人修改保留。
    expect((await readLinksByCatalogId(auth.workspaceId, entryKeep.id))[0]?.title).toBe('我改过的标题');
    // 墓碑仍是删除，且没有新增重复行。
    const toolRows = await readLinksByCatalogId(auth.workspaceId, entryTool.id);
    expect(toolRows.length).toBe(1);
    expect(toolRows[0]?.deleted_at).not.toBeNull();
    // 整个工作空间里没有任何一行带上「目录升级后的新标题」。
    expect((await readAllLinkRows(auth.workspaceId)).some((row) => row.title === '目录升级后的新标题')).toBe(false);

    // 5) 显式再导入但**不**允许覆盖个人修改：墓碑复活（一行），个人修改仍保留。
    const explicit = await importCatalogViaApi(auth, {
      catalogIds: [entryKeep.id, entryTool.id],
      explicitReimport: true,
      operationId: opId('catalog-import-explicit'),
    });
    expect(explicit.status).toBe(200);
    expect(explicit.body?.decisions[0]?.action).toBe('skip');
    expect(explicit.body?.decisions[1]?.action).toBe('restore_tombstone');
    expect(explicit.body?.restoredLinkIds).toEqual([linkToolId]);
    expect(explicit.body?.importedCount).toBe(1);

    const restoredRows = await readLinksByCatalogId(auth.workspaceId, entryTool.id);
    expect(restoredRows.length).toBe(1); // 复活墓碑，而不是复制一份
    expect(restoredRows[0]?.id).toBe(linkToolId);
    expect(restoredRows[0]?.deleted_at).toBeNull();
    expect(restoredRows[0]?.title).toBe('目录升级后的新标题'); // 内容被刷新为目录新版本
    expect(restoredRows[0]?.imported_source_version).toBe(NAV_CATALOG_SOURCE_VERSION + 1);
    expect((await readLinksByCatalogId(auth.workspaceId, entryKeep.id))[0]?.title).toBe('我改过的标题');

    // 6) 显式 + 允许覆盖：个人修改被目录内容覆盖（唯一会覆盖个人行的入口）。
    const overwriteOperationId = opId('catalog-import-overwrite');
    const overwritten = await importCatalogViaApi(auth, {
      catalogIds: [entryKeep.id],
      explicitReimport: true,
      overwriteUserEdits: true,
      operationId: overwriteOperationId,
    });
    expect(overwritten.status).toBe(200);
    expect(overwritten.body?.decisions[0]?.action).toBe('update');
    const keepRows = await readLinksByCatalogId(auth.workspaceId, entryKeep.id);
    expect(keepRows.length).toBe(1);
    expect(keepRows[0]?.title).toBe('目录升级后的新标题');
    expect(keepRows[0]?.id).toBe(linkKeepId);

    // 7) 同一 operationId 重放：行数不变、结果一致。
    const before = await readAllLinkRows(auth.workspaceId);
    const revisionBefore = await readStateRevision(auth.workspaceId);
    const replay = await importCatalogViaApi(auth, {
      catalogIds: [entryKeep.id],
      explicitReimport: true,
      overwriteUserEdits: true,
      operationId: overwriteOperationId,
    });
    expect(replay.status).toBe(200);
    expect(replay.body?.replayed).toBe(true);
    expect(JSON.stringify(await readAllLinkRows(auth.workspaceId))).toBe(JSON.stringify(before));
    expect(await readStateRevision(auth.workspaceId)).toBe(revisionBefore);
  });

  it('目录里没有的 ID 逐项跳过，不影响同批的合法条目', async () => {
    const auth = await seedAuth();
    const entry = NAV_CATALOG_SEED[0];
    if (entry === undefined) {
      throw new Error('种子为空');
    }
    const result = await importCatalogViaApi(auth, {
      catalogIds: ['catalog.does-not-exist', entry.id],
      operationId: opId('catalog-import-unknown'),
    });
    expect(result.status).toBe(200);
    const decisions = result.body?.decisions ?? [];
    expect(decisions[0]).toMatchObject({ catalogId: 'catalog.does-not-exist', action: 'skip', linkId: null });
    expect(decisions[0]?.reason).toContain('目录中没有该条目');
    expect(decisions[1]?.action).toBe('insert');
    expect(result.body?.skippedCatalogIds).toEqual(['catalog.does-not-exist']);
    expect((await readActiveLinkRows(auth.workspaceId)).length).toBe(1);
  });

  it('快照的 catalogSourceVersion 反映目录版本（客户端据此判断「目录有没有升级」）', async () => {
    const auth = await seedAuth();
    const response = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } });
    expect(response.status).toBe(200);
    const snapshot = await response.json<{ catalogSourceVersion: number }>();
    expect(snapshot.catalogSourceVersion).toBe(NAV_CATALOG_SOURCE_VERSION);

    const entry = NAV_CATALOG_SEED[0];
    if (entry === undefined) {
      throw new Error('种子为空');
    }
    await upgradeCatalogEntry(entry.id, entry.title);
    const upgraded = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } });
    const upgradedSnapshot = await upgraded.json<{ catalogSourceVersion: number }>();
    expect(upgradedSnapshot.catalogSourceVersion).toBe(NAV_CATALOG_SOURCE_VERSION + 1);
    // 目录升级本身**绝不**写个人表。
    expect(await readAllLinkRows(auth.workspaceId)).toEqual([]);
  });
});

describe('书签 / 结构化导入', () => {
  it('http 与 javascript: 条目逐项说明并拒绝；重复 URL 逐项跳过；小组名复用创建', async () => {
    const auth = await seedAuth();

    // 先放一条已存在的链接，用来验证「与现有 URL 重复」的逐项跳过。
    const existing = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('import-existing'), title: '已存在', url: 'https://exists.test/' },
        { Authorization: auth.authorization },
      ),
    );
    expect(existing.status).toBe(201);

    // 现代浏览器导出的书签里 `<DT>` 往往没有闭合标签，而共享解析器是按
    // 「标签必须闭合」的数据视角扫描的（它不解释 HTML，只按 `<A>` / `<H3>` 取数据），
    // 因此这里用解析器明确支持的形状：`<H3>…</H3>` 与 `<A HREF="…">…</A>`。
    const bookmarkHtml = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<DL><p>',
      '<H3>我的收藏夹</H3>',
      '<DL><p>',
      '<A HREF="https://exists.test/">已存在</A>',
      '<A HREF="https://new.test/a">新条目甲</A>',
      '<A HREF="https://new.test/a">重复的新条目甲</A>',
      '<A HREF="http://plain.test/">http 条目</A>',
      '<A HREF="javascript:alert(1)">危险条目</A>',
      '</DL><p>',
      '</DL><p>',
    ].join('\n');

    // 客户端侧（共享纯函数）解析：逐项给出 accepted / skipped，绝不静默丢弃。
    const parsed = parseBookmarkHtml(bookmarkHtml);
    const [parsedExisting, parsedNew] = parsed.items;
    if (parsedExisting === undefined || parsedNew === undefined) {
      throw new Error(`书签解析结果不符合预期：${JSON.stringify(parsed)}`);
    }
    expect(parsed.items.map((item) => item.url)).toEqual(['https://exists.test/', 'https://new.test/a']);
    expect(parsedExisting.groupName).toBe('我的收藏夹');
    const skipReasons = parsed.skipped.map((skipped) => skipped.reason);
    expect(skipReasons).toContain('duplicate');
    expect(skipReasons.filter((reason) => reason === 'unsupported_scheme').length).toBe(2);
    for (const skipped of parsed.skipped) {
      // 每条跳过都可被共享 Schema 读回（reason / detail / title / url 齐全）。
      expect(navImportSkippedSchema.safeParse(skipped).success).toBe(true);
    }
    expect(validateNavUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateNavUrl('http://plain.test/').ok).toBe(false);

    // 服务端**重新校验**客户端解析结果：批内重复 + 与现有 URL 重复都逐项跳过。
    const previewItems = [
      parsedExisting,
      parsedNew,
      parsedNew,
      { title: '再一条新条目', url: 'https://new.test/b', groupName: '我的收藏夹' },
    ];
    const preview = await SELF.fetch(
      URLS.meNavigationImportPreview,
      jsonPost({ items: previewItems }, { Authorization: auth.authorization }),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json<{
      items: readonly { url: string }[];
      skipped: readonly { reason: string; url: string | null; title: string | null }[];
      revision: number;
    }>();
    expect(previewBody.items.map((item) => item.url)).toEqual(['https://new.test/a', 'https://new.test/b']);
    expect(previewBody.skipped.map((skipped) => skipped.reason)).toEqual(['duplicate', 'duplicate']);
    // 「与现有 URL 重复」的那条带着标题与 URL，界面能指出具体是哪一条。
    expect(previewBody.skipped[0]?.url).toBe('https://exists.test/');
    expect(previewBody.skipped[0]?.title).toBe('已存在');
    expect(previewBody.revision).toBe(await readStateRevision(auth.workspaceId));

    // 落地：小组名复用 / 新建（同名只建一个分组），逐项结果与预览一致。
    const applyOperationId = opId('import-apply');
    const apply = await applyImportViaApi(auth, {
      items: previewItems,
      expectedRevision: previewBody.revision,
      operationId: applyOperationId,
    });
    expect(apply.status).toBe(200);
    expect(apply.body?.['importedCount']).toBe(2);
    expect((apply.body?.['skipped'] as readonly { reason: string }[]).map((skipped) => skipped.reason)).toEqual([
      'duplicate',
      'duplicate',
    ]);
    const activeRows = await readActiveLinkRows(auth.workspaceId);
    expect(activeRows.map((row) => row.url).sort((a, b) => a.localeCompare(b))).toEqual([
      'https://exists.test/',
      'https://new.test/a',
      'https://new.test/b',
    ]);
    expect(await readGroupNames(auth.workspaceId)).toEqual(['我的收藏夹']);
    expect(apply.body?.['revision']).toBe(previewBody.revision + 1);

    // 同一个 operationId 重放：不产生新行、修订号不变。
    const replay = await applyImportViaApi(auth, {
      items: previewItems,
      expectedRevision: previewBody.revision,
      operationId: applyOperationId,
    });
    expect(replay.status).toBe(200);
    expect(replay.body?.['replayed']).toBe(true);
    expect((await readActiveLinkRows(auth.workspaceId)).length).toBe(3);
  });

  it('危险协议与 http 的条目在 apply 请求体里直接被 422 拒绝（逐项说明在解析阶段）', async () => {
    const auth = await seedAuth();
    for (const dangerous of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'http://plain.test/']) {
      const response = await SELF.fetch(
        URLS.meNavigationImportApply,
        jsonPost(
          {
            operationId: opId('import-dangerous'),
            items: [{ title: '危险条目', url: dangerous }],
            expectedRevision: 0,
          },
          { Authorization: auth.authorization },
        ),
      );
      expect(response.status, `应拒绝：${dangerous}`).toBe(422);
      const body = errorBodyOf(await response.text());
      expect(body.code).toBe('validation_failed');
      // 结构化原因：Zod 的字段路径（不回显提交的值）。
      expect(body.message).toContain('url');
    }
    // 零写入。
    expect(await readAllLinkRows(auth.workspaceId)).toEqual([]);
    expect(await readStateRevision(auth.workspaceId)).toBe(0);
  });

  it('预览新鲜度过期 → 409 import_preview_stale 且零写入', async () => {
    const auth = await seedAuth();
    const preview = await SELF.fetch(
      URLS.meNavigationImportPreview,
      jsonPost(
        { items: [{ title: '待导入', url: 'https://fresh.test/' }] },
        { Authorization: auth.authorization },
      ),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json<{ revision: number }>();

    // 预览之后工作空间被别处改动：修订号前进，旧预览失效。
    const bumped = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('import-bump'), title: '别处的新链接', url: 'https://bump.test/' },
        { Authorization: auth.authorization },
      ),
    );
    expect(bumped.status).toBe(201);

    const stale = await applyImportViaApi(auth, {
      items: [{ title: '待导入', url: 'https://fresh.test/' }],
      expectedRevision: previewBody.revision,
      operationId: opId('import-stale'),
    });
    expect(stale.status).toBe(409);
    expect(errorBodyOf(stale.text).code).toBe('conflict');
    expect((await readAllLinkRows(auth.workspaceId)).map((row) => row.url)).toEqual(['https://bump.test/']);
  });

  it('targetGroupId 必须属于同一工作空间，否则 404 且零写入', async () => {
    const auth = await seedAuth();
    const other = await seedAuth();
    const group = await SELF.fetch(
      URLS.meNavigationGroups,
      jsonPost({ operationId: opId('import-group-other'), name: '别人的分组' }, { Authorization: other.authorization }),
    );
    expect(group.status).toBe(201);
    const otherGroup = await group.json<{ id: string }>();

    const response = await applyImportViaApi(auth, {
      items: [{ title: '越权分组', url: 'https://scope.test/' }],
      expectedRevision: 0,
      operationId: opId('import-foreign-group'),
      targetGroupId: otherGroup.id,
    });
    expect(response.status).toBe(404);
    expect(await readAllLinkRows(auth.workspaceId)).toEqual([]);
  });
});

describe('导出', () => {
  it('只含活跃行、不含任何凭证，且能被共享 parseNavExportDocument 读回（roundtrip）', async () => {
    const auth = await seedAuth();
    const groupResponse = await SELF.fetch(
      URLS.meNavigationGroups,
      jsonPost({ operationId: opId('export-group'), name: '导出分组' }, { Authorization: auth.authorization }),
    );
    expect(groupResponse.status).toBe(201);
    const group = await groupResponse.json<{ id: string }>();

    const keepResponse = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('export-keep'), title: '保留', url: 'https://export.test/keep', groupIds: [group.id] },
        { Authorization: auth.authorization },
      ),
    );
    expect(keepResponse.status).toBe(201);
    const keep = await keepResponse.json<{ link: { id: string } }>();

    const goneResponse = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('export-gone'), title: '将被删除', url: 'https://export.test/gone' },
        { Authorization: auth.authorization },
      ),
    );
    expect(goneResponse.status).toBe(201);
    const gone = await goneResponse.json<{ link: { id: string } }>();
    const deleted = await SELF.fetch(
      navLinkUrl(gone.link.id),
      jsonDelete({ operationId: opId('export-delete'), expectedRevision: 0 }, { Authorization: auth.authorization }),
    );
    expect(deleted.status).toBe(200);

    const response = await SELF.fetch(URLS.meNavigationExport, { headers: { Authorization: auth.authorization } });
    expect(response.status).toBe(200);
    const body = await response.json<{ document: unknown; exportedAt: number }>();
    const parsed = parseNavExportDocument(body.document);
    if (!parsed.ok) {
      throw new Error(`导出文档读回失败：${parsed.reason}`);
    }
    // 只含活跃行：被删除的链接既不以行、也不以墓碑出现在导出里。
    expect(parsed.document.links.map((link) => link.id)).toEqual([keep.link.id]);
    expect(parsed.document.groups.map((entry) => entry.id)).toEqual([group.id]);
    expect(parsed.document.memberships.length).toBe(1);
    expect(parsed.document.exportedAt).toBe(body.exportedAt);
    // 导出**不含**任何凭证或工作空间标识。
    const text = JSON.stringify(parsed.document);
    for (const forbidden of ['token', 'secret', 'recovery', 'workspaceId', 'workspace_id']) {
      expect(text.includes(forbidden), `导出文档不应包含 ${forbidden}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 复核发现的三个真实缺陷的回归用例
//
// 这三条都不是「实现细节」：它们分别是「界面状态不可达」「导入静默少写了一半」
// 与「没有变化却推进水位」，用户能直接看到后果，因此必须有测试盯着。
// ---------------------------------------------------------------------------

describe('复核回归：目录状态投影 / 分类成员关系 / 无变化不推进水位', () => {
  it('#3 快照带服务端目录状态投影：删除过的条目必须是 tombstoned（界面才可能显示「你删除过」）', async () => {
    const auth = await seedAuth();
    const entry = NAV_CATALOG_SEED[0];
    if (entry === undefined) {
      throw new Error('目录种子为空');
    }

    const imported = await importCatalogViaApi(auth, {
      catalogIds: [entry.id],
      operationId: opId('repro-plan-import'),
    });
    expect(imported.status).toBe(200);
    const linkId = imported.body?.importedLinkIds[0];
    expect(typeof linkId).toBe('string');

    // 删除它（墓碑）。快照的 `links` **不会**包含它——这正是缺陷的根源。
    const removed = await SELF.fetch(
      navLinkUrl(linkId as string),
      jsonDelete(
        { expectedRevision: 0, operationId: opId('repro-plan-delete') },
        { Authorization: auth.authorization },
      ),
    );
    expect(removed.status).toBe(200);

    const snapshotResponse = await SELF.fetch(URLS.meNavigation, {
      headers: { Authorization: auth.authorization },
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshot = JSON.parse(await snapshotResponse.text()) as {
      readonly links: readonly { readonly id: string }[];
      readonly catalogPlan?: readonly {
        readonly catalogId: string;
        readonly state: string;
        readonly linkId: string | null;
      }[];
    };

    // 活跃快照里确实没有它（墓碑不属于用户快照）。
    expect(snapshot.links.some((link) => link.id === linkId)).toBe(false);
    // 但状态投影必须如实说「它被删除了」，否则界面会把它显示成「尚未导入」并默认勾选。
    expect(snapshot.catalogPlan).toBeDefined();
    const planned = snapshot.catalogPlan?.find((item) => item.catalogId === entry.id);
    expect(planned?.state).toBe('tombstoned');
    expect(planned?.linkId).toBe(linkId);
  });

  it('#4 目录导入时新建的分类分组必须真的写入成员关系（不是空分组）', async () => {
    const auth = await seedAuth();
    const entry = NAV_CATALOG_SEED.find((candidate) => candidate.category === '数据工具');
    if (entry === undefined) {
      throw new Error('目录种子缺少「数据工具」分类');
    }

    const imported = await importCatalogViaApi(auth, {
      catalogIds: [entry.id],
      operationId: opId('repro-membership-import'),
    });
    expect(imported.status).toBe(200);
    const linkId = imported.body?.importedLinkIds[0];
    expect(typeof linkId).toBe('string');

    // 分类分组被建立……
    expect(await readGroupNames(auth.workspaceId)).toContain(entry.category);
    // ……并且该链接**真的**在分组里（成员关系存在且未墓碑）。
    const membership = await env.DB.prepare(
      `SELECT m.deleted_at, g.name AS group_name
         FROM workspace_nav_memberships m
         JOIN workspace_nav_groups g ON g.id = m.group_id
        WHERE m.workspace_id = ? AND m.link_id = ?`,
    )
      .bind(auth.workspaceId, linkId)
      .all<{ deleted_at: number | null; group_name: string }>();
    expect(membership.results).toHaveLength(1);
    expect(membership.results[0]?.deleted_at).toBeNull();
    expect(membership.results[0]?.group_name).toBe(entry.category);
  });

  it('#6 全部跳过的目录导入不推进工作空间水位、也不假装 revision 变了', async () => {
    const auth = await seedAuth();
    const entry = NAV_CATALOG_SEED[0];
    if (entry === undefined) {
      throw new Error('目录种子为空');
    }

    const first = await importCatalogViaApi(auth, {
      catalogIds: [entry.id],
      operationId: opId('repro-noop-first'),
    });
    expect(first.status).toBe(200);
    const revisionAfterImport = await readStateRevision(auth.workspaceId);

    // 再导入同一条（非显式）：状态是 unchanged → 决策为 skip，个人表不会有任何变化。
    const second = await importCatalogViaApi(auth, {
      catalogIds: [entry.id],
      operationId: opId('repro-noop-second'),
    });
    expect(second.status).toBe(200);
    expect(second.body?.decisions.map((decision) => decision.action)).toEqual(['skip']);
    expect(second.body?.importedCount).toBe(0);

    // 水位不动，响应里的 revision 也不假装 +1（否则其它设备会收到无意义信号）。
    expect(await readStateRevision(auth.workspaceId)).toBe(revisionAfterImport);
    expect(second.body?.revision).toBe(revisionAfterImport);
  });
});
