/**
 * 幂等键绑定**请求意图**（HUB-054 复核修复，B5）。
 *
 * 复核发现的缺陷：幂等只按 `(workspace, operationId, kind)` 判定。于是
 *   - `page.update` 用同一个 ID 指向**另一页**会被当成重放返回旧结果；
 *   - `layout.save` 的 kind 只有断点（不含页面），换一页保存同样会被当成重放；
 *   - 同一个 `widget.add` 换一份 config 也会被当成重放。
 * 现在把「规范化请求指纹」（目标 ID / 动作 / 正文 / 预期 revision / 断点）与幂等记录一起存进
 * `workbench_operation_intents`，指纹不同 → 409 `operation_payload_mismatch` 且**零写入**。
 *
 * 证据标准：每一条被拒绝的调用都要同时断言（1）可解释错误码、（2）目标行逐字节未变、
 * （3）`workbench_operations` 与 `workbench_operation_intents` 都没有多出行。
 */
import { DEMO_BASICS_MODULE_ID, DEMO_WIDGET_IDS } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  URLS,
  addWidgetViaApi,
  createPageViaApi,
  enableDemoModule,
  jsonPatch,
  jsonPost,
  jsonPut,
  pageLayoutUrl,
  pageUrl,
  readLayoutRevisions,
  readLayoutRows,
  readPageRow,
  readWorkbenchOperationRow,
  resetIdentityState,
  opId,
  seedAuth,
} from './helpers';

const DEMO_COUNTER = DEMO_WIDGET_IDS.counter;

function errorBodyOf(text: string): { code: string; message: string } {
  return JSON.parse(text) as { code: string; message: string };
}

/** 幂等两张表的行数（`workbench_operations` 与 0007 的意图指纹表）。 */
async function operationTableCounts(workspaceId: string): Promise<{ operations: number; intents: number }> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM workbench_operations WHERE workspace_id = ?) AS operations,
            (SELECT COUNT(*) FROM workbench_operation_intents WHERE workspace_id = ?) AS intents`,
  )
    .bind(workspaceId, workspaceId)
    .first<{ operations: number; intents: number }>();
  return { operations: row?.operations ?? -1, intents: row?.intents ?? -1 };
}

/** 断言「刚发生的那一次成功写入恰好让两张幂等表各 +1」。 */
async function expectOneMoreOperation(
  workspaceId: string,
  baseline: { readonly operations: number; readonly intents: number },
): Promise<{ operations: number; intents: number }> {
  const after = await operationTableCounts(workspaceId);
  expect(after.operations).toBe(baseline.operations + 1);
  expect(after.intents).toBe(baseline.intents + 1);
  return after;
}

/** 读取意图指纹行（直接读库，用于断言「指纹确实与幂等记录一起落下」）。 */
async function readIntentRow(
  workspaceId: string,
  operationId: string,
): Promise<{ kind: string; request_fingerprint: string } | null> {
  return await env.DB.prepare(
    'SELECT kind, request_fingerprint FROM workbench_operation_intents WHERE workspace_id = ? AND operation_id = ?',
  )
    .bind(workspaceId, operationId)
    .first<{ kind: string; request_fingerprint: string }>();
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('B5 幂等必须绑定请求意图', () => {
  it('page.update 在页面 A 上用掉 X：同一 X 改页面 B ⇒ 409 operation_payload_mismatch，B 逐字节未变', async () => {
    const auth = await seedAuth();
    const pageA = await createPageViaApi(auth.authorization, { name: '页面甲', operationId: opId('page-a') });
    const pageB = await createPageViaApi(auth.authorization, { name: '页面乙', operationId: opId('page-b') });
    const sharedOperationId = opId('shared-page-update');

    const baseline = await operationTableCounts(auth.workspaceId);
    const renamedA = await SELF.fetch(
      pageUrl(pageA.page.id),
      jsonPatch({ expectedRevision: 0, name: '甲已改名', operationId: sharedOperationId }, { Authorization: auth.authorization }),
    );
    expect(renamedA.status).toBe(200);
    const countsAfterFirst = await expectOneMoreOperation(auth.workspaceId, baseline);
    const intent = await readIntentRow(auth.workspaceId, sharedOperationId);
    expect(intent?.kind).toBe('page.update');
    // SHA-256 十六进制摘要。
    expect(intent?.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const pageBBefore = JSON.stringify(await readPageRow(auth.workspaceId, pageB.page.id));

    const reusedOnB = await SELF.fetch(
      pageUrl(pageB.page.id),
      jsonPatch({ expectedRevision: 0, name: '乙被偷改', operationId: sharedOperationId }, { Authorization: auth.authorization }),
    );
    expect(reusedOnB.status).toBe(409);
    const body = errorBodyOf(await reusedOnB.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('与首次不同');

    // 零写入：B 未变；A 仍是第一次的结果；两张幂等表都没有多出行。
    expect(JSON.stringify(await readPageRow(auth.workspaceId, pageB.page.id))).toBe(pageBBefore);
    expect((await readPageRow(auth.workspaceId, pageA.page.id))?.name).toBe('甲已改名');
    expect(await operationTableCounts(auth.workspaceId)).toEqual(countsAfterFirst);
  });

  it('layout.save 在页面 A 的 desktop 上用掉 X：同一 X 保存页面 B 的 desktop ⇒ 409，B 的布局与修订号未变', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const pageA = await createPageViaApi(auth.authorization, { name: '布局甲', operationId: opId('layout-a') });
    const pageB = await createPageViaApi(auth.authorization, { name: '布局乙', operationId: opId('layout-b') });
    const widgetA = await addWidgetViaApi(auth.authorization, pageA.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('layout-widget-a'),
    });
    const widgetB = await addWidgetViaApi(auth.authorization, pageB.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: opId('layout-widget-b'),
    });
    const sharedOperationId = opId('shared-layout-save');

    const baseline = await operationTableCounts(auth.workspaceId);
    const savedA = await SELF.fetch(
      pageLayoutUrl(pageA.page.id),
      jsonPut(
        {
          breakpoint: 'desktop',
          baseRevision: 1,
          rects: [{ i: widgetA.instance.id, x: 0, y: 0, w: 4, h: 3 }],
          operationId: sharedOperationId,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(savedA.status).toBe(200);
    const countsAfterFirst = await expectOneMoreOperation(auth.workspaceId, baseline);
    expect((await readIntentRow(auth.workspaceId, sharedOperationId))?.kind).toBe('layout.save.desktop');

    const layoutsBefore = JSON.stringify(await readLayoutRows(pageB.page.id));
    const revisionsBefore = JSON.stringify([...(await readLayoutRevisions(pageB.page.id)).entries()]);

    const reusedOnB = await SELF.fetch(
      pageLayoutUrl(pageB.page.id),
      jsonPut(
        {
          breakpoint: 'desktop',
          baseRevision: 1,
          rects: [{ i: widgetB.instance.id, x: 4, y: 0, w: 4, h: 3 }],
          operationId: sharedOperationId,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(reusedOnB.status).toBe(409);
    const body = errorBodyOf(await reusedOnB.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('与首次不同');

    expect(JSON.stringify(await readLayoutRows(pageB.page.id))).toBe(layoutsBefore);
    expect(JSON.stringify([...(await readLayoutRevisions(pageB.page.id)).entries()])).toBe(revisionsBefore);
    expect(await operationTableCounts(auth.workspaceId)).toEqual(countsAfterFirst);
  });

  it('widget.add 用掉 X：同一 X 换一份 config ⇒ 409，实例数与布局一行都没变', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '实例页', operationId: opId('widget-page') });
    const sharedOperationId = opId('shared-widget-add');

    const baseline = await operationTableCounts(auth.workspaceId);
    const created = await addWidgetViaApi(auth.authorization, page.page.id, {
      widgetType: DEMO_COUNTER,
      operationId: sharedOperationId,
      config: { step: 1, label: '甲', initDelayMs: 0 },
    });
    const countsAfterFirst = await expectOneMoreOperation(auth.workspaceId, baseline);
    expect((await readIntentRow(auth.workspaceId, sharedOperationId))?.kind).toBe('widget.add');

    const instancesBefore = JSON.stringify(
      (
        await env.DB.prepare('SELECT id, config_json FROM widget_instances WHERE page_id = ?')
          .bind(page.page.id)
          .all<{ id: string; config_json: string }>()
      ).results,
    );
    const layoutsBefore = JSON.stringify(await readLayoutRows(page.page.id));

    const reused = await SELF.fetch(
      `${URLS.pages}/${page.page.id}/widgets`,
      jsonPost(
        {
          widgetType: DEMO_COUNTER,
          config: { step: 9, label: '乙', initDelayMs: 0 },
          operationId: sharedOperationId,
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(reused.status).toBe(409);
    const body = errorBodyOf(await reused.text());
    expect(body.code).toBe('conflict');
    expect(body.message).toContain('与首次不同');

    expect(
      JSON.stringify(
        (
          await env.DB.prepare('SELECT id, config_json FROM widget_instances WHERE page_id = ?')
            .bind(page.page.id)
            .all<{ id: string; config_json: string }>()
        ).results,
      ),
    ).toBe(instancesBefore);
    expect(JSON.stringify(await readLayoutRows(page.page.id))).toBe(layoutsBefore);
    expect(await operationTableCounts(auth.workspaceId)).toEqual(countsAfterFirst);
    expect(created.instance.id).toBeDefined();
  });

  it('完全相同的重试仍是重放：replayed=true、零写入、意图指纹与首次一致', async () => {
    const auth = await seedAuth();
    await enableDemoModule(auth.authorization, DEMO_BASICS_MODULE_ID);
    const page = await createPageViaApi(auth.authorization, { name: '重放页', operationId: opId('replay-page') });
    const operationId = opId('replay-widget');
    const addRequest = (): Promise<Response> =>
      SELF.fetch(
        `${URLS.pages}/${page.page.id}/widgets`,
        jsonPost(
          {
            widgetType: DEMO_COUNTER,
            config: { step: 3, label: '重放', initDelayMs: 0 },
            operationId,
          },
          { Authorization: auth.authorization },
        ),
      );

    const baseline = await operationTableCounts(auth.workspaceId);
    const firstResponse = await addRequest();
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json<{ instance: { id: string }; replayed: boolean }>();
    expect(first.replayed).toBe(false);

    const countsAfterFirst = await expectOneMoreOperation(auth.workspaceId, baseline);
    const fingerprint = (await readIntentRow(auth.workspaceId, operationId))?.request_fingerprint ?? '';
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const stateSnapshot = async (): Promise<string> =>
      JSON.stringify({
        instances: (
          await env.DB.prepare('SELECT id, config_json, revision FROM widget_instances WHERE page_id = ?')
            .bind(page.page.id)
            .all<{ id: string; config_json: string; revision: number }>()
        ).results,
        layouts: await readLayoutRows(page.page.id),
        revisions: [...(await readLayoutRevisions(page.page.id)).entries()],
        counters: await operationTableCounts(auth.workspaceId),
      });
    const snapshotBefore = await stateSnapshot();

    const replayResponse = await addRequest();
    expect(replayResponse.status).toBe(201);
    const replay = await replayResponse.json<{ instance: { id: string }; replayed: boolean }>();
    expect(replay.replayed).toBe(true);
    expect(replay.instance).toEqual(first.instance);
    expect((await readIntentRow(auth.workspaceId, operationId))?.request_fingerprint).toBe(fingerprint);
    expect(await stateSnapshot()).toBe(snapshotBefore);
    // 重放没有再多写一行（`countsAfterFirst` 里已经含首次那一行）。
    expect(await operationTableCounts(auth.workspaceId)).toEqual(countsAfterFirst);
    // 幂等记录仍已收尾（没有残留 attempt_token）。
    expect((await readWorkbenchOperationRow(auth.workspaceId, operationId))?.attempt_token).toBeNull();
  });
});
