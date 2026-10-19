// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_WIDGET_IDS } from '@ff14-hub/shared';
import { HomeView } from '../src/app/shell/HomeView';
import { useNav } from '../src/app/nav/use-nav';
import { catalogEntry, fakeNavApi, fakeSyncApi, link, snapshot } from './nav-fixtures';
import { instance, page } from './workbench-fixtures';

afterEach(cleanup);
const sync = fakeSyncApi().api;
const readOnlyWorkbench = {
  activePage: null, status: 'ready' as const, error: null, instances: [], persistedRects: [],
  dirty: false, conflict: null, reload: vi.fn(async () => {}),
};
const onOpen = vi.fn();
function Harness({ authenticated = false, workbench = readOnlyWorkbench }: {
  authenticated?: boolean; workbench?: Parameters<typeof HomeView>[0]['workbench'];
}) {
  const fake = fakeNavApi({
    snapshot: snapshot({ links: [link('personal', { title: '我的收藏', isFavorite: true })] }),
    catalog: [catalogEntry('catalog', { title: '资料检索', aliases: ['wiki'] })],
  });
  // API 替身保持稳定；交互经过真实导航控制器。
  const stable = useStableApi(fake.api);
  const nav = useNav({ getToken: () => authenticated ? 'test-token' : null, enabled: authenticated, api: stable, syncApi: sync, syncIntervalMs: 0 });
  return <HomeView nav={nav} workbench={workbench} authenticated={authenticated}
    access={() => ({ status: 'disabled', grantedCapabilities: [] })} dataPortFor={() => undefined} onOpen={onOpen}/>;
}
function useStableApi<T>(value: T): T { return useState(() => value)[0]; }

describe('日常首页', () => {
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
