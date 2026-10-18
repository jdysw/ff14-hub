/**
 * 完整导航视图测试（阶段 04 / HUB-007 · 008 · 009 · 047 · 048）。
 *
 * 这些用例把「界面行为」与「共享纯函数的事实」绑在一起：
 * 断言列表内容时，期望值是用**同一个** `projectNavLinks` 算出来的，
 * 因此界面不可能自己偷偷维护第二套筛选/排序规则。
 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectNavLinks, type NavFilter, type NavSnapshot } from '@ff14-hub/shared';
import { NavView } from '../src/app/nav/NavView';
import { useNav } from '../src/app/nav/use-nav';
import type { NavApi } from '../src/app/nav/nav-api';
import { catalogEntry, fakeNavApi, fakeSyncApi, group, link, membership, snapshot } from './nav-fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKEN = 'test-session-token';

interface HarnessProps {
  readonly api: NavApi;
  readonly syncApi: ReturnType<typeof fakeSyncApi>['api'];
}

/** 承载真实 `useNav` + `NavView` 的测试外壳（只注入 API 替身，不绕过状态层）。 */
function Harness(props: HarnessProps) {
  const state = useNav({
    getToken: () => TOKEN,
    enabled: true,
    api: props.api,
    syncApi: props.syncApi,
    // 关闭定时轮询：测试只通过「立即同步」按钮显式触发，避免时间不确定。
    syncIntervalMs: 0,
  });
  return <NavView state={state} />;
}

/** 三条链接 + 一个分组 + 一条成员关系（顺序即 sortOrder）。 */
function baseSnapshot(): NavSnapshot {
  return snapshot({
    revision: 7,
    links: [
      link('L1', { title: '以太之光广场', url: 'https://cn.example.com/a', tags: ['工具'], sortOrder: 0, isFavorite: true }),
      link('L2', { title: '国际服资料站', url: 'https://global.example.com/b', region: 'global', sortOrder: 1 }),
      link('L3', { title: 'FF14 新闻', description: '每日新闻速递', region: 'cn', sortOrder: 2 }),
    ],
    groups: [group('G1', { name: '资料' })],
    memberships: [membership('L2', 'G1')],
  });
}

function expectationFor(snap: NavSnapshot, filter: NavFilter): readonly string[] {
  return projectNavLinks({
    links: snap.links,
    groups: snap.groups,
    memberships: snap.memberships,
    filter,
  }).map((view) => view.title);
}

function renderedTitles(): string[] {
  return screen.getAllByTestId('nav-link-item').map((item) => {
    const anchor = within(item).getByTestId('nav-link-anchor');
    return anchor.textContent ?? '';
  });
}

/**
 * 往输入框里填文本。
 *
 * 为什么用「点击 + 粘贴」而不是 `user.type`：`user.type` 会把 `{` / `[` 当成键盘描述符
 * （JSON 文本里到处是这两个字符），而粘贴是按字面量插入的，语义上更贴近「用户粘贴一段 JSON」。
 */
async function pasteInto(user: ReturnType<typeof userEvent.setup>, element: HTMLElement, text: string): Promise<void> {
  await user.click(element);
  await user.paste(text);
}

describe('列表渲染与筛选', () => {
  it('默认按个人顺序渲染全部链接（期望值来自共享 projectNavLinks）', async () => {
    const snap = baseSnapshot();
    const fake = fakeNavApi({ snapshot: snap });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('nav-link-item')).toHaveLength(3);
    });
    expect(renderedTitles()).toEqual(expectationFor(snap, { sort: 'manual' }));
    // 主机名、区服徽章、收藏标记、所属分组、未探测状态都在行里。
    const first = screen.getAllByTestId('nav-link-item')[0] as HTMLElement;
    expect(within(first).getByTestId('nav-link-host').textContent).toBe('cn.example.com');
    expect(within(first).getByTestId('nav-link-region').textContent).toBe('国服');
    expect(within(first).getByTestId('nav-link-favorite-mark')).toBeDefined();
    expect(within(first).getByTestId('nav-link-health').textContent).toBe('未探测');
    const second = screen.getAllByTestId('nav-link-item')[1] as HTMLElement;
    expect(within(second).getByTestId('nav-link-groups').textContent).toBe('资料');
  });

  it('关键词筛选命中标题 / 别名 / 描述 / 标签，且期望值与共享纯函数一致', async () => {
    const user = userEvent.setup();
    const snap = baseSnapshot();
    const fake = fakeNavApi({ snapshot: snap });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await user.type(screen.getByTestId('nav-filter-text'), '新闻');
    expect(renderedTitles()).toEqual(expectationFor(snap, { text: '新闻', sort: 'manual' }));

    await user.clear(screen.getByTestId('nav-filter-text'));
    await user.type(screen.getByTestId('nav-filter-text'), '工具');
    expect(renderedTitles()).toEqual(expectationFor(snap, { text: '工具', sort: 'manual' }));

    // 清空后回到全部。
    await user.clear(screen.getByTestId('nav-filter-text'));
    expect(renderedTitles()).toEqual(expectationFor(snap, { sort: 'manual' }));
  });

  it('区服 / 分组 / 只看收藏筛选都走共享规则', async () => {
    const user = userEvent.setup();
    const snap = baseSnapshot();
    const fake = fakeNavApi({ snapshot: snap });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await user.selectOptions(screen.getByTestId('nav-filter-region'), 'global');
    expect(renderedTitles()).toEqual(expectationFor(snap, { region: 'global', sort: 'manual' }));

    await user.selectOptions(screen.getByTestId('nav-filter-region'), '');
    await user.selectOptions(screen.getByTestId('nav-filter-group'), 'G1');
    expect(renderedTitles()).toEqual(expectationFor(snap, { groupId: 'G1', sort: 'manual' }));

    await user.selectOptions(screen.getByTestId('nav-filter-group'), '');
    await user.click(screen.getByTestId('nav-filter-favorites'));
    expect(renderedTitles()).toEqual(expectationFor(snap, { favoritesOnly: true, sort: 'manual' }));

    // 排序选择：标题序。
    await user.click(screen.getByTestId('nav-filter-favorites'));
    await user.selectOptions(screen.getByTestId('nav-sort'), 'title');
    expect(renderedTitles()).toEqual(expectationFor(snap, { sort: 'title' }));
  });

  it('空导航显示明确空态与两个入口（不隐藏功能）', async () => {
    const fake = fakeNavApi({ snapshot: snapshot({ links: [], groups: [] }) });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    expect(await screen.findByTestId('nav-empty')).toBeDefined();
    expect(screen.getByTestId('nav-empty-create')).toBeDefined();
    expect(screen.getByTestId('nav-empty-catalog')).toBeDefined();
  });
});

describe('链接 CRUD 走正确的操作', () => {
  it('新建链接：提交带 operationId 的请求，成功后刷新并提示', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await user.click(screen.getByTestId('nav-new-link'));
    await user.type(screen.getByTestId('nav-link-title'), '新站点');
    await user.type(screen.getByTestId('nav-link-url'), 'https://new.example.com/');
    await user.type(screen.getByTestId('nav-link-tags'), '工具，攻略');
    await user.click(screen.getByTestId('nav-link-submit'));

    await waitFor(() => {
      expect(fake.calls.createLink).toHaveBeenCalledTimes(1);
    });
    const request = fake.calls.createLink.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['title']).toBe('新站点');
    expect(request['url']).toBe('https://new.example.com/');
    expect(request['tags']).toEqual(['工具', '攻略']);
    expect(typeof request['operationId']).toBe('string');
    expect((request['operationId'] as string).length).toBeGreaterThanOrEqual(8);
    // 成功后重新拉取快照（成员关系与分组名由服务端权威给出）。
    expect(fake.calls.readSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('编辑链接：提交**该行**的行修订作为 expectedRevision（与服务端 CAS 语义一致）', async () => {
    const user = userEvent.setup();
    const snap = baseSnapshot();
    const fake = fakeNavApi({ snapshot: snap });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await user.click(within(screen.getAllByTestId('nav-link-item')[0] as HTMLElement).getByTestId('nav-link-edit'));
    const titleInput = screen.getByTestId('nav-link-title');
    await user.clear(titleInput);
    await user.type(titleInput, '以太之光（改名）');
    await user.click(screen.getByTestId('nav-link-submit'));

    await waitFor(() => {
      expect(fake.calls.updateLink).toHaveBeenCalledTimes(1);
    });
    const [linkId, request] = fake.calls.updateLink.mock.calls[0] as [string, Record<string, unknown>];
    expect(linkId).toBe('L1');
    // 关键回归（阶段 04 复核发现真实缺陷）：服务端 PATCH 的 CAS 比较的是**行修订**
    // （`workspace_nav_links.revision`），而不是工作空间修订。早先这里提交的是
    // `snap.revision`（工作空间级），导致链接编辑保存**永远 409**。
    expect(request['expectedRevision']).toBe(1);
    expect(snap.revision).not.toBe(1);
    expect(request['title']).toBe('以太之光（改名）');
    expect(typeof request['operationId']).toBe('string');
  });

  it('收藏切换走 updateLink（带该行 revision 的 CAS）', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    const firstRow = () => screen.getAllByTestId('nav-link-item')[0] as HTMLElement;
    await user.click(within(firstRow()).getByTestId('nav-link-toggle-favorite'));
    await waitFor(() => {
      expect(fake.calls.updateLink).toHaveBeenCalledTimes(1);
    });
    const [favLinkId, favRequest] = fake.calls.updateLink.mock.calls[0] as [string, Record<string, unknown>];
    expect(favLinkId).toBe('L1');
    expect(favRequest['isFavorite']).toBe(false);
    expect(favRequest['expectedRevision']).toBe(1);
    expect(typeof favRequest['operationId']).toBe('string');
  });

  it('删除链接：带该行 revision 的 CAS 请求', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    const firstRow = () => screen.getAllByTestId('nav-link-item')[0] as HTMLElement;
    await user.click(within(firstRow()).getByTestId('nav-link-delete'));
    await waitFor(() => {
      expect(fake.calls.deleteLink).toHaveBeenCalledTimes(1);
    });
    const [deletedId, deleteRequest] = fake.calls.deleteLink.mock.calls[0] as [string, Record<string, unknown>];
    expect(deletedId).toBe('L1');
    expect(deleteRequest['expectedRevision']).toBe(1);
    expect(typeof deleteRequest['operationId']).toBe('string');
  });

  it('个人排序（上移 / 下移）提交全部活跃链接的期望顺序', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    const rows = screen.getAllByTestId('nav-link-item');
    await user.click(within(rows[2] as HTMLElement).getByTestId('nav-link-move-up'));
    await waitFor(() => {
      expect(fake.calls.reorderLinks).toHaveBeenCalledTimes(1);
    });
    const request = fake.calls.reorderLinks.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['orderedIds']).toEqual(['L1', 'L3', 'L2']);
    expect(request['expectedRevision']).toBe(7);
  });

  it('危险 URL（javascript:）就地报错且不发任何请求', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await user.click(screen.getByTestId('nav-new-link'));
    await user.type(screen.getByTestId('nav-link-title'), '恶意站点');
    await user.type(screen.getByTestId('nav-link-url'), 'javascript:alert(1)');
    await user.click(screen.getByTestId('nav-link-submit'));

    expect(await screen.findByTestId('nav-link-url-error')).toBeDefined();
    expect(screen.getByTestId('nav-link-url-error').textContent).toContain('未发出任何请求');
    expect(fake.calls.createLink).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('分组管理', () => {
  it('新建 / 改名 / 重排 / 删除分组各走对应操作', async () => {
    const user = userEvent.setup();
    const snap = snapshot({
      revision: 3,
      links: [link('L1')],
      groups: [group('G1', { name: '资料' }), group('G2', { name: '工具', sortOrder: 1 })],
      memberships: [],
    });
    const fake = fakeNavApi({ snapshot: snap });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByTestId('nav-group-list');

    await user.type(screen.getByTestId('nav-group-new-name'), '新分组');
    await user.click(screen.getByTestId('nav-group-create'));
    await waitFor(() => {
      expect(fake.calls.createGroup).toHaveBeenCalledTimes(1);
    });
    const createRequest = fake.calls.createGroup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createRequest['name']).toBe('新分组');
    expect(typeof createRequest['operationId']).toBe('string');

    const groupRows = screen.getAllByTestId('nav-group-item');
    const firstGroupInput = within(groupRows[0] as HTMLElement).getByTestId('nav-group-name');
    await user.clear(firstGroupInput);
    await user.type(firstGroupInput, '资料站');
    await user.click(within(groupRows[0] as HTMLElement).getByTestId('nav-group-rename'));
    await waitFor(() => {
      expect(fake.calls.updateGroup).toHaveBeenCalledTimes(1);
    });
    expect(fake.calls.updateGroup.mock.calls[0]?.[0]).toBe('G1');
    expect((fake.calls.updateGroup.mock.calls[0]?.[1] as Record<string, unknown>)['name']).toBe('资料站');

    await user.click(within(screen.getAllByTestId('nav-group-item')[1] as HTMLElement).getByTestId('nav-group-move-up'));
    await waitFor(() => {
      expect(fake.calls.reorderGroups).toHaveBeenCalledTimes(1);
    });
    expect((fake.calls.reorderGroups.mock.calls[0]?.[0] as Record<string, unknown>)['orderedIds']).toEqual(['G2', 'G1']);

    await user.click(within(screen.getAllByTestId('nav-group-item')[0] as HTMLElement).getByTestId('nav-group-delete'));
    await waitFor(() => {
      expect(fake.calls.deleteGroup).toHaveBeenCalledTimes(1);
    });
  });
});

describe('推荐目录', () => {
  it('tombstoned 条目显示状态、默认不勾选，并提供「显式再次导入」按钮', async () => {
    const user = userEvent.setup();
    const entryC1 = catalogEntry('C1', { title: '目录条目 C1' });
    const snap = snapshot({
      revision: 2,
      links: [
        // 与目录内容**逐字段一致**的个人副本 → 状态应为 unchanged。
        link('L-imported', {
          title: entryC1.title,
          url: entryC1.url,
          description: entryC1.description,
          icon: entryC1.icon,
          openMode: entryC1.openMode,
          region: entryC1.region,
          tags: [...entryC1.tags],
          aliases: [...entryC1.aliases],
          sourceCatalogId: 'C1',
          importedSourceVersion: 1,
        }),
        // 用户删掉过的副本（墓碑）→ 状态应为 tombstoned。
        link('L-deleted', {
          title: '我删掉过的条目',
          sourceCatalogId: 'C2',
          importedSourceVersion: 1,
          deletedAt: 1_700_000_100_000,
        }),
      ],
    });
    const fake = fakeNavApi({
      snapshot: snap,
      catalog: [catalogEntry('C1', { title: '目录条目 C1' }), catalogEntry('C2', { title: '目录条目 C2' })],
    });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('目录条目 C1');

    await user.click(screen.getByTestId('nav-catalog-load'));

    const rows = await screen.findAllByTestId('nav-catalog-entry');
    const c2Row = rows.find((row) => row.getAttribute('data-catalog-id') === 'C2') as HTMLElement;
    expect(c2Row.getAttribute('data-catalog-state')).toBe('tombstoned');
    expect(within(c2Row).getByTestId('nav-catalog-state').textContent).toContain('你删除过');
    // 默认不可勾选：墓碑只能靠用户**显式**再次导入恢复。
    expect(within(c2Row).getByTestId<HTMLInputElement>('nav-catalog-select').checked).toBe(false);
    expect(within(c2Row).getByTestId('nav-catalog-reimport').textContent).toContain('显式再次导入');

    const c1Row = rows.find((row) => row.getAttribute('data-catalog-id') === 'C1') as HTMLElement;
    // 与目录一致的条目默认勾选：可以安全导入。
    expect(c1Row.getAttribute('data-catalog-state')).toBe('unchanged');
    expect(within(c1Row).getByTestId<HTMLInputElement>('nav-catalog-select').checked).toBe(true);
  });

  it('本地状态优先于服务端投影：刚改过的条目立即显示 user_modified，墓碑仍来自服务端投影', async () => {
    const user = userEvent.setup();
    const entryC1 = catalogEntry('C1', { title: '目录条目 C1' });
    const snap = snapshot({
      revision: 3,
      links: [
        // 本地看到的事实：这条已经被用户改过（收藏）。
        link('L-imported', {
          title: entryC1.title,
          url: entryC1.url,
          description: entryC1.description,
          icon: entryC1.icon,
          openMode: entryC1.openMode,
          region: entryC1.region,
          tags: [...entryC1.tags],
          aliases: [...entryC1.aliases],
          sourceCatalogId: 'C1',
          importedSourceVersion: 1,
          isFavorite: true,
        }),
      ],
      // 服务端投影随快照冻结点一起返回：这里刻意给一个**过期**的 unchanged。
      // 若界面无条件采用投影，刚改过的条目会被显示回 unchanged（端到端验收发现的回归）。
      catalogPlan: [
        { catalogId: 'C1', state: 'unchanged', linkId: 'L-imported' },
        // C2 的墓碑行不在 links 里（快照只含活跃行），只有服务端投影能证明「你删除过」。
        { catalogId: 'C2', state: 'tombstoned', linkId: 'L-deleted' },
      ],
    });
    const fake = fakeNavApi({
      snapshot: snap,
      catalog: [catalogEntry('C1', { title: '目录条目 C1' }), catalogEntry('C2', { title: '目录条目 C2' })],
    });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('目录条目 C1');
    await user.click(screen.getByTestId('nav-catalog-load'));

    const rows = await screen.findAllByTestId('nav-catalog-entry');
    const c1Row = rows.find((row) => row.getAttribute('data-catalog-id') === 'C1') as HTMLElement;
    expect(c1Row.getAttribute('data-catalog-state')).toBe('user_modified');
    const c2Row = rows.find((row) => row.getAttribute('data-catalog-id') === 'C2') as HTMLElement;
    expect(c2Row.getAttribute('data-catalog-state')).toBe('tombstoned');
    expect(within(c2Row).getByTestId<HTMLInputElement>('nav-catalog-select').checked).toBe(false);
  });

  it('导入选中的目录条目时把显式标志一并提交', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({
      snapshot: snapshot({ revision: 2, links: [link('L-deleted', { sourceCatalogId: 'C2', deletedAt: 5 })] }),
      catalog: [catalogEntry('C2', { title: '目录条目 C2' })],
    });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    // 唯一的链接是墓碑 → 列表为空，显示空态。
    await screen.findByTestId('nav-empty');
    await user.click(screen.getByTestId('nav-catalog-load'));
    const row = await screen.findByTestId('nav-catalog-entry');
    expect(row.getAttribute('data-catalog-state')).toBe('tombstoned');

    // 墓碑条目默认没勾选 → 直接点导入会说「请先勾选」。
    await user.click(screen.getByTestId('nav-catalog-import'));
    expect(fake.calls.importCatalog).not.toHaveBeenCalled();

    await user.click(within(row).getByTestId('nav-catalog-reimport'));
    await user.click(screen.getByTestId('nav-catalog-explicit'));
    await user.click(screen.getByTestId('nav-catalog-overwrite'));
    await user.click(screen.getByTestId('nav-catalog-import'));

    await waitFor(() => {
      expect(fake.calls.importCatalog).toHaveBeenCalledTimes(1);
    });
    const request = fake.calls.importCatalog.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['catalogIds']).toEqual(['C2']);
    expect(request['explicitReimport']).toBe(true);
    expect(request['overwriteUserEdits']).toBe(true);
  });
});

describe('书签 / JSON 导入预览', () => {
  it('书签 HTML 在本地解析：逐项列出跳过原因，且页面里不出现任何 HTML 标签文本', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    const bookmarkHtml = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<H3>分组A</H3>',
      '<A HREF="https://ok.example.com/x">好的站点</A>',
      '<A HREF="http://insecure.example.com">http 站点</A>',
      '<A HREF="https://dup.example.com">重复</A>',
      '<A HREF="https://dup.example.com">重复</A>',
      '<A HREF="https://evil.example.com/"><img src=x onerror=alert(1)>恶意标题</A>',
      "<script>alert('导入文件里的脚本绝不能执行')</script>",
    ].join('\n');
    const file = new File([bookmarkHtml], 'bookmarks.html', { type: 'text/html' });
    await user.upload(screen.getByTestId('nav-import-file-input'), file);

    // 逐项展示「将被导入」的条目（标签被剥掉，只剩文本）：
    // 好的站点 + 重复（只保留第一条）+ 恶意标题（标签被剥离的文本）。
    await waitFor(() => {
      expect(screen.getAllByTestId('nav-import-item')).toHaveLength(3);
    });
    expect(screen.getByText('好的站点')).toBeDefined();
    expect(screen.getByText('恶意标题')).toBeDefined();

    // 跳过项逐条给出原因（http 协议 / 重复）。
    const skipped = screen.getAllByTestId('nav-import-skipped-item');
    expect(skipped).toHaveLength(2);
    const reasons = screen.getAllByTestId('nav-import-skip-reason').map((node) => node.textContent ?? '');
    expect(reasons).toEqual(expect.arrayContaining(['只允许 https', '同一地址重复出现']));

    // **绝不**把外来 HTML 插进 DOM。
    const html = document.body.innerHTML;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('粘贴 JSON：本地解析 + 服务端预览 + 显式确认 apply 才写入', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await pasteInto(
      user,
      screen.getByTestId('nav-import-json-text'),
      '{"links":[{"title":"JSON 站点","url":"https://json.example.com/"}]}',
    );
    await user.click(screen.getByTestId('nav-import-json-parse'));
    expect(screen.getByTestId('nav-import-local')).toBeDefined();
    expect(screen.getByText('JSON 站点')).toBeDefined();

    await user.click(screen.getByTestId('nav-import-preview'));
    await waitFor(() => {
      expect(fake.calls.previewImport).toHaveBeenCalledTimes(1);
    });
    const previewRequest = fake.calls.previewImport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((previewRequest['items'] as { title: string }[])[0]?.title).toBe('JSON 站点');

    await screen.findByTestId('nav-import-preview-result');
    await user.click(screen.getByTestId('nav-import-apply'));
    await waitFor(() => {
      expect(fake.calls.applyImport).toHaveBeenCalledTimes(1);
    });
    const applyRequest = fake.calls.applyImport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(applyRequest['expectedRevision']).toBe(7);
    expect(typeof applyRequest['operationId']).toBe('string');
  });

  it('本地解析失败（非法 JSON）时逐项给出原因，不进入服务端预览', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await pasteInto(user, screen.getByTestId('nav-import-json-text'), '{ 这不是 JSON');
    await user.click(screen.getByTestId('nav-import-json-parse'));

    expect(screen.getAllByTestId('nav-import-skipped-item')).toHaveLength(1);
    expect(screen.getByTestId('nav-import-skip-reason').textContent).toBe('地址形态不可用');
    expect(screen.getByText(/不是合法 JSON/)).toBeDefined();
    expect(fake.calls.previewImport).not.toHaveBeenCalled();
  });
});

describe('导出与读回校验', () => {
  it('导出走 nav.export，且导出内容能被共享 parseNavExportDocument 读回（往返稳定）', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await user.click(screen.getByTestId('nav-export-run'));
    await waitFor(() => {
      expect(fake.calls.exportDocument).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId('nav-export-notice')).toBeDefined();
    const output = screen.getByTestId<HTMLTextAreaElement>('nav-export-output');
    expect(output.value).toContain('"schemaVersion": 1');

    await user.click(screen.getByTestId('nav-export-copy'));
    const result = await screen.findByTestId('nav-export-readback-result');
    expect(result.textContent).toContain('读回成功');
    expect(result.textContent).toContain('往返稳定');
  });

  it('读回校验对损坏文档给出明确失败原因', async () => {
    const user = userEvent.setup();
    const fake = fakeNavApi({ snapshot: baseSnapshot() });
    render(<Harness api={fake.api} syncApi={fakeSyncApi().api} />);
    await screen.findByText('以太之光广场');

    await pasteInto(user, screen.getByTestId('nav-export-readback-input'), '{"schemaVersion":99}');
    await user.click(screen.getByTestId('nav-export-readback'));
    const result = await screen.findByTestId('nav-export-readback-result');
    expect(result.textContent).toContain('读回失败');
    expect(result.textContent).toContain('99');
  });
});
