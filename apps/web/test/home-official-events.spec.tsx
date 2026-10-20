// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeOfficialEvents } from '../src/app/shell/HomeOfficialEvents';
import { SystemBar } from '../src/app/shell/SystemBar';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const response = {
  serverTimeMs: new Date('2026-10-19T05:00:00Z').getTime(),
  source: {
    name: '盛趣官方公告', homeUrl: 'https://ff.web.sdo.com/web8/index.html',
    checkedAtMs: new Date('2026-10-19T04:59:00Z').getTime(), stale: false,
  },
  events: [{
    id: 'official:sample', title: '官方测试活动', region: 'cn', category: '季节活动',
    startsAt: new Date('2026-10-18T05:00:00Z').getTime(),
    endsAt: new Date('2030-10-20T05:00:00Z').getTime(),
    description: '', sourceUrl: 'https://ff.web.sdo.com/web8/index.html',
    location: '', allDay: false,
  }],
} as const;

describe('首页公开活动', () => {
  it('无需登录或个人工作空间，也能从公开接口显示活动及官方链接', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify(response), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    vi.stubGlobal('fetch', fetchSpy);
    render(<HomeOfficialEvents onOpenCalendar={vi.fn()} onHide={vi.fn()}/>);
    expect(await screen.findByText('官方测试活动')).toBeTruthy();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/events/calendar');
    expect(init.credentials).toBe('omit');
    expect(init.method).toBe('GET');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(screen.getByRole('link', { name: '官方测试活动' }).getAttribute('href')).toBe(response.events[0].sourceUrl);
    expect(screen.queryByText('连接工作空间')).toBeNull();
    expect(screen.getByRole('button', { name: '完整日历 ↗' })).toBeTruthy();
    expect(screen.queryByText('今日活动')).toBeNull();
    expect(screen.getByText('未来 7 天开始')).toBeTruthy();
    expect(screen.getByText('24 小时内结束')).toBeTruthy();
  });

  it('来源时间缺失时不伪造倒计时', async () => {
    const unknown = { ...response, events: [{ ...response.events[0], startsAt: null, endsAt: null }] };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(unknown), { status: 200 }))));
    render(<HomeOfficialEvents onOpenCalendar={vi.fn()} onHide={vi.fn()}/>);
    expect(await screen.findByText(/目前没有已确认时间的未结束活动/)).toBeTruthy();
    expect(screen.queryByText('官方测试活动')).toBeNull();
    expect(screen.getByRole('button',{name:'完整日历 ↗'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:/条待核实公告/})).toBeNull();
  });

  it('keeps all confirmed upcoming events in the scrollable list and removes the extra footer', async () => {
    const now = Date.now();
    const make = (id: string, startsAt: number|null, endsAt: number|null) =>
      ({...response.events[0],id,title:id,startsAt,endsAt});
    const events = [
      make('已结束活动',now-10*86400000,now-86400000),
      make('长期进行A',now-10*86400000,now+30*86400000),
      make('长期进行B',now-10*86400000,now+40*86400000),
      make('长期进行C',now-10*86400000,now+50*86400000),
      make('临期活动',now-2*86400000,now+3600000),
      make('近期开始活动',now+3600000,now+2*86400000),
      make('远期活动',now+50*86400000,now+60*86400000),
      make('公告待核实A',null,null),
      make('公告待核实B',null,null),
    ];
    vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(JSON.stringify({
      ...response,serverTimeMs:now,events,
    }),{status:200}))));
    const onOpenCalendar=vi.fn();
    const {container}=render(<HomeOfficialEvents onOpenCalendar={onOpenCalendar} onHide={vi.fn()}/>);
    await screen.findByText('临期活动');
    await waitFor(()=>expect(container.querySelectorAll('.home-official-event')).toHaveLength(6));
    expect(screen.getByText('近期开始活动')).toBeTruthy();
    expect(screen.getByText('长期进行B')).toBeTruthy();
    expect(screen.queryByText('公告待核实A')).toBeNull();
    expect(screen.queryByText('已结束活动')).toBeNull();
    expect(container.querySelector('.home-official__more')).toBeNull();
    expect(screen.getByRole('list',{name:'国服活动列表'}).tabIndex).toBe(0);
    fireEvent.click(screen.getByRole('button',{name:'完整日历 ↗'}));
    expect(onOpenCalendar).toHaveBeenCalledTimes(1);
  });

  it('服务不可用时展示重试，且不伪装为无活动', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    render(<HomeOfficialEvents onOpenCalendar={vi.fn()} onHide={vi.fn()}/>);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('目前还没有获取到官方活动公告。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('官方测试活动')).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('polls visible activity data each minute and retains the last list if an update fails',async()=>{
    vi.useFakeTimers();
    try{
      const updated={...response,events:[{...response.events[0],title:'官方更新活动'}]};
      const fetchSpy=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response),{status:200}))
        .mockResolvedValueOnce(new Response(JSON.stringify(updated),{status:200}))
        .mockRejectedValue(new Error('temporarily unavailable'));
      vi.stubGlobal('fetch',fetchSpy);
      render(<HomeOfficialEvents onOpenCalendar={vi.fn()} onHide={vi.fn()}/>);
      await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
      expect(screen.getByText('官方测试活动')).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
      expect(screen.getByText('官方更新活动')).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
      expect(screen.getByText('官方更新活动')).toBeTruthy();expect(screen.getByText(/当前展示缓存数据/)).toBeTruthy();
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    }finally{vi.useRealTimers();}
  });
});

describe('普通玩家设置', () => {
  it('常用入口明确，技术与调试功能默认折叠，仍可手动打开', () => {
    const onSelectView = vi.fn();
    const { container } = render(<SystemBar currentView="settings" onSelectView={onSelectView} />);
    expect(screen.getByRole('button', { name: /自定义工作台/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /钓鱼手账/ })).toBeTruthy();
    expect(screen.getByText(/浏览公共内容无需连接/)).toBeTruthy();
    const advanced = container.querySelector('details.settings-advanced');
    expect(advanced?.hasAttribute('open')).toBe(false);
    fireEvent.click(screen.getByText(/高级设置/));
    expect(advanced?.hasAttribute('open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /模块管理/ }));
    expect(onSelectView).toHaveBeenCalledWith('modules');
  });
});
