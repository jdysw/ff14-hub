// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeOfficialEvents } from '../src/app/shell/HomeOfficialEvents';
import {PUBLIC_CALENDAR_CACHE_KEY,saveCachedPublicCalendar} from '../src/app/local/public-calendar-cache';
import {eventCalendarResponseSchema} from '@ff14-hub/shared';

afterEach(() => { cleanup(); localStorage.removeItem(PUBLIC_CALENDAR_CACHE_KEY); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  it('未定结束日期的活动在开始后进入进行中，保留结束条件且不显示虚假的结束倒计时',async()=>{
    vi.useFakeTimers();
    try{
      const now=Date.UTC(2026,9,28,8)-1000;vi.setSystemTime(now);
      const entry={...response.events[0],title:'魔光键影跨日回归',startsAt:now+1000,endsAt:null,description:'活动结束条件：8.0版本更新维护前'};
      const fetcher=vi.fn(()=>Promise.resolve(Response.json({...response,serverTimeMs:now,events:[entry]})));
      vi.stubGlobal('fetch',fetcher);render(<HomeOfficialEvents onOpenCalendar={vi.fn()}/>);
      await act(async()=>{await Promise.resolve();});
      fireEvent.click(screen.getByRole('button',{name:'未来活动'}));expect(screen.getByText(entry.title)).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
      expect(screen.queryByText(entry.title)).toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'进行中活动'}));expect(screen.getByText(entry.title)).toBeTruthy();
      expect(screen.getByText('已开始 · 结束待确认')).toBeTruthy();expect(screen.queryByText('距结束')).toBeNull();
      expect(screen.getByText('结束：8.0版本更新维护前')).toBeTruthy();
      vi.setSystemTime(now+2*86400000);await act(()=>window.dispatchEvent(new Event('focus')));
      expect(screen.getByText(entry.title)).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(1);
    }finally{vi.useRealTimers();}
  });



  it('keeps switching at time boundaries on the current data without refetching',async()=>{
    vi.useFakeTimers();
    try{
      const now=Date.parse('2026-10-19T05:00:00Z');vi.setSystemTime(now);
      const events=[{...response.events[0],id:'starts-now',title:'现在开始',startsAt:now,endsAt:now+60000},
        {...response.events[0],id:'ends-now',title:'已到结束',startsAt:now-60000,endsAt:now},
        {...response.events[0],id:'next',title:'下一秒开始',startsAt:now+1000,endsAt:now+120000}];
      const fetcher=vi.fn(()=>Promise.resolve(new Response(JSON.stringify({...response,serverTimeMs:now,events}),{status:200})));vi.stubGlobal('fetch',fetcher);
      render(<HomeOfficialEvents onOpenCalendar={vi.fn()}/>);await act(async()=>{await Promise.resolve();});
      expect(screen.getByText('现在开始')).toBeTruthy();expect(screen.queryByText('已到结束')).toBeNull();expect(screen.queryByText('下一秒开始')).toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'未来活动'}));expect(screen.getByText('下一秒开始')).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(screen.queryByText('下一秒开始')).toBeNull();
      fireEvent.click(screen.getByRole('button',{name:'进行中活动'}));expect(screen.getByText('下一秒开始')).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(1);
    }finally{vi.useRealTimers();}
  });






  it('离线时显示上次校验过的公开活动缓存，并明确标记数据可能过期', async () => {
    saveCachedPublicCalendar(eventCalendarResponseSchema.parse(response));
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network offline'))));
    render(<HomeOfficialEvents onOpenCalendar={vi.fn()}/>);
    expect(await screen.findByText('官方测试活动')).toBeTruthy();
    expect(screen.getByText(/当前展示缓存数据，官方活动可能已有变更/)).toBeTruthy();
    expect(screen.queryByText('活动暂时无法加载。')).toBeNull();
  });

  it('服务不可用时展示重试，且不伪装为无活动', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    render(<HomeOfficialEvents onOpenCalendar={vi.fn()}/>);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('目前还没有获取到官方活动公告。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('官方测试活动')).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });


});
