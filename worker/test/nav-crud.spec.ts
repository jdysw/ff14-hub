/**
 * 个人导航 CRUD（HUB-048 / ADR-0004 D2 / D5）验收。
 *
 * 证据标准：每条写入都要同时断言（1）HTTP 结果与响应体、（2）**数据库里的行事实**
 * （墓碑是不是真的墓碑、修订号是不是真的推进了）、（3）失败路径**零改动**。
 */
import {
  navSnapshotSchema,
  type NavGroup,
  type NavLink,
  type NavLinkView,
  type NavSnapshot,
} from '@ff14-hub/shared';
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
// 本地读取器（helpers.ts 不允许改；这里只读本 spec 需要的行事实）
// ---------------------------------------------------------------------------

interface NavLinkDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly status: string;
  readonly is_favorite: number;
  readonly sort_order: number;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly updated_at: number;
}

const LINK_ROW_COLUMNS =
  'id, workspace_id, title, url, description, status, is_favorite, sort_order, revision, deleted_at, updated_at';

interface NavGroupDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly sort_order: number;
  readonly revision: number;
  readonly deleted_at: number | null;
  readonly updated_at: number;
}

interface NavMembershipDbRow {
  readonly link_id: string;
  readonly group_id: string;
  readonly workspace_id: string;
  readonly sort_order: number;
  readonly deleted_at: number | null;
  readonly updated_at: number;
}

async function readLinkRows(workspaceId: string): Promise<NavLinkDbRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${LINK_ROW_COLUMNS} FROM workspace_nav_links WHERE workspace_id = ? ORDER BY id ASC`,
  )
    .bind(workspaceId)
    .all<NavLinkDbRow>();
  return result.results;
}

async function readLinkRow(workspaceId: string, linkId: string): Promise<NavLinkDbRow | null> {
  return await env.DB.prepare(
    `SELECT ${LINK_ROW_COLUMNS} FROM workspace_nav_links WHERE id = ? AND workspace_id = ?`,
  )
    .bind(linkId, workspaceId)
    .first<NavLinkDbRow>();
}

async function readGroupRows(workspaceId: string): Promise<NavGroupDbRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, workspace_id, name, sort_order, revision, deleted_at, updated_at
       FROM workspace_nav_groups WHERE workspace_id = ? AND deleted_at IS NULL
      ORDER BY sort_order ASC, id ASC`,
  )
    .bind(workspaceId)
    .all<NavGroupDbRow>();
  return result.results;
}

async function readMembershipRows(workspaceId: string): Promise<NavMembershipDbRow[]> {
  const result = await env.DB.prepare(
    `SELECT link_id, group_id, workspace_id, sort_order, deleted_at, updated_at
       FROM workspace_nav_memberships WHERE workspace_id = ? ORDER BY link_id ASC, group_id ASC`,
  )
    .bind(workspaceId)
    .all<NavMembershipDbRow>();
  return result.results;
}

async function readMembershipRow(
  workspaceId: string,
  linkId: string,
  groupId: string,
): Promise<NavMembershipDbRow | null> {
  return await env.DB.prepare(
    `SELECT link_id, group_id, workspace_id, sort_order, deleted_at, updated_at
       FROM workspace_nav_memberships WHERE workspace_id = ? AND link_id = ? AND group_id = ?`,
  )
    .bind(workspaceId, linkId, groupId)
    .first<NavMembershipDbRow>();
}

async function readStateRevision(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT revision FROM workspace_nav_state WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

/** 链接行的逐字节快照（用于断言「失败路径零改动」）。 */
async function linkRowsSnapshot(workspaceId: string): Promise<string> {
  return JSON.stringify(await readLinkRows(workspaceId));
}

// ---------------------------------------------------------------------------
// API 便捷入口（只用于应当成功的路径）
// ---------------------------------------------------------------------------

async function readSnapshot(auth: AuthedWorkspace): Promise<NavSnapshot> {
  const response = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: auth.authorization } });
  expect(response.status).toBe(200);
  const snapshot = await response.json<unknown>();
  // 快照形状必须能过共享 Schema：这是响应契约的硬要求（不是「看起来像」）。
  const parsed = navSnapshotSchema.safeParse(snapshot);
  expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
  return snapshot as NavSnapshot;
}

async function listLinks(auth: AuthedWorkspace, query = ''): Promise<{ links: NavLinkView[]; revision: number }> {
  const response = await SELF.fetch(`${URLS.meNavigationLinks}${query}`, {
    headers: { Authorization: auth.authorization },
  });
  expect(response.status).toBe(200);
  return await response.json<{ links: NavLinkView[]; revision: number }>();
}

async function createLinkViaApi(
  auth: AuthedWorkspace,
  body: Record<string, unknown>,
): Promise<{ status: number; link: NavLink; replayed: boolean; text: string }> {
  const response = await SELF.fetch(
    URLS.meNavigationLinks,
    jsonPost({ ...body, operationId: body['operationId'] ?? opId('crud-create') }, { Authorization: auth.authorization }),
  );
  const text = await response.text();
  const parsed = JSON.parse(text) as { link?: NavLink; replayed?: boolean };
  return { status: response.status, link: parsed.link as NavLink, replayed: parsed.replayed === true, text };
}

async function createGroupViaApi(auth: AuthedWorkspace, name: string): Promise<NavGroup> {
  const response = await SELF.fetch(
    URLS.meNavigationGroups,
    jsonPost({ operationId: opId('crud-group'), name }, { Authorization: auth.authorization }),
  );
  expect(response.status).toBe(201);
  return await response.json<NavGroup>();
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('个人链接 CRUD', () => {
  it('创建后快照可见；改名 / 改 URL / 收藏 / 状态 / 排序持久化（重新 GET 一致）', async () => {
    const auth = await seedAuth();

    const created = await createLinkViaApi(auth, {
      title: '甲链接',
      url: 'https://a.test/path',
      tags: ['工具'],
      aliases: ['别名甲'],
      isFavorite: true,
      sortOrder: 5,
    });
    expect(created.status).toBe(201);
    expect(created.link.revision).toBe(0);
    expect(created.link.health).toBe('unknown');
    expect(created.link.icon.length).toBeGreaterThan(0);

    const snapshot = await readSnapshot(auth);
    expect(snapshot.links.map((link) => link.id)).toEqual([created.link.id]);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.limits).toEqual({ maxLinks: 500, maxGroups: 100, maxGroupsPerLink: 20 });

    const patched = await SELF.fetch(
      navLinkUrl(created.link.id),
      jsonPatch(
        {
          operationId: opId('crud-patch'),
          expectedRevision: 0,
          title: '乙链接',
          url: 'https://b.test/alt',
          description: '改动后的描述',
          icon: '🌟',
          openMode: 'same_tab',
          region: 'global',
          status: 'archived',
          isFavorite: false,
          sortOrder: 9,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json<{ link: NavLink }>();
    expect(patchedBody.link.title).toBe('乙链接');
    expect(patchedBody.link.url).toBe('https://b.test/alt');
    expect(patchedBody.link.openMode).toBe('same_tab');
    expect(patchedBody.link.region).toBe('global');
    expect(patchedBody.link.status).toBe('archived');
    expect(patchedBody.link.isFavorite).toBe(false);
    expect(patchedBody.link.sortOrder).toBe(9);
    expect(patchedBody.link.revision).toBe(1);

    // 重新读取：持久化的是同一份内容（不是只在响应里改了一下）。
    const after = await readSnapshot(auth);
    const stored = after.links.find((link) => link.id === created.link.id);
    expect(stored).toEqual(patchedBody.link);
    expect(after.revision).toBe(2);

    // 状态筛选：默认只看 active，显式 status=archived 才看得到它。
    expect((await listLinks(auth)).links.length).toBe(0);
    expect((await listLinks(auth, '?status=archived')).links.map((link) => link.id)).toEqual([created.link.id]);

    // 收藏与文本（别名参与匹配）筛选。
    const favorited = await SELF.fetch(
      navLinkUrl(created.link.id),
      jsonPatch(
        { operationId: opId('crud-favorite'), expectedRevision: 1, status: 'active', isFavorite: true },
        { Authorization: auth.authorization },
      ),
    );
    expect(favorited.status).toBe(200);
    expect((await listLinks(auth, '?favoritesOnly=true')).links.map((link) => link.id)).toEqual([created.link.id]);
    // `favoritesOnly=false` 不是「只看非收藏」，而是「不按收藏筛选」——契约里默认就不筛。
    expect((await listLinks(auth, '?favoritesOnly=false')).links.map((link) => link.id)).toEqual([created.link.id]);
    expect((await listLinks(auth, '?text=%E5%88%AB%E5%90%8D')).links.map((link) => link.id)).toEqual([
      created.link.id,
    ]);
    expect((await listLinks(auth, '?sort=title')).links.length).toBe(1);
  });

  it('陈旧 revision → 409 结构化冲突，且行与工作空间修订号零改动', async () => {
    const auth = await seedAuth();
    const created = await createLinkViaApi(auth, { title: '并发链接', url: 'https://a.test/concurrent' });
    const before = await linkRowsSnapshot(auth.workspaceId);
    const revisionBefore = await readStateRevision(auth.workspaceId);

    const conflict = await SELF.fetch(
      navLinkUrl(created.link.id),
      jsonPatch(
        { operationId: opId('crud-conflict'), expectedRevision: 99, title: '不该生效' },
        { Authorization: auth.authorization },
      ),
    );
    expect(conflict.status).toBe(409);
    const body = await conflict.json<{ code: string; details?: { conflict?: Record<string, unknown> } }>();
    expect(body.code).toBe('conflict');
    expect(body.details?.conflict).toMatchObject({
      reason: 'revision_conflict',
      entityType: 'nav_link',
      entityId: created.link.id,
      field: 'title',
      baseRevision: 99,
      currentRevision: 0,
    });
    expect(body.details?.conflict?.['resolutionOptions']).toEqual(['local', 'server']);

    expect(await linkRowsSnapshot(auth.workspaceId)).toBe(before);
    expect(await readStateRevision(auth.workspaceId)).toBe(revisionBefore);

    // 删除也遵守同一套乐观并发。
    const deleteConflict = await SELF.fetch(
      navLinkUrl(created.link.id),
      jsonDelete({ operationId: opId('crud-delete-conflict'), expectedRevision: 5 }, { Authorization: auth.authorization }),
    );
    expect(deleteConflict.status).toBe(409);
    expect(await linkRowsSnapshot(auth.workspaceId)).toBe(before);
  });

  it('删除 = 墓碑：行仍在且 deleted_at 非空，成员关系一并墓碑化', async () => {
    const auth = await seedAuth();
    const group = await createGroupViaApi(auth, '待删组');
    const created = await createLinkViaApi(auth, {
      title: '待删链接',
      url: 'https://a.test/delete-me',
      groupIds: [group.id],
    });
    expect(await readMembershipRow(auth.workspaceId, created.link.id, group.id)).toMatchObject({ deleted_at: null });

    const deleted = await SELF.fetch(
      navLinkUrl(created.link.id),
      jsonDelete({ operationId: opId('crud-delete'), expectedRevision: 0 }, { Authorization: auth.authorization }),
    );
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json<{ deletedId: string; revision: number }>();
    expect(deletedBody.deletedId).toBe(created.link.id);
    expect(deletedBody.revision).toBe(3);

    // 墓碑是行事实：行还在，`deleted_at` 非空，修订号推进。
    const row = await readLinkRow(auth.workspaceId, created.link.id);
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.revision).toBe(1);
    expect((await readMembershipRow(auth.workspaceId, created.link.id, group.id))?.deleted_at).not.toBeNull();

    // 快照里链接消失，但分组保留（删除链接不等于删除分组）。
    const snapshot = await readSnapshot(auth);
    expect(snapshot.links).toEqual([]);
    expect(snapshot.groups.map((entry) => entry.id)).toEqual([group.id]);
    expect(snapshot.memberships).toEqual([]);
    expect(snapshot.revision).toBe(3);
  });
});

describe('多分组与重排', () => {
  it('一个链接可进 2 个分组；PUT 整体替换（移除者墓碑化、加回者复活）；分组删除后链接仍在', async () => {
    const auth = await seedAuth();
    const g1 = await createGroupViaApi(auth, '组一');
    const g2 = await createGroupViaApi(auth, '组二');
    const g3 = await createGroupViaApi(auth, '组三');

    const created = await createLinkViaApi(auth, {
      title: '多分组链接',
      url: 'https://a.test/multi',
      groupIds: [g1.id, g2.id],
    });
    const views = await listLinks(auth);
    expect(views.links.length).toBe(1);
    expect([...(views.links[0]?.groupIds ?? [])].sort()).toEqual([g1.id, g2.id].sort());
    expect(new Set(views.links[0]?.groupNames ?? [])).toEqual(new Set(['组一', '组二']));

    // 整体替换为 [组二, 组三]：组一被墓碑化，组三是新归属。
    const replaced = await SELF.fetch(
      navLinkGroupsUrl(created.link.id),
      jsonPut(
        { operationId: opId('crud-set-groups'), groupIds: [g2.id, g3.id], expectedRevision: 0 },
        { Authorization: auth.authorization },
      ),
    );
    expect(replaced.status).toBe(200);
    expect((await readMembershipRow(auth.workspaceId, created.link.id, g1.id))?.deleted_at).not.toBeNull();
    expect((await readMembershipRow(auth.workspaceId, created.link.id, g2.id))?.deleted_at).toBeNull();
    expect((await readMembershipRow(auth.workspaceId, created.link.id, g3.id))?.deleted_at).toBeNull();
    // 归属变化推进链接自身的修订号（客户端据此发现自己手上的分组归属已过期）。
    expect((await readLinkRow(auth.workspaceId, created.link.id))?.revision).toBe(1);

    // 再把组二加回来（同一行的墓碑被复活，不产生重复行）。
    const replacedBack = await SELF.fetch(
      navLinkGroupsUrl(created.link.id),
      jsonPut(
        { operationId: opId('crud-set-groups-back'), groupIds: [g1.id, g2.id], expectedRevision: 1 },
        { Authorization: auth.authorization },
      ),
    );
    expect(replacedBack.status).toBe(200);
    expect((await readMembershipRow(auth.workspaceId, created.link.id, g1.id))?.deleted_at).toBeNull();
    expect((await readMembershipRow(auth.workspaceId, created.link.id, g3.id))?.deleted_at).not.toBeNull();
    const memberships = await readMembershipRows(auth.workspaceId);
    expect(memberships.length).toBe(3);

    // 删除组二：链接仍在，只有归属被墓碑化。
    const groupRowBefore = (await readGroupRows(auth.workspaceId)).find((row) => row.id === g2.id);
    const deletedGroup = await SELF.fetch(
      navGroupUrl(g2.id),
      jsonDelete(
        { operationId: opId('crud-delete-group'), expectedRevision: groupRowBefore?.revision ?? 0 },
        { Authorization: auth.authorization },
      ),
    );
    expect(deletedGroup.status).toBe(200);
    const linkRow = await readLinkRow(auth.workspaceId, created.link.id);
    expect(linkRow?.deleted_at).toBeNull();
    expect((await readMembershipRow(auth.workspaceId, created.link.id, g2.id))?.deleted_at).not.toBeNull();
    const afterDelete = await listLinks(auth);
    expect(afterDelete.links[0]?.groupIds).toEqual([g1.id]);

    // 已删除的分组不能再被加入（404，不泄露存在性）。
    const addDeleted = await SELF.fetch(
      navLinkGroupsUrl(created.link.id),
      jsonPut(
        {
          operationId: opId('crud-add-deleted-group'),
          groupIds: [g1.id, g2.id],
          expectedRevision: (await readLinkRow(auth.workspaceId, created.link.id))?.revision ?? 0,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(addDeleted.status).toBe(404);
  });

  it('重排整体替换：错误集合 → 409 且零改动；正确集合 → 顺序持久化；集合外的 ID 也拒绝', async () => {
    const auth = await seedAuth();
    const group = await createGroupViaApi(auth, '重排分组');
    const first = await createLinkViaApi(auth, { title: '第一', url: 'https://a.test/1', groupIds: [group.id] });
    const second = await createLinkViaApi(auth, { title: '第二', url: 'https://a.test/2', groupIds: [group.id] });
    const third = await createLinkViaApi(auth, { title: '第三', url: 'https://a.test/3', groupIds: [group.id] });

    const revisionBefore = await readStateRevision(auth.workspaceId);
    const rowsBefore = await linkRowsSnapshot(auth.workspaceId);

    // 只给一部分 ID：不是「当前活跃集合」，整批拒绝，零改动。
    const partial = await SELF.fetch(
      URLS.meNavigationLinksReorder,
      jsonPost(
        { operationId: opId('crud-reorder-partial'), orderedIds: [first.link.id], expectedRevision: revisionBefore },
        { Authorization: auth.authorization },
      ),
    );
    expect(partial.status).toBe(409);
    expect(errorBodyOf(await partial.text()).code).toBe('conflict');
    expect(await linkRowsSnapshot(auth.workspaceId)).toBe(rowsBefore);

    // 集合里有一个不属于本工作空间的 ID：同样整批拒绝。
    const foreign = await SELF.fetch(
      URLS.meNavigationLinksReorder,
      jsonPost(
        {
          operationId: opId('crud-reorder-foreign'),
          orderedIds: [first.link.id, second.link.id, '00000000-0000-4000-8000-000000000000'],
          expectedRevision: revisionBefore,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(foreign.status).toBe(409);
    expect(await linkRowsSnapshot(auth.workspaceId)).toBe(rowsBefore);

    // 正确集合（全部 3 条，顺序反转）：整体替换成功。
    const ordered = await SELF.fetch(
      URLS.meNavigationLinksReorder,
      jsonPost(
        {
          operationId: opId('crud-reorder-ok'),
          orderedIds: [third.link.id, second.link.id, first.link.id],
          expectedRevision: revisionBefore,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(ordered.status).toBe(200);
    expect((await ordered.json<{ revision: number }>()).revision).toBe(revisionBefore + 1);

    const sorted = await listLinks(auth, '?sort=manual');
    expect(sorted.links.map((link) => link.id)).toEqual([third.link.id, second.link.id, first.link.id]);
    // 组内顺序 = 链接手动顺序在该分组内的表现：按分组筛选后顺序同样被重排改变。
    const inGroup = await listLinks(auth, `?groupId=${group.id}&sort=manual`);
    expect(inGroup.links.map((link) => link.id)).toEqual([third.link.id, second.link.id, first.link.id]);
    const rows = await readLinkRows(auth.workspaceId);
    expect(rows.find((row) => row.id === third.link.id)?.sort_order).toBe(0);
    expect(rows.find((row) => row.id === second.link.id)?.sort_order).toBe(1);
    expect(rows.find((row) => row.id === first.link.id)?.sort_order).toBe(2);

    // 用已经过期的 revision 再排一次：409（集合级 CAS）。
    const stale = await SELF.fetch(
      URLS.meNavigationLinksReorder,
      jsonPost(
        {
          operationId: opId('crud-reorder-stale'),
          orderedIds: [first.link.id, second.link.id, third.link.id],
          expectedRevision: revisionBefore,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(stale.status).toBe(409);
    expect(await linkRowsSnapshot(auth.workspaceId)).toBe(JSON.stringify(rows));
  });
});

describe('分组 CRUD 与幂等', () => {
  it('分组改名 / 排序 / 重排 / 删除（墓碑）都遵守乐观并发', async () => {
    const auth = await seedAuth();
    const g1 = await createGroupViaApi(auth, '甲组');
    const g2 = await createGroupViaApi(auth, '乙组');

    const renamed = await SELF.fetch(
      navGroupUrl(g1.id),
      jsonPatch(
        { operationId: opId('crud-group-rename'), expectedRevision: 0, name: '甲组改名' },
        { Authorization: auth.authorization },
      ),
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json<NavGroup>()).name).toBe('甲组改名');

    const stale = await SELF.fetch(
      navGroupUrl(g1.id),
      jsonPatch(
        { operationId: opId('crud-group-stale'), expectedRevision: 0, name: '不该生效' },
        { Authorization: auth.authorization },
      ),
    );
    expect(stale.status).toBe(409);
    const staleBody = await stale.json<{ details?: { conflict?: Record<string, unknown> } }>();
    expect(staleBody.details?.conflict).toMatchObject({
      reason: 'revision_conflict',
      entityType: 'nav_group',
      entityId: g1.id,
      field: 'name',
      baseRevision: 0,
      currentRevision: 1,
    });

    const revisionBefore = await readStateRevision(auth.workspaceId);
    const wrongSet = await SELF.fetch(
      URLS.meNavigationGroupsReorder,
      jsonPost(
        { operationId: opId('crud-group-reorder-wrong'), orderedIds: [g1.id], expectedRevision: revisionBefore },
        { Authorization: auth.authorization },
      ),
    );
    expect(wrongSet.status).toBe(409);

    const reordered = await SELF.fetch(
      URLS.meNavigationGroupsReorder,
      jsonPost(
        { operationId: opId('crud-group-reorder'), orderedIds: [g2.id, g1.id], expectedRevision: revisionBefore },
        { Authorization: auth.authorization },
      ),
    );
    expect(reordered.status).toBe(200);
    const groupsAfter = await readGroupRows(auth.workspaceId);
    expect(groupsAfter.map((row) => row.id)).toEqual([g2.id, g1.id]);

    const deleteStale = await SELF.fetch(
      navGroupUrl(g2.id),
      jsonDelete({ operationId: opId('crud-group-delete-stale'), expectedRevision: 7 }, { Authorization: auth.authorization }),
    );
    expect(deleteStale.status).toBe(409);

    const group2Row = groupsAfter.find((row) => row.id === g2.id);
    const deleted = await SELF.fetch(
      navGroupUrl(g2.id),
      jsonDelete(
        { operationId: opId('crud-group-delete'), expectedRevision: group2Row?.revision ?? 0 },
        { Authorization: auth.authorization },
      ),
    );
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json<{ deletedId: string; revision: number }>();
    expect(deletedBody.deletedId).toBe(g2.id);
    expect((await readGroupRows(auth.workspaceId)).map((row) => row.id)).toEqual([g1.id]);
    // 墓碑行还在。
    const tombstone = await env.DB.prepare('SELECT deleted_at FROM workspace_nav_groups WHERE id = ? AND workspace_id = ?')
      .bind(g2.id, auth.workspaceId)
      .first<{ deleted_at: number | null }>();
    expect(tombstone?.deleted_at).not.toBeNull();
  });

  it('每次成功写入都推进工作空间修订号；同一 operationId 重放不产生第二行', async () => {
    const auth = await seedAuth();
    const operationId = opId('crud-idempotent');

    const first = await createLinkViaApi(auth, { title: '幂等链接', url: 'https://a.test/idem', operationId });
    expect(first.status).toBe(201);
    expect(first.replayed).toBe(false);
    expect(await readStateRevision(auth.workspaceId)).toBe(1);

    const replay = await createLinkViaApi(auth, { title: '幂等链接', url: 'https://a.test/idem', operationId });
    expect(replay.status).toBe(201);
    expect(replay.replayed).toBe(true);
    expect(replay.link.id).toBe(first.link.id);
    // 重放不产生第二行、也不再推进修订号。
    expect((await readLinkRows(auth.workspaceId)).length).toBe(1);
    expect(await readStateRevision(auth.workspaceId)).toBe(1);

    // 同一个 operationId 换意图：409 且零写入。
    const reused = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { operationId, title: '换了标题', url: 'https://a.test/other' },
        { Authorization: auth.authorization },
      ),
    );
    expect(reused.status).toBe(409);
    expect(errorBodyOf(await reused.text()).message).toContain('与首次不同');
    expect((await readLinkRows(auth.workspaceId)).length).toBe(1);
    expect(await readStateRevision(auth.workspaceId)).toBe(1);
    const operationRows = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM nav_operations WHERE workspace_id = ?',
    )
      .bind(auth.workspaceId)
      .first<{ count: number }>();
    expect(operationRows?.count).toBe(1);
  });
});
