/**
 * 跨设备变更应用的测试（阶段 04 / HUB-051 客户端侧）。**不发任何真实网络请求**。
 *
 * 这些用例刻意把「同一毫秒」当成默认前提（`syncUpsert` / `syncDelete` 的 `updatedAt`
 * 默认全部相同），因此每一条通过都只能由 `seq` 解释——时间比较在这些用例里不可能正确。
 *
 * 覆盖的硬事实（对应集中复核发现的 P1）：
 * 1. **seq 是唯一排序依据**：同一毫秒「删除 → 恢复」按 seq 落地；更旧的 upsert 不复活删除；
 * 2. **权威全局修订**：重排 / 导入提交的 `expectedRevision` 只来自服务端 `meta.navRevision`
 *    （行修订再大也不参与推导），因此远端新增/编辑后另一端**无需人工刷新**即可继续写；
 * 3. **真并发 409**：草稿保留、提示带新旧 revision、不自动重试；
 * 4. **游标被拒（422）**：丢弃本地游标 + 可见提示 + 下一轮从头同步；原因未知则不丢。
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
  emptySyncResponse,
  failureResult,
  fakeNavApi,
  fakeSyncApi,
  link,
  navConflictResult,
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

function Harness(props: { readonly api: NavApi; readonly syncApi: Parameters<typeof useNav>[0]['syncApi'] }) {
  const state = useNav({
    getToken: () => 'sync-test-token',
    enabled: true,
    api: props.api,
    syncApi: props.syncApi,
    syncIntervalMs: 0,
  });
  return <NavView state={state} />;
}

function baseSnapshot() {
  return snapshot({
    revision: 2,
    links: [link('L1', { title: '以太之光', sortOrder: 0 }), link('L2', { title: '国际服资料站', sortOrder: 1 })],
  });
}

describe('seq 顺序（同一毫秒也能正确落地）', () => {
  it('delete(seq=10) → upsert(seq=11)：最终为活跃（数组里刻意倒序，证明按 seq 排序）', async () => {
    const sync = fakeSyncApi([
      syncResponse({
        navRevision: 5,
        // 故意把「更晚的 upsert」放在「更早的 delete」前面，且两者 `updatedAt` 完全相同。
        changes: [
          syncUpsert({ entityId: 'L2', payload: link('L2', { title: '恢复后的站点', sortOrder: 1 }), seq: 11 }),
          syncDelete({ entityId: 'L2', seq: 10 }),
        ],
        nextCursor: encodeSyncCursor(11),
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
      syncResponse({
        navRevision: 6,
        changes: [
          syncUpsert({ entityId: 'L2', payload: link('L2', { title: '先出现的标题', sortOrder: 1 }), seq: 11 }),
          syncDelete({ entityId: 'L2', seq: 12 }),
        ],
        nextCursor: encodeSyncCursor(12),
      }),
      syncResponse({
        navRevision: 7,
        // 更旧的 upsert：seq 小于墓碑，绝不能把它加回来。
        changes: [syncUpsert({ entityId: 'L2', payload: link('L2', { title: '更旧的旧数据' }), seq: 10 })],
        nextCursor: encodeSyncCursor(12),
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
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
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
    });
    // 第二轮：`seq` 更小的旧 upsert —— 绝不允许复活。
    const second = syncResponse({
      navRevision: 4,
      changes: [syncUpsert({ entityId: 'L2', payload: link('L2', { title: '被删掉的站点' }), seq: 9 })],
      nextCursor: encodeSyncCursor(10),
    });
    const sync = fakeSyncApi([first, second]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    await screen.findByText('以太之光');
    // 首轮（挂载时自动同步）已把被删行移除。
    await waitFor(() => {
      expect(screen.queryByText('国际服资料站')).toBeNull();
    });

    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
    });
    // 旧 upsert 被墓碑拦下：仍然不存在。
    expect(screen.queryByText('被删掉的站点')).toBeNull();
    expect(screen.getAllByTestId('nav-link-item')).toHaveLength(1);

    // 游标按共享编解码往返推进（第一次 null，之后是上一轮的 nextCursor）。
    expect(sync.queries[0]?.since).toBeNull();
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(10));
  });
});

describe('权威全局修订：只认 meta.navRevision', () => {
  it('A 端新增后 B 端同步：重排直接提交 meta.navRevision（无需人工刷新）', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      syncResponse({
        navRevision: 42,
        changes: [
          syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增站点', sortOrder: 2 }), seq: 21 }),
        ],
        nextCursor: encodeSyncCursor(21),
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    // 远端新增的行已经出现在列表里（本地快照修订也被 meta 抬到了 42）。
    await screen.findByText('远端新增站点');

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
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('远端改过的标题');

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
      syncResponse({
        navRevision: 42,
        changes: [
          syncUpsert({ entityId: 'L3', payload: link('L3', { title: '远端新增站点', sortOrder: 2 }), seq: 21 }),
        ],
        nextCursor: encodeSyncCursor(21),
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
  it('服务端拒绝游标：丢弃本地游标、给出可见提示，下一轮从头同步', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      syncResponse({ navRevision: 3, nextCursor: encodeSyncCursor(5) }),
      failureResult<SyncChangesResponse>({
        status: 422,
        code: 'validation_failed',
        message: '请求参数校验失败。',
        details: { reason: 'cursor_version_unsupported' },
      }),
      emptySyncResponse({ navRevision: 4 }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('以太之光');

    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(2);
    });
    // 第二轮确实带着旧游标发出。
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(5));
    // 可见提示（不静默）：说明游标已丢弃、将从头完整同步。
    const notice = await screen.findByTestId('nav-sync-notice');
    expect(notice.textContent).toContain('游标');
    expect(notice.textContent).toContain('完整同步');
    // 这不是「同步失败」，因此不显示成错误。
    expect(screen.queryByTestId('nav-error')).toBeNull();

    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    // 第三轮从头同步：不再带旧游标。
    expect(sync.queries[2]?.since).toBeNull();
  });

  it('原因未知的 422 不丢弃游标（只认结构化原因，绝不猜）', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      syncResponse({ navRevision: 3, nextCursor: encodeSyncCursor(5) }),
      failureResult<SyncChangesResponse>({
        status: 422,
        code: 'validation_failed',
        message: '请求参数校验失败。',
        details: { reason: 'something_else_entirely' },
      }),
      emptySyncResponse({ navRevision: 4 }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);
    await screen.findByText('以太之光');

    await user.click(screen.getByTestId('nav-sync-now'));
    expect(await screen.findByTestId('nav-error')).toBeDefined();
    await user.click(screen.getByTestId('nav-sync-now'));
    await waitFor(() => {
      expect(sync.queries.length).toBeGreaterThanOrEqual(3);
    });
    // 游标保持不变：原因不明时绝不擅自重来一次全量同步。
    expect(sync.queries[2]?.since).toBe(encodeSyncCursor(5));
    expect(screen.queryByTestId('nav-sync-notice')).toBeNull();
  });
});

describe('响应形状不符时整轮丢弃', () => {
  it('缺少 meta / entityTypes 的响应被丢弃，本地快照不被半可信数据改动', async () => {
    const user = userEvent.setup();
    const api = fakeNavApi({ snapshot: baseSnapshot() });
    /**
     * 这个替身**故意**返回不符合共享契约的响应（缺少 `entityTypes` 与 `meta`）：
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
      emptySyncResponse({ navRevision: 2 }),
      syncResponse({
        navRevision: 9,
        changes: [syncUpsert({ entityId: 'L1', payload: remoteRow, seq: 13, revision: 9, updatedAt: 400 })],
        nextCursor: encodeSyncCursor(13),
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
      syncResponse({
        navRevision: 9,
        changes: [syncUpsert({ entityId: 'L1', payload: remoteRow, seq: 14, revision: 9, updatedAt: 500 })],
        nextCursor: encodeSyncCursor(14),
      }),
    ]);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={sync.api} />);

    // 挂载时的首次同步就会应用这条 upsert。
    expect(await screen.findByText('远端新标题')).toBeDefined();
    expect(screen.queryByText('以太之光')).toBeNull();
    // 没有草稿 → 不出现任何冲突提示。
    expect(screen.queryByTestId('nav-conflict')).toBeNull();
  });

  it('本地草稿遇到远端删除：草稿保留并说明「已被删除」', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([
      emptySyncResponse({ navRevision: 2 }),
      syncResponse({
        navRevision: 10,
        changes: [syncDelete({ entityId: 'L1', seq: 15, revision: 9, updatedAt: 600 })],
        nextCursor: encodeSyncCursor(15),
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
