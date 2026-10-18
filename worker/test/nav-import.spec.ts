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
  parseNavExportDocument,
  navImportSkippedSchema,
  parseBookmarkHtml,
  validateNavUrl,
  type NavExportDocument,
  type NavSnapshot,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_CATALOG_SEED, NAV_CATALOG_SOURCE_VERSION, applyCatalogSeed } from '../modules/nav/catalog';
import {
  URLS,
  errorBodyOf,
  jsonDelete,
  jsonPatch,
  jsonPost,
  navGroupUrl,
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

// ---------------------------------------------------------------------------
// restore 导入（完整配置恢复）辅助
// ---------------------------------------------------------------------------

/** 通过真实 HTTP 导出（并顺带用共享 `parseNavExportDocument` 校验一次形状）。 */
async function exportViaApi(auth: AuthedWorkspace): Promise<NavExportDocument> {
  const response = await SELF.fetch(URLS.meNavigationExport, { headers: { Authorization: auth.authorization } });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const body = JSON.parse(text) as { document: unknown; exportedAt: number };
  const parsed = parseNavExportDocument(body.document);
  if (!parsed.ok) {
    throw new Error(`导出文档读回失败：${parsed.reason}`);
  }
  return parsed.document;
}

type RestoreStatus = number;
interface RestorePreviewBody {
  readonly mode: string;
  readonly links: number;
  readonly groups: number;
  readonly memberships: number;
  readonly conflicts: readonly { readonly reason: string; readonly detail: string }[];
  readonly expectedRevision: number;
}
interface RestoreApplyBody {
  readonly mode: string;
  readonly importedLinks: number;
  readonly importedGroups: number;
  readonly importedMemberships: number;
  readonly skipped: readonly { readonly reason: string; readonly detail: string }[];
  readonly idMaps: {
    readonly links: Readonly<Record<string, string>>;
    readonly groups: Readonly<Record<string, string>>;
  };
  readonly revision: number;
  readonly replayed?: boolean;
}

async function previewRestoreViaApi(
  auth: AuthedWorkspace,
  document: unknown,
): Promise<{ status: RestoreStatus; body: RestorePreviewBody | null; text: string }> {
  const response = await SELF.fetch(
    URLS.meNavigationImportPreview,
    jsonPost({ mode: 'restore', document }, { Authorization: auth.authorization }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: response.status === 200 ? (JSON.parse(text) as RestorePreviewBody) : null,
    text,
  };
}

async function applyRestoreViaApi(
  auth: AuthedWorkspace,
  document: unknown,
  input: { readonly operationId: string; readonly expectedRevision: number },
): Promise<{ status: RestoreStatus; body: RestoreApplyBody | null; text: string }> {
  const response = await SELF.fetch(
    URLS.meNavigationImportApply,
    jsonPost(
      {
        mode: 'restore',
        document,
        operationId: input.operationId,
        expectedRevision: input.expectedRevision,
      },
      { Authorization: auth.authorization },
    ),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: response.status === 200 ? (JSON.parse(text) as RestoreApplyBody) : null,
    text,
  };
}

/** 活跃链接行（只取断言需要的列）。 */
interface ActiveLinkSnapshot {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly tags_json: string;
  readonly aliases_json: string;
  readonly icon: string;
  readonly open_mode: string;
  readonly region: string;
  readonly status: string;
  readonly is_favorite: number;
  readonly sort_order: number;
  readonly health: string;
  readonly health_checked_at: number | null;
  readonly source_catalog_id: string | null;
  readonly imported_source_version: number | null;
  readonly deleted_at: number | null;
  readonly revision: number;
}

async function readActiveLinkSnapshots(workspaceId: string): Promise<ActiveLinkSnapshot[]> {
  const result = await env.DB.prepare(
    `SELECT id, url, title, description, tags_json, aliases_json, icon, open_mode, region, status,
            is_favorite, sort_order, health, health_checked_at, source_catalog_id,
            imported_source_version, deleted_at, revision
       FROM workspace_nav_links WHERE workspace_id = ? ORDER BY url ASC, id ASC`,
  )
    .bind(workspaceId)
    .all<ActiveLinkSnapshot>();
  return result.results;
}

interface ActiveGroupSnapshot {
  readonly id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly deleted_at: number | null;
}

async function readActiveGroupSnapshots(workspaceId: string): Promise<ActiveGroupSnapshot[]> {
  const result = await env.DB.prepare(
    `SELECT id, name, sort_order, deleted_at FROM workspace_nav_groups
      WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC`,
  )
    .bind(workspaceId)
    .all<ActiveGroupSnapshot>();
  return result.results;
}

interface MembershipSnapshot {
  readonly link_id: string;
  readonly group_id: string;
  readonly sort_order: number;
  readonly deleted_at: number | null;
}

async function readMembershipSnapshots(workspaceId: string): Promise<MembershipSnapshot[]> {
  const result = await env.DB.prepare(
    `SELECT link_id, group_id, sort_order, deleted_at FROM workspace_nav_memberships
      WHERE workspace_id = ? ORDER BY link_id ASC, group_id ASC`,
  )
    .bind(workspaceId)
    .all<MembershipSnapshot>();
  return result.results;
}

async function readDeviceTokenHash(deviceId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT token_hash FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<{ token_hash: string }>();
  return row?.token_hash ?? null;
}

/**
 * 快照自洽性（P1-3 的可证伪断言，与文档上下文无关）：
 * ① 每条成员关系的两端都必须出现在**同一份**快照里；
 * ② 快照的 revision 必须 ≥ 该快照里每一行的行级 revision 的最大值
 *    （写路径永远「行先变、revision 后加 1」，因此一行能带着 revision=N 被看到，
 *    工作空间修订号就绝不可能是 N-1）。
 */
function assertSnapshotSelfConsistent(snapshot: {
  readonly links: readonly { readonly id: string; readonly revision: number }[];
  readonly groups: readonly { readonly id: string; readonly revision: number }[];
  readonly memberships: readonly { readonly linkId: string; readonly groupId: string }[];
  readonly revision: number;
}): void {
  const linkIds = new Set(snapshot.links.map((link) => link.id));
  const groupIds = new Set(snapshot.groups.map((group) => group.id));
  for (const membership of snapshot.memberships) {
    expect(linkIds.has(membership.linkId), `悬空成员关系（链接不在快照里）：${membership.linkId}`).toBe(true);
    expect(groupIds.has(membership.groupId), `悬空成员关系（分组不在快照里）：${membership.groupId}`).toBe(true);
  }
  const maxRowRevision = [...snapshot.links, ...snapshot.groups].reduce(
    (max, row) => Math.max(max, row.revision),
    0,
  );
  expect(
    snapshot.revision,
    `快照 revision=${String(snapshot.revision)} 小于其中行级 revision 的最大值 ${String(maxRowRevision)}`,
  ).toBeGreaterThanOrEqual(maxRowRevision);
}

// ---------------------------------------------------------------------------
// 本地行读取器（helpers.ts 不允许改；这里只读本 spec 需要的行事实）
// ---------------------------------------------------------------------------

/**
 * 每个用例前的清理。
 *
 * 为什么在 `resetIdentityState()` **之前**显式删导航行（与 `sync-changes.spec.ts` 同一处理）：
 * 导航行是靠工作空间级联删除清理的，而迁移 0011 的 DELETE 触发器会在级联过程中往
 * `workspace_changes` 插一行（它的 `workspace_id` 外键指向 `workspaces`）——此时父行已经
 * 不在了，于是外键失败、整个清理 batch 回滚。先在工作空间还在时删掉导航行即可让触发器正常写入。
 */
async function clearNavigationState(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM workspace_nav_memberships'),
    env.DB.prepare('DELETE FROM workspace_nav_links'),
    env.DB.prepare('DELETE FROM workspace_nav_groups'),
    env.DB.prepare('DELETE FROM workspace_nav_state'),
    env.DB.prepare('DELETE FROM nav_operations'),
    env.DB.prepare('DELETE FROM nav_operation_intents'),
  ]);
}

beforeEach(async () => {
  await clearNavigationState();
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

// ---------------------------------------------------------------------------
// restore：完整配置恢复（复核修复的真实缺陷：完整配置的 round-trip）
//
// 背景：旧实现只从 `{links:[...]}` 里取链接数组，于是 `isFavorite` / `status` /
// `sortOrder` / `groups` / `memberships` **全部静默丢失**——多分组链接导回来只剩一个
// 分组，收藏与归档状态消失，自定义顺序被重置。这里证明的是**真实 HTTP** 上的完整恢复。
// ---------------------------------------------------------------------------

/** 导出文档闭包性：每条成员关系的两端都必须在**同一份**文档的活跃行里。 */
function assertExportClosed(document: NavExportDocument): void {
  const linkIds = new Set(document.links.map((link) => link.id));
  const groupIds = new Set(document.groups.map((group) => group.id));
  for (const membership of document.memberships) {
    expect(linkIds.has(membership.linkId), `悬空成员关系（链接）：${membership.linkId}`).toBe(true);
    expect(groupIds.has(membership.groupId), `悬空成员关系（分组）：${membership.groupId}`).toBe(true);
  }
}

/** 从 apply 响应的 idMaps 反查某个**新**分组 ID 对应的旧分组 ID。 */
function oldIdOfGroup(
  result: {
    readonly idMaps: { readonly groups: Readonly<Record<string, string>> };
  },
  newGroupId: string,
): string {
  const entry = Object.entries(result.idMaps.groups).find(([, mapped]) => mapped === newGroupId);
  if (entry === undefined) {
    throw new Error(`新分组 ID 不在 idMaps 里：${newGroupId}`);
  }
  return entry[0];
}

describe('restore：导出 → 空 scope 预览 → 确认导入 → 字段与关系全恢复', () => {
  it('A 导出到 B 恢复：字段逐个相等、多分组关系与空分组都在、且不触碰 A / B 的其它数据', async () => {
    const authA = await seedAuth();
    const authB = await seedAuth();

    // ── A 里造数据：甲组 / 乙组 / 空组（空组无任何成员）、X（收藏 + archived + 自定义顺序 + 全字段，属甲+乙）、Y（属甲）
    const groupNames = ['甲组', '乙组', '空组'];
    const groupIds: string[] = [];
    for (const [index, name] of groupNames.entries()) {
      const response = await SELF.fetch(
        URLS.meNavigationGroups,
        jsonPost(
          { operationId: opId(`restore-group-${String(index)}`), name, sortOrder: index * 10 },
          { Authorization: authA.authorization },
        ),
      );
      expect(response.status).toBe(201);
      groupIds.push((await response.json<{ id: string }>()).id);
    }
    const [g1, g2, g3] = groupIds;
    if (g1 === undefined || g2 === undefined || g3 === undefined) {
      throw new Error('分组创建失败');
    }

    const createdX = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        {
          operationId: opId('restore-link-x'),
          title: '收藏的归档链接',
          url: 'https://restore.test/x?a=1&b=2',
          description: '带描述 & 符号',
          tags: ['工具', '常用'],
          aliases: ['别名一', '别名二'],
          icon: '🌟',
          openMode: 'same_tab',
          region: 'global',
          status: 'archived',
          isFavorite: true,
          sortOrder: 17,
          groupIds: [g1, g2],
        },
        { Authorization: authA.authorization },
      ),
    );
    expect(createdX.status).toBe(201);
    const linkX = (await createdX.json<{ link: { id: string } }>()).link;

    const createdY = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        {
          operationId: opId('restore-link-y'),
          title: '乙链接',
          url: 'https://restore.test/y',
          description: '',
          tags: [],
          aliases: [],
          icon: '🔗',
          openMode: 'new_tab',
          region: 'cn',
          status: 'active',
          isFavorite: false,
          sortOrder: 3,
          groupIds: [g1],
        },
        { Authorization: authA.authorization },
      ),
    );
    expect(createdY.status).toBe(201);
    const linkY = (await createdY.json<{ link: { id: string } }>()).link;

    // A 的完整事实（用于事后证明「恢复不会触碰 A」）。
    const aBefore = {
      links: await readActiveLinkSnapshots(authA.workspaceId),
      groups: await readActiveGroupSnapshots(authA.workspaceId),
      memberships: await readMembershipSnapshots(authA.workspaceId),
      revision: await readStateRevision(authA.workspaceId),
    };
    expect(aBefore.memberships).toHaveLength(3);

    // ── 导出（真实 HTTP）
    const document = await exportViaApi(authA);
    expect([...document.links.map((link) => link.id)].sort()).toEqual([linkX.id, linkY.id].sort());
    expect(document.groups).toHaveLength(3);
    expect(document.memberships).toHaveLength(3);
    assertExportClosed(document);

    // ── B：restore 预览（空 scope）——不写入任何数据
    const bBefore = {
      links: await readActiveLinkSnapshots(authB.workspaceId),
      groups: await readActiveGroupSnapshots(authB.workspaceId),
      memberships: await readMembershipSnapshots(authB.workspaceId),
      revision: await readStateRevision(authB.workspaceId),
      tokenHash: await readDeviceTokenHash(authB.deviceId),
    };
    expect(bBefore.links).toEqual([]);
    expect(bBefore.revision).toBe(0);

    const preview = await previewRestoreViaApi(authB, document);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body?.mode).toBe('restore');
    expect(preview.body?.links).toBe(2);
    expect(preview.body?.groups).toBe(3);
    expect(preview.body?.memberships).toBe(3);
    expect(preview.body?.conflicts).toEqual([]);
    // 预览是修订号回显 + 零写入。
    expect(preview.body?.expectedRevision).toBe(0);
    expect(await readActiveLinkSnapshots(authB.workspaceId)).toEqual([]);
    expect(await readStateRevision(authB.workspaceId)).toBe(0);

    // ── B：确认导入
    const applied = await applyRestoreViaApi(authB, document, {
      operationId: opId('restore-apply'),
      expectedRevision: preview.body?.expectedRevision ?? 0,
    });
    expect(applied.status, applied.text).toBe(200);
    const result = applied.body;
    if (result === null) {
      throw new Error('restore apply 未返回 200');
    }
    expect(result.mode).toBe('restore');
    expect(result.importedLinks).toBe(2);
    expect(result.importedGroups).toBe(3);
    expect(result.importedMemberships).toBe(3);
    expect(result.skipped).toEqual([]);

    // ── 断言：字段逐个相等（id 是重映射后的**新** id）
    const bLinks = await readActiveLinkSnapshots(authB.workspaceId);
    expect(bLinks).toHaveLength(2);
    for (const [oldId, newId] of Object.entries(result.idMaps.links)) {
      expect(newId).not.toBe(oldId);
    }
    // 重映射是**双射**：新 id 两两不同，且与旧 id 无交集（不采用外部 ID）。
    const newLinkIds = Object.values(result.idMaps.links);
    expect(new Set(newLinkIds).size).toBe(newLinkIds.length);
    expect(newLinkIds.some((id) => id === linkX.id || id === linkY.id)).toBe(false);

    const restoredX = bLinks.find((row) => row.id === result.idMaps.links[linkX.id]);
    const exportedX = document.links.find((link) => link.id === linkX.id);
    if (restoredX === undefined || exportedX === undefined) {
      throw new Error('恢复后找不到链接 X');
    }
    expect(restoredX.title).toBe(exportedX.title);
    expect(restoredX.url).toBe(exportedX.url);
    expect(restoredX.description).toBe(exportedX.description);
    expect(JSON.parse(restoredX.tags_json)).toEqual(exportedX.tags);
    expect(JSON.parse(restoredX.aliases_json)).toEqual(exportedX.aliases);
    expect(restoredX.icon).toBe(exportedX.icon);
    expect(restoredX.open_mode).toBe('same_tab');
    expect(restoredX.region).toBe('global');
    expect(restoredX.status).toBe('archived');
    expect(restoredX.is_favorite).toBe(1);
    expect(restoredX.sort_order).toBe(17);
    expect(restoredX.source_catalog_id).toBe(exportedX.sourceCatalogId);
    expect(restoredX.imported_source_version).toBe(exportedX.importedSourceVersion);
    // health 是唯一不保留的：导入一律 unknown / null（阶段 04 没有任何探测结论）。
    expect(restoredX.health).toBe('unknown');
    expect(restoredX.health_checked_at).toBeNull();
    // 断言的另一面：导出里的健康字段本来就只能是 unknown，因此「不保留」不丢任何真实信息。
    expect(exportedX.health).toBe('unknown');
    expect(exportedX.healthCheckedAt).toBeNull();

    const restoredY = bLinks.find((row) => row.id === result.idMaps.links[linkY.id]);
    const exportedY = document.links.find((link) => link.id === linkY.id);
    if (restoredY === undefined || exportedY === undefined) {
      throw new Error('恢复后找不到链接 Y');
    }
    expect(restoredY.sort_order).toBe(exportedY.sortOrder);
    expect(restoredY.status).toBe('active');
    expect(restoredY.is_favorite).toBe(0);

    // ── 断言：分组（名字 / 顺序 / 空分组都在）与组内顺序
    const bGroups = await readActiveGroupSnapshots(authB.workspaceId);
    expect([...bGroups.map((group) => group.name)].sort()).toEqual([...groupNames].sort());
    for (const group of bGroups) {
      const oldGroup = document.groups.find((entry) => entry.id === oldIdOfGroup(result, group.id));
      if (oldGroup === undefined) {
        throw new Error('恢复后的分组找不到对应的旧分组');
      }
      expect(group.sort_order).toBe(oldGroup.sortOrder);
    }

    const bMemberships = (await readMembershipSnapshots(authB.workspaceId)).filter(
      (row) => row.deleted_at === null,
    );
    expect(bMemberships).toHaveLength(3);
    // 每条成员关系都指向 B 里的活跃行（不可能出现悬空 / 跨 workspace 引用）。
    const bLinkIdSet = new Set(bLinks.map((row) => row.id));
    const bGroupIdSet = new Set(bGroups.map((row) => row.id));
    for (const membership of bMemberships) {
      expect(bLinkIdSet.has(membership.link_id)).toBe(true);
      expect(bGroupIdSet.has(membership.group_id)).toBe(true);
    }
    // X 属于**两个**分组，且组内 sortOrder 与文档一致。
    const xMemberships = bMemberships.filter((row) => row.link_id === result.idMaps.links[linkX.id]);
    expect(xMemberships).toHaveLength(2);
    const docMembershipOrders = new Map(
      document.memberships.map((entry) => [`${entry.linkId}\u0000${entry.groupId}`, entry.sortOrder] as const),
    );
    for (const membership of xMemberships) {
      const expected = docMembershipOrders.get(`${linkX.id}\u0000${oldIdOfGroup(result, membership.group_id)}`);
      expect(membership.sort_order).toBe(expected);
    }
    const yMemberships = bMemberships.filter((row) => row.link_id === result.idMaps.links[linkY.id]);
    expect(yMemberships).toHaveLength(1);

    // 空分组 G3 也在（没有任何成员关系，但必须存在）。
    const g3New = result.idMaps.groups[g3];
    expect(bGroups.some((group) => group.id === g3New)).toBe(true);
    expect(bMemberships.some((row) => row.group_id === g3New)).toBe(false);

    // ── 断言：B 的 URL 集合与 A 一致
    expect([...bLinks.map((row) => row.url)].sort()).toEqual(['https://restore.test/x?a=1&b=2', 'https://restore.test/y']);

    // ── 断言：**不触碰** A 的数据
    expect(await readActiveLinkSnapshots(authA.workspaceId)).toEqual(aBefore.links);
    expect(await readActiveGroupSnapshots(authA.workspaceId)).toEqual(aBefore.groups);
    expect(await readMembershipSnapshots(authA.workspaceId)).toEqual(aBefore.memberships);
    expect(await readStateRevision(authA.workspaceId)).toBe(aBefore.revision);

    // ── 断言：**不触碰** B 的设备凭证与模块个人数据
    expect(await readDeviceTokenHash(authB.deviceId)).toBe(bBefore.tokenHash);
    const moduleRows = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workspace_modules WHERE workspace_id = ? AND module_id = ?',
    )
      .bind(authB.workspaceId, 'demo.basics')
      .first<{ count: number }>();
    expect(moduleRows?.count).toBe(0);
    // 设备凭证仍然可用（恢复之后仍能正常调用受保护端点）。
    const stillAuthed = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: authB.authorization } });
    expect(stillAuthed.status).toBe(200);

    // 恢复后的 B 快照自洽（同一个 batch 读出 → 不存在悬空成员关系）。
    const snapshot = await stillAuthed.json<NavSnapshot>();
    assertSnapshotSelfConsistent(snapshot);
    expect(snapshot.memberships).toHaveLength(3);
    expect(snapshot.revision).toBe(result.revision);
  });

  it('与目标工作空间已有 URL 重复时：跳过该链接及其成员关系，并逐条说明原因（不静默）', async () => {
    const authA = await seedAuth();
    const authB = await seedAuth();

    const groupResponse = await SELF.fetch(
      URLS.meNavigationGroups,
      jsonPost({ operationId: opId('dup-group'), name: '重复组' }, { Authorization: authA.authorization }),
    );
    const groupId = (await groupResponse.json<{ id: string }>()).id;

    const shared = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        {
          operationId: opId('dup-shared'),
          title: '同 URL 的链接',
          url: 'https://dup.test/same',
          groupIds: [groupId],
        },
        { Authorization: authA.authorization },
      ),
    );
    expect(shared.status).toBe(201);
    const distinct = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('dup-distinct'), title: '独有链接', url: 'https://dup.test/other' },
        { Authorization: authA.authorization },
      ),
    );
    expect(distinct.status).toBe(201);

    const document = await exportViaApi(authA);
    expect(document.memberships).toHaveLength(1);

    // B 里先放一条**同一 URL** 的链接（用户自己的副本，绝不能被覆盖）。
    const bOwn = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('dup-b-own'), title: 'B 自己的副本', url: 'https://dup.test/same' },
        { Authorization: authB.authorization },
      ),
    );
    expect(bOwn.status).toBe(201);
    const bOwnLink = (await bOwn.json<{ link: { id: string } }>()).link;
    const bBefore = await readActiveLinkSnapshots(authB.workspaceId);

    const preview = await previewRestoreViaApi(authB, document);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body?.links).toBe(1);
    expect(preview.body?.memberships).toBe(0);
    expect(preview.body?.conflicts).toHaveLength(1);
    expect(preview.body?.conflicts[0]?.reason).toBe('duplicate_url');
    expect(preview.body?.conflicts[0]?.detail).toContain('https://dup.test/same');

    const applied = await applyRestoreViaApi(authB, document, {
      operationId: opId('dup-apply'),
      expectedRevision: preview.body?.expectedRevision ?? 0,
    });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.body?.importedLinks).toBe(1);
    expect(applied.body?.importedMemberships).toBe(0);
    expect(applied.body?.skipped).toHaveLength(1);
    expect(applied.body?.skipped[0]?.reason).toBe('duplicate_url');

    // B 自己的行逐字节未变；只多了一条「独有链接」；跳过的那条没有留下任何成员关系。
    const after = await readActiveLinkSnapshots(authB.workspaceId);
    expect(after.filter((row) => row.url === 'https://dup.test/same')).toEqual(
      bBefore.filter((row) => row.url === 'https://dup.test/same'),
    );
    expect(after.find((row) => row.url === 'https://dup.test/same')?.id).toBe(bOwnLink.id);
    expect([...after.map((row) => row.url)].sort()).toEqual([
      'https://dup.test/other',
      'https://dup.test/same',
    ]);
    expect(
      (await readMembershipSnapshots(authB.workspaceId)).filter((row) => row.deleted_at === null),
    ).toEqual([]);
  });
});

describe('restore：引用完整性 / 未来版本 / 危险 URL 一律整份拒绝（零写入）', () => {
  it('悬空 membership 的文档：preview 与 apply 都 422 且零写入', async () => {
    const authA = await seedAuth();
    const authB = await seedAuth();

    const groupResponse = await SELF.fetch(
      URLS.meNavigationGroups,
      jsonPost({ operationId: opId('dangling-group'), name: '正常组' }, { Authorization: authA.authorization }),
    );
    const groupId = (await groupResponse.json<{ id: string }>()).id;
    const linkResponse = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('dangling-link'), title: '正常链接', url: 'https://dangling.test/ok', groupIds: [groupId] },
        { Authorization: authA.authorization },
      ),
    );
    expect(linkResponse.status).toBe(201);
    const linkId = (await linkResponse.json<{ link: { id: string } }>()).link.id;

    const valid = await exportViaApi(authA);
    expect(valid.memberships).toHaveLength(1);

    // 悬空成员关系（指向不存在的链接 / 不存在的分组）——手工构造，模拟被编辑过的配置文件。
    const danglingLink = {
      ...valid,
      memberships: [{ linkId: 'no-such-link', groupId, sortOrder: 0, deletedAt: null, updatedAt: 1 }],
    };
    const danglingGroup = {
      ...valid,
      memberships: [{ linkId, groupId: 'no-such-group', sortOrder: 0, deletedAt: null, updatedAt: 1 }],
    };

    for (const document of [danglingLink, danglingGroup]) {
      const preview = await previewRestoreViaApi(authB, document);
      expect(preview.status, preview.text).toBe(422);
      expect(errorBodyOf(preview.text).code).toBe('validation_failed');
      expect(errorBodyOf(preview.text).message).toContain('引用不完整');

      const applied = await applyRestoreViaApi(authB, document, {
        operationId: opId('dangling-apply'),
        expectedRevision: 0,
      });
      expect(applied.status, applied.text).toBe(422);
      expect(errorBodyOf(applied.text).code).toBe('validation_failed');
    }

    // 零写入（连分组都没建）。
    expect(await readActiveLinkSnapshots(authB.workspaceId)).toEqual([]);
    expect(await readActiveGroupSnapshots(authB.workspaceId)).toEqual([]);
    expect(await readMembershipSnapshots(authB.workspaceId)).toEqual([]);
    expect(await readStateRevision(authB.workspaceId)).toBe(0);
  });

  it('未来 schemaVersion=99 → 422（明确拒绝，不降级成 links）', async () => {
    const auth = await seedAuth();
    const document = {
      schemaVersion: 99,
      exportedAt: 1_760_000_000_000,
      catalogSourceVersion: 0,
      links: [],
      groups: [],
      memberships: [],
    };

    // 共享判定层先给出明确理由（未来版本绝不猜测、也不降级成 links 数组）。
    const parsedShared = parseNavExportDocument(document);
    expect(parsedShared.ok).toBe(false);
    if (parsedShared.ok) {
      throw new Error('未来版本必须被拒绝');
    }
    expect(parsedShared.reason).toContain('高于当前支持');

    const preview = await previewRestoreViaApi(auth, document);
    expect(preview.status, preview.text).toBe(422);
    expect(errorBodyOf(preview.text).code).toBe('validation_failed');
    expect(errorBodyOf(preview.text).message).toContain('schemaVersion');

    const applied = await applyRestoreViaApi(auth, document, {
      operationId: opId('future-apply'),
      expectedRevision: 0,
    });
    expect(applied.status, applied.text).toBe(422);
    expect(await readStateRevision(auth.workspaceId)).toBe(0);
  });

  it('文档里的危险 URL（javascript: / http:）被拒绝，且**不**降级为 links 导入', async () => {
    const authA = await seedAuth();
    const authB = await seedAuth();
    const created = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId: opId('danger-src'), title: '正常条目', url: 'https://danger.test/ok' },
        { Authorization: authA.authorization },
      ),
    );
    expect(created.status).toBe(201);

    const valid = await exportViaApi(authA);
    const base = valid.links[0];
    if (base === undefined) {
      throw new Error('导出文档缺少链接');
    }

    for (const dangerous of ['javascript:alert(1)', 'http://plain.test/', 'data:text/html,<b>x</b>']) {
      const document = { ...valid, links: [{ ...base, url: dangerous }] };
      const preview = await previewRestoreViaApi(authB, document);
      expect(preview.status, `应拒绝：${dangerous}`).toBe(422);
      expect(errorBodyOf(preview.text).message).toContain('url');
      const applied = await applyRestoreViaApi(authB, document, {
        operationId: opId('danger-apply'),
        expectedRevision: 0,
      });
      expect(applied.status, `应拒绝：${dangerous}`).toBe(422);
    }

    // 关键：**没有**任何一条危险 URL 以「普通链接导入」的形式落进 B。
    expect(await readActiveLinkSnapshots(authB.workspaceId)).toEqual([]);
    expect(await readStateRevision(authB.workspaceId)).toBe(0);
  });
});

describe('restore：幂等与并发（操作 ID 重放 / 过期 revision）', () => {
  it('同一 operationId 重放只导入一次；错误 expectedRevision → 409 且零写入', async () => {
    const authA = await seedAuth();
    const authB = await seedAuth();

    const groupResponse = await SELF.fetch(
      URLS.meNavigationGroups,
      jsonPost({ operationId: opId('idem-group'), name: '幂等组' }, { Authorization: authA.authorization }),
    );
    const groupId = (await groupResponse.json<{ id: string }>()).id;
    const linkResponse = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        {
          operationId: opId('idem-link'),
          title: '幂等链接',
          url: 'https://idem.test/a',
          isFavorite: true,
          sortOrder: 4,
          groupIds: [groupId],
        },
        { Authorization: authA.authorization },
      ),
    );
    expect(linkResponse.status).toBe(201);
    const document = await exportViaApi(authA);

    // ① 错误 expectedRevision：409 且零写入。
    const stale = await applyRestoreViaApi(authB, document, {
      operationId: opId('idem-stale'),
      expectedRevision: 7,
    });
    expect(stale.status, stale.text).toBe(409);
    expect(errorBodyOf(stale.text).code).toBe('conflict');
    expect(await readActiveLinkSnapshots(authB.workspaceId)).toEqual([]);
    expect(await readStateRevision(authB.workspaceId)).toBe(0);

    // ② 正常导入。
    const operationId = opId('idem-apply');
    const applyRestore = () => applyRestoreViaApi(authB, document, { operationId, expectedRevision: 0 });
    const first = await applyRestore();
    expect(first.status, first.text).toBe(200);
    expect(first.body?.replayed).toBe(false);
    const rowsAfterFirst = await readActiveLinkSnapshots(authB.workspaceId);
    const membershipsAfterFirst = await readMembershipSnapshots(authB.workspaceId);
    const revisionAfterFirst = await readStateRevision(authB.workspaceId);

    // ③ 同一 operationId 重放：不产生第二份数据、也不再推进修订号。
    const replay = await applyRestore();
    expect(replay.status, replay.text).toBe(200);
    expect(replay.body?.replayed).toBe(true);
    expect(replay.body?.importedLinks).toBe(first.body?.importedLinks);
    expect(replay.body?.idMaps).toEqual(first.body?.idMaps);
    expect(await readActiveLinkSnapshots(authB.workspaceId)).toEqual(rowsAfterFirst);
    expect(await readMembershipSnapshots(authB.workspaceId)).toEqual(membershipsAfterFirst);
    expect(await readStateRevision(authB.workspaceId)).toBe(revisionAfterFirst);

    // ④ 同一 operationId 换意图（换文档）：409 且零写入（幂等账本的指纹判定）。
    const mismatched = await applyRestoreViaApi(
      authB,
      { ...document, exportedAt: document.exportedAt + 1 },
      { operationId, expectedRevision: revisionAfterFirst },
    );
    expect(mismatched.status).toBe(409);
    expect(await readActiveLinkSnapshots(authB.workspaceId)).toEqual(rowsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// P1-3：一致快照（复核发现的真实缺陷）
// ---------------------------------------------------------------------------

describe('P1-3：快照 / 导出的一致性（不出现悬空成员关系）', () => {
  it('并发删除分组与链接期间：每次读到的 memberships 两端都在同一份快照里，revision 与行同批', async () => {
    const auth = await seedAuth();
    const groupIds: string[] = [];
    for (const name of ['组甲', '组乙']) {
      const response = await SELF.fetch(
        URLS.meNavigationGroups,
        jsonPost({ operationId: opId('snap-group'), name }, { Authorization: auth.authorization }),
      );
      expect(response.status).toBe(201);
      groupIds.push((await response.json<{ id: string }>()).id);
    }
    const [g1, g2] = groupIds;
    if (g1 === undefined || g2 === undefined) {
      throw new Error('分组创建失败');
    }
    const linkIds: string[] = [];
    for (const [index, url] of ['https://snap.test/a', 'https://snap.test/b'].entries()) {
      const response = await SELF.fetch(
        URLS.meNavigationLinks,
        jsonPost(
          {
            operationId: opId(`snap-link-${String(index)}`),
            title: `链接${String(index)}`,
            url,
            groupIds: [g1, g2],
          },
          { Authorization: auth.authorization },
        ),
      );
      expect(response.status).toBe(201);
      linkIds.push((await response.json<{ link: { id: string } }>()).link.id);
    }
    const [la, lb] = linkIds;
    if (la === undefined || lb === undefined) {
      throw new Error('链接创建失败');
    }

    // 初始：4 条活跃成员关系，快照与导出都自洽。
    const first = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } });
    const firstSnapshot = await first.json<NavSnapshot>();
    expect(firstSnapshot.memberships).toHaveLength(4);
    assertSnapshotSelfConsistent(firstSnapshot);
    // 快照的 revision 与库里的权威值相同（同一批读出 → 不可能落后）。
    expect(firstSnapshot.revision).toBe(await readStateRevision(auth.workspaceId));
    const firstExport = await exportViaApi(auth);
    expect(firstExport.memberships).toHaveLength(4);
    assertExportClosed(firstExport);

    // 同一 tick 内发出：删除分组乙 + 删除链接 B + 两次读取快照 + 两次导出。
    // 断言全是**不变量**：任何一次读取都不能出现「指向已删分组/链接」的悬空成员关系，
    // 且该次读到的 revision 必须与库里权威值一致（「旧行 + 新 revision」的组合被排除）。
    const responses = await Promise.all([
      SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } }),
      SELF.fetch(URLS.meNavigationExport, { headers: { Authorization: auth.authorization } }),
      SELF.fetch(
        navGroupUrl(g2),
        jsonDelete({ operationId: opId('snap-del-group'), expectedRevision: 0 }, { Authorization: auth.authorization }),
      ),
      SELF.fetch(
        navLinkUrl(lb),
        jsonDelete({ operationId: opId('snap-del-link'), expectedRevision: 0 }, { Authorization: auth.authorization }),
      ),
      SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } }),
      SELF.fetch(URLS.meNavigationExport, { headers: { Authorization: auth.authorization } }),
      SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } }),
    ]);

    let snapshotReads = 0;
    let exportReads = 0;
    const observedSnapshotRevisions: number[] = [];
    for (const response of responses) {
      const { pathname } = new URL(response.url);
      const text = await response.text();
      if (pathname.endsWith('/navigation/export')) {
        exportReads += 1;
        expect(response.status, text).toBe(200);
        const parsed = parseNavExportDocument((JSON.parse(text) as { document: unknown }).document);
        if (!parsed.ok) {
          throw new Error(`导出文档必须自洽（引用完整性）：${parsed.reason}`);
        }
        assertExportClosed(parsed.document);
        continue;
      }
      if (pathname.endsWith('/navigation')) {
        snapshotReads += 1;
        expect(response.status, text).toBe(200);
        const snapshot = JSON.parse(text) as NavSnapshot;
        assertSnapshotSelfConsistent(snapshot);
        // 该次读到的 revision 与行必须是同一批：行级 revision 更大即说明「行新、revision 旧」。
        // 它同时不可能超过最终可见的权威值（revision 只增不减）。
        observedSnapshotRevisions.push(snapshot.revision);
      }
    }
    // 确认真的读到了快照与导出（没有因为路由判断写错而空转）。
    expect(snapshotReads).toBeGreaterThanOrEqual(3);
    expect(exportReads).toBeGreaterThanOrEqual(2);

    // 终态：链接 B 与其 2 条成员关系一起消失，分组乙的 2 条也墓碑化，只剩 (A, 甲组)。
    const after = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } });
    const afterSnapshot = await after.json<NavSnapshot>();
    assertSnapshotSelfConsistent(afterSnapshot);
    expect(afterSnapshot.links.map((link) => link.id)).toEqual([la]);
    expect(afterSnapshot.groups.map((group) => group.id)).toEqual([g1]);
    expect(afterSnapshot.memberships).toHaveLength(1);
    expect(afterSnapshot.memberships[0]?.linkId).toBe(la);
    expect(afterSnapshot.memberships[0]?.groupId).toBe(g1);

    // 并发读取期间观察到的每一个 revision 都不超过终态权威值（任何顺序下都成立）。
    const finalRevision = await readStateRevision(auth.workspaceId);
    expect(observedSnapshotRevisions.length).toBeGreaterThanOrEqual(3);
    for (const revision of observedSnapshotRevisions) {
      expect(revision).toBeLessThanOrEqual(finalRevision);
    }
    // 写入全部完成后的一次读取必须报出终态水位（确定性：证明读数没有落后）。
    const settled = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } });
    const settledSnapshot = await settled.json<NavSnapshot>();
    assertSnapshotSelfConsistent(settledSnapshot);
    expect(settledSnapshot.revision).toBe(finalRevision);

    const lastExport = await exportViaApi(auth);
    assertExportClosed(lastExport);
    expect(lastExport.memberships).toHaveLength(1);
    // 导出里没有墓碑（行与关系都不含已删除的那些）。
    expect(lastExport.links.map((link) => link.id)).toEqual([la]);
    expect(lastExport.groups.map((group) => group.id)).toEqual([g1]);

    // 行级 revision 与工作空间 revision 的关系：后者 ≥ 前者。
    const rows = await readActiveLinkSnapshots(auth.workspaceId);
    const maxRowRevision = rows.reduce((max, row) => Math.max(max, row.revision), 0);
    expect(await readStateRevision(auth.workspaceId)).toBeGreaterThanOrEqual(maxRowRevision);
  });
});

// ---------------------------------------------------------------------------
// P1-3（目录导入一侧）：目录导入的规划读取必须与 revision 同批
// ---------------------------------------------------------------------------

describe('P1-3：目录导入的规划读取与 revision 同批（不覆盖个人修改、不按旧墓碑复活）', () => {
  it('导入前先在真实 HTTP 上改过 / 删过：目录升级后的决策尊重个人修改与墓碑', async () => {
    const auth = await seedAuth();
    const entryKeep = NAV_CATALOG_SEED.find((candidate) => candidate.category === '官方');
    const entryTool = NAV_CATALOG_SEED.find((candidate) => candidate.category === '数据工具');
    if (entryKeep === undefined || entryTool === undefined) {
      throw new Error('目录种子缺少预期分类');
    }

    const imported = await importCatalogViaApi(auth, {
      catalogIds: [entryKeep.id, entryTool.id],
      operationId: opId('plan-batch-import'),
    });
    expect(imported.status).toBe(200);
    const keepId = imported.body?.decisions[0]?.linkId ?? '';
    const toolId = imported.body?.decisions[1]?.linkId ?? '';

    // 真实 HTTP 上「改一条」（个人修改）与「删一条」（墓碑），随后**立即**做目录导入。
    const patched = await SELF.fetch(
      navLinkUrl(keepId),
      jsonPatch(
        { operationId: opId('plan-batch-patch'), expectedRevision: 0, title: '我改过的标题' },
        { Authorization: auth.authorization },
      ),
    );
    expect(patched.status).toBe(200);
    const deleted = await SELF.fetch(
      navLinkUrl(toolId),
      jsonDelete({ operationId: opId('plan-batch-delete'), expectedRevision: 0 }, { Authorization: auth.authorization }),
    );
    expect(deleted.status).toBe(200);
    const revisionAfterEdits = await readStateRevision(auth.workspaceId);

    // 目录升级（更高版本 + 新标题），再导入：非显式 → 两条都 skip。
    await upgradeCatalogEntry(entryKeep.id, '目录升级后的新标题');
    await upgradeCatalogEntry(entryTool.id, '目录升级后的新标题');
    const planImport = await importCatalogViaApi(auth, {
      catalogIds: [entryKeep.id, entryTool.id],
      operationId: opId('plan-batch-upgrade'),
    });
    expect(planImport.status).toBe(200);
    expect(planImport.body?.decisions.map((decision) => decision.action)).toEqual(['skip', 'skip']);
    expect(planImport.body?.decisions[0]?.reason).toContain('个人修改');
    expect(planImport.body?.decisions[1]?.reason).toContain('删除');
    // 全跳过 → 不推进水位、也不假装 revision 变了。
    expect(planImport.body?.revision).toBe(revisionAfterEdits);
    expect(await readStateRevision(auth.workspaceId)).toBe(revisionAfterEdits);

    // 个人修改保留；墓碑仍是删除；目录新内容一个字节都没落库。
    const rows = await readAllLinkRows(auth.workspaceId);
    expect(rows.find((row) => row.id === keepId)?.title).toBe('我改过的标题');
    expect(rows.find((row) => row.id === toolId)?.deleted_at).not.toBeNull();
    expect(rows.some((row) => row.title === '目录升级后的新标题')).toBe(false);
    expect(rows).toHaveLength(2);
  });
});

