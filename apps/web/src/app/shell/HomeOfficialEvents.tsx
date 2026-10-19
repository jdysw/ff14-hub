/**
 * 首页公开活动：只读取固定同源公开端点，不依赖个人工作空间或设备凭证。
 * 与私人活动严格隔离；来源、时间与倒计时完全采用已验证的官方日历契约。
 */
import { eventCalendarResponseSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';
import { useEffect, useMemo, useState } from 'react';
import { calendarCountdown, calendarPhase } from '../events/EventsCalendarWidget';

type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly value: EventCalendarResponse; readonly offset: number };

const PUBLIC_CALENDAR_URL = '/api/v1/events/calendar';
const INITIAL_COUNT = 4;

function chinaMinute(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function sortOfficialEvents(events: readonly EventCalendarItem[], now: number): EventCalendarItem[] {
  const rank = (item: EventCalendarItem): number => {
    const phase = calendarPhase(item, now);
    return phase === 'active' ? 0 : phase === 'upcoming' ? 1 : phase === 'unknown' ? 2 : 3;
  };
  return [...events].sort((a, b) => {
    const left = rank(a), right = rank(b);
    if (left !== right) return left - right;
    if (left === 0) return (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity);
    if (left === 1) return (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity);
    return (b.startsAt ?? 0) - (a.startsAt ?? 0);
  });
}

function OfficialEventSummary({ item, now }: { readonly item: EventCalendarItem; readonly now: number }) {
  const phase = calendarPhase(item, now);
  const target = phase === 'upcoming' ? item.startsAt : phase === 'active' ? item.endsAt : null;
  const label = phase === 'active' ? '距结束' : phase === 'upcoming' ? '距开始' : phase === 'ended' ? '已结束' : '时间待确认';
  return <li className="home-official-event">
    <div className="home-official-event__main">
      <span className="home-official-event__category">{item.category || '官方活动'}</span>
      <span className="home-official-event__phase">{phase === 'active' ? '进行中' : phase === 'upcoming' ? '即将开始' : phase === 'ended' ? '已结束' : '待公布时间'}</span>
      <h3>{item.sourceUrl
        ? <a href={item.sourceUrl} rel="noopener noreferrer" target="_blank">{item.title}</a>
        : item.title}</h3>
      <p>{item.startsAt !== null ? chinaMinute(item.startsAt) + ' 开始' : '开始时间未公布'} · {item.endsAt !== null ? chinaMinute(item.endsAt) + ' 结束' : '结束时间未公布'}</p>
    </div>
    <div className="home-official-event__timer" aria-label={label + (target === null ? '' : calendarCountdown(target, now))}>
      <span>{label}</span><strong>{target === null ? '—' : calendarCountdown(target, now)}</strong>
    </div>
  </li>;
}

export function HomeOfficialEvents() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [clock, setClock] = useState(Date.now);

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(PUBLIC_CALENDAR_URL, {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        if (!response.ok) throw new Error('公开活动接口不可用');
        const data: unknown = await response.json();
        const parsed = eventCalendarResponseSchema.safeParse(data);
        if (!parsed.success) throw new Error('公开活动返回数据不符合约定');
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
  const sorted = useMemo(
    () => state.kind === 'ready' ? sortOfficialEvents(state.value.events, now) : [],
    [state, now],
  );
  const visible = showAll ? sorted.slice(0, 40) : sorted.filter(item => calendarPhase(item, now) !== 'ended').slice(0, INITIAL_COUNT);
  const hiddenCount = sorted.length - visible.length;

  return <section className="home-official" aria-label="国服官方活动">
    <header className="home-section-heading">
      <div className="home-heading-group"><h2>国服活动</h2><span className="home-section-kicker">OFFICIAL EVENTS</span></div>
      <button className="text-button" type="button" onClick={() => { setState({ kind: 'loading' }); setRefresh(value => value + 1); }}>刷新活动</button>
    </header>
    <p className="home-official__hint">来自盛趣官方公告 · 北京时间 · 无需登录</p>
    {state.kind === 'loading' && <p className="home-state" role="status">正在获取最新活动…</p>}
    {state.kind === 'error' && <div className="home-official__notice" role="alert">活动暂时无法加载，请检查网络或稍后重试。 <button className="text-button" type="button" onClick={() => { setState({ kind: 'loading' }); setRefresh(value => value + 1); }}>重试</button></div>}
    {state.kind === 'ready' && <>
      {state.value.source.stale && <p className="home-official__notice" role="status">官方源暂时无法更新，当前显示的是缓存数据。</p>}
      {visible.length === 0 && <p className="home-state">{sorted.length === 0 ? '目前还没有获取到官方活动公告。' : '目前没有进行中或即将开始的活动，可查看历史公告。'}</p>}
      {visible.length > 0 && <ul className="home-official__list">{visible.map(item => <OfficialEventSummary key={item.id} item={item} now={now}/>)}</ul>}
      {hiddenCount > 0 && <button className="text-button" type="button" onClick={() => setShowAll(value => !value)}>{showAll ? '收起活动' : '查看全部活动（含历史）'} <span aria-hidden="true">↗</span></button>}
      <a className="text-button" href={state.value.source.homeUrl} rel="noopener noreferrer" target="_blank">官方活动公告 <span aria-hidden="true">↗</span></a>
      <p className="home-official__disclaimer">仅对有明确官方起止时间的活动显示倒计时；时间未公布的活动不会推测。</p>
    </>}
  </section>;
}
