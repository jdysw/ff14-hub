/** 首页只显示值得关注的近期日程；完整历史、筛选与日期选择放入独立活动中心。 */
import { eventCalendarResponseSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  calendarOverview, chinaDateTime, displayCalendarTitle, eventStatus, isScheduled,
} from '../events/public-calendar-utils';
import { calendarCountdown } from '../events/EventsCalendarWidget';

type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly value: EventCalendarResponse; readonly offset: number };

function OfficialEventSummary({ item, now }: { readonly item: EventCalendarItem; readonly now: number }) {
  const status = eventStatus(item, now);
  const target = status === 'upcoming' ? item.startsAt : status === 'active' || status === 'ending' ? item.endsAt : null;
  const label = status === 'ending' ? '即将结束' :
    status === 'active' ? '进行中' : status === 'upcoming' ? '即将开始' :
      status === 'ended' ? '已结束' : '待核实公告';
  return <li className="home-official-event">
    <div className="home-official-event__main">
      <span className="home-official-event__category">{item.category || '官方公告'}</span>
      <span className="home-official-event__phase">{label}</span>
      <h3>{item.sourceUrl
        ? <a href={item.sourceUrl} rel="noopener noreferrer" target="_blank">{displayCalendarTitle(item.title)}</a>
        : displayCalendarTitle(item.title)}</h3>
      <p>{isScheduled(item) ? chinaDateTime(item.startsAt!) + ' — ' + chinaDateTime(item.endsAt!) : '官方起止时间未确认'}</p>
    </div>
    <div className="home-official-event__timer" aria-label={target === null ? label : label + calendarCountdown(target, now)}>
      <span>{target === null ? '时间待确认' : (status === 'upcoming' ? '距开始' : '距结束')}</span>
      <strong>{target === null ? '—' : calendarCountdown(target, now)}</strong>
    </div>
  </li>;
}

export function HomeOfficialEvents({ onOpenCalendar, onHide, maxItems = 4 }: {
  readonly onOpenCalendar: () => void;
  readonly onHide: () => void;
  readonly maxItems?: number;
}) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [clock, setClock] = useState(Date.now);

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/events/calendar', {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        if (!response.ok) throw new Error('calendar_unavailable');
        const data: unknown = await response.json();
        const parsed = eventCalendarResponseSchema.safeParse(data);
        if (!parsed.success) throw new Error('calendar_contract_error');
        if (!controller.signal.aborted) {
          setState({ kind: 'ready', value: parsed.data, offset: parsed.data.serverTimeMs - Date.now() });
        }
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      }
    })();
    return () => controller.abort();
  }, [refresh]);

  const now = state.kind === 'ready' ? clock + state.offset : clock;
  const overview = useMemo(() =>
    calendarOverview(state.kind === 'ready' ? state.value.events : [], now), [state, now]);
  // 去重后按「即将结束 → 进行中 → 即将开始」排序；只有没有可靠日程时才显示待核实公告。
  const important = useMemo(() => {
    const seen = new Set<string>();
    const ordered = [...overview.ending, ...overview.active, ...overview.upcoming];
    const filtered = ordered.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }).slice(0, maxItems);
    return filtered.length ? filtered : overview.unscheduled.slice(0, maxItems);
  }, [overview, maxItems]);
  const reload = () => { setState({ kind: 'loading' }); setRefresh(value => value + 1); };

  return <section className="home-official" aria-label="国服官方活动">
    <header className="home-section-heading">
      <div className="home-heading-group"><h2>国服活动</h2></div>
      <div className="home-official__actions">
        <button className="text-button" type="button" onClick={onOpenCalendar}>完整日历 ↗</button>
        <button className="text-button" type="button" onClick={reload} aria-label="刷新活动" title="刷新">↻</button>
        <button className="text-button home-official__hide" type="button" onClick={onHide}
          aria-label="从首页隐藏国服活动模块">隐藏</button>
      </div>
    </header>
    
    {state.kind === 'loading' && <p className="home-state" role="status">正在获取最新活动…</p>}
    {state.kind === 'error' && <div className="home-official__notice" role="alert">
      活动暂时无法加载。 <button className="text-button" type="button" onClick={reload}>重试</button>
      <button className="text-button" type="button" onClick={onOpenCalendar}>打开活动中心</button>
    </div>}
    {state.kind === 'ready' && <>
      {state.value.source.stale && <p className="home-official__notice" role="status">当前展示缓存数据，官方活动可能已有变更。</p>}
      <div className="home-official__stats" aria-label="国服活动摘要">
        <button type="button" onClick={onOpenCalendar}><strong>{overview.upcoming.length}</strong><span>未来 7 天开始</span></button>
        <button type="button" onClick={onOpenCalendar}><strong>{overview.ending.length}</strong><span>24 小时内结束</span></button>
      </div>
      {important.length === 0 && <p className="home-state">暂无近期活动</p>}
      {important.length > 0 && <ul className="home-official__list">
        {important.map(item => <OfficialEventSummary key={item.id} item={item} now={now}/>)}
      </ul>}
    </>}
  </section>;
}
