// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PvpBoard} from '../src/app/pvp/PvpBoard';

afterEach(()=>{cleanup();vi.useRealTimers();});

it('displays both current PVP maps and the next rotation on the compact homepage',()=>{
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T02:10:00Z'));
  const onOpenDetail=vi.fn();
  render(<PvpBoard onOpenDetail={onOpenDetail}/>);
  const overview=screen.getByTestId('pvp-board');
  expect(within(overview).getByText('尘封秘岩（争夺战）')).toBeDefined();
  expect(within(overview).getByText('赤土红沙')).toBeDefined();
  expect(within(overview).getByText('下轮：周边遗迹群（阵地战） · 北京时间 23:00')).toBeDefined();
  expect(within(overview).getByText('下张：角力学校 · 北京时间 11:00')).toBeDefined();
  expect(within(overview).getByText('00:50:00')).toBeDefined();
  expect(overview.querySelector('.pvp-board__schedules')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'完整轮换 ↗'}));
  expect(onOpenDetail).toHaveBeenCalledTimes(1);
  act(()=>{
    vi.setSystemTime(new Date('2026-10-21T03:00:00Z'));
    vi.advanceTimersByTime(1_000);
  });
  expect(within(overview).getByText('角力学校')).toBeDefined();
  expect(within(overview).getByText('下张：火山之心 · 北京时间 12:00')).toBeDefined();
});

it('shows every map entry in the expanded schedule instead of a second long homepage list',()=>{
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T02:10:00Z'));
  const {container}=render(<PvpBoard expanded/>);
  expect(container.querySelectorAll('.pvp-board__schedule')).toHaveLength(2);
  expect(container.querySelectorAll('.pvp-board__schedule li')).toHaveLength(16);
  expect(screen.getByText('2026-10-21 10:00–11:00')).toBeDefined();
  expect(screen.getByText('2026-10-22 23:00')).toBeDefined();
  expect(screen.getByText(/官方调整地图轮换/)).toBeDefined();
  expect(screen.queryByRole('button',{name:'完整轮换 ↗'})).toBeNull();
});
