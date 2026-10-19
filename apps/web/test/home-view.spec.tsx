// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_WIDGET_IDS, type NavCatalogEntry } from '@ff14-hub/shared';
import { HomeView } from '../src/app/shell/HomeView';
import { DEFAULT_SITE_SETTINGS } from '../src/app/admin/site-settings';
import { useNav } from '../src/app/nav/use-nav';
import { catalogEntry, fakeNavApi, fakeSyncApi, link, linkView, snapshot } from './nav-fixtures';
import { groupDirectoryLinks } from '../src/app/shell/NavigationDirectory';
import { instance, page } from './workbench-fixtures';

afterEach(cleanup);
const sync = fakeSyncApi().api;
const readOnlyWorkbench = {
  activePage: null, status: 'ready' as const, error: null, instances: [], persistedRects: [],
  dirty: false, conflict: null, reload: vi.fn(async () => {}),
};
const onOpen = vi.fn();
function Harness({ authenticated = false, workbench = readOnlyWorkbench, catalog }: {
  authenticated?: boolean; workbench?: Parameters<typeof HomeView>[0]['workbench'];
  catalog?: readonly NavCatalogEntry[];
}) {
  const fake = fakeNavApi({
    snapshot: snapshot({ links: [link('personal', { title: '我的收藏', isFavorite: true })] }),
    catalog: catalog ?? [catalogEntry('catalog', { title: '资料检索', aliases: ['wiki'] })],
  });
  // API 替身保持稳定；交互经过真实导航控制器。
  const stable = useStableApi(fake.api);
  const nav = useNav({ getToken: () => authenticated ? 'test-token' : null, enabled: authenticated, api: stable, syncApi: sync, syncIntervalMs: 0 });
  return <HomeView nav={nav} workbench={workbench} authenticated={authenticated}
    access={() => ({ status: 'disabled', grantedCapabilities: [] })} dataPortFor={() => undefined} onOpen={onOpen} siteSettings={DEFAULT_SITE_SETTINGS}/>;
}
function useStableApi<T>(value: T): T { return useState(() => value)[0]; }

describe('日常首页', () => {
  it('400 个站点按 20 个真实分类呈现，索引可定位且简介按需显示', async () => {
    const catalog = Array.from({ length: 400 }, (_, index) => catalogEntry(`site-${index}`, {
      title: `站点 ${index}`, category: `分类 ${Math.floor(index / 20)}`, description: `用途说明 ${index}`,
    }));
    render(<Harness catalog={catalog}/>);
    await screen.findByRole('link', { name: '站点 399' });
    const index = screen.getByRole('navigation', { name: '网站分类索引' });
    expect(within(index).getAllByRole('link')).toHaveLength(20);
    const anchor = within(index).getAllByRole('link')[19];
    const target = document.getElementById((anchor?.getAttribute('href') ?? '').slice(1));
    expect(target?.textContent).toBe('分类 1920');
    expect(screen.queryByText('用途说明 399')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '显示简介' }));
    expect(screen.getByText('用途说明 399')).toBeDefined();
    expect(screen.getByText('400 个站点 · 20 个分类')).toBeDefined();
  });
  it('国服与国际服筛选均保留通用站点，清空筛选恢复目录', async () => {
    render(<Harness catalog={[
      catalogEntry('cn', { title: '国服入口', region: 'cn' }),
      catalogEntry('global', { title: '国际服入口', region: 'global' }),
      catalogEntry('both', { title: '通用工具', region: 'both' }),
    ]}/>);
    await screen.findByRole('link', { name: '国服入口' });
    fireEvent.change(screen.getByRole('combobox', { name: '导航区服' }), { target: { value: 'cn' } });
    expect(screen.queryByRole('link', { name: '国际服入口' })).toBeNull();
    expect(screen.getByRole('link', { name: '通用工具' })).toBeDefined();
    fireEvent.change(screen.getByRole('combobox', { name: '导航区服' }), { target: { value: 'global' } });
    expect(screen.queryByRole('link', { name: '国服入口' })).toBeNull();
    expect(screen.getByRole('link', { name: '通用工具' })).toBeDefined();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '无结果' } });
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }));
    expect(screen.getByRole('link', { name: '国服入口' })).toBeDefined();
    expect(screen.getByRole('link', { name: '国际服入口' })).toBeDefined();
  });
  it('个人多分组保留归属和配置顺序，未分组链接不会丢失', () => {
    const shared = linkView(link('shared'), ['a', 'b'], ['攻略', '采集']);
    const plain = linkView(link('plain'));
    const groups = groupDirectoryLinks([shared, plain], [{ id: 'b', name: '采集' }, { id: 'a', name: '攻略' }]);
    expect(groups.map(group => group.name)).toEqual(['采集', '攻略', '未分组']);
    expect(groups.map(group => group.links.map(item => item.id))).toEqual([['shared'], ['shared'], ['plain']]);
  });
  it('公开目录可搜索别名，空态可恢复，并保留链接的安全打开属性', async () => {
    render(<Harness/>);
    const anchor = await screen.findByRole('link', { name: /资料检索/ });
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'wiki' } });
    expect(screen.getByRole('link', { name: /资料检索/ })).toBeDefined();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在' } });
    expect(screen.queryByRole('link', { name: /资料检索/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }));
    expect(screen.getByRole('link', { name: /资料检索/ })).toBeDefined();
  });
  it('连接后使用个人目录，收藏筛选不混入推荐目录', async () => {
    render(<Harness authenticated/>);
    await screen.findByRole('link', { name: /我的收藏/ });
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    expect(screen.getByRole('link', { name: /我的收藏/ })).toBeDefined();
    expect(screen.queryByRole('link', { name: /资料检索/ })).toBeNull();
  });
  it('既有实例按已保存顺序呈现，隐藏实例不执行，禁用模块仍由 Host 拦截', async () => {
    const p = page('daily', '我的日常');
    const workbench = { ...readOnlyWorkbench, activePage: p,
      instances: [instance('late', DEMO_WIDGET_IDS.counter, p.id), instance('first', DEMO_WIDGET_IDS.counter, p.id), instance('hidden', DEMO_WIDGET_IDS.counter, p.id, { hidden: true })],
      persistedRects: [{ i: 'first', x: 0, y: 0, w: 6, h: 4 }, { i: 'late', x: 0, y: 4, w: 6, h: 4 }],
    };
    render(<Harness authenticated workbench={workbench}/>);
    await waitFor(() => expect(screen.getAllByTestId('widget-instance')).toHaveLength(2));
    expect(screen.getAllByTestId('widget-instance').map(node => node.dataset['instanceId'])).toEqual(['first', 'late']);
    expect(screen.getAllByTestId('widget-degraded')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: '日常信息' })).toBeNull();
    expect(workbench.reload).not.toHaveBeenCalled();
  });
  it('斜杠快捷键聚焦搜索，输入框中的斜杠不拦截', async () => {
    render(<Harness/>);
    await screen.findByRole('link', { name: /资料检索/ });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    screen.getByRole('searchbox').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
