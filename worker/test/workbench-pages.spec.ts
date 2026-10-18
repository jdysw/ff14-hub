/**
 * 工作台**多页面**集成测试（HUB-046 验收）。
 *
 * 证据标准：
 * 1. 行为走真实 HTTP（SELF.fetch）+ 真实 D1（workerd + Miniflare）；
 * 2. 「默认页唯一」「删除即墓碑」「恢复带回内容」这类不变量一律**直接读表**断言，
 *    不信响应体自述；
 * 3. 陈旧写一律断言「一个字节都没变」（把整行序列化后逐字段比较）。
 *
 * 覆盖：默认页推导与迁移、事务不变量（含数据库级守卫）、改名/排序的 CAS、
 * 墓碑删除与整体恢复、最后一页的恢复提示、页面数量上限。
 */
import {
  DEMO_BASICS_MODULE_ID,
  DEMO_WIDGET_IDS,
  MAX_PAGES_PER_WORKSPACE,
  WORKBENCH_MESSAGES,
  type WorkspacePage,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  URLS,
  addWidgetViaApi,
  countRows,
  createPageViaApi,
  enableDemoModule,
  jsonDelete,
  jsonPatch,
  jsonPost,
  pageRestoreUrl,
  pageUrl,
  pageWidgetsUrl,
  readInstanceRows,
  readLayoutRows,
  readPageRow,
  readPageRows,
  readWorkbenchOperationRow,
  resetIdentityState,
  opId,
  seedAuth,
} from './helpers';

const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;


function errorBodyOf(text: string): { code: string; message: string } {
  return JSON.parse(text) as { code: string; message: string };
}

async function listPages(authorization: string): Promise<{
  readonly pages: readonly WorkspacePage[];
  readonly defaultPageId: string | null;
}> {
  const response = await SELF.fetch(URLS.pages, { headers: { Authorization: authorization } });
  expect(response.status).toBe(200);
  return await response.json<{ pages: WorkspacePage[]; defaultPageId: string | null }>();
}

function patchPage(authorization: string, pageId: string, body: unknown): Promise<Response> {
  return SELF.fetch(pageUrl(pageId), jsonPatch(body, { Authorization: authorization }));
}

function deletePage(authorization: string, pageId: string, body: unknown): Promise<Response> {
  return SELF.fetch(pageUrl(pageId), jsonDelete(body, { Authorization: authorization }));
}

function restorePage(authorization: string, pageId: string, body: unknown): Promise<Response> {
  return SELF.fetch(pageRestoreUrl(pageId), jsonPost(body, { Authorization: authorization }));
}

/**
 * 不变量：活跃页面非空时**恰好一个**默认页；活跃页面为 0 时默认页必须是 0 个。
 * 直接查库，不依赖任何接口的返回值。
 */
async function expectDefaultPageInvariant(workspaceId: string): Promise<void> {
  const rows = await readPageRows(workspaceId);
  const active = rows.filter((row) => row.deleted_at === null);
  const defaults = active.filter((row) => row.is_default === 1);
  if (active.length === 0) {
    expect(defaults).toHaveLength(0);
  } else {
    expect(defaults).toHaveLength(1);
  }
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('页面列表与默认页推导', () => {
  it('第一个页面成为默认页；后加的页面不会抢走默认页', async () => {
    const auth = await seedAuth();

    const first = await createPageViaApi(auth.authorization, { name: '首页', operationId: opId('page-1') });
    expect(first.page.isDefault).toBe(true);
    expect(first.page.sortOrder).toBe(0);
    expect(first.page.revision).toBe(0);
    expect(first.replayed).toBe(false);
    expect(first.defaultPageId).toBe(first.page.id);

    const second = await createPageViaApi(auth.authorization, { name: '第二页', operationId: opId('page-2') });
    expect(second.page.isDefault).toBe(false);
    expect(second.page.sortOrder).toBe(1);
    expect(second.page.slug).not.toBe(first.page.slug);
    // 新页面没有抢走默认页：响应必须报告**原有**默认页。
    expect(second.defaultPageId).toBe(first.page.id);

    const rows = await readPageRows(auth.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(first.page.id);
    expect(rows[0]?.is_default).toBe(1);
    expect(rows[1]?.id).toBe(second.page.id);
    expect(rows[1]?.is_default).toBe(0);

    const listed = await listPages(auth.authorization);
    expect(listed.pages.map((page) => page.id)).toEqual([first.page.id, second.page.id]);
    expect(listed.defaultPageId).toBe(first.page.id);
  });

  it('PATCH {isDefault:true} 迁移默认页，并且**清掉**旧的默认标记（断言数据库行）', async () => {
    const auth = await seedAuth();
    const first = await createPageViaApi(auth.authorization, { name: '首页', operationId: opId('page-1') });
    const second = await createPageViaApi(auth.authorization, { name: '第二页', operationId: opId('page-2') });
    const before = await readPageRow(auth.workspaceId, first.page.id);

    const response = await patchPage(auth.authorization, second.page.id, {
      isDefault: true,
      expectedRevision: second.page.revision,
      operationId: opId('page-default'),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ page: WorkspacePage; noop: boolean; replayed: boolean }>();
    expect(body.page.isDefault).toBe(true);
    expect(body.page.revision).toBe(second.page.revision + 1);
    expect(body.noop).toBe(false);

    const firstAfter = await readPageRow(auth.workspaceId, first.page.id);
    const secondAfter = await readPageRow(auth.workspaceId, second.page.id);
    expect(firstAfter?.is_default).toBe(0);
    expect(secondAfter?.is_default).toBe(1);
    // 旧默认页被显式清理（时间戳随之更新），且它的 revision 不变。
    expect(firstAfter?.revision).toBe(before?.revision);
    expect(firstAfter?.updated_at).toBeGreaterThanOrEqual(before?.updated_at ?? 0);
    await expectDefaultPageInvariant(auth.workspaceId);

    const listed = await listPages(auth.authorization);
    expect(listed.defaultPageId).toBe(second.page.id);
  });

  it('事务不变量：创建 / 删除 / 恢复之后，活跃页面非空时恰好一个默认页', async () => {
    const auth = await seedAuth();
    const a = await createPageViaApi(auth.authorization, { name: '甲', operationId: opId('page-a') });
    await expectDefaultPageInvariant(auth.workspaceId);

    const b = await createPageViaApi(auth.authorization, { name: '乙', operationId: opId('page-b') });
    await expectDefaultPageInvariant(auth.workspaceId);

    // 删掉当前默认页：默认页必须在同一事务里重推。
    const deleteDefault = await deletePage(auth.authorization, a.page.id, {
      expectedRevision: a.page.revision,
      operationId: opId('page-del-a'),
    });
    expect(deleteDefault.status).toBe(200);
    await expectDefaultPageInvariant(auth.workspaceId);
    expect((await readPageRow(auth.workspaceId, b.page.id))?.is_default).toBe(1);

    // 恢复被删页面：不会产生第二个默认页。
    const restore = await restorePage(auth.authorization, a.page.id, { operationId: opId('page-restore-a') });
    expect(restore.status).toBe(200);
    await expectDefaultPageInvariant(auth.workspaceId);

    // 全部删光：默认页数量必须是 0（而不是留着一个指向墓碑页的标记）。
    const deleteB = await deletePage(auth.authorization, b.page.id, {
      expectedRevision: b.page.revision,
      operationId: opId('page-del-b'),
    });
    expect(deleteB.status).toBe(200);
    const deleteA2 = await deletePage(auth.authorization, a.page.id, {
      // 恢复会把页面 revision +1：创建 0 → 删除 1 → 恢复 2。
      expectedRevision: 2,
      operationId: opId('page-del-a2'),
    });
    expect(deleteA2.status).toBe(200);
    await expectDefaultPageInvariant(auth.workspaceId);
    expect((await listPages(auth.authorization)).pages).toHaveLength(0);
  });

  it('数据库级守卫：不变量成立之后，原样把另一个页面改成默认页会被部分唯一索引拒绝', async () => {
    const auth = await seedAuth();
    const a = await createPageViaApi(auth.authorization, { name: '甲', operationId: opId('page-a') });
    const b = await createPageViaApi(auth.authorization, { name: '乙', operationId: opId('page-b') });
    await expectDefaultPageInvariant(auth.workspaceId);

    // 绕过服务层直接写：**必须**被 idx_workspace_pages_single_default 拦住。
    await expect(
      env.DB.prepare('UPDATE workspace_pages SET is_default = 1 WHERE id = ? AND workspace_id = ?')
        .bind(b.page.id, auth.workspaceId)
        .run(),
    ).rejects.toThrow(/unique/i);

    // 被拒绝后默认页仍然是甲，且只有它一个默认页。
    expect((await readPageRow(auth.workspaceId, a.page.id))?.is_default).toBe(1);
    expect((await readPageRow(auth.workspaceId, b.page.id))?.is_default).toBe(0);
    await expectDefaultPageInvariant(auth.workspaceId);
  });
});

describe('改名、排序与防静默覆盖', () => {
  it('改名 / 排序成功后落库；陈旧 expectedRevision 返回 409 且整行字节不变', async () => {
    const auth = await seedAuth();
    const created = await createPageViaApi(auth.authorization, { name: '原名', operationId: opId('page-1') });

    const response = await patchPage(auth.authorization, created.page.id, {
      name: '新名字',
      sortOrder: 7,
      expectedRevision: created.page.revision,
      operationId: opId('page-update'),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ page: WorkspacePage; noop: boolean }>();
    expect(body.page.name).toBe('新名字');
    expect(body.page.sortOrder).toBe(7);
    expect(body.page.revision).toBe(created.page.revision + 1);

    const afterUpdate = await readPageRow(auth.workspaceId, created.page.id);
    expect(afterUpdate?.name).toBe('新名字');
    expect(afterUpdate?.sort_order).toBe(7);
    expect(afterUpdate?.revision).toBe(created.page.revision + 1);

    const snapshot = JSON.stringify(afterUpdate);
    const stale = await patchPage(auth.authorization, created.page.id, {
      name: '陈旧写',
      expectedRevision: created.page.revision,
      operationId: opId('page-stale'),
    });
    expect(stale.status).toBe(409);
    expect(errorBodyOf(await stale.text()).code).toBe('conflict');
    expect(JSON.stringify(await readPageRow(auth.workspaceId, created.page.id))).toBe(snapshot);
  });

  it('陈旧 revision 的删除同样被拒绝，页面没有被墓碑化', async () => {
    const auth = await seedAuth();
    const created = await createPageViaApi(auth.authorization, { name: '页面', operationId: opId('page-1') });
    await patchPage(auth.authorization, created.page.id, {
      name: '改名一次',
      expectedRevision: 0,
      operationId: opId('page-update'),
    });
    const snapshot = JSON.stringify(await readPageRow(auth.workspaceId, created.page.id));

    const stale = await deletePage(auth.authorization, created.page.id, {
      expectedRevision: 0,
      operationId: opId('page-del'),
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await readPageRow(auth.workspaceId, created.page.id))).toBe(snapshot);
    expect((await readPageRow(auth.workspaceId, created.page.id))?.deleted_at).toBeNull();
  });

  it('删除的幂等重放：沿用首次的 operationId 与 expectedRevision 仍返回首次结果（404/409 都不该出现）', async () => {
    const auth = await seedAuth();
    const created = await createPageViaApi(auth.authorization, { name: '待删页面', operationId: opId('page-1') });
    const operationId = opId('page-del-replay');

    const first = await deletePage(auth.authorization, created.page.id, {
      expectedRevision: created.page.revision,
      operationId,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ deletedPageId: string; remainingPages: number; replayed: boolean }>();
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.deletedPageId).toBe(created.page.id);

    // 「响应丢失后客户端原样重试」：同一个 operationId、同一个 expectedRevision。
    // 首次成功后页面已经墓碑化、revision 也变了，若幂等短路发生在前置检查之后，
    // 这里就会得到 404 或 409，客户端永远拿不到首次结果。
    const replay = await deletePage(auth.authorization, created.page.id, {
      expectedRevision: created.page.revision,
      operationId,
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json<{ deletedPageId: string; remainingPages: number; replayed: boolean }>();
    expect(replayBody.replayed).toBe(true);
    expect(replayBody).toEqual({ ...firstBody, replayed: true });

    // 只墓碑了一次：页面行仍在（墓碑），幂等记录只有一条。
    const row = await readPageRow(auth.workspaceId, created.page.id);
    expect(row?.deleted_at).not.toBeNull();
    expect((await readWorkbenchOperationRow(auth.workspaceId, operationId))?.kind).toBe('page.delete');
  });

  it('对当前默认页 PATCH {isDefault:false} 被拒绝（422），并且一个字节都没变', async () => {
    const auth = await seedAuth();
    const created = await createPageViaApi(auth.authorization, { name: '默认页', operationId: opId('page-1') });
    const snapshot = JSON.stringify(await readPageRow(auth.workspaceId, created.page.id));

    const response = await patchPage(auth.authorization, created.page.id, {
      isDefault: false,
      expectedRevision: 0,
      operationId: opId('page-unset-default'),
    });
    expect(response.status).toBe(422);
    expect(errorBodyOf(await response.text()).code).toBe('validation_failed');
    expect(JSON.stringify(await readPageRow(auth.workspaceId, created.page.id))).toBe(snapshot);
    await expectDefaultPageInvariant(auth.workspaceId);
  });
});

describe('删除与恢复', () => {
  it('删除默认页：墓碑化、剩余数量正确、默认页在同一事务里重推', async () => {
    const auth = await seedAuth();
    const a = await createPageViaApi(auth.authorization, { name: '甲', operationId: opId('page-a') });
    const b = await createPageViaApi(auth.authorization, { name: '乙', operationId: opId('page-b') });

    const response = await deletePage(auth.authorization, a.page.id, {
      expectedRevision: a.page.revision,
      operationId: opId('page-del-a'),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      deletedPageId: string;
      defaultPageId: string | null;
      remainingPages: number;
      notice: string;
    }>();
    expect(body.deletedPageId).toBe(a.page.id);
    expect(body.remainingPages).toBe(1);
    expect(body.defaultPageId).toBe(b.page.id);
    expect(body.notice.length).toBeGreaterThan(0);

    const deleted = await readPageRow(auth.workspaceId, a.page.id);
    expect(deleted?.deleted_at).not.toBeNull();
    expect(deleted?.is_default).toBe(0);
    expect(deleted?.revision).toBe(a.page.revision + 1);
    expect((await readPageRow(auth.workspaceId, b.page.id))?.is_default).toBe(1);
  });

  it('删除**非**默认页时默认页不变，响应也必须报告真实默认页（而不是排序最靠前的页面）', async () => {
    const auth = await seedAuth();
    const first = await createPageViaApi(auth.authorization, { name: '甲', operationId: opId('page-a') });
    const second = await createPageViaApi(auth.authorization, { name: '乙', operationId: opId('page-b') });
    const third = await createPageViaApi(auth.authorization, { name: '丙', operationId: opId('page-c') });

    // 默认页迁移到「乙」（sortOrder = 1），于是它**不是**排序最靠前的活跃页面。
    const promote = await patchPage(auth.authorization, second.page.id, {
      isDefault: true,
      expectedRevision: second.page.revision,
      operationId: opId('page-default-b'),
    });
    expect(promote.status).toBe(200);

    const response = await deletePage(auth.authorization, third.page.id, {
      expectedRevision: third.page.revision,
      operationId: opId('page-del-c'),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ defaultPageId: string | null; remainingPages: number }>();
    expect(body.remainingPages).toBe(2);
    // 「丙」不是默认页，删它不会改变默认页 —— 真实默认页是「乙」。
    expect(body.defaultPageId).toBe(second.page.id);
    expect((await readPageRow(auth.workspaceId, second.page.id))?.is_default).toBe(1);
    expect((await readPageRow(auth.workspaceId, first.page.id))?.is_default).toBe(0);
    expect((await listPages(auth.authorization)).defaultPageId).toBe(second.page.id);
  });

  it('删除最后一个页面：defaultPageId 为 null、remainingPages 为 0，并给出 Shell 恢复提示', async () => {
    const auth = await seedAuth();
    const only = await createPageViaApi(auth.authorization, { name: '唯一页面', operationId: opId('page-1') });

    const response = await deletePage(auth.authorization, only.page.id, {
      expectedRevision: only.page.revision,
      operationId: opId('page-del'),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      defaultPageId: string | null;
      remainingPages: number;
      notice: string;
    }>();
    expect(body.defaultPageId).toBeNull();
    expect(body.remainingPages).toBe(0);
    expect(body.notice).toBe(WORKBENCH_MESSAGES.last_page_deleted);

    const listed = await listPages(auth.authorization);
    expect(listed.pages).toHaveLength(0);
    expect(listed.defaultPageId).toBeNull();
  });

  it('恢复页面会把它的 Widget 实例与布局一起带回来（内容随墓碑保留）', async () => {
    const auth = await seedAuth();
    const page = await createPageViaApi(auth.authorization, { name: '内容页', operationId: opId('page-1') });
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const added = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('widget-add'),
    });
    expect(await readInstanceRows(page.page.id)).toHaveLength(1);
    expect(await readLayoutRows(page.page.id)).toHaveLength(3);

    const response = await deletePage(auth.authorization, page.page.id, {
      expectedRevision: page.page.revision,
      operationId: opId('page-del'),
    });
    expect(response.status).toBe(200);

    // 删除只是墓碑：实例与布局**原样保留**，因此恢复能整体带回。
    const instancesAfterDelete = await readInstanceRows(page.page.id);
    expect(instancesAfterDelete).toHaveLength(1);
    expect(instancesAfterDelete[0]?.id).toBe(added.instance.id);
    expect(instancesAfterDelete[0]?.deleted_at).toBeNull();
    expect(await readLayoutRows(page.page.id)).toHaveLength(3);

    const restore = await restorePage(auth.authorization, page.page.id, {
      operationId: opId('page-restore'),
    });
    expect(restore.status).toBe(200);
    const restored = await restore.json<{ page: WorkspacePage; defaultPageId: string | null }>();
    expect(restored.page.id).toBe(page.page.id);
    // 创建 0 → 删除使 revision 变 1 → 恢复再 +1 变 2（墓碑不重置修订号）。
    expect(restored.page.revision).toBe(2);
    expect(restored.defaultPageId).toBe(page.page.id);

    const row = await readPageRow(auth.workspaceId, page.page.id);
    expect(row?.deleted_at).toBeNull();
    expect(row?.is_default).toBe(1);
    // 实例与布局都还在，并且重新可见（列表接口能读到）。
    const instances = await readInstanceRows(page.page.id);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.revision).toBe(0);
    const listed = await SELF.fetch(pageWidgetsUrl(page.page.id), {
      headers: { Authorization: auth.authorization },
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json<{ instances: { id: string }[] }>();
    expect(listedBody.instances.map((instance) => instance.id)).toEqual([added.instance.id]);
    expect(await readLayoutRows(page.page.id)).toHaveLength(3);
  });
});

describe('页面数量上限', () => {
  it(`创建 ${String(MAX_PAGES_PER_WORKSPACE)} 个页面成功，第 ${String(MAX_PAGES_PER_WORKSPACE + 1)} 个返回 409 page_limit_reached`, async () => {
    const auth = await seedAuth();
    for (let index = 0; index < MAX_PAGES_PER_WORKSPACE; index += 1) {
      const created = await createPageViaApi(auth.authorization, {
        name: `上限页 ${String(index + 1)}`,
        operationId: opId('page-fill'),
      });
      expect(created.page.sortOrder).toBe(index);
    }
    expect(await countRows('workspace_pages')).toBe(MAX_PAGES_PER_WORKSPACE);

    const overflowId = opId('page-overflow');
    const response = await SELF.fetch(
      URLS.pages,
      jsonPost({ name: '超限页', operationId: overflowId }, { Authorization: auth.authorization }),
    );
    expect(response.status).toBe(409);
    const body = errorBodyOf(await response.text());
    expect(body.code).toBe('conflict');
    // 拒绝原因（page_limit_reached）只写服务端日志；对外只给可读文案。
    expect(body.message).toContain('页面数量已达上限');
    expect(body.message).toContain(String(MAX_PAGES_PER_WORKSPACE));

    // 被拒绝的请求没有留下任何痕迹：没有第 31 个页面，也没有幂等操作行。
    expect(await countRows('workspace_pages')).toBe(MAX_PAGES_PER_WORKSPACE);
    expect(await readWorkbenchOperationRow(auth.workspaceId, overflowId)).toBeNull();
    await expectDefaultPageInvariant(auth.workspaceId);
  });
});
