/**
 * 导航 Widget 测试（阶段 04 / HUB-010 · 008 · 009）。
 *
 * 覆盖两个组件各自的**正常 / 空 / 错误 / 无端口降级**路径，以及最关键的一条接线：
 * Host 通过 `dataPortFor` 注入端口后，组件**只**用这个端口（用假端口断言被调用），
 * 而不是自己去 fetch。
 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_MODULE_ID, NAV_WIDGET_IDS } from '@ff14-hub/shared';
import { WidgetHost } from '../src/app/widgets/WidgetHost';
import type { ModuleAccess, ModuleDataPort, WidgetRuntimeProps } from '../src/app/widgets/types';
import type { WidgetInstance } from '../src/app/widgets/instance-store';
import { link, snapshot } from './nav-fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 替身返回值的两种形态：成功 / 失败（同步构造 Promise，避免 sync 无 wait）。 */
function resolves(value: unknown): Promise<unknown> {
  return Promise.resolve(value);
}

function rejects(error: Error): Promise<unknown> {
  return Promise.reject(error);
}

const NAV_ACCESS: ModuleAccess = {
  status: 'enabled',
  grantedCapabilities: ['storage:own', 'navigation:read-catalog'],
};

function accessOf(): ModuleAccess {
  return NAV_ACCESS;
}

function instance(widgetId: string, config: unknown): WidgetInstance {
  return {
    instanceId: 'i1',
    moduleId: NAV_MODULE_ID,
    widgetId,
    config,
    configVersion: 1,
    hidden: false,
  };
}

/** 假数据端口：记录调用并按需返回快照 / 抛错。 */
function fakePort(handler: (operation: string) => Promise<unknown>): {
  readonly port: ModuleDataPort;
  readonly call: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn((operation: string): Promise<unknown> => handler(operation));
  const port: ModuleDataPort = {
    moduleId: NAV_MODULE_ID,
    operations: ['nav.snapshot'],
    // 端口契约的 `call` 是泛型的；这里把记录用的 vi.fn 包一层，保持类型诚实。
    call: <T = unknown>(operation: string, _input?: unknown): Promise<T> => call(operation) as Promise<T>,
  };
  return { port, call };
}

/** 快照：三条链接（两条收藏、一条非收藏、一条国际服）。 */
function threeLinks() {
  return snapshot({
    revision: 4,
    links: [
      link('L1', { title: '以太之光', isFavorite: true, sortOrder: 0, tags: ['工具'] }),
      link('L2', { title: '国际服资料站', isFavorite: true, sortOrder: 1, region: 'global' }),
      link('L3', { title: 'FF14 新闻', isFavorite: false, sortOrder: 2, aliases: ['新闻站'] }),
    ],
  });
}

describe('nav-quick-links', () => {
  it('Host 注入端口后组件使用该端口（只读快照），并按收藏优先渲染', async () => {
    const { port, call } = fakePort(() => resolves(threeLinks()));
    render(
      <WidgetHost
        instances={[instance(NAV_WIDGET_IDS.quickLinks, { title: '常用网站', favoritesOnly: false, limit: 8 })]}
        access={accessOf}
        dataPortFor={() => port}
      />,
    );

    expect(await screen.findByText('以太之光')).toBeDefined();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('nav.snapshot');

    const items = screen.getAllByTestId('nav-quick-link');
    expect(items).toHaveLength(3);
    // 收藏优先：两条收藏排在最前（共享 sortNavLinks 的规则）。
    expect(items[0]?.getAttribute('data-link-id')).toBe('L1');
    expect(items[1]?.getAttribute('data-link-id')).toBe('L2');
    // 主机名与区服徽章都渲染出来。
    expect(within(items[0] as HTMLElement).getByText('example.com')).toBeDefined();
    expect(within(items[1] as HTMLElement).getByText('国际服')).toBeDefined();
    // 外链必须带 rel="noreferrer noopener"。
    const anchor = within(items[0] as HTMLElement).getByTestId('nav-quick-link-anchor');
    expect(anchor.getAttribute('rel')).toBe('noreferrer noopener');
    expect(anchor.getAttribute('target')).toBe('_blank');
  });

  it('limit 与 favoritesOnly 生效：只显示收藏且不超过上限', async () => {
    const { port } = fakePort(() => resolves(threeLinks()));
    render(
      <WidgetHost
        instances={[instance(NAV_WIDGET_IDS.quickLinks, { title: '收藏', favoritesOnly: true, limit: 1 })]}
        access={accessOf}
        dataPortFor={() => port}
      />,
    );
    expect(await screen.findByText('以太之光')).toBeDefined();
    expect(screen.getAllByTestId('nav-quick-link')).toHaveLength(1);
    expect(screen.queryByText('FF14 新闻')).toBeNull();
  });

  it('没有可显示内容时报告空态（Host 渲染空态卡片，而不是错误）', async () => {
    const { port } = fakePort(() => resolves(snapshot({ links: [link('L1', { isFavorite: false })] })));
    render(
      <WidgetHost
        instances={[instance(NAV_WIDGET_IDS.quickLinks, { title: '收藏', favoritesOnly: true, limit: 8 })]}
        access={accessOf}
        dataPortFor={() => port}
      />,
    );
    expect(await screen.findByText('暂无内容')).toBeDefined();
    expect(screen.queryByText('组件异步加载失败')).toBeNull();
  });

  it('端口抛错（含 409 / 门禁拒绝）时报告异步错误，Host 渲染错误卡片', async () => {
    const { port } = fakePort(() => rejects(new Error('该数据已被其他设备修改（conflict）')));
    render(
      <WidgetHost
        instances={[instance(NAV_WIDGET_IDS.quickLinks, { title: '常用网站', favoritesOnly: false, limit: 8 })]}
        access={accessOf}
        dataPortFor={() => port}
      />,
    );
    expect(await screen.findByText('组件异步加载失败')).toBeDefined();
    expect(screen.getByText(/其他设备修改/)).toBeDefined();
  });

  it('没有数据端口时降级：明确说明缺少端口，且不自行发起请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <WidgetHost
        instances={[instance(NAV_WIDGET_IDS.quickLinks, { title: '常用网站', favoritesOnly: false, limit: 8 })]}
        access={accessOf}
      />,
    );
    expect(await screen.findByText('组件异步加载失败')).toBeDefined();
    expect(screen.getByText(/需要模块数据端口/)).toBeDefined();
    // 组件**没有**自己 fetch：没有端口就没有任何网络请求。
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('nav-search', () => {
  const searchConfig = { title: '导航搜索', groupId: null, region: 'both', tag: null, sort: 'manual' };

  it('本地搜索用共享纯函数筛选（无额外网络请求），并可清空回全部', async () => {
    const user = userEvent.setup();
    const { port, call } = fakePort(() => resolves(threeLinks()));
    render(
      <WidgetHost
        instances={[instance(NAV_WIDGET_IDS.search, searchConfig)]}
        access={accessOf}
        dataPortFor={() => port}
      />,
    );

    expect(await screen.findByText('FF14 新闻')).toBeDefined();
    expect(screen.getAllByTestId('nav-search-result')).toHaveLength(3);

    await user.type(screen.getByTestId('nav-search-input'), '资料');
    expect(screen.getAllByTestId('nav-search-result')).toHaveLength(1);
    expect(screen.getByText('国际服资料站')).toBeDefined();

    // 别名也参与匹配（共享规范化 + 标题/别名/描述/标签）。
    await user.clear(screen.getByTestId('nav-search-input'));
    await user.type(screen.getByTestId('nav-search-input'), '新闻站');
    expect(screen.getByText('FF14 新闻')).toBeDefined();

    // 搜索是**本地**的：端口只被调用过一次（初始加载）。
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('无匹配时报告空态（Host 已就绪时不回退成空态卡片，组件就地说明）', async () => {
    const user = userEvent.setup();
    const { port } = fakePort(() => resolves(threeLinks()));
    render(
      <WidgetHost
        instances={[instance(NAV_WIDGET_IDS.search, searchConfig)]}
        access={accessOf}
        dataPortFor={() => port}
      />,
    );
    expect(await screen.findByText('以太之光')).toBeDefined();
    await user.type(screen.getByTestId('nav-search-input'), '绝不存在的关键字');
    // 组件同时调用了 reportEmpty()（见下面的直连用例），但 Host 的语义是「就绪优先」，
    // 因此界面上的诚实事实是组件自己的空结果说明，而不是把整张卡片换掉。
    expect(await screen.findByTestId('nav-search-empty')).toBeDefined();
    expect(screen.queryAllByTestId('nav-search-result')).toHaveLength(0);
  });

  it('直连渲染时无匹配会调用 reportEmpty()（组件确实上报了空态）', async () => {
    const user = userEvent.setup();
    const reportEmpty = vi.fn();
    const { NavSearchWidget } = await import('../src/app/nav/NavSearchWidget');
    render(
      <NavSearchWidget
        instanceId="direct-search"
        moduleId={NAV_MODULE_ID}
        widgetId={NAV_WIDGET_IDS.search}
        config={searchConfig}
        retryToken={0}
        data={fakePort(() => resolves(threeLinks())).port}
        reportReady={vi.fn()}
        reportEmpty={reportEmpty}
        reportAsyncError={vi.fn()}
      />,
    );
    expect(await screen.findByText('以太之光')).toBeDefined();
    await user.type(screen.getByTestId('nav-search-input'), '绝不存在的关键字');
    expect(reportEmpty).toHaveBeenCalled();
  });

  it('没有数据端口时降级并说明原因', async () => {
    render(
      <WidgetHost instances={[instance(NAV_WIDGET_IDS.search, searchConfig)]} access={accessOf} />,
    );
    expect(await screen.findByText('组件异步加载失败')).toBeDefined();
    expect(screen.getByText(/需要模块数据端口/)).toBeDefined();
  });

  it('配置不合法时不执行加载（配置错误由 Host 拦下）', () => {
    render(<WidgetHost instances={[instance(NAV_WIDGET_IDS.search, { title: '' })]} access={accessOf} />);
    // title 为空 → 共享 Schema 拒绝 → Host 显示「配置无法使用」，不渲染组件内容。
    expect(screen.getByText('配置无法使用')).toBeDefined();
  });
});

/** 直接渲染组件（不走 Host）用于断言「无端口时组件自身的行为」。 */
function DirectWidget(props: { readonly Component: (p: WidgetRuntimeProps) => ReactNode }) {
  const Component = props.Component;
  return (
    <Component
      instanceId="direct"
      moduleId={NAV_MODULE_ID}
      widgetId={NAV_WIDGET_IDS.quickLinks}
      config={{ title: '直连', favoritesOnly: false, limit: 8 }}
      retryToken={0}
      reportReady={vi.fn()}
      reportEmpty={vi.fn()}
      reportAsyncError={vi.fn()}
    />
  );
}

describe('直接渲染（无端口）', () => {
  it('没有 data 时组件渲染说明性文本而不是抛错', async () => {
    const { NavQuickLinksWidget } = await import('../src/app/nav/NavQuickLinksWidget');
    render(<DirectWidget Component={NavQuickLinksWidget} />);
    expect(screen.getByText('直连')).toBeDefined();
    expect(screen.getByText(/当前没有可显示的常用链接/)).toBeDefined();
  });
});
