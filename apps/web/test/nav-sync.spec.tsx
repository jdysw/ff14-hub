/**
 * 跨设备变更应用的测试（阶段 04 / HUB-051 客户端侧）。
 *
 * 三条必须成立的事实（对应任务书的三个用例）：
 * 1. **删除即删除**：收到 `nav_link` 的 `op:'delete'` 后本地列表移除，
 *    且随后到达的**更早的 upsert**不会把它加回来（墓碑防复活）；
 * 2. **草稿优先**：正在编辑的链接收到远端更新 → 草稿保留 + 明确提示 + **不自动保存**；
 * 3. **无草稿时应用**：远端 upsert 直接反映到列表里。
 *
 * 另外验证：游标按共享 `encodeSyncCursor` / `decodeSyncCursor` 往返推进，
 * 以及形状不符的响应被整轮丢弃（不会用半可信数据改本地快照）。
 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSyncCursor, type SyncChangesResponse } from '@ff14-hub/shared';
import { NavView } from '../src/app/nav/NavView';
import { useNav } from '../src/app/nav/use-nav';
import type { NavApi, SyncChangesApi } from '../src/app/nav/nav-api';
import { emptySyncResponse, fakeNavApi, fakeSyncApi, link, snapshot } from './nav-fixtures';

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

function upsertLink(linkRow: ReturnType<typeof link>, revision: number, updatedAt: number): SyncChangesResponse['changes'][number] {
  return {
    entityType: 'nav_link',
    entityId: linkRow.id,
    op: 'upsert',
    revision,
    updatedAt,
    payload: linkRow,
  };
}

function baseSnapshot() {
  return snapshot({
    revision: 2,
    links: [link('L1', { title: '以太之光', sortOrder: 0 }), link('L2', { title: '国际服资料站', sortOrder: 1 })],
  });
}

describe('远端删除与防复活', () => {
  it('收到 nav_link 的 delete 后本地移除，且更早的 upsert 不会把它加回来', async () => {
    const user = userEvent.setup();
    const first: SyncChangesResponse = {
      changes: [{ entityType: 'nav_link', entityId: 'L2', op: 'delete', revision: 3, updatedAt: 200, payload: null }],
      nextCursor: 'v1:200',
      hasMore: false,
      serverTimeMs: 200,
      entityTypes: ['nav_link', 'nav_group', 'nav_membership'],
    };
    // 第二轮：一个**更早**的旧 upsert（updatedAt 150 < 墓碑 200）——绝不允许复活。
    const second: SyncChangesResponse = {
      changes: [upsertLink(link('L2', { title: '被删掉的站点' }), 2, 150)],
      nextCursor: 'v1:150',
      hasMore: false,
      serverTimeMs: 260,
      entityTypes: ['nav_link', 'nav_group', 'nav_membership'],
    };
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
    expect(sync.queries[1]?.since).toBe(encodeSyncCursor(200));
  });

  it('形状不符的变更响应被整轮丢弃（不会用半可信数据改本地快照）', async () => {
    const user = userEvent.setup();
    const sync = fakeSyncApi([emptySyncResponse()]);
    const api = fakeNavApi({ snapshot: baseSnapshot() });
    // 覆写 readChanges：返回一个**缺少 entityTypes** 的响应（违反共享 Schema）。
    /**
     * 这个替身**故意**返回不符合共享契约的响应（缺少 `entityTypes`）：它只用于验证
     * 「形状不符 → 整轮丢弃」这条分支，因此这里显式断言它的类型不安全。
     */
    const broken = {
      readChanges: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          data: {
          changes: [
            { entityType: 'nav_link', entityId: 'L1', op: 'delete', revision: 9, updatedAt: 900, payload: null },
          ],
            nextCursor: null,
            hasMore: false,
            serverTimeMs: 900,
          },
        }),
      ),
    } as unknown as SyncChangesApi;
    void sync;
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
      emptySyncResponse(),
      {
        changes: [upsertLink(remoteRow, 9, 400)],
        nextCursor: 'v1:400',
        hasMore: false,
        serverTimeMs: 400,
        entityTypes: ['nav_link', 'nav_group', 'nav_membership'],
      },
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
      {
        changes: [upsertLink(remoteRow, 9, 500)],
        nextCursor: 'v1:500',
        hasMore: false,
        serverTimeMs: 500,
        entityTypes: ['nav_link', 'nav_group', 'nav_membership'],
      },
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
      emptySyncResponse(),
      {
        changes: [{ entityType: 'nav_link', entityId: 'L1', op: 'delete', revision: 9, updatedAt: 600, payload: null }],
        nextCursor: 'v1:600',
        hasMore: false,
        serverTimeMs: 600,
        entityTypes: ['nav_link', 'nav_group', 'nav_membership'],
      },
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
