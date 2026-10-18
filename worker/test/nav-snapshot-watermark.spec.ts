/**
 * 导航快照的**原子水位**（第四轮复核修正的竞态；ADR-0004 D7）。
 *
 * 缺陷（本文件第一条用例就是它的真实复现）：
 *   客户端先用 `GET /me/sync/changes`（无 `since`）拿到水位 W，再 `GET /me/navigation` 读快照 S。
 *   若这两个请求之间远端做了「`delete(W+1)` → 显式恢复 `(W+2)`」，S **已经**包含恢复后的链接与
 *   成员关系，但客户端的游标仍是 W，于是会把 W+1 那条**历史** `delete` 应用到刚恢复的数据上，
 *   把链接（及其成员关系）删掉。根因：**请求发起顺序不能证明数据库观察顺序**——W 与 S 来自两个
 *   不同的观察时刻。
 *
 * 修复后的协议（本文件逐条钉住）：
 *   ① 快照自带 `watermark`：`workspace_changes.MAX(seq)` 与 links / groups / memberships /
 *      `revision` 在**同一个 D1 batch**（= 单个事务）里读出；
 *   ② 客户端**只**用快照发布状态，并把游标设成该 `watermark`；
 *   ③ 因此「内容更新 ⇒ 水位更大」：删除(W+1)+恢复(W+2) 之后读到的快照，其 `watermark ≥ W+2`，
 *      W+1 那条历史 `delete` 落在游标**之后**，永不被应用；
 *      （W+1 / W+2 是**操作**的序号：一笔删除会同时墓碑化链接与它的成员关系，各占一条日志，
 *      因此真实的 seq 段可能比「两笔写 = 两个 seq」更长；判据始终是「历史事件 ≤ 快照水位」。）
 *   ④ 日志仍然是**历史事件**：`since=v2:<W>` + `limit=1` 照样能读到 W+1 的 `delete` 页
 *      （服务端如实返回被请求的序号段），只是客户端的游标已经越过它——这就是协议依据。
 *
 * 证据标准：真实 HTTP（`SELF.fetch`）+ 真实 D1（workerd + Miniflare）；快照一律过共享
 * `navSnapshotSchema`（严格），变更页一律过共享 `syncChangesResponseSchema`。
 */
import {
  encodeSyncCursor,
  navSnapshotSchema,
  syncChangesResponseSchema,
  type NavSnapshot,
  type SyncChange,
  type SyncChangesResponse,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_CATALOG_SEED, applyCatalogSeed } from '../modules/nav/catalog';
import {
  URLS,
  jsonDelete,
  jsonPatch,
  jsonPost,
  navGroupUrl,
  navLinkUrl,
  opId,
  resetIdentityState,
  seedAuth,
  syncChangesUrl,
} from './helpers';

const T0 = 1_760_000_000_000;

/**
 * 每个用例前的清理（与 `nav-import.spec.ts` 同一处理与同一理由）：
 * 导航行靠工作空间级联删除清理，而迁移 0011 的 DELETE 触发器会在级联过程中往
 * `workspace_changes` 插一行（外键指向**已经不在**的 `workspaces` 父行）→ 外键失败。
 * 先在工作空间还在时删掉导航行，触发器即可正常写入。
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
  await env.DB.prepare('DELETE FROM nav_catalog_links').run();
  await applyCatalogSeed({ db: env.DB, now: T0 });
});

// ---------------------------------------------------------------------------
// 读取辅助（全部走真实 HTTP）
// ---------------------------------------------------------------------------

/**
 * `GET /me/navigation`，并**强制**通过共享严格契约。
 *
 * `navSnapshotSchema` 现在把 `watermark` 定为**必填**：服务端一旦漏掉它，这里的 safeParse
 * 就会失败——因此这个辅助函数本身就是「快照自带水位」的契约证据。
 */
async function readSnapshotStrict(authorization: string): Promise<NavSnapshot> {
  const response = await SELF.fetch(URLS.meNavigation, { headers: { Authorization: authorization } });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const parsed = navSnapshotSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new Error(`快照不符合 navSnapshotSchema：${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** 无 `since` 的**重置协议**读取：不投递历史，`nextCursor` 恰好是本工作空间当前水位。 */
async function readReset(authorization: string): Promise<SyncChangesResponse> {
  const response = await SELF.fetch(syncChangesUrl(), { headers: { Authorization: authorization } });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const parsed = syncChangesResponseSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new Error(`响应不符合 syncChangesResponseSchema：${JSON.stringify(parsed.error.issues)}`);
  }
  expect(parsed.data.resetRequired).toBe(true);
  expect(parsed.data.changes).toEqual([]);
  expect(parsed.data.nextCursor).toBe(encodeSyncCursor(parsed.data.meta.watermark));
  return parsed.data;
}

/** 指定游标的增量读取（严格过契约）。 */
async function readChangesSince(
  authorization: string,
  since: string,
  limit?: number,
): Promise<SyncChangesResponse> {
  const response = await SELF.fetch(syncChangesUrl(since, limit), {
    headers: { Authorization: authorization },
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const parsed = syncChangesResponseSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new Error(`响应不符合 syncChangesResponseSchema：${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** 该实体在该序号段里的**全部**日志（同一实体可以有「先墓碑后恢复」多条）。 */
function changesOf(response: SyncChangesResponse, entityType: string, entityId: string): SyncChange[] {
  return response.changes.filter(
    (change) => change.entityType === entityType && change.entityId === entityId,
  );
}

// ---------------------------------------------------------------------------
// ① 竞态复现：删除 → 显式恢复（两笔写发生在「拿水位」与「读快照」之间）
// ---------------------------------------------------------------------------

describe('快照的原子水位（删除 → 显式恢复的竞态）', () => {
  it('快照自带的水位越过 W+1 的历史 delete，客户端因此绝不会应用它', async () => {
    const entry = NAV_CATALOG_SEED.find((item) => item.category === '官方');
    if (entry === undefined) {
      throw new Error('目录种子缺少「官方」分类条目');
    }
    const auth = await seedAuth();

    // 夹具：导入链接（**含分组归属**——目录导入按 category 建分组并建立成员关系，全部真实 HTTP）。
    const imported = await SELF.fetch(
      URLS.meNavigationCatalogImport,
      jsonPost({ catalogIds: [entry.id], operationId: opId('wm-import') }, { Authorization: auth.authorization }),
    );
    expect(imported.status, await imported.clone().text()).toBe(200);
    const importedBody = await imported.json<{ decisions: readonly { linkId: string | null }[] }>();
    const linkId = importedBody.decisions[0]?.linkId ?? '';
    expect(linkId.length).toBeGreaterThan(0);

    const baseline = await readSnapshotStrict(auth.authorization);
    expect(baseline.links.map((link) => link.id)).toContain(linkId);
    expect(
      baseline.memberships.filter((membership) => membership.linkId === linkId).length,
      '导入应当建立链接 × 分组（category）的成员关系',
    ).toBeGreaterThan(0);

    // ① 客户端的协议第一步：`GET /me/sync/changes`（无 since）→ 水位 W。
    const reset = await readReset(auth.authorization);
    const W = reset.meta.watermark;
    expect(W).toBeGreaterThan(0);

    // ② W **之后**的两笔真实写：删除（W+1）→ 显式恢复（W+2）。
    const linkRow = await env.DB.prepare(
      'SELECT revision FROM workspace_nav_links WHERE id = ? AND workspace_id = ?',
    )
      .bind(linkId, auth.workspaceId)
      .first<{ revision: number }>();
    const deleted = await SELF.fetch(
      navLinkUrl(linkId),
      jsonDelete(
        { operationId: opId('wm-delete'), expectedRevision: linkRow?.revision ?? 0 },
        { Authorization: auth.authorization },
      ),
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    const restored = await SELF.fetch(
      URLS.meNavigationCatalogImport,
      jsonPost(
        { catalogIds: [entry.id], operationId: opId('wm-reimport'), explicitReimport: true },
        { Authorization: auth.authorization },
      ),
    );
    expect(restored.status, await restored.clone().text()).toBe(200);
    const restoredBody = await restored.json<{ restoredLinkIds: readonly string[] }>();
    expect(restoredBody.restoredLinkIds).toContain(linkId);

    // ③ 权威快照：内容已是**恢复后**的活跃链接与成员关系，而水位必须越过那两笔写。
    const snapshot = await readSnapshotStrict(auth.authorization);
    const link = snapshot.links.find((item) => item.id === linkId);
    expect(link?.deletedAt).toBeNull();
    const memberships = snapshot.memberships.filter((membership) => membership.linkId === linkId);
    expect(memberships.length).toBeGreaterThan(0);
    expect(memberships.every((membership) => membership.deletedAt === null)).toBe(true);

    // 这一序号段里的全部日志（一笔操作可能落在多个 seq 上：删除链接会同时墓碑化它的成员关系，
    // 恢复同理。协议关心的不是「恰好两行」，而是「这些历史事件都 ≤ 快照自己的水位」）。
    const historyFromW = await readChangesSince(auth.authorization, encodeSyncCursor(W), 50);
    const linkChanges = changesOf(historyFromW, 'nav_link', linkId);
    const deletes = linkChanges.filter((change) => change.op === 'delete');
    const restores = linkChanges.filter((change) => change.op === 'upsert');
    expect(deletes, 'W 之后应当有一条 nav_link 的 delete').toHaveLength(1);
    expect(deletes[0]?.seq ?? 0).toBeGreaterThan(W);
    expect(deletes[0]?.payload).toBeNull();
    expect(
      historyFromW.changes.filter((change) => change.entityType === 'nav_membership' && change.op === 'delete')
        .length,
      '删除链接会一并墓碑化成员关系（各占一条历史日志）',
    ).toBeGreaterThan(0);
    expect(restores.length, '显式恢复应当在 W 之后留下 upsert').toBeGreaterThan(0);

    // 这才是「原子」的判据：水位 ≥ 快照里这一行最新一次变更的 seq（此处即恢复那一笔）。
    const latestChangeSeq = Math.max(
      ...restores.map((change) => change.seq),
      ...historyFromW.changes.map((change) => change.seq),
    );
    expect(snapshot.watermark, '水位必须 ≥ 快照里任何一行的最新变更 seq').toBeGreaterThanOrEqual(
      latestChangeSeq,
    );
    expect(snapshot.watermark).toBeGreaterThanOrEqual(W + 2);
    // 而且 revision 也来自那一批（删除 + 恢复各 bump 一次 ⇒ 比 reset 时更高）。
    expect(snapshot.revision).toBeGreaterThan(reset.meta.navRevision);

    // ④ 对照：日志是**历史事件**——`since=v2:W` + `limit=1` 的第一页就是删除那一笔
    //    （同一操作里最先落下的那条：链接或其成员关系的墓碑）。
    const firstPage = await readChangesSince(auth.authorization, encodeSyncCursor(W), 1);
    expect(firstPage.resetRequired).toBe(false);
    expect(firstPage.changes).toHaveLength(1);
    const firstChange = firstPage.changes[0];
    expect(firstChange?.seq).toBe(W + 1);
    expect(firstChange?.op).toBe('delete');
    expect(firstChange?.payload).toBeNull();
    expect(firstChange?.entityId.startsWith(linkId), `删除日志应当属于该链接：${firstChange?.entityId ?? ''}`).toBe(
      true,
    );

    // 协议依据：客户端把游标设为**快照自己的水位**（而非 ① 的 W），它已经越过 W+1。
    expect(snapshot.watermark).toBeGreaterThan(W + 1);
    const afterSnapshotCursor = await readChangesSince(
      auth.authorization,
      encodeSyncCursor(snapshot.watermark),
    );
    expect(
      afterSnapshotCursor.changes.filter((change) => change.seq <= W + 1),
      '游标越过 W+1 之后，那条历史 delete 不可能再被投递',
    ).toEqual([]);
    // 反向对照：若客户端用的是 ① 的水位 W（旧协议），这条 delete 就会被读到并应用。
    expect(historyFromW.changes.map((change) => change.op)).toContain('delete');
  });

  it('契约：watermark 是快照的必填字段（空工作空间是 0，不是缺失）', async () => {
    const auth = await seedAuth();
    const snapshot = await readSnapshotStrict(auth.authorization);
    // 没有任何变更时 `COALESCE(MAX(seq), 0)` 给出 0：客户端拿得到可用的游标。
    expect(snapshot.watermark).toBe(0);
    expect(snapshot.revision).toBe(0);

    // 缺字段 / 负数都不是合法快照：客户端不会把「没有水位」误当成水位 0。
    const withoutWatermark: Record<string, unknown> = { ...snapshot };
    delete withoutWatermark['watermark'];
    expect(navSnapshotSchema.safeParse(withoutWatermark).success).toBe(false);
    expect(navSnapshotSchema.safeParse({ ...snapshot, watermark: -1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② 普通写后 reload：水位与 revision 都严格前进（只增不减）
// ---------------------------------------------------------------------------

describe('普通写之后 reload 抬地板', () => {
  it('分组 / 改名 / 建链接 / 收藏之后，快照 watermark 与 revision 都严格前进', async () => {
    const auth = await seedAuth();
    const s0 = await readSnapshotStrict(auth.authorization);
    expect(s0.watermark).toBe(0);
    expect(s0.revision).toBe(0);

    // 写 1：新建分组。
    const created = await SELF.fetch(
      URLS.meNavigationGroups,
      jsonPost({ name: '地板分组', operationId: opId('wm-floor-group') }, { Authorization: auth.authorization }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const group = await created.json<{ id: string; revision: number }>();
    const s1 = await readSnapshotStrict(auth.authorization);
    expect(s1.watermark, '新建分组之后水位必须前进').toBeGreaterThan(s0.watermark);
    expect(s1.revision).toBeGreaterThan(s0.revision);
    expect(s1.groups.map((item) => item.id)).toContain(group.id);

    // 写 2：分组改名（带 expectedRevision 的 CAS）。
    const renamed = await SELF.fetch(
      navGroupUrl(group.id),
      jsonPatch(
        { name: '地板分组（改名）', expectedRevision: group.revision, operationId: opId('wm-floor-rename') },
        { Authorization: auth.authorization },
      ),
    );
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const s2 = await readSnapshotStrict(auth.authorization);
    expect(s2.watermark).toBeGreaterThan(s1.watermark);
    expect(s2.revision).toBeGreaterThan(s1.revision);

    // 写 3：新建链接。
    const linked = await SELF.fetch(
      URLS.meNavigationLinks,
      jsonPost(
        { title: '地板链接', url: 'https://floor.example.com/', operationId: opId('wm-floor-link') },
        { Authorization: auth.authorization },
      ),
    );
    expect(linked.status, await linked.clone().text()).toBe(201);
    const linkedBody = await linked.json<{ link: { id: string; revision: number } }>();
    const s3 = await readSnapshotStrict(auth.authorization);
    expect(s3.watermark).toBeGreaterThan(s2.watermark);
    expect(s3.revision).toBeGreaterThan(s2.revision);

    // 写 4：收藏（同一条链接的新一次写 ⇒ 水位再次前进）。
    const favorite = await SELF.fetch(
      navLinkUrl(linkedBody.link.id),
      jsonPatch(
        {
          isFavorite: true,
          expectedRevision: linkedBody.link.revision,
          operationId: opId('wm-floor-favorite'),
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(favorite.status, await favorite.clone().text()).toBe(200);
    const s4 = await readSnapshotStrict(auth.authorization);
    expect(s4.watermark).toBeGreaterThan(s3.watermark);
    expect(s4.revision).toBeGreaterThan(s3.revision);
    expect(s4.links.find((item) => item.id === linkedBody.link.id)?.isFavorite).toBe(true);
  });
});
