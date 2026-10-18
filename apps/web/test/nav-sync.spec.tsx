/**
 * 跨设备同步的测试（阶段 04 / HUB-051 客户端侧）。**不发任何真实网络请求**。
 *
 * 本文件验证第四轮复核收口的两个 P1 所对应的协议：
 *
 * > **日志只作失效信号；状态只由原子快照发布。**
 *
 * 1. **不许半份发布**：`changes` 的 op/payload 一次都不许应用到本地状态（它们是历史事件，
 *    而 payload 是当前内容）。只要收到相关变更信号，就整体重读一次权威快照并在**一个**状态
 *    更新里发布；因此「重排/删除页先落地、恢复页还没到」的中间态在结构上不存在。
 * 2. **快照地板**：游标必须等于**与内容同批读出**的 `snapshot.watermark`
 *    （`v2:<watermark>`）。请求发起顺序不能证明数据库观察顺序，因此「先用 reset 拿水位、
 *    再单独读快照」这条老路径不再决定水位。
 * 3. **普通 reload 也抬地板**：手动/写入后的 reload 发布新快照后，`seq` 小于新水位的旧增量
 *    不得回退本地状态。
 * 4. **排空失败 / 超页上限不恢复全局写**：不发布半份状态，`syncing` 保持为真（全局 CAS 写仍被
 *    拒绝）并给出可见提示；只有一轮「快照已发布且无更多变更」才清除。
 * 5. **写闸门**：`syncing` 为真时重排 / 目录导入 / restore 落地被拒，`expectedRevision`
 *    **绝不**使用未来值（也不使用服务端当前值）。
 * 6. **既有行为不回归**：真并发 409 + 草稿保留、游标 422 重建、restore 面板、
 *    无真实网络（会话/工作空间作用域隔离由 `session-isolation.spec.tsx` 覆盖）。
 */
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSyncCursor, type NavSnapshot, type SyncChangesResponse } from '@ff14-hub/shared';
import { NavView } from '../src/app/nav/NavView';
import { useNav, type NavController } from '../src/app/nav/use-nav';
import type { NavApi, SyncChangesApi } from '../src/app/nav/nav-api';
import {
  catalogEntry,
  deferredSyncResponse,
  emptySyncResponse,
  exportDocument,
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

const TOKEN = 'sync-test-token';

/**
 * 只存在于**变更日志 payload** 里的标题。
 *
 * 它绝不该出现在任何一次对外发布的本地状态里：出现即证明客户端把日志条目逐条应用了
 * （而日志条目是历史事件，payload 却是当前内容——正是 P1 的成因）。
 */
const PAYLOAD_MARKER = '【payload 标记】只存在于变更日志里的标题';

// ---------------------------------------------------------------------------
// 测试外壳与观察工具
// ---------------------------------------------------------------------------

interface HarnessProps {
  readonly api: NavApi;
  readonly syncApi: SyncChangesApi | undefined;
  readonly syncLimit?: number | undefined;
  readonly syncMaxPages?: number | undefined;
  /**
   * 「状态对外发布历史」：**每一次**渲染都记一次控制器。
   *
   * 为什么必须记历史而不是只看最终值：本文件要证明「**任何一次**对外发布的状态里都有那条
   * 链接与成员关系」。只断言最终值会漏掉「先删掉、再补回来」这种半份发布。
   * 这里只是**只读观察**（渲染期往数组里 push），不修改任何状态。
   */
  readonly history: NavController[];
}

function Harness(props: HarnessProps) {
  const state = useNav({
    getToken: () => TOKEN,
    enabled: true,
    api: props.api,
    ...(props.syncApi === undefined ? {} : { syncApi: props.syncApi }),
    // 关闭定时轮询：测试只通过「立即同步」按钮显式触发，避免时间不确定。
    syncIntervalMs: 0,
    ...(props.syncLimit === undefined ? {} : { syncLimit: props.syncLimit }),
    ...(props.syncMaxPages === undefined ? {} : { syncMaxPages: props.syncMaxPages }),
  });
  props.history.push(state);
  return (
    <>
      <span
        data-testid="nav-probe"
        data-revision={String(state.snapshot?.revision ?? -1)}
        data-watermark={String(state.snapshot?.watermark ?? -1)}
        data-syncing={state.syncing ? 'true' : 'false'}
      />
      <NavView state={state} />
    </>
  );
}

/** 渲染真实 `useNav` + `NavView`，并把每次状态发布记进返回的数组。 */
function renderNav(input: {
  readonly api: NavApi;
  readonly syncApi: SyncChangesApi | undefined;
  readonly syncLimit?: number | undefined;
  readonly syncMaxPages?: number | undefined;
}): NavController[] {
  const history: NavController[] = [];
  render(
    <Harness
      api={input.api}
      syncApi={input.syncApi}
      history={history}
      {...(input.syncLimit === undefined ? {} : { syncLimit: input.syncLimit })}
      {...(input.syncMaxPages === undefined ? {} : { syncMaxPages: input.syncMaxPages })}
    />,
  );
  return history;
}

/** 历史上**所有真正发布过的快照**（去掉还没有快照的那些渲染）。 */
function publishedSnapshots(history: readonly NavController[]): NavSnapshot[] {
  return history
    .map((entry) => entry.snapshot)
    .filter((value): value is NavSnapshot => value !== null);
}

function latest(history: readonly NavController[]): NavController {
  const value = history[history.length - 1];
  if (value === undefined) {
    throw new Error('还没有任何一次状态发布');
  }
  return value;
}

function probeSyncing(): boolean {
  return screen.getByTestId('nav-probe').getAttribute('data-syncing') === 'true';
}

function probeWatermark(): number {
  return Number(screen.getByTestId('nav-probe').getAttribute('data-watermark'));
}

/** 取第 N 行链接（不存在就抛错：让测试的失败信息比 "undefined" 有用）。 */
function linkRowAt(index: number): HTMLElement {
  const node = screen.getAllByTestId('nav-link-item')[index];
  if (node === undefined) {
    throw new Error(`第 ${String(index + 1)} 行链接不存在`);
  }
  return node;
}

/** 往输入框里粘贴文本（`{`/`[` 会被 `user.type` 当成键盘描述符，粘贴是按字面量插入的）。 */
async function pasteInto(user: ReturnType<typeof userEvent.setup>, element: HTMLElement, text: string): Promise<void> {
  await user.click(element);
  await user.paste(text);
}

// ---------------------------------------------------------------------------
// 场景夹具
// ---------------------------------------------------------------------------

/** 两条链接 + 一个分组关系：重排 / 列表断言需要多行才能观察。 */
function baseSnapshot(watermark = 2): NavSnapshot {
  return snapshot({
    revision: watermark,
    watermark,
    links: [
      link('L1', { title: '以太之光', sortOrder: 0 }),
      link('L2', { title: '国际服资料站', sortOrder: 1 }),
    ],
  });
}

/** 「已恢复」的权威快照：链接活跃、并且带着它的分组关系（复核反例的最终状态）。 */
function restoredSnapshot(watermark: number, revision = 7): NavSnapshot {
  return snapshot({
    revision,
    watermark,
    links: [link('L1', { title: '恢复后的链接', revision: 3, sortOrder: 0 })],
    groups: [group('G1', { name: '常用' })],
    memberships: [membership('L1', 'G1')],
  });
}

/** 分页场景的起始快照：L1 活跃且带分组关系（历史 delete 页想删掉的就是它）。 */
function pagedSnapshot(watermark: number, revision = 7): NavSnapshot {
  return snapshot({
    revision,
    watermark,
    links: [
      link('L1', { title: '国际服资料站', revision: 3, sortOrder: 0 }),
      link('L2', { title: '以太之光', revision: 1, sortOrder: 1 }),
    ],
    groups: [group('G1', { name: '常用' })],
    memberships: [membership('L1', 'G1')],
  });
}

/** L1 与它的成员关系在任何一次发布里都必须存在（「不许半份发布」的核心断言）。 */
function expectLinkAndMembershipIntact(history: readonly NavController[]): void {
  const published = publishedSnapshots(history);
  expect(published.length).toBeGreaterThan(0);
  for (const snap of published) {
    expect(snap.links.some((row) => row.id === 'L1' && row.deletedAt === null)).toBe(true);
    expect(
      snap.memberships.some(
        (row) => row.linkId === 'L1' && row.groupId === 'G1' && row.deletedAt === null,
      ),
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------

describe('1. 日志只作失效信号：状态只由原子快照发布（不许半份发布）', () => {
  it('reset(W) → 快照（含已恢复链接 + 成员关系）→ 之后喂入历史 delete(W+1) 与 restore(W+2) 两页（limit=1）：任何一次发布都完整，changes 从未被逐条应用', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // 权威快照：已经包含「恢复后」的内容，水位 32（= W+2）。
    const authoritative = restoredSnapshot(32);
    const fake = fakeNavApi({ snapshot: authoritative });
    const sync = fakeSyncApi(
      [
        resetResponse({ watermark: 30, navRevision: 7 }),
        // 第一页：历史 delete（seq = W+1）。重放它会把已恢复的链接删掉。
        syncResponse({
          navRevision: 7,
          changes: [syncDelete({ entityId: 'L1', seq: 31, revision: 2 })],
          nextCursor: encodeSyncCursor(31),
          hasMore: true,
          watermark: 31,
        }),
        // 第二页（最后一页）：历史 restore 页。它的 payload 是**当前**内容，
        // 而日志条目本身是历史事件——因此这条 payload 也绝不能被逐条应用。
        syncResponse({
          navRevision: 7,
          changes: [
            syncUpsert({
              entityId: 'L1',
              payload: link('L1', { title: PAYLOAD_MARKER, revision: 3, sortOrder: 0 }),
              seq: 32,
              revision: 3,
            }),
          ],
          nextCursor: encodeSyncCursor(32),
          watermark: 32,
        }),
      ],
      { navRevision: 7, watermark: 32 },
    );
    const history = renderNav({ api: fake.api, syncApi: sync.api, syncLimit: 1 });

    expect(await screen.findByText('恢复后的链接')).toBeDefined();
    expect(screen.getAllByTestId('nav-link-groups')[0]?.textContent).toContain('常用');
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });

    // ① **任何一次**对外发布的状态里都有链接与成员关系（不是只看最终值）。
    expectLinkAndMembershipIntact(history);

    /**
     * ② 「changes 从未被逐条应用」的**结构性**证据：
     * 每一次发布的快照都是服务端返回的**同一个对象引用**——逐条应用必然构造新对象
     * （`applyNavSyncChanges` 那条路径已在结构上被删除，这里用引用相等把它钉住）。
     */
    for (const snap of publishedSnapshots(history)) {
      expect(snap === authoritative).toBe(true);
    }
    // ③ 变更日志 payload 里的标记在任何一次发布里都不存在。
    for (const snap of publishedSnapshots(history)) {
      expect(snap.links.some((row) => row.title.includes('payload 标记'))).toBe(false);
    }

    // ④ 游标来自**与内容同批读出**的快照水位（32），而不是 reset 给的水位（30）。
    expect(sync.queries.map((query) => query.since)).toEqual([
      null,
      encodeSyncCursor(32),
      encodeSyncCursor(31),
      encodeSyncCursor(32),
    ]);
    expect(sync.queries.map((query) => query.limit)).toEqual([1, 1, 1, 1]);
    // 失效信号被权威快照消费掉这件事是**可见**的（不静默）。
    expect(screen.getByTestId('nav-notice').textContent).toContain('变更信号');
    // 全程零真实网络请求（替身注入后不该有别的出口）。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resetRequired 那一页即便带着 changes 也一律不应用（初始化只认快照 + 它的水位）', async () => {
    const authoritative = restoredSnapshot(33);
    const fake = fakeNavApi({ snapshot: authoritative });
    const sync = fakeSyncApi([
      syncResponse({
        navRevision: 7,
        // 契约要求 resetRequired 时 changes 为空；这里**故意**塞一条历史 delete，
        // 用来证明客户端不会「顺手应用」初始化页里的变更。
        changes: [syncDelete({ entityId: 'L1', seq: 31, revision: 2 })],
        nextCursor: encodeSyncCursor(33),
        resetRequired: true,
        watermark: 33,
      }),
    ]);
    const history = renderNav({ api: fake.api, syncApi: sync.api });

    expect(await screen.findByText('恢复后的链接')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });
    expectLinkAndMembershipIntact(history);
    expect(sync.queries[0]?.since).toBeNull();
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(33));
  });

  it('初始化时权威快照读不到：不发布任何状态、不推进水位，下一轮仍是「不带 since」的初始化', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({
      snapshot: baseSnapshot(30),
      readSnapshotFailure: failureResult<never>({
        status: 503,
        code: 'service_unavailable',
        message: '服务尚未完成部署配置，暂时不可用。',
      }),
    });
    const sync = fakeSyncApi([
      resetResponse({ watermark: 9, navRevision: 3 }),
      // 若客户端错误地在「没有快照」时采用了水位，这一页就会被当成增量（并让列表出现东西）。
      syncResponse({
        navRevision: 4,
        changes: [
          syncUpsert({ entityId: 'L9', payload: link('L9', { title: '绝不该出现' }), seq: 10 }),
        ],
        nextCursor: encodeSyncCursor(10),
        watermark: 10,
      }),
    ]);
    const history = renderNav({ api: fake.api, syncApi: sync.api });

    // 快照读不到 → 既是加载错误，也是「本轮同步不推进水位」的原因（两者都可见）。
    expect(await screen.findByTestId('nav-error')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(true);
    });
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
    });

    // 没有任何一次请求带着游标发出：水位从未被采用（下一次仍然是完整的初始化）。
    expect(sync.queries.map((query) => query.since)).toEqual([null, null]);
    // 一次都没有发布过快照，也没有任何变更被应用。
    expect(publishedSnapshots(history)).toEqual([]);
    expect(screen.queryByTestId('nav-link-item')).toBeNull();
    expect(screen.queryByText('绝不该出现')).toBeNull();
  });
});

describe('2. 快照地板：游标必须等于快照 watermark，旧增量不得回退', () => {
  it('reset 水位 30、快照水位 37 → 游标 = v2:37；seq <= 37 的旧增量不得回退本地状态', async () => {
    const authoritative = restoredSnapshot(37);
    const fake = fakeNavApi({ snapshot: authoritative });
    const sync = fakeSyncApi([
      resetResponse({ watermark: 30, navRevision: 7 }),
      // 旧增量：seq(31) <= 快照水位(37) → 它已经包含在快照里，绝不能改本地状态。
      syncResponse({
        navRevision: 7,
        changes: [syncDelete({ entityId: 'L1', seq: 31, revision: 2 })],
        nextCursor: encodeSyncCursor(31),
        watermark: 31,
      }),
    ]);
    const history = renderNav({ api: fake.api, syncApi: sync.api });

    expect(await screen.findByText('恢复后的链接')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });

    /**
     * 游标是 **v2:37**（快照自带的水位），不是 reset 信封里的 30：
     * 只有「内容 + 水位同批读出」才能证明这份内容已经覆盖到哪个 seq。
     */
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(37));
    expectLinkAndMembershipIntact(history);
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(1);
    expect(probeWatermark()).toBe(37);
  });
});

describe('3. 普通 reload 抬地板', () => {
  it.each([false, true])('交错请求按数据库水位发布，旧响应先到=%s', async (olderFirst) => {
    const fake = fakeNavApi({ snapshot: baseSnapshot(10) });
    const sync = fakeSyncApi();
    const history = renderNav({ api: fake.api, syncApi: sync.api });
    await waitFor(() => expect(latest(history).snapshot?.watermark).toBe(10));
    await waitFor(() => expect(probeSyncing()).toBe(false));
    const resolvers: ((value: Awaited<ReturnType<NavApi['readSnapshot']>>) => void)[] = [];
    const api: NavApi = fake.api;
    vi.spyOn(api, 'readSnapshot').mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    let first: Promise<void>;
    let second: Promise<void>;
    act(() => { first = latest(history).reload(); second = latest(history).reload(); });
    // 先发请求观察到较新状态；后发请求在数据库里反而先读到旧状态。
    const newer = baseSnapshot(30);
    const older = baseSnapshot(20);
    const resolveAt = async (index: number, value: NavSnapshot): Promise<void> => {
      await act(() => { resolvers[index]?.({ ok: true, data: value, status: 200 }); });
    };
    if (olderFirst) { await resolveAt(1, older); await resolveAt(0, newer); }
    else { await resolveAt(0, newer); await resolveAt(1, older); }
    await act(async () => { await Promise.all([first, second]); });
    expect(latest(history).snapshot).toBe(newer);
    await act(async () => { await latest(history).syncNow(); });
    expect(sync.queries.at(-1)?.since).toBe(encodeSyncCursor(30));
  });
  it('手动 reload 到新快照（watermark 55）后：游标 = v2:55，seq < 55 的旧增量不得回退', async () => {
    const user = userEvent.setup();
    const before = baseSnapshot(30);
    const after = snapshot({
      revision: 9,
      watermark: 55,
      links: [
        link('L1', { title: '以太之光（远端新标题）', revision: 4, sortOrder: 0 }),
        link('L2', { title: '国际服资料站', revision: 1, sortOrder: 1 }),
      ],
    });
    const fake = fakeNavApi({ snapshot: before });
    const sync = fakeSyncApi([resetResponse({ watermark: 30, navRevision: 2 })]);
    const history = renderNav({ api: fake.api, syncApi: sync.api });
    expect(await screen.findByText('以太之光')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });

    // 服务端又写了一次 → 用户手动 reload 拿到更新的快照（水位 55）。
    fake.setSnapshot(after);
    await act(async () => {
      await latest(history).reload();
    });
    expect(await screen.findByText('以太之光（远端新标题）')).toBeDefined();
    expect(probeWatermark()).toBe(55);

    // 喂入一条 seq(40) < 新水位(55) 的旧增量，再显式同步一次。
    sync.enqueue(
      syncResponse({
        navRevision: 9,
        changes: [
          syncUpsert({
            entityId: 'L1',
            payload: link('L1', { title: '更旧的历史内容', revision: 8 }),
            seq: 40,
            revision: 8,
          }),
        ],
        nextCursor: encodeSyncCursor(40),
        watermark: 40,
      }),
    );
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });

    // reload 已经把地板抬到 55：下一次请求因此带 v2:55（不是 v2:30）。
    expect(sync.queries[2]?.since).toBe(encodeSyncCursor(55));
    // 旧增量不得回退本地状态。
    expect(screen.getByText('以太之光（远端新标题）')).toBeDefined();
    expect(screen.queryByText('更旧的历史内容')).toBeNull();
    for (const snap of publishedSnapshots(history)) {
      expect(snap.links.some((row) => row.title === '更旧的历史内容')).toBe(false);
    }
  });
});

describe('4. 排空失败 / 超页上限：不发布半份状态，且 syncing 保持为真', () => {
  it('第二页请求失败：不发布半份状态、syncing 为真、重排被拒且有可见提示；恢复后一次成功轮次才清除', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: pagedSnapshot(30, 7) });
    const sync = fakeSyncApi(
      [
        resetResponse({ watermark: 30, navRevision: 7 }),
        // 第一页：链接被删除（服务端会一并墓碑化它的成员关系）。
        syncResponse({
          navRevision: 8,
          changes: [syncDelete({ entityId: 'L1', seq: 31, revision: 4 })],
          nextCursor: encodeSyncCursor(31),
          hasMore: true,
          watermark: 31,
        }),
        // 第二页：请求直接失败（网络 / 服务不可用）。
        failureResult<SyncChangesResponse>({
          status: 503,
          code: 'service_unavailable',
          message: '服务暂时不可用。',
        }),
      ],
      { navRevision: 8, watermark: 31 },
    );
    const history = renderNav({ api: fake.api, syncApi: sync.api, syncLimit: 1 });

    // 可见提示：这一轮同步失败了。
    expect(await screen.findByTestId('nav-error')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(true);
    });
    expect(screen.getByTestId('nav-sync-notice').textContent).toContain('正在同步');

    // 不许半份发布：那条历史 delete 一次都没有被应用。
    expectLinkAndMembershipIntact(history);
    expect(screen.getByText('国际服资料站')).toBeDefined();

    // 同步未完成 → 重排（全局 CAS 写）被拒：一个请求都不发。
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    expect(fake.calls.reorderLinks).not.toHaveBeenCalled();
    expect(screen.getByTestId('nav-notice').textContent).toContain('正在同步');

    // 服务端继续前进（水位 99 / 权威修订 8）→ 一次成功轮次之后才恢复全局写。
    fake.setSnapshot(pagedSnapshot(99, 8));
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });

    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    await waitFor(() => {
      expect(fake.calls.reorderLinks).toHaveBeenCalledTimes(1);
    });
    const request = fake.calls.reorderLinks.mock.calls[0]?.[0] as Record<string, unknown>;
    // 用**已发布快照**的权威修订（8），绝不是水位 99 / 中途那一页里的未来修订。
    expect(request['expectedRevision']).toBe(8);
  });

  it('触发页上限（maxPages=1）：同样保持「同步中」，恢复后一次成功轮次才清除', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: pagedSnapshot(31, 7) });
    const sync = fakeSyncApi([
      resetResponse({ watermark: 30, navRevision: 7 }),
      // 永远声称还有下一页：页上限必须兜住它。
      syncResponse({
        navRevision: 99,
        changes: [
          syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增' }), seq: 32 }),
        ],
        nextCursor: encodeSyncCursor(32),
        hasMore: true,
        watermark: 32,
      }),
    ]);
    const history = renderNav({ api: fake.api, syncApi: sync.api, syncLimit: 1, syncMaxPages: 1 });

    expect(await screen.findByTestId('nav-error')).toBeDefined();
    expect(screen.getByTestId('nav-error').textContent).toContain('页');
    await waitFor(() => {
      expect(probeSyncing()).toBe(true);
    });
    // 不发布半份状态：本地仍然是完整的两行，且那一页的 payload 从未被应用。
    expect(screen.queryByText('远端新增')).toBeNull();
    expectLinkAndMembershipIntact(history);
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    expect(fake.calls.reorderLinks).not.toHaveBeenCalled();

    // 服务端前进到水位 33 / 修订 9：一次成功轮次之后才放行。
    fake.setSnapshot(pagedSnapshot(33, 9));
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    await waitFor(() => {
      expect(fake.calls.reorderLinks).toHaveBeenCalledTimes(1);
    });
    expect(
      (fake.calls.reorderLinks.mock.calls[0]?.[0] as Record<string, unknown>)['expectedRevision'],
    ).toBe(9);
  });
});

describe('5. 同步未完成期间的全局 CAS 写闸门', () => {
  it('排空进行中：重排 / 目录导入 / restore 落地全被拒（expectedRevision 绝不用未来值）；确认同步后才放行', async () => {
    const user = userEvent.setup();
    const openPage = deferredSyncResponse();
    const fake = fakeNavApi({ snapshot: pagedSnapshot(30, 7), catalog: [catalogEntry('C1')] });
    const sync = fakeSyncApi(
      [
        resetResponse({ watermark: 30, navRevision: 7 }),
        // 第一页：远端新增。`meta.navRevision` 是**未来**的 99 —— 绝不能被当成 CAS 基数。
        syncResponse({
          navRevision: 99,
          changes: [
            syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增' }), seq: 31 }),
          ],
          nextCursor: encodeSyncCursor(31),
          hasMore: true,
          watermark: 31,
        }),
        // 第二页停在测试手里：用它观察「排空进行中」的界面。
        openPage.step,
      ],
      { navRevision: 99, watermark: 31 },
    );
    const history = renderNav({ api: fake.api, syncApi: sync.api });

    // 闸门**不必等排空结束**：收到相关变更信号的那一刻就已经抬起。
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    expect(probeSyncing()).toBe(true);
    expect(screen.getByTestId('nav-sync-notice').textContent).toContain('正在同步');
    // 第一页的变更只是失效信号：本地状态没有被它改动。
    expect(screen.queryByText('远端新增')).toBeNull();

    // ① 重排（全局 CAS 写）：拒绝，不发请求，给出可见提示。
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    expect(fake.calls.reorderLinks).not.toHaveBeenCalled();
    expect(screen.getByTestId('nav-notice').textContent).toContain('正在同步');

    // ①' 但**行级写**（收藏，用行修订 CAS）不受闸门影响：它照样发请求，基数是该行的修订。
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-toggle-favorite'));
    await waitFor(() => {
      expect(fake.calls.updateLink).toHaveBeenCalledTimes(1);
    });
    const favoriteRequest = fake.calls.updateLink.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(favoriteRequest['expectedRevision']).toBe(3);

    // ② 目录导入（全局 CAS 写：整体改动集合与顺序）：同样拒绝。
    await user.click(screen.getByTestId('nav-catalog-load'));
    await screen.findByTestId('nav-catalog-entry');
    await user.click(within(screen.getByTestId('nav-catalog-entry')).getByTestId('nav-catalog-select'));
    await user.click(screen.getByTestId('nav-catalog-import'));
    expect(fake.calls.importCatalog).not.toHaveBeenCalled();
    expect(screen.getByTestId('nav-notice').textContent).toContain('正在同步');

    // ③ restore 导入：**预览**（读操作）可以发生，但**落地**被拒绝。
    await pasteInto(
      user,
      screen.getByTestId('nav-import-json-text'),
      JSON.stringify(
        exportDocument({
          links: [link('X1', { title: '配置里的链接' })],
          groups: [group('GX', { name: '配置分组' })],
          memberships: [membership('X1', 'GX')],
        }),
      ),
    );
    await user.click(screen.getByTestId('nav-import-json-parse'));
    expect(await screen.findByTestId('nav-restore-summary')).toBeDefined();
    await user.click(screen.getByTestId('nav-import-preview'));
    await screen.findByTestId('nav-import-preview-result');
    await user.click(screen.getByTestId('nav-import-apply'));
    expect(fake.calls.applyImport).not.toHaveBeenCalled();
    expect(screen.getByTestId('nav-notice').textContent).toContain('正在同步');

    // 兑现第二页（没有新变更）→ 服务端前进到水位 31 / 修订 9 → 本轮确认同步完成。
    fake.setSnapshot(pagedSnapshot(31, 9));
    openPage.resolve(
      syncResponse({
        navRevision: 9,
        changes: [],
        nextCursor: encodeSyncCursor(31),
        watermark: 31,
      }),
    );
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });
    expectLinkAndMembershipIntact(history);

    await user.click(within(linkRowAt(0)).getByTestId('nav-link-move-down'));
    await waitFor(() => {
      expect(fake.calls.reorderLinks).toHaveBeenCalledTimes(1);
    });
    // CAS 基数是**已发布快照**的权威修订（9）；第一页里的 99 从未被采用。
    expect(
      (fake.calls.reorderLinks.mock.calls[0]?.[0] as Record<string, unknown>)['expectedRevision'],
    ).toBe(9);
  });
});

describe('6. 既有行为不回归', () => {
  it('真并发 409：草稿保留、提示带新旧 revision、不自动重试', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({
      snapshot: baseSnapshot(2),
      // 服务端说：你基于 revision 1，而现在是 revision 4。
      updateLinkFailure: navConflictResult({
        entityType: 'nav_link',
        entityId: 'L1',
        baseRevision: 1,
        currentRevision: 4,
      }),
    });
    renderNav({ api: fake.api, syncApi: fakeSyncApi([], { navRevision: 2 }).api });
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

  it('游标被拒（422）：丢弃本地游标 + 可见提示 + 下一轮重新初始化（先不带 since）', async () => {
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
      ],
      { navRevision: 4, watermark: 5 },
    );
    renderNav({ api: fakeNavApi({ snapshot: baseSnapshot(5) }).api, syncApi: sync.api });
    await screen.findByText('以太之光');

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
    renderNav({ api: fakeNavApi({ snapshot: baseSnapshot(5) }).api, syncApi: sync.api });
    await screen.findByText('以太之光');

    // 未知原因的 422 只报错：绝不擅自重来一次全量同步。
    expect(await screen.findByTestId('nav-error')).toBeDefined();
    await waitFor(() => {
      expect(probeSyncing()).toBe(true);
    });
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    // 游标保持不变：仍然带着初始化得到的水位请求增量。
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(5));
    expect(sync.queries[2]?.since).toBe(encodeSyncCursor(5));
    // 这一轮没有收到任何失效信号 → 成功轮次之后闸门恢复、提示清除。
    await waitFor(() => {
      expect(probeSyncing()).toBe(false);
    });
    expect(screen.queryByTestId('nav-sync-notice')).toBeNull();
  });

  it('草稿 vs 远端变化：快照被整份替换时，草稿输入与冲突提示都保留', async () => {
    const user = userEvent.setup();
    const remoteRow = link('L1', { title: '远端改过的标题', revision: 9, updatedAt: 400 });
    const fake = fakeNavApi({ snapshot: baseSnapshot(2) });
    const sync = fakeSyncApi([
      resetResponse({ watermark: 2, navRevision: 2 }),
      // 挂载阶段的「确认没有更多变更」那一轮会把下一页消费掉，因此这里先给一页空响应。
      emptySyncResponse({ navRevision: 2 }),
      syncResponse({
        navRevision: 9,
        changes: [syncUpsert({ entityId: 'L1', payload: remoteRow, seq: 13, revision: 9 })],
        nextCursor: encodeSyncCursor(13),
        watermark: 13,
      }),
    ]);
    const history = renderNav({ api: fake.api, syncApi: sync.api });
    await screen.findByText('以太之光');

    // 开始编辑并写下本地草稿。
    await user.click(within(linkRowAt(0)).getByTestId('nav-link-edit'));
    const titleInput = screen.getByTestId<HTMLInputElement>('nav-link-title');
    await user.clear(titleInput);
    await user.type(titleInput, '我的本地草稿标题');

    // 其它设备改了同一条 → 服务端快照已经变了 → 同步一轮。
    fake.setSnapshot(
      snapshot({
        revision: 9,
        watermark: 13,
        links: [remoteRow, link('L2', { title: '国际服资料站', sortOrder: 1 })],
      }),
    );
    await user.click(screen.getByTestId('nav-sync-now'));

    const conflict = await screen.findByTestId('nav-conflict');
    expect(conflict.textContent).toContain('其它设备');
    expect(conflict.textContent).toContain('服务器上是 revision 9');
    const notice = screen.getByTestId('nav-draft-remote-notice');
    expect(notice.textContent).toContain('未保存');
    // 草稿内容**一个字符都没变**（整份替换只写 snapshot，不碰 draft）。
    expect(screen.getByTestId<HTMLInputElement>('nav-link-title').value).toBe('我的本地草稿标题');
    // 也**没有**自动保存草稿。
    expect(fake.calls.updateLink).not.toHaveBeenCalled();
    // 界面上明确给出用户出口。
    expect(screen.getByTestId('nav-conflict-adopt')).toBeDefined();
    expect(screen.getByTestId('nav-conflict-discard')).toBeDefined();
    expect(publishedSnapshots(history).length).toBeGreaterThan(0);
  });

  it('restore 面板：完整配置被识别为 restore，preview 原样提交文档，apply 回显服务端权威修订', async () => {
    const user = userEvent.setup();
    const document = exportDocument({
      links: [link('X1', { title: '配置里的链接' })],
      groups: [group('GX', { name: '配置分组' })],
      memberships: [membership('X1', 'GX')],
    });
    // 服务端此刻的权威修订是 42（预览响应回传它，apply 必须原样回显）。
    const fake = fakeNavApi({ snapshot: baseSnapshot(2), previewRevision: 42 });
    renderNav({ api: fake.api, syncApi: fakeSyncApi([], { navRevision: 42 }).api });
    await screen.findByText('以太之光');

    await pasteInto(user, screen.getByTestId('nav-import-json-text'), JSON.stringify(document));
    await user.click(screen.getByTestId('nav-import-json-parse'));
    expect(await screen.findByTestId('nav-restore-summary')).toBeDefined();
    expect(screen.getByTestId('nav-restore-counts').textContent).toContain('链接 1 条');

    await user.click(screen.getByTestId('nav-import-preview'));
    await waitFor(() => {
      expect(fake.calls.previewImport).toHaveBeenCalledTimes(1);
    });
    const previewRequest = fake.calls.previewImport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(previewRequest['mode']).toBe('restore');
    expect(previewRequest['document']).toEqual(document);
    expect(previewRequest['items']).toBeUndefined();

    await screen.findByTestId('nav-import-preview-result');
    await user.click(screen.getByTestId('nav-import-apply'));
    await waitFor(() => {
      expect(fake.calls.applyImport).toHaveBeenCalledTimes(1);
    });
    const applyRequest = fake.calls.applyImport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(applyRequest['mode']).toBe('restore');
    expect(applyRequest['expectedRevision']).toBe(42);
  });
});
