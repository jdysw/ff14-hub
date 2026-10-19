// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicCalendarPage } from '../src/app/events/PublicCalendarPage';
import { chinaToday } from '../src/app/events/public-calendar-utils';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function response() {
  const now = Date.now();
  return {
    serverTimeMs: now,
    source: {
      name: '盛趣游戏 · FF14 国服官方公告',
      homeUrl: 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',
      checkedAtMs: now - 60_000,
      stale: false,
    },
    events: [
      {
        id: 'official:1', region: 'cn', title: '守护天节', category: '季节活动',
        description: '官方活动时间已核实', location: '', startsAt: now - 3600_000,
        endsAt: now + 3600_000, allDay: false,
        sourceUrl: 'https://actff1.web.sdo.com/project/seasonal/index.html',
      },
      {
        id: 'official:2', region: 'cn', title: '官方时间待确认公告', category: '官方公告',
        description: '', location: '', startsAt: null, endsAt: null, allDay: false,
        sourceUrl: null,
      },
    ],
  };
}

describe('公开国服活动中心', () => {
  it('匿名拉取官方列表：默认月历，可选今日、月份、列表筛选，并提供 ICS', async () => {
    const get = vi.fn(() => Promise.resolve(new Response(JSON.stringify(response()), { status: 200 })));
    vi.stubGlobal('fetch', get);
    const back = vi.fn();
    render(<PublicCalendarPage onBack={back}/>);
    expect(await screen.findByRole('heading', { name: '国服活动日历' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('守护天节')).toBeTruthy());
    expect(screen.getByRole('region', { name: '活动月历' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /订阅日历/ }).getAttribute('href')).toBe('/api/v1/events/calendar.ics');
    expect(screen.getByRole('button', { name: /^上个月$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: chinaToday(Date.now()) + '，1 个活动' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '列表' }));
    expect(screen.getByRole('region', { name: '国服活动列表' })).toBeTruthy();
    expect(screen.getByText('守护天节')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /返回首页/ }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    const [url, init] = get.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/events/calendar');
    expect(init.credentials).toBe('omit');
  });

  it('未知官方日期仅在待核实区，绝不塞入月历日程', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json(response()))));
    render(<PublicCalendarPage onBack={vi.fn()}/>);
    expect(await screen.findByText(/尚无可靠起止时间的公告（1）/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '选定日期的活动' })).queryByText('官方时间待确认公告')).toBeNull();
    fireEvent.click(screen.getByText(/尚无可靠起止时间的公告（1）/));
    expect(screen.getByText('官方时间待确认公告')).toBeTruthy();
  });
});
