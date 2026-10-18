/**
 * 跨设备变更应用的测试（阶段 04 / HUB-051 客户端侧）。**不发任何真实网络请求**。
 *
 * 这些用例刻意把「同一毫秒」当成默认前提（`syncUpsert` / `syncDelete` 的 `updatedAt`
 * 默认全部相同），因此每一条通过都只能由 `seq` 解释——时间比较在这些用例里不可能正确。
 *
 * 覆盖的硬事实（对应集中复核发现的 P1）：
 * 0. **初始化协议（安全快照 + 稳定水位）**：本地没有游标时先发一次不带 `since` 的请求，
 *    收到 `resetRequired: true` 后**不应用任何 changes**，读一次权威快照并整份替换，
 *    **快照落地之后**才采用返回的水位——因此历史变更（`seq <= 水位`）永远不会被重放，
 *    「导入 → 删除 → 显式恢复」里的那条历史 `delete` 不会删掉已恢复的链接与成员关系；
 * 1. **seq 是唯一排序依据**：同一毫秒「删除 → 恢复」按 seq 落地；更旧的 upsert 不复活删除；
 * 2. **权威全局修订**：重排 / 导入提交的 `expectedRevision` 只来自服务端 `meta.navRevision`
 *    （行修订再大也不参与推导），且**只在排空页**（`hasMore === false`）之后才写入本地；
 * 3. **排空**：一次轮询发现 `hasMore` 立即续取下一页直到排空；排空期间界面提示「正在同步」
 *    且**禁止**重排 / 导入这类全局 CAS 写（绝不静默用旧或新的修订提交）；
 * 4. **真并发 409**：草稿保留、提示带新旧 revision、不自动重试；
 * 5. **游标被拒（422）**：丢弃本地游标 + 可见提示 + 下一轮重新初始化；原因未知则不丢。
 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSyncCursor, type SyncChangesResponse } from '@ff14-hub/shared';
import { NavView } from '../src/app/nav/NavView';
import { useNav } from '../src/app/nav/use-nav';
import type { NavApi } from '../src/app/nav/nav-api';
import {
  deferredSyncResponse,
  emptySyncResponse,
  failureResult,
  fakeNavApi,
  fakeSyncApi,
  group,
  link,
  membership,
  navConflictResult,
  resetResponse,
  snapshot,
  syncDelete,
  syncResponse,
  syncUpsert,
} from './nav-fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 取第 N 行链接（不存在就抛错：让测试的失败信息比 "undefined" 有用）。 */
function linkRowAt(index: number): HTMLElement {
  const node = screen.getAllByTestId('nav-link-item')[index];
  if (node === undefined) {
    throw new Error(`第 ${String(index + 1)} 行链接不存在`);
  }
  return node;
}

/**
 * 测试夹具组件。
 *
 * 除被测的 `NavView` 之外，这里额外渲染一个**只读探针**：它把控制器**公开**的
 * 「当前全局修订」与「是否正在排空」暴露成属性，便于断言「`hasMore` 期间绝不采用
 * `meta.navRevision`」——那是本次修复的关键不变式，而界面本身不显示这两个值。
 */
function Harness(props: {
  readonly api: NavApi;
  readonly syncApi: Parameters<typeof useNav>[0]['syncApi'];
  readonly syncLimit?: number | undefined;
}) {
  const state = useNav({
    getToken: () => 'sync-test-token',
    enabled: true,
    api: props.api,
    syncApi: props.syncApi,
    syncIntervalMs: 0,
    ...(props.syncLimit === undefined ? {} : { syncLimit: props.syncLimit }),
  });
  return (
    <>
      <span
        data-testid="nav-probe"
        data-revision={String(state.snapshot?.revision ?? -1)}
        data-syncing={state.syncing ? 'true' : 'false'}
      />
      <NavView state={state} />
    </>
  );
}

/** 探针读到的本地全局修订（`-1` = 还没有快照）。 */
function probeRevision(): number {
  return Number(screen.getByTestId('nav-probe').getAttribute('data-revision'));
}

function probeSyncing(): boolean {
  return screen.getByTestId('nav-probe').getAttribute('data-syncing') === 'true';
}

function baseSnapshot() {
  return snapshot({
    revision: 2,
    links: [link('L1', { title: '以太之光', sortOrder: 0 }), link('L2', { title: '国际服资料站', sortOrder: 1 })],
  });
}

/** 「已恢复」的权威快照：链接活跃、并且带着它的分组关系（复核反例的最终状态）。 */
function restoredSnapshot() {
  return snapshot({
    revision: 7,
    links: [link('L1', { title: '恢复后的链接', revision: 3, sortOrder: 0 })],
    groups: [group('G1', { name: '常用' })],
    memberships: [membership('L1', 'G1')],
  });
}

describe('初始化协议：先快照、再水位、绝不回放历史', () => {
  it('本地已有「已恢复」的快照：首轮不带 since → 先读权威快照再采用水位，历史 delete 不得删掉它', async () => {
    const sync = fakeSyncApi([
      // ① 初始化信封：历史里有 upsert(5) → delete(6) → restore(7)，当前水位是 7。
      resetResponse({ watermark: 7, navRevision: 7 }),
      // ③ 采用水位后的第一页：服务端（错误地）又把 seq=6 那条**历史** delete 投了出来。
      //    它的 seq <= 水位，因此属于「已包含在权威快照里」的历史事件，绝不能应用。
      syncResponse({
        navRevision: 7,
        changes: [syncDelete({ entityId: 'L1', seq: 6, revision: 6 })],
        nextCursor: encodeSyncCursor(7),
        watermark: 7,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: restoredSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    await screen.findByText('恢复后的链接');
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
    });

    // ② 首轮请求确实**不带** since（不是先猜一个 v2:0 就把历史灌进来）。
    expect(sync.queries[0]?.since).toBeNull();
    // ④ 采用的水位来自初始化信封（v2:7），而不是 v2:0 / 最后一次变更的 seq。
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(7));

    /**
     * 顺序：① 不带 since 的 changes 请求 → ② 权威快照读取 → ③ 带水位的增量请求。
     * 交换任意两步都会造成「快照与水位之间」的变更丢失或历史回放，因此这里用真实的
     * 调用顺序断言，而不是靠计数近似。
     */
    const changesOrder = sync.readChanges.mock.invocationCallOrder;
    const snapshotOrder = fake.calls.readSnapshot.mock.invocationCallOrder;
    expect(snapshotOrder[1] ?? 0).toBeGreaterThan(changesOrder[0] ?? 0);
    expect(changesOrder[1] ?? 0).toBeGreaterThan(snapshotOrder[1] ?? 0);

    // 历史 delete 被丢弃：链接还在，**成员关系也还在**（这正是复核反例里丢掉的东西）。
    expect(screen.getByText('恢复后的链接')).toBeDefined();
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(1);
    expect(screen.getAllByTestId('nav-link-groups')[0]?.textContent).toContain('常用');
    // 丢弃历史是**可见**的事实，不是静默处理。
    expect(screen.getByTestId('nav-notice').textContent).toContain('已忽略');
    expect(probeRevision()).toBe(7);
  });

  it('resetRequired 那一页即便带着 changes 也一律不应用（初始化只认快照 + 水位）', async () => {
    const sync = fakeSyncApi([
      syncResponse({
        navRevision: 7,
        /**
         * 契约要求 `resetRequired: true` 时 `changes` 为空；这里**故意**塞一条历史 delete，
         * 用来证明客户端不会「顺手应用」初始化页里的变更——那正是历史回放的入口。
         */
        changes: [syncDelete({ entityId: 'L1', seq: 6, revision: 6 })],
        nextCursor: encodeSyncCursor(7),
        resetRequired: true,
        watermark: 7,
      }),
      emptySyncResponse({ navRevision: 7, cursor: 7 }),
    ]);
    const fake = fakeNavApi({ snapshot: restoredSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    await screen.findByText('恢复后的链接');
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
    });
    // 快照整份替换之后链接与成员关系都在：那条历史 delete 一次都没有被应用。
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(1);
    expect(screen.getAllByTestId('nav-link-groups')[0]?.textContent).toContain('常用');
    expect(sync.queries[0]?.since).toBeNull();
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(7));
  });

  it('初始化时权威快照读不到：不采用水位、也不应用任何变更，下一轮仍是「不带 since」的初始化', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      resetResponse({ watermark: 9, navRevision: 3 }),
      // 如果客户端错误地在「没有快照」时采用了水位，这一页就会被应用（并删掉本地行）。
      syncResponse({
        navRevision: 4,
        changes: [syncDelete({ entityId: 'L1', seq: 10, revision: 3 })],
        nextCursor: encodeSyncCursor(10),
        watermark: 10,
      }),
    ]);
    const fake = fakeNavApi({
      snapshot: baseSnapshot(),
      readSnapshotFailure: failureResult<never>({
        status: 503,
        code: 'service_unavailable',
        message: '服务尚未完成部署配置，暂时不可用。',
      }),
    });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    // 快照读不到 → 既是加载错误，也是「本轮同步不推进水位」的原因（两者都可见）。
    expect(await screen.findByTestId('nav-error')).toBeDefined();
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
    });

    // 没有任何一次请求带着游标发出：水位从未被采用（下一次仍然是完整的初始化）。
    expect(sync.queries.map((query) => query.since)).toEqual([null, null]);
    // 没有权威快照落地 → 探针里的全局修订仍是 -1，绝不用猜测值冒充权威值。
    expect(probeRevision()).toBe(-1);
    // 那一页变更一次都没有被应用（列表根本没渲染出来，更没有「删掉 L1」这回事）。
    expect(screen.queryByTestId('nav-link-item')).toBeNull();
  });
});

describe('seq 顺序（同一毫秒也能正确落地）', () => {
  it('delete(seq=10) → upsert(seq=11)：最终为活跃（数组里刻意倒序，证明按 seq 排序）', async () => {
    const sync = fakeSyncApi([
      resetResponse({ watermark: 9, navRevision: 5 }),
      syncResponse({
        navRevision: 5,
        // 故意把「更晚的 upsert」放在「更早的 delete」前面，且两者 `updatedAt` 完全相同。
        changes: [
          syncUpsert({ entityId: 'L2', payload: link('L2', { title: '恢复后的站点', sortOrder: 1 }), seq: 11 }),
          syncDelete({ entityId: 'L2', seq: 10 }),
        ],
        nextCursor: encodeSyncCursor(11),
        watermark: 11,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    // 恢复生效：最终是活跃行，标题是新值。
    expect(await screen.findByText('恢复后的站点')).toBeDefined();
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(2);
  });

  it('upsert(seq=11) → delete(seq=12)：最终删除；随后更旧的 upsert(seq=10) 不复活', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      resetResponse({ watermark: 9, navRevision: 6 }),
      syncResponse({
        navRevision: 6,
        changes: [
          syncUpsert({ entityId: 'L2', payload: link('L2', { title: '先出现的标题', sortOrder: 1 }), seq: 11 }),
          syncDelete({ entityId: 'L2', seq: 12 }),
        ],
        nextCursor: encodeSyncCursor(12),
        watermark: 12,
      }),
      syncResponse({
        navRevision: 7,
        // 更旧的 upsert：seq 小于墓碑，绝不能把它加回来。
        changes: [syncUpsert({ entityId: 'L2', payload: link('L2', { title: '更旧的旧数据' }), seq: 10 })],
        nextCursor: encodeSyncCursor(12),
        watermark: 12,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    await screen.findByText('以太之光');
    await waitFor(() => {
      expect(screen.queryByText('国际服资料站')).toBeNull();
    });

    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    expect(screen.queryByText('更旧的旧数据')).toBeNull();
    expect(screen.queryByText('先出现的标题')).toBeNull();
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(1);
  });
});

describe('墓碑防复活', () => {
  it('收到 delete(seq=10) 后本地移除，且更旧的 upsert(seq=9) 不会加回来', async () => {
    const user = userEvent.setup();
    const first = syncResponse({
      navRevision: 3,
      changes: [syncDelete({ entityId: 'L2', seq: 10, revision: 3 })],
      nextCursor: encodeSyncCursor(10),
      watermark: 10,
    });
    // 第二轮：`seq` 更小的旧 upsert —— 绝不允许复活。
    const second = syncResponse({
      navRevision: 4,
      changes: [syncUpsert({ entityId: 'L2', payload: link('L2', { title: '被删掉的站点' }), seq: 9 })],
      nextCursor: encodeSyncCursor(10),
      watermark: 10,
    });
    const sync = fakeSyncApi([resetResponse({ watermark: 8, navRevision: 3 }), first, second]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    await screen.findByText('以太之光');
    // 首轮（挂载时的排空）已把被删行移除。
    await waitFor(() => {
      expect(screen.queryByText('国际服资料站')).toBeNull();
    });

    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    // 旧 upsert 被墓碑拦下：仍然不存在。
    expect(screen.queryByText('被删掉的站点')).toBeNull();
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(1);

    // 游标按共享编解码往返推进：先初始化（不带 since）→ 用初始化水位取增量 → 之后逐页推进。
    expect(sync.queries[0]?.since).toBeNull();
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(8));
    expect(sync.queries[2]?.since).toBe(encodeSyncCursor(10));
  });
});

describe('权威全局修订：只认 meta.navRevision', () => {
  it('A 端新增后 B 端同步：重排直接提交 meta.navRevision（无需人工刷新）', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      resetResponse({ watermark: 20, navRevision: 42 }),
      syncResponse({
        navRevision: 42,
        changes: [
          syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增站点', sortOrder: 2 }), seq: 21 }),
        ],
        nextCursor: encodeSyncCursor(21),
        watermark: 21,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    // 远端新增的行已经出现在列表里（本地快照修订也被 meta 抬到了 42）。
    await screen.findByText('远端新增站点');
    expect(probeRevision()).toBe(42);

    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    await waitFor(() => {
      expect(fake.calls.reorderLinks).toHaveBeenCalledTimes(1);
    });
    const request = fake.calls.reorderLinks.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['expectedRevision']).toBe(42);
    expect(request['orderedIds']).toEqual(['L2', 'L1', 'L3']);
  });

  it('行修订再大也不参与全局修订：快照修订只跟 meta 走', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      resetResponse({ watermark: 6, navRevision: 5 }),
      syncResponse({
        navRevision: 5,
        changes: [
          // 行修订 99（远大于工作空间修订）：它是**行**的计数器，不能被当成全局修订。
          syncUpsert({
            entityId: 'L1',
            payload: link('L1', { title: '远端改过的标题', revision: 99, sortOrder: 0 }),
            seq: 7,
            revision: 99,
          }),
        ],
        nextCursor: encodeSyncCursor(7),
        watermark: 7,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('远端改过的标题');
    expect(probeRevision()).toBe(5);

    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    await waitFor(() => {
      expect(fake.calls.reorderLinks).toHaveBeenCalledTimes(1);
    });
    const request = fake.calls.reorderLinks.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['expectedRevision']).toBe(5);
  });

  it('导入 apply 回显服务端预览返回的权威修订，而不是本地推算的值', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      resetResponse({ watermark: 20, navRevision: 42 }),
      syncResponse({
        navRevision: 42,
        changes: [
          syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增站点', sortOrder: 2 }), seq: 21 }),
        ],
        nextCursor: encodeSyncCursor(21),
        watermark: 21,
      }),
    ]);
    // 服务端在预览响应里回传它此刻的权威修订（42）——apply 必须原样回显。
    const fake = fakeNavApi({ snapshot: baseSnapshot(), previewRevision: 42 });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('远端新增站点');

    const textarea = screen.getByTestId('nav-import-json-text');
    await user.click(textarea);
    await user.paste('{"links":[{"title":"JSON 站点","url":"https://json.example.com/"}]}');
    await user.click(screen.getByTestId('nav-import-json-parse'));
    await user.click(screen.getByTestId('nav-import-preview'));
    await waitFor(() => {
      expect(fake.calls.previewImport).toHaveBeenCalledTimes(1);
    });
    await screen.findByTestId('nav-import-preview-result');
    await user.click(screen.getByTestId('nav-import-apply'));
    await waitFor(() => {
      expect(fake.calls.applyImport).toHaveBeenCalledTimes(1);
    });
    const applyRequest = fake.calls.applyImport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(applyRequest['expectedRevision']).toBe(42);
    expect(applyRequest['mode']).toBe('links');
    expect(typeof applyRequest['operationId']).toBe('string');
  });
});

describe('真并发 409', () => {
  it('B 基于旧行修订保存：草稿保留、提示带新旧 revision、不自动重试', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({
      snapshot: baseSnapshot(),
      // 服务端说：你基于 revision 1，而现在是 revision 4。
      updateLinkFailure: navConflictResult({
        entityType: 'nav_link',
        entityId: 'L1',
        baseRevision: 1,
        currentRevision: 4,
      }),
    });
    render(<Harness api={fake.api} syncApi={fakeSyncApi([], { navRevision: 2 }).api} />);
    await screen.findByText('以太之光');

    await user.click(within(linkRowAt(0)).getByTestId('nav-link-edit'));
    const titleInput = screen.getByTestId<HTMLInputElement>('nav-link-title');
    await user.clear(titleInput);
    await user.type(titleInput, '我的并发草稿');
    await user.click(screen.getByTestId('nav-link-submit'));

    const conflict = await screen.findByTestId('nav-conflict');
    // 提示必须同时给出「服务器上现在是几」与「你基于的是几」。
    expect(conflict.textContent).toContain('服务器上是 revision 4');
    expect(conflict.textContent).toContain('你基于的修订：1');
    // 草稿**一个字符都没丢**。
    expect(screen.getByTestId<HTMLInputElement>('nav-link-title').value).toBe('我的并发草稿');
    // 不盲重试：就这一次提交。
    expect(fake.calls.updateLink).toHaveBeenCalledTimes(1);
  });
});

describe('游标版本处理（422）', () => {
  it('服务端拒绝游标：丢弃本地游标、给出可见提示，下一轮重新初始化', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi(
      [
        resetResponse({ watermark: 5, navRevision: 3 }),
        failureResult<SyncChangesResponse>({
          status: 422,
          code: 'validation_failed',
          message: '请求参数校验失败。',
          details: { reason: 'cursor_version_unsupported' },
        }),
        resetResponse({ watermark: 5, navRevision: 4 }),
      ],
      { navRevision: 4, watermark: 5 },
    );
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('以太之光');

    // 挂载的排空带着**初始化水位**发出，并被服务端拒绝。
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
    });
    expect(sync.queries[0]?.since).toBeNull();
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(5));
    // 可见提示（不静默）：说明游标已丢弃、将重新做完整同步。
    const notice = await screen.findByTestId('nav-sync-notice');
    expect(notice.textContent).toContain('游标');
    expect(notice.textContent).toContain('完整同步');
    // 这不是「同步失败」，因此不显示成错误。
    expect(screen.queryByTestId('nav-error')).toBeNull();

    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    // 之后重新初始化：先不带 since（而不是猜一个游标继续增量）。
    expect(sync.queries[2]?.since).toBeNull();
  });

  it('原因未知的 422 不丢弃游标（只认结构化原因，绝不猜）', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi(
      [
        resetResponse({ watermark: 5, navRevision: 3 }),
        failureResult<SyncChangesResponse>({
          status: 422,
          code: 'validation_failed',
          message: '请求参数校验失败。',
          details: { reason: 'something_else_entirely' },
        }),
      ],
      { navRevision: 4, watermark: 5 },
    );
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('以太之光');

    // 未知原因的 422 只报错：绝不擅自重来一次全量同步。
    expect(await screen.findByTestId('nav-error')).toBeDefined();
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    // 游标保持不变：仍然带着初始化得到的水位请求增量。
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(5));
    expect(sync.queries[2]?.since).toBe(encodeSyncCursor(5));
    expect(screen.queryByTestId('nav-sync-notice')).toBeNull();
  });
});

describe('响应形状不符时整轮丢弃', () => {
  it('缺少 meta / entityTypes / resetRequired 的响应被丢弃，本地快照不被半可信数据改动', async () => {
    const user = userEvent.setup();
    const api = fakeNavApi({ snapshot: baseSnapshot() });
    /**
     * 这个替身**故意**返回不符合共享契约的响应（缺少 `entityTypes` / `meta` / `resetRequired`）：
     * 它只用于验证「形状不符 → 整轮丢弃」这条分支，因此这里显式断言它的类型不安全。
     */
    const broken = {
      readChanges: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          data: {
            changes: [syncDelete({ entityId: 'L1', seq: 9, revision: 9, updatedAt: 900 })],
            nextCursor: null,
            hasMore: false,
            serverTimeMs: 900,
          },
        }),
      ),
    } as unknown as Parameters<typeof useNav>[0]['syncApi'];
    render(<Harness api={api.api} syncApi={broken} />);

    await screen.findByText('以太之光');
    await user.click(screen.getByTestId('nav-sync-now'));
    expect(await screen.findByTestId('nav-error')).toBeDefined();
    expect(screen.getByTestId('nav-error').textContent).toContain('不符合契约');
    // 本地数据没有被那轮「半可信变更」改动。
    expect(screen.getByText('以太之光')).toBeDefined();
  });
});

describe('草稿 vs 远端变化', () => {
  it('编辑中收到远端更新：草稿保留 + 冲突提示 + 不自动保存', async () => {
    const user = userEvent.setup();
    const remoteRow = link('L1', { title: '远端改过的标题', revision: 9, updatedAt: 400 });
    const sync = fakeSyncApi([
      resetResponse({ watermark: 0, navRevision: 2 }),
      // 排空页：没有任何变更（水位停在 v2:0）。
      emptySyncResponse({ navRevision: 2 }),
      syncResponse({
        navRevision: 9,
        changes: [syncUpsert({ entityId: 'L1', payload: remoteRow, seq: 13, revision: 9, updatedAt: 400 })],
        nextCursor: encodeSyncCursor(13),
        watermark: 13,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('以太之光');

    // 开始编辑并写下本地草稿。
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-edit'));
    const titleInput = screen.getByTestId<HTMLInputElement>('nav-link-title');
    await user.clear(titleInput);
    await user.type(titleInput, '我的本地草稿标题');

    // 其它设备改了同一条 → 同步一轮。
    await user.click(screen.getByTestId('nav-sync-now'));

    const conflict = await screen.findByTestId('nav-conflict');
    expect(conflict.textContent).toContain('其它设备');
    const notice = screen.getByTestId('nav-draft-remote-notice');
    expect(notice.textContent).toContain('未保存');
    // 草稿内容**一个字符都没变**。
    expect(screen.getByTestId<HTMLInputElement>('nav-link-title').value).toBe('我的本地草稿标题');
    // 远端更新没有被写进列表（避免与草稿打架），也**没有**自动保存草稿。
    expect(screen.queryByText('远端改过的标题')).toBeNull();
    expect(fake.calls.updateLink).not.toHaveBeenCalled();
    // 界面上明确给出用户出口：基于最新修订保存 / 放弃草稿并重新载入。
    expect(screen.getByTestId('nav-conflict-adopt')).toBeDefined();
    expect(screen.getByTestId('nav-conflict-discard')).toBeDefined();
  });

  it('无草稿时收到远端 upsert：列表就地更新', async () => {
    const remoteRow = link('L1', { title: '远端新标题', revision: 9, updatedAt: 500 });
    const sync = fakeSyncApi([
      resetResponse({ watermark: 13, navRevision: 9 }),
      syncResponse({
        navRevision: 9,
        changes: [syncUpsert({ entityId: 'L1', payload: remoteRow, seq: 14, revision: 9, updatedAt: 500 })],
        nextCursor: encodeSyncCursor(14),
        watermark: 14,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    // 挂载时的首次排空就会应用这条 upsert。
    expect(await screen.findByText('远端新标题')).toBeDefined();
    expect(screen.queryByText('以太之光')).toBeNull();
    // 没有草稿 → 不出现任何冲突提示。
    expect(screen.queryByTestId('nav-conflict')).toBeNull();
  });

  it('本地草稿遇到远端删除：草稿保留并说明「已被删除」', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      resetResponse({ watermark: 2, navRevision: 2 }),
      emptySyncResponse({ navRevision: 2 }),
      syncResponse({
        navRevision: 10,
        changes: [syncDelete({ entityId: 'L1', seq: 15, revision: 9, updatedAt: 600 })],
        nextCursor: encodeSyncCursor(15),
        watermark: 15,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('以太之光');

    await user.click(within(linkRowAt(0)).getByTestId('nav-link-edit'));
    await user.type(screen.getByTestId('nav-link-title'), '（本地补充）');

    await user.click(screen.getByTestId('nav-sync-now'));
    const notice = await screen.findByTestId('nav-draft-remote-notice');
    expect(notice.textContent).toContain('删除');
    expect(screen.getByTestId<HTMLInputElement>('nav-link-title').value).toContain('（本地补充）');
    expect(fake.calls.deleteLink).not.toHaveBeenCalled();
  });
});

describe('分页排空（hasMore）', () => {
  it('limit=1 的 delete → restore 分页：中间态是删除，最终活跃且成员关系保留', async () => {
    const membershipRestore = deferredSyncResponse();
    const sync = fakeSyncApi(
      [
        resetResponse({ watermark: 30, navRevision: 30 }),
        // 第一页（limit=1）：链接被删除（服务端会一并墓碑化它的成员关系，客户端本地级联）。
        syncResponse({
          navRevision: 31,
          changes: [syncDelete({ entityId: 'L1', seq: 31, revision: 2 })],
          nextCursor: encodeSyncCursor(31),
          hasMore: true,
          watermark: 31,
        }),
        // 第二页：显式恢复成员关系（停在测试手里，用于观察**中间态**）。
        membershipRestore.step,
        // 第三页：显式恢复链接本身 —— 最终活跃。
        syncResponse({
          navRevision: 33,
          changes: [
            syncUpsert({
              entityId: 'L1',
              payload: link('L1', { title: '国际服资料站', revision: 3, sortOrder: 0 }),
              seq: 33,
              revision: 3,
            }),
          ],
          nextCursor: encodeSyncCursor(33),
          watermark: 33,
        }),
      ],
      { navRevision: 33, watermark: 33 },
    );
    const fake = fakeNavApi({ snapshot: restoredSnapshotForPaging() });
    render(<Harness api={fake.api} syncApi={sync.api} syncLimit={1} />);

    /**
     * 中间态：第一页（删除页）已按 seq 落地。
     *
     * 起始快照里那条链接是**活跃**的（`restoredSnapshotForPaging`），而本地没有任何其它
     * 会移除它的路径，因此「列表空了」只可能来自那一条 delete —— 这就是中间态的证据
     * （挂载与排空都在微任务里完成，所以这里直接等它落地，而不是先断言它还在）。
     */
    await waitFor(() => {
      expect(screen.queryByText('国际服资料站')).toBeNull();
    });
    expect(screen.getByTestId('nav-empty')).toBeDefined();
    // 排空进行中：提示可见，且探针确认状态是「正在同步」。
    expect(screen.getByTestId('nav-sync-notice').textContent).toContain('正在同步');
    expect(probeSyncing()).toBe(true);

    // 兑现第二页（成员关系恢复）：客户端会立刻续取第三页，不需要等下一个轮询间隔。
    membershipRestore.resolve(
      syncResponse({
        navRevision: 32,
        changes: [
          syncUpsert({
            entityId: 'L1:G1',
            entityType: 'nav_membership',
            payload: membership('L1', 'G1', { sortOrder: 1 }),
            seq: 32,
          }),
        ],
        nextCursor: encodeSyncCursor(32),
        hasMore: true,
        watermark: 32,
      }),
    );

    // 最终态：链接回到活跃，**成员关系还在**（分组徽章仍然是「常用」）。
    expect(await screen.findByText('国际服资料站')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(1);
    expect(screen.getAllByTestId('nav-link-groups')[0]?.textContent).toContain('常用');

    // 四轮请求：初始化（不带 since）+ 三页增量，每页恰好 limit=1，游标按 seq 严格推进。
    expect(sync.queries.map((query) => query.since)).toEqual([
      null,
      encodeSyncCursor(30),
      encodeSyncCursor(31),
      encodeSyncCursor(32),
    ]);
    expect(sync.queries.map((query) => query.limit)).toEqual([1, 1, 1, 1]);
  });

  it('分页之间发生并发写：不漏、不重复、最终一致；hasMore 期间不采用全局修订且禁止重排', async () => {
    const user = userEvent.setup();
    const concurrentPage = deferredSyncResponse();
    const sync = fakeSyncApi(
      [
        resetResponse({ watermark: 20, navRevision: 20 }),
        // 第一页：远端新增 A（`meta.navRevision` 是**未来**的 99，绝不能在这里被采用）。
        syncResponse({
          navRevision: 99,
          changes: [
            syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增 A', sortOrder: 2 }), seq: 21 }),
          ],
          nextCursor: encodeSyncCursor(21),
          hasMore: true,
          watermark: 21,
        }),
        concurrentPage.step,
      ],
      { navRevision: 100, watermark: 100 },
    );
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    expect(await screen.findByText('远端新增 A')).toBeDefined();
    // hasMore 期间：本地全局修订**仍是快照里的 2**（没有被抬到 99）。
    expect(probeRevision()).toBe(2);
    expect(probeSyncing()).toBe(true);

    // 此时发起重排会被拒绝并提示「正在同步」，绝不静默用旧或新的修订提交。
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    expect(fake.calls.reorderLinks).not.toHaveBeenCalled();
    expect(screen.getByTestId('nav-notice').textContent).toContain('正在同步');

    // 下一页带来「排空期间发生的并发写」：它必须与第一页一起落地（不漏、不重）。
    concurrentPage.resolve(
      syncResponse({
        navRevision: 100,
        changes: [
          syncUpsert({ entityId: 'L4', payload: link('L4', { title: '并发写 B', sortOrder: 3 }), seq: 22 }),
        ],
        nextCursor: encodeSyncCursor(22),
        watermark: 22,
      }),
    );

    expect(await screen.findByText('并发写 B')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });
    expect(screen.getByText('远端新增 A')).toBeDefined();
    // 四行：L1 / L2 / L3 / L4 —— 既不漏也不重复。
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(4);
    // 排空完成之后才采用排空页的权威全局修订（100）。
    expect(probeRevision()).toBe(100);
  });

  it('排空（hasMore=false）之后才采用 meta.navRevision：重排/导入无需人工刷新', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      resetResponse({ watermark: 20, navRevision: 20 }),
      syncResponse({
        navRevision: 99,
        changes: [
          syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增 A', sortOrder: 2 }), seq: 21 }),
        ],
        nextCursor: encodeSyncCursor(21),
        hasMore: true,
        watermark: 21,
      }),
      syncResponse({
        navRevision: 42,
        changes: [
          syncUpsert({ entityId: 'L4', payload: link('L4', { title: '并发写 B', sortOrder: 3 }), seq: 22 }),
        ],
        nextCursor: encodeSyncCursor(22),
        watermark: 22,
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    await screen.findByText('并发写 B');
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(4);

    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    await waitFor(() => {
      expect(fake.calls.reorderLinks).toHaveBeenCalledTimes(1);
    });
    const request = fake.calls.reorderLinks.mock.calls[0]?.[0] as Record<string, unknown>;
    // 排空页给出的权威修订（42），而不是中途那一页的 99，也不是本地推算。
    expect(request['expectedRevision']).toBe(42);
  });
});

/** 分页用例的起始快照：链接与它的分组关系都在，且修订已是「删除之前」的水位。 */
function restoredSnapshotForPaging() {
  return snapshot({
    revision: 30,
    links: [link('L1', { title: '国际服资料站', revision: 2, sortOrder: 0 })],
    groups: [group('G1', { name: '常用' })],
    memberships: [membership('L1', 'G1')],
  });
}
