/**
 * 导航的作用域 / 鉴权 / 危险 URL 边界（HUB-048 / ADR-0004 D2 / D3）验收。
 *
 * 三层证据：
 * 1. **未认证一律 401**：整棵 `/me/navigation/*` 都在 `deviceAuth()` 之后（每个端点一条）。
 * 2. **作用域只来自认证结果**：两个工作空间的数据互不可见；拿 A 的凭证 PATCH / DELETE
 *    B 的 linkId / groupId 只会得到 404，且 B 的行**逐字节未变**。
 * 3. **关联 ID 也必须同 scope 校验**（外键不能替代）：把 A 的链接加入 B 的分组、
 *    或在新建/更新时引用 B 的分组，一律 404 且**零写入**——`workspace_nav_memberships`
 *    分别外键到 links 与 groups，但它证明不了三者 workspace 相同（迁移文件头也这么说）。
 * 4. **危险 URL 逐条 422**：`javascript:` / `data:` / `file:` / `blob:` / `vbscript:` /
 *    http / 内嵌凭证 / 无 host，全部拒绝并给出结构化字段路径，且不写入任何数据。
 */
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  URLS,
  errorBodyOf,
  jsonDelete,
  jsonPatch,
  jsonPost,
  jsonPut,
  navGroupUrl,
  navLinkGroupsUrl,
  navLinkUrl,
  opId,
  resetIdentityState,
  seedAuth,
  type AuthedWorkspace,
} from './helpers';

// ---------------------------------------------------------------------------
// 本地行读取器（测试直接看数据库事实）
// ---------------------------------------------------------------------------

/** 代表「另一个工作空间的链接 ID」的占位值（格式合法、本工作空间不存在）。 */
const FOREIGN_LINK_ID = '00000000-0000-4000-8000-0000000000ff';

interface NavLinkDbRow {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly updated_at: number;
}

const LINK_COLUMNS = 'id, title, url, revision, deleted_at, updated_at';

async function readLinkRows(workspaceId: string): Promise<NavLinkDbRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${LINK_COLUMNS} FROM workspace_nav_links WHERE workspace_id = ? ORDER BY id ASC`,
  )
    .bind(workspaceId)
    .all<NavLinkDbRow>();
  return result.results;
}

async function readGroupRows(workspaceId: string): Promise<readonly { readonly id: string; readonly deleted_at: number | null }[]> {
  const result = await env.DB.prepare(
    'SELECT id, deleted_at FROM workspace_nav_groups WHERE workspace_id = ? ORDER BY id ASC',
  )
    .bind(workspaceId)
    .all<{ id: string; deleted_at: number | null }>();
  return result.results;
}

async function membershipCount(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM workspace_nav_memberships WHERE workspace_id = ?',
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

async function readSnapshot(auth: AuthedWorkspace): Promise<{
  links: readonly { id: string }[];
  groups: readonly { id: string }[];
  memberships: readonly unknown[];
  revision: number;
}> {
  const response = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } });
  expect(response.status).toBe(200);
  return await response.json();
}

/** 建一条链接（应当成功的路径）。 */
async function createLink(
  auth: AuthedWorkspace,
  body: Record<string, unknown>,
): Promise<{ id: string; revision: number }> {
  const response = await SELF.fetch(
    URLS.meNavigationLinks,
    jsonPost({ title: '链接', url: 'https://a.test/', operationId: opId('scope-link'), ...body }, {
      Authorization: auth.authorization,
    }),
  );
  expect(response.status).toBe(201);
  const parsed = await response.json<{ link: { id: string; revision: number } }>();
  return parsed.link;
}

/** 建一个分组（应当成功的路径）。 */
async function createGroup(auth: AuthedWorkspace, name: string): Promise<{ id: string; revision: number }> {
  const response = await SELF.fetch(
    URLS.meNavigationGroups,
    jsonPost({ name, operationId: opId('scope-group') }, { Authorization: auth.authorization }),
  );
  expect(response.status).toBe(201);
  return await response.json<{ id: string; revision: number }>();
}

/** 每个导航端点的探针（未认证时必须 401）。 */
function scopeProbes(id: string): readonly { readonly label: string; readonly url: string; readonly init: RequestInit }[] {
  const operationId = 'op-probe-00000001';
  return [
    { label: 'GET /me/navigation', url: URLS.meNavigation, init: { method: 'GET' } },
    { label: 'GET /me/navigation/links', url: URLS.meNavigationLinks, init: { method: 'GET' } },
    { label: 'GET /me/navigation/groups', url: URLS.meNavigationGroups, init: { method: 'GET' } },
    { label: 'GET /me/navigation/export', url: URLS.meNavigationExport, init: { method: 'GET' } },
    {
      label: 'POST /me/navigation/links',
      url: URLS.meNavigationLinks,
      init: jsonPost({ operationId, title: '探针', url: 'https://probe.test/' }),
    },
    {
      label: 'POST /me/navigation/links/reorder',
      url: URLS.meNavigationLinksReorder,
      init: jsonPost({ operationId, orderedIds: [], expectedRevision: 0 }),
    },
    {
      label: 'PATCH /me/navigation/links/:id',
      url: navLinkUrl(id),
      init: jsonPatch({ operationId, expectedRevision: 0, title: '探针' }),
    },
    {
      label: 'DELETE /me/navigation/links/:id',
      url: navLinkUrl(id),
      init: jsonDelete({ operationId, expectedRevision: 0 }),
    },
    {
      label: 'PUT /me/navigation/links/:id/groups',
      url: navLinkGroupsUrl(id),
      init: jsonPut({ operationId, groupIds: [], expectedRevision: 0 }),
    },
    {
      label: 'POST /me/navigation/groups',
      url: URLS.meNavigationGroups,
      init: jsonPost({ operationId, name: '探针组' }),
    },
    {
      label: 'POST /me/navigation/groups/reorder',
      url: URLS.meNavigationGroupsReorder,
      init: jsonPost({ operationId, orderedIds: [], expectedRevision: 0 }),
    },
    {
      label: 'PATCH /me/navigation/groups/:id',
      url: navGroupUrl(id),
      init: jsonPatch({ operationId, expectedRevision: 0, name: '探针组' }),
    },
    {
      label: 'DELETE /me/navigation/groups/:id',
      url: navGroupUrl(id),
      init: jsonDelete({ operationId, expectedRevision: 0 }),
    },
    {
      label: 'POST /me/navigation/catalog/import',
      url: URLS.meNavigationCatalogImport,
      init: jsonPost({ operationId, catalogIds: ['catalog.official.cn'] }),
    },
    {
      label: 'POST /me/navigation/import/preview',
      url: URLS.meNavigationImportPreview,
      init: jsonPost({ items: [{ title: '探针', url: 'https://probe.test/' }] }),
    },
    {
      label: 'POST /me/navigation/import/apply',
      url: URLS.meNavigationImportApply,
      init: jsonPost({ operationId, items: [{ title: '探针', url: 'https://probe.test/' }], expectedRevision: 0 }),
    },
  ];
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('鉴权与作用域', () => {
  it('每个导航端点未认证都返回 401', async () => {
    const probes = scopeProbes('00000000-0000-4000-8000-000000000000');
    expect(probes.length).toBe(16);
    for (const probe of probes) {
      const response = await SELF.fetch(probe.url, probe.init);
      expect(response.status, `${probe.label} 应 401`).toBe(401);
      expect(errorBodyOf(await response.text()).code, `${probe.label} 应 unauthorized`).toBe('unauthorized');
    }
  });

  it('两个工作空间互不可见：快照、列表与导出都不含对方的数据', async () => {
    const a = await seedAuth();
    const b = await seedAuth();
    const groupA = await createGroup(a, 'A 的分组');
    const linkA = await createLink(a, { title: 'A 的链接', groupIds: [groupA.id] });

    const snapshotA = await readSnapshot(a);
    expect(snapshotA.links.map((link) => link.id)).toEqual([linkA.id]);
    expect(snapshotA.groups.map((group) => group.id)).toEqual([groupA.id]);
    expect(snapshotA.memberships.length).toBe(1);

    const snapshotB = await readSnapshot(b);
    expect(snapshotB.links).toEqual([]);
    expect(snapshotB.groups).toEqual([]);
    expect(snapshotB.memberships).toEqual([]);
    expect(snapshotB.revision).toBe(0);

    const linksB = await SELF.fetch(URLS.meNavigationLinks, { headers: { Authorization: b.authorization } });
    expect(linksB.status).toBe(200);
    expect((await linksB.json<{ links: readonly unknown[] }>()).links).toEqual([]);

    const exportB = await SELF.fetch(URLS.meNavigationExport, { headers: { Authorization: b.authorization } });
    expect(exportB.status).toBe(200);
    const exportBody = await exportB.json<{ document: { links: readonly unknown[]; groups: readonly unknown[] } }>();
    expect(exportBody.document.links).toEqual([]);
    expect(exportBody.document.groups).toEqual([]);
  });

  it('拿 A 的凭证 PATCH / DELETE B 的 linkId / groupId → 404，且 B 的行逐字节未变', async () => {
    const a = await seedAuth();
    const b = await seedAuth();
    const groupB = await createGroup(b, 'B 的分组');
    const linkB = await createLink(b, { title: 'B 的链接', groupIds: [groupB.id] });
    const linksBefore = JSON.stringify(await readLinkRows(b.workspaceId));
    const groupsBefore = JSON.stringify(await readGroupRows(b.workspaceId));
    const membershipsBefore = await membershipCount(b.workspaceId);

    const patchForeign = await SELF.fetch(
      navLinkUrl(linkB.id),
      jsonPatch({ operationId: opId('scope-patch-foreign'), expectedRevision: 0, title: '越权改名' }, {
        Authorization: a.authorization,
      }),
    );
    expect(patchForeign.status).toBe(404);

    const deleteForeign = await SELF.fetch(
      navLinkUrl(linkB.id),
      jsonDelete({ operationId: opId('scope-delete-foreign'), expectedRevision: 0 }, {
        Authorization: a.authorization,
      }),
    );
    expect(deleteForeign.status).toBe(404);

    const patchGroupForeign = await SELF.fetch(
      navGroupUrl(groupB.id),
      jsonPatch({ operationId: opId('scope-patch-group-foreign'), expectedRevision: 0, name: '越权改名' }, {
        Authorization: a.authorization,
      }),
    );
    expect(patchGroupForeign.status).toBe(404);

    const deleteGroupForeign = await SELF.fetch(
      navGroupUrl(groupB.id),
      jsonDelete({ operationId: opId('scope-delete-group-foreign'), expectedRevision: 0 }, {
        Authorization: a.authorization,
      }),
    );
    expect(deleteGroupForeign.status).toBe(404);

    const setGroupsForeign = await SELF.fetch(
      navLinkGroupsUrl(linkB.id),
      jsonPut({ operationId: opId('scope-set-groups-foreign'), groupIds: [], expectedRevision: 0 }, {
        Authorization: a.authorization,
      }),
    );
    expect(setGroupsForeign.status).toBe(404);

    // B 的行逐字节未变；A 自己什么也没多出来。
    expect(JSON.stringify(await readLinkRows(b.workspaceId))).toBe(linksBefore);
    expect(JSON.stringify(await readGroupRows(b.workspaceId))).toBe(groupsBefore);
    expect(await membershipCount(b.workspaceId)).toBe(membershipsBefore);
    expect(await readLinkRows(a.workspaceId)).toEqual([]);
    expect(await readGroupRows(a.workspaceId)).toEqual([]);
  });

  it('把 A 的链接加入 B 的分组 → 404 且零写入（关联 ID 也受 scope 约束）', async () => {
    const a = await seedAuth();
    const b = await seedAuth();
    const groupB = await createGroup(b, 'B 的分组');
    const linkA = await createLink(a, { title: 'A 的链接' });
    const linkBefore = JSON.stringify(await readLinkRows(a.workspaceId));

    // (1) 用 A 的凭证把 A 的链接挂到 B 的分组上。
    const attach = await SELF.fetch(
      navLinkGroupsUrl(linkA.id),
      jsonPut({ operationId: opId('scope-attach'), groupIds: [groupB.id], expectedRevision: 0 }, {
        Authorization: a.authorization,
      }),
    );
    expect(attach.status).toBe(404);
    expect(errorBodyOf(await attach.text()).code).toBe('not_found');

    // (2) 新建链接时引用 B 的分组。
    const createForeignGroup = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost({ operationId: opId('scope-create-foreign-group'), title: '越权链接', url: 'https://a.test/foreign', groupIds: [groupB.id] }, {
        Authorization: a.authorization,
      }),
    );
    expect(createForeignGroup.status).toBe(404);

    // (3) 更新时引用 B 的分组。
    const patchForeignGroup = await SELF.fetch(
      navLinkUrl(linkA.id),
      jsonPatch({ operationId: opId('scope-patch-foreign-group'), expectedRevision: 0, groupIds: [groupB.id] }, {
        Authorization: a.authorization,
      }),
    );
    expect(patchForeignGroup.status).toBe(404);

    // 零写入：A 的行逐字节未变、没有任何成员关系落库、A 的工作空间修订号仍是 1（只有建链接那次）。
    expect(JSON.stringify(await readLinkRows(a.workspaceId))).toBe(linkBefore);
    expect(await membershipCount(a.workspaceId)).toBe(0);
    expect(await membershipCount(b.workspaceId)).toBe(0);
    expect((await readSnapshot(a)).revision).toBe(1);

    // 重排里塞入别的链接 ID：集合不匹配 → 409，零改动。
    const reorderForeign = await SELF.fetch(
      URLS.meNavigationLinksReorder,
      jsonPost(
        { operationId: opId('scope-reorder-foreign'), orderedIds: [linkA.id, FOREIGN_LINK_ID], expectedRevision: 1 },
        { Authorization: a.authorization },
      ),
    );
    expect(reorderForeign.status).toBe(409);
    expect(JSON.stringify(await readLinkRows(a.workspaceId))).toBe(linkBefore);
  });

  it('危险 URL 逐条 422 拒绝并给出结构化字段路径，且零写入', async () => {
    const auth = await seedAuth();
    const dangerous = [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'blob:https://example.test/00000000',
      'vbscript:msgbox(1)',
      'http://plain.test/',
      'https://user:pass@example.test/',
      'https://',
    ];
    for (const url of dangerous) {
      const response = await SELF.fetch(
        URLS.meNavigationLinks,
        jsonPost({ operationId: opId('scope-dangerous'), title: '危险链接', url }, {
          Authorization: auth.authorization,
        }),
      );
      expect(response.status, `创建应拒绝：${url}`).toBe(422);
      const body = errorBodyOf(await response.text());
      expect(body.code).toBe('validation_failed');
      // 结构化原因：Zod 的字段路径（且**不回显**提交的地址）。
      expect(body.message).toContain('url');
      expect(body.message.includes(url)).toBe(false);
    }

    // 已存在的合法链接也不能被改成危险地址。
    const link = await createLink(auth, { title: '合法链接', url: 'https://safe.test/' });
    for (const url of dangerous) {
      const response = await SELF.fetch(
        navLinkUrl(link.id),
        jsonPatch({ operationId: opId('scope-dangerous-patch'), expectedRevision: 0, url }, {
          Authorization: auth.authorization,
        }),
      );
      expect(response.status, `更新应拒绝：${url}`).toBe(422);
    }

    // 零写入：只有那一条合法链接，且它没有被改动（失败的创建与更新都没有推进修订号）。
    const rows = await readLinkRows(auth.workspaceId);
    expect(rows.length).toBe(1);
    expect(rows[0]?.url).toBe('https://safe.test/');
    expect(rows[0]?.revision).toBe(0);
    expect((await readSnapshot(auth)).revision).toBe(1);
  });
});
