// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENTS_MODULE_ID, EVENTS_WIDGET_IDS } from '@ff14-hub/shared';
import { EventsCalendarWidget, calendarCountdown, calendarPhase } from '../src/app/events/EventsCalendarWidget';
import { EVENTS_PORT_OPERATIONS } from '../src/app/events/events-data-port';
import type { ModuleDataPort, WidgetRuntimeProps } from '../src/app/widgets/types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function widget(response: unknown) {
  const call = vi.fn(async (operation: string) => {
    if (operation !== EVENTS_PORT_OPERATIONS.calendar) throw new Error('incorrect operation');
    return response;
  });
  const port: ModuleDataPort = {
    moduleId: EVENTS_MODULE_ID,
    operations: [EVENTS_PORT_OPERATIONS.calendar],
    call: <T,>(operation: string): Promise<T> => call(operation) as Promise<T>,
  };
  const ready = vi.fn();
  const error = vi.fn();
  const props: WidgetRuntimeProps = {
    instanceId: 'cn-calendar', moduleId: EVENTS_MODULE_ID, widgetId: EVENTS_WIDGET_IDS.calendar,
    config: { title: '国服活动', limit: 20 }, retryToken: 0, data: port,
    reportReady: ready, reportEmpty: vi.fn(), reportAsyncError: error,
  };
  return { props, ready, error, call };
}

describe('国服官方活动日历', () => {
  it('无完整时间时显示待核实，不展示虚假开始/结束倒计时', async () => {
    const state = widget({
      serverTimeMs: Date.now(),
      source: { name: '盛趣官方公告', homeUrl: 'https://ff.web.sdo.com/web8/index.html',
        checkedAtMs: Date.now(), stale: false },
      events: [{
        id: 'official:123', region: 'cn', title: '季节活动公告', category: '季节活动',
        description: '请阅读活动详情', startsAt: null, endsAt: null,
        sourceUrl: 'https://ff.web.sdo.com/web8/index.html#/newstab/newscont/123',
        location: '', allDay: false,
      }],
    });
    render(<EventsCalendarWidget {...state.props} />);
    expect(await screen.findByText('季节活动公告')).toBeTruthy();
    expect(screen.getByText('官方时间待核实')).toBeTruthy();
    expect(screen.getByText('暂无可靠时间', { exact: false })).toBeTruthy();
    await waitFor(() => expect(state.ready).toHaveBeenCalled());
    expect(state.error).not.toHaveBeenCalled();
  });

  it('只有确认时间的活动才进入状态判定', () => {
    expect(calendarPhase({ startsAt: null, endsAt: null } as Parameters<typeof calendarPhase>[0], 100)).toBe('unknown');
    expect(calendarPhase({ startsAt: 50, endsAt: null } as Parameters<typeof calendarPhase>[0], 100)).toBe('unknown');
    expect(calendarPhase({ startsAt: 120, endsAt: 200 } as Parameters<typeof calendarPhase>[0], 100)).toBe('upcoming');
    expect(calendarPhase({ startsAt: 50, endsAt: 200 } as Parameters<typeof calendarPhase>[0], 100)).toBe('active');
    expect(calendarPhase({ startsAt: 50, endsAt: 90 } as Parameters<typeof calendarPhase>[0], 100)).toBe('ended');
    expect(calendarCountdown(65_000, 0)).toBe('00:01:05');
  });
});
