/** 独立公开活动中心：日历和列表双视图，匿名访问，和个人工作台数据完全隔离。 */
import { eventCalendarResponseSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';
import { useEffect, useMemo, useState } from 'react';
import './public-calendar.css';
import {
  calendarOverview, chinaDateTime, chinaMonthDays, chinaToday,
  displayCalendarTitle, eventStatus, eventsForChinaDay, isScheduled,
} from './public-calendar-utils';

type DataState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly data: EventCalendarResponse; readonly offset: number };

type DisplayMode = 'month' | 'list';
type PhaseFilter = 'all' | 'active' | 'upcoming' | 'ending' | 'unscheduled';
const PHASES: ReadonlyArray<{ value: PhaseFilter; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'active', label: '进行中' },
  { value: 'upcoming', label: '即将开始' }, { value: 'ending', label: '即将结束' },
  { value: 'unscheduled', label: '时间待确认' },
];
const ICAL_URL = '/api/v1/events/calendar.ics';

function CalendarEvent({ event, now }: { readonly event: EventCalendarItem; readonly now: number }) {
  const status = eventStatus(event, now);
  const label = {
    active: '进行中', upcoming: '即将开始', ending: '即将结束',
    ended: '已结束', unscheduled: '时间待确认',
  }[status];
  const content = <>
    <span className="calendar-center__event-category">{event.category || '官方公告'} · {label}</span>
    <strong>{displayCalendarTitle(event.title)}</strong>
    <span className="calendar-center__event-time">
      {isScheduled(event) ? chinaDateTime(event.startsAt!) + ' — ' + chinaDateTime(event.endsAt!) : '官方起止时间未确认'}
    </span>
    {event.description && <span className="calendar-center__event-description">{event.description}</span>}
  </>;
  return <li className="calendar-center__event">
    {event.sourceUrl ? <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer">{content}<span aria-hidden="true">↗</span></a>
      : <div>{content}</div>}
  </li>;
}

function currentMonthKey(day: string, direction: number): string {
  const parts = day.split('-');
  const year = Number(parts[0]), month = Number(parts[1]);
  return new Date(Date.UTC(year, month - 1 + direction, 1)).toISOString().slice(0, 10);
}

export function PublicCalendarPage({ onBack }: { readonly onBack: () => void }) {
  const [state, setState] = useState<DataState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const [selectedDay, setSelectedDay] = useState(() => chinaToday(Date.now()));
  const [mode, setMode] = useState<DisplayMode>('month');
  const [category, setCategory] = useState('all');
  const [phase, setPhase] = useState<PhaseFilter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/events/calendar', {
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('official_calendar_unavailable');
        const parsed = eventCalendarResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error('invalid_calendar_contract');
        if (!controller.signal.aborted) setState({
          status: 'loaded', data: parsed.data, offset: parsed.data.serverTimeMs - Date.now(),
        });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  const now = state.status === 'loaded' ? clock + state.offset : clock;
  const events = useMemo(() => state.status === 'loaded' ? state.data.events : [], [state]);
  const overview = useMemo(() => calendarOverview(events, now), [events, now]);
  const categories = useMemo(() => [...new Set(events.map(x => x.category || '官方公告'))].sort(), [events]);
  const selectedYear = Number(selectedDay.slice(0, 4));
  const selectedMonth = Number(selectedDay.slice(5, 7));
  const days = useMemo(() => chinaMonthDays(selectedYear, selectedMonth), [selectedYear, selectedMonth]);
  const hasFilter = category !== 'all' || phase !== 'all' || search.trim() !== '';
  const filtered = useMemo(() => events.filter(event => {
    if (category !== 'all' && (event.category || '官方公告') !== category) return false;
    const status = eventStatus(event, now);
    if (phase !== 'all' && !(phase === 'active' && status === 'ending') && status !== phase) return false;
    const term = search.trim().normalize('NFKC').toLowerCase();
    return !term || (event.title + ' ' + event.description + ' ' + event.category).normalize('NFKC').toLowerCase().includes(term);
  }), [events, now, phase, category, search]);
  const dayEvents = useMemo(() => eventsForChinaDay(filtered, selectedDay), [filtered, selectedDay]);
  const knownList = useMemo(() => filtered.filter(isScheduled).sort((a, b) => {
    const aEnded = a.endsAt! < now, bEnded = b.endsAt! < now;
    if (aEnded !== bEnded) return aEnded ? 1 : -1;
    return aEnded ? b.endsAt! - a.endsAt! : a.endsAt! - b.endsAt!;
  }), [filtered, now]);
  const unknownList = useMemo(() => filtered.filter(x => !isScheduled(x)), [filtered]);

  const summary = (label: string, count: number, nextPhase: PhaseFilter) =>
    <button type="button" className="calendar-center__stat"
      onClick={() => { setMode('list'); setPhase(nextPhase); }}>
      <strong>{count}</strong><span>{label}</span>
    </button>;

  return <div className="calendar-center">
    <header className="calendar-center__header">
      <div>
        <button type="button" className="text-button" onClick={onBack}>← 返回首页</button>
        <h2>国服活动日历</h2>
        <p>北京时间 · 官方已核实的时间进入日历，其余公告单独显示</p>
      </div>
      <div className="calendar-center__actions">
        <a className="button" href={ICAL_URL} title="在日历应用中订阅，不包含未确认日期的活动">订阅日历（ICS） ↗</a>
        <button type="button" className="text-button" onClick={() => {
          setState({ status: 'loading' }); setAttempt(i => i + 1);
        }}>刷新</button>
      </div>
    </header>
    {state.status === 'loading' && <p className="home-state" role="status">正在加载国服官方活动…</p>}
    {state.status === 'failed' && <p className="notice notice--error" role="alert">国服活动暂时不可用。
      <button type="button" className="text-button" onClick={() => {
        setState({ status: 'loading' }); setAttempt(i => i + 1);
      }}>重试</button></p>}
    {state.status === 'loaded' && <>
      {state.data.source.stale && <p className="notice notice--warn" role="status">官方源暂时无法更新，当前展示的是历史快照，时间可能已变更。</p>}
      <div className="calendar-center__stats" aria-label="活动概览">
        {summary('今天', overview.today.length, 'all')}
        {summary('进行中', overview.active.length, 'active')}
        {summary('未来 7 天开始', overview.upcoming.length, 'upcoming')}
        {summary('72 小时内结束', overview.ending.length, 'ending')}
      </div>
      <div className="calendar-center__toolbar">
        <div className="calendar-center__mode" role="group" aria-label="活动视图">
          <button type="button" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>月历</button>
          <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>列表</button>
        </div>
        <label>活动类别
          <select value={category} onChange={e => setCategory(e.target.value)}>
            <option value="all">全部类别</option>
            {categories.map(name => <option value={name} key={name}>{name}</option>)}
          </select>
        </label>
        <label>搜索活动
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="名称、关键词"/>
        </label>
      </div>
      {mode === 'month' ? <div className="calendar-center__month-layout">
        <section className="calendar-center__calendar" aria-label="活动月历">
          <header>
            <button type="button" aria-label="上个月" onClick={() => setSelectedDay(currentMonthKey(selectedDay, -1))}>‹</button>
            <h3>{selectedYear} 年 {selectedMonth} 月</h3>
            <button type="button" aria-label="下个月" onClick={() => setSelectedDay(currentMonthKey(selectedDay, 1))}>›</button>
            <button type="button" className="text-button" onClick={() => setSelectedDay(chinaToday(now))}>今天</button>
          </header>
          <div className="calendar-center__grid">
            {['日','一','二','三','四','五','六'].map(s => <span className="calendar-center__weekday" key={s}>{s}</span>)}
            {days.map(day => {
              const count = eventsForChinaDay(filtered, day).length;
              return <button key={day} type="button" title={day + ' · ' + count + ' 个活动'}
                aria-label={day + '，' + count + ' 个活动'} aria-pressed={day === selectedDay}
                className={day.slice(0,7) !== selectedDay.slice(0,7) ? 'calendar-center__day calendar-center__day--outside' : 'calendar-center__day'}
                onClick={() => setSelectedDay(day)}>
                <span>{Number(day.slice(8))}</span>{count > 0 && <small>{count} 项</small>}
                {day === chinaToday(now) && <i aria-label="今天">•</i>}
              </button>;
            })}
          </div>
        </section>
        <section className="calendar-center__selected" aria-label="选定日期的活动">
          <h3>{selectedDay} · {dayEvents.length} 项日程</h3>
          {dayEvents.length === 0 ? <p className="home-state">这一天没有已确认时间的活动。</p> :
            <ul className="calendar-center__events">{dayEvents.map(x => <CalendarEvent event={x} now={now} key={x.id}/>)}</ul>}
          {hasFilter && <p className="panel__muted">当前日期结果已应用搜索与类别筛选。</p>}
        </section>
      </div> : <section className="calendar-center__list" aria-label="国服活动列表">
        <div className="calendar-center__phase-tabs" role="group" aria-label="活动状态筛选">
          {PHASES.map(f => <button type="button" key={f.value} aria-pressed={phase === f.value}
            onClick={() => setPhase(f.value)}>{f.label}</button>)}
        </div>
        <h3>已确认日程 · {knownList.length} 项</h3>
        {knownList.length ? <ul className="calendar-center__events">{knownList.map(x => <CalendarEvent key={x.id} event={x} now={now}/>)}</ul>
          : <p className="home-state">此筛选条件下暂无已确认日程。</p>}
      </section>}
      {(mode === 'list' || unknownList.length > 0) && <details className="calendar-center__unknown">
        <summary>尚无可靠起止时间的公告（{unknownList.length}）</summary>
        <p>此类信息只提供原文，无法计算倒计时，也不会进入 ICS 订阅。</p>
        <ul className="calendar-center__events">{unknownList.map(x => <CalendarEvent key={x.id} event={x} now={now}/>)}</ul>
      </details>}
      <footer className="calendar-center__footer">
        数据来源：{state.data.source.name} · 更新于 {chinaDateTime(state.data.source.checkedAtMs)}
        <a href={state.data.source.homeUrl} target="_blank" rel="noopener noreferrer">核对官方公告 ↗</a>
      </footer>
    </>}
  </div>;
}
