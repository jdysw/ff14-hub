/** 首页只显示值得关注的近期日程；完整历史、筛选与日期选择放入独立活动中心。 */
import { eventCalendarResponseSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  calendarOverview, chinaDateTime, displayCalendarTitle, eventStatus, isScheduled, SOON_MS,
} from '../events/public-calendar-utils';
import { calendarCountdown } from '../events/EventsCalendarWidget';

export const HOME_EVENT_LIMIT = 3;

/**
 * 首页不是活动档案：仅显示近期有效的 3 条可行动日程。
 * 无可靠起止时间的公告不能计算倒计时，在完整活动日历中单独查看。
 */
export function homeEventHighlights(items: readonly EventCalendarItem[], now: number): EventCalendarItem[] {
  const rank = (item: EventCalendarItem) => {
    const status = eventStatus(item, now);
    if (status === 'ending') return 0;
    if (status === 'upcoming' && item.startsAt! <= now + SOON_MS) return 1;
    if (status === 'active') return 2;
    return 3;
  };
  return items
    .filter(item => isScheduled(item) && item.endsAt! >= now)
    .sort((a, b) => {
      const diff = rank(a) - rank(b);
      if (diff) return diff;
      const targetA = a.startsAt! > now ? a.startsAt! : a.endsAt!;
      const targetB = b.startsAt! > now ? b.startsAt! : b.endsAt!;
      return targetA - targetB || a.id.localeCompare(b.id);
    })
    .slice(0, HOME_EVENT_LIMIT);
}

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

export function HomeOfficialEvents({ onOpenCalendar, onHide }: {
  readonly onOpenCalendar: () => void;
  readonly onHide: () => void;
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
  // 所有未结束活动仍可在完整日历中查看；首页只加载最多 3 条有可靠日期的日程。
  const allEvents = state.kind === 'ready' ? state.value.events : [];
  const confirmedCount = allEvents.filter(item => isScheduled(item) && item.endsAt! >= now).length;
  const unknownCount = allEvents.filter(item => !isScheduled(item)).length;
  const important = useMemo(() => homeEventHighlights(allEvents, now), [state, now]);
  const remaining = Math.max(0, confirmedCount - important.length);
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
        <button type="button" onClick={onOpenCalendar}><strong>{overview.active.length}</strong><span>进行中</span></button>
        <button type="button" onClick={onOpenCalendar}><strong>{overview.upcoming.length}</strong><span>未来 7 天开始</span></button>
        <button type="button" onClick={onOpenCalendar}><strong>{overview.ending.length}</strong><span>24 小时内结束</span></button>
      </div>
      {important.length === 0 && <p className="home-state">目前没有已确认时间的未结束活动。{unknownCount > 0 ? '待核实公告可在完整日历查看。' : ''}</p>}
      {important.length > 0 && <ul className="home-official__list">
        {important.map(item => <OfficialEventSummary key={item.id} item={item} now={now}/>)}
      </ul>}
      {(remaining > 0 || unknownCount > 0) && <button className="home-official__more" type="button"
        onClick={onOpenCalendar}>
        {remaining > 0 ? `其余 ${remaining} 项日程` : '查看完整日历'}
        {unknownCount > 0 ? ` · ${unknownCount} 条待核实公告` : ''}
        <span aria-hidden="true">↗</span>
      </button>}
    </>}
  </section>;
}
