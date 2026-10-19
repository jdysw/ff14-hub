/**
 * 国服活动日历 Widget。数据只由 Host 注入的受限 ModuleDataPort 获取。
 * 直接展示盛趣官方资讯接口的活动公告，只有明确完整日期才呈现倒计时。
 */
import { eventCalendarResponseSchema, eventsCalendarConfigSchema, type EventCalendarItem } from '@ff14-hub/shared';
import { useEffect, useMemo, useState } from 'react';
import { EVENTS_PORT_OPERATIONS } from './events-data-port';
import type { WidgetRuntimeProps } from '../widgets/types';

type CalendarState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'loaded'; data: ReturnType<typeof eventCalendarResponseSchema.parse>; clockOffset: number };

type Phase = 'all' | 'active' | 'upcoming' | 'ending' | 'ended' | 'unknown';
const PHASES: { id: Phase; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'active', label: '进行中' },
  { id: 'upcoming', label: '即将开始' }, { id: 'ending', label: '即将结束' },
  { id: 'ended', label: '已结束' }, { id: 'unknown', label: '时间待确认' },
];
const THREE_DAYS = 72 * 60 * 60_000;

export function calendarPhase(event: EventCalendarItem, now: number): 'upcoming' | 'active' | 'ended' | 'unknown' {
  if (event.startsAt === null) return 'unknown';
  if (event.startsAt > now) return 'upcoming';
  if (event.endsAt === null) return 'unknown';
  if (event.endsAt < now) return 'ended';
  return 'active';
}

export function calendarCountdown(targetMs: number, nowMs: number): string {
  if (targetMs <= nowMs) return '已到时';
  let left = Math.ceil((targetMs - nowMs) / 1000);
  const d = Math.floor(left / 86_400); left %= 86_400;
  const h = Math.floor(left / 3600); left %= 3600;
  const m = Math.floor(left / 60); const s = left % 60;
  return (d ? String(d) + ' 天 ' : '') + String(h).padStart(2, '0') + ':' +
    String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function chinaTime(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

function order(items: EventCalendarItem[], now: number): EventCalendarItem[] {
  return items.sort((a, b) => {
    const phaseRank = (item: EventCalendarItem) => {
      const phase = calendarPhase(item, now);
      return phase === 'active' ? 0 : phase === 'upcoming' ? 1 : phase === 'unknown' ? 2 : 3;
    };
    const ra = phaseRank(a), rb = phaseRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (a.endsAt ?? Number.MAX_SAFE_INTEGER) - (b.endsAt ?? Number.MAX_SAFE_INTEGER);
    if (ra >= 2) return (b.startsAt ?? 0) - (a.startsAt ?? 0);
    return (a.startsAt ?? 0) - (b.startsAt ?? 0);
  });
}

export function EventsCalendarWidget(props: WidgetRuntimeProps) {
  const { data, config, reportReady, reportEmpty, reportAsyncError, retryToken } = props;
  const [state, setState] = useState<CalendarState>({ kind: 'loading' });
  const [now, setNow] = useState(Date.now);
  const [reload, setReload] = useState(0);
  const [phase, setPhase] = useState<Phase>('all');
  const [category, setCategory] = useState('all');
  const [keyword, setKeyword] = useState('');
  const options = eventsCalendarConfigSchema.safeParse(config);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, []);
  useEffect(() => {
    if (!data) { reportAsyncError(new Error('国服活动日历缺少受限数据端口')); return; }
    if (!options.success) { reportAsyncError(new Error('国服活动日历配置无效')); return; }
    let cancelled = false;
    // 官方详情可能较慢：组件已有加载/筛选 UI，先向 Host 报告可见内容，避免 4 秒统一超时误报。
    reportReady();
    void (async () => {
      try {
        const response = eventCalendarResponseSchema.parse(await data.call(EVENTS_PORT_OPERATIONS.calendar, {}));
        if (cancelled) return;
        setState({ kind: 'loaded', data: response, clockOffset: response.serverTimeMs - Date.now() });
        if (response.events.length === 0) reportEmpty();
        else reportReady();
      } catch (error) {
        if (!cancelled) { setState({ kind: 'failed' }); reportAsyncError(error); }
      }
    })();
    return () => { cancelled = true; };
    // 配置按 Host 已校验的引用更新；reload 是用户手动刷新。
  }, [data, config, retryToken, reload, reportReady, reportEmpty, reportAsyncError, options.success]);

  const current = state.kind === 'loaded' ? now + state.clockOffset : now;
  const events = useMemo(() => state.kind === 'loaded' ? state.data.events : [], [state]);
  const categories = useMemo(() => [...new Set(events.map((e) => e.category))].sort(), [events]);
  const counts = useMemo(() => ({
    active: events.filter((e) => calendarPhase(e, current) === 'active').length,
    upcoming: events.filter((e) => calendarPhase(e, current) === 'upcoming').length,
    ending: events.filter((e) => e.startsAt !== null && e.endsAt !== null && e.endsAt > current &&
      e.endsAt - current <= THREE_DAYS && e.startsAt <= current).length,
    unknown: events.filter((e) => calendarPhase(e, current) === 'unknown').length,
  }), [events, current]);
  const limit = options.success ? options.data.limit : 20;
  const visible = useMemo(() => order(events.filter((e) => {
    const itemPhase = calendarPhase(e, current);
    if (phase === 'ending' && !(e.endsAt !== null && e.endsAt > current &&
      e.endsAt - current <= THREE_DAYS && e.startsAt !== null && e.startsAt <= current)) return false;
    if (phase !== 'all' && phase !== 'ending' && phase !== itemPhase) return false;
    if (category !== 'all' && e.category !== category) return false;
    const words = keyword.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((word) => (e.title + ' ' + e.description + ' ' + e.category).normalize('NFKC').toLowerCase().includes(word));
  }), current).slice(0, limit), [events, phase, category, keyword, current, limit]);

  if (!options.success || !data) return null;

  return (
    <section className="event-calendar" aria-labelledby={props.instanceId + '-calendar-title'}>
      <div className="event-calendar__heading">
        <div>
          <h3 className="subsection-title" id={props.instanceId + '-calendar-title'}>{options.data.title}</h3>
          <p className="panel__muted">国服 · 北京时间 (UTC+8) · 盛趣官方活动公告接口</p>
        </div>
        <button className="button" type="button" onClick={() => { setState({ kind: 'loading' }); setReload((v) => v + 1); }}>刷新</button>
      </div>

      {state.kind === 'loading' ? <p className="panel__muted">正在读取国服活动日历…</p> : null}
      {state.kind === 'failed' ? <p className="panel__muted">活动数据暂不可用，可点击组件的重试按钮。</p> : null}

      {state.kind === 'loaded' ? (
        <>
          <div className="event-calendar__stats" aria-label="活动概览">
            <div><strong>{counts.active}</strong><span>进行中</span></div>
            <div><strong>{counts.upcoming}</strong><span>即将开始</span></div>
            <div><strong>{counts.ending}</strong><span>72 小时内结束</span></div>
            <div><strong>{counts.unknown}</strong><span>时间待确认</span></div>
          </div>
          <div className="event-calendar__controls">
            <div className="event-calendar__tabs" role="group" aria-label="活动阶段">
              {PHASES.map((tab) => (
                <button className={phase === tab.id ? 'button button--active' : 'button'} type="button"
                  key={tab.id} aria-pressed={phase === tab.id} onClick={() => setPhase(tab.id)}>{tab.label}</button>
              ))}
            </div>
            <div className="event-calendar__fields">
              <label>类别
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="all">全部类别</option>
                  {categories.map((name) => <option value={name} key={name}>{name}</option>)}
                </select>
              </label>
              <label>查找
                <input type="search" value={keyword} placeholder="输入活动名称或关键词"
                  onChange={(e) => setKeyword(e.target.value)} />
              </label>
            </div>
          </div>
          {visible.length === 0 ? <p className="panel__muted">当前条件下没有活动，可切换筛选条件查看。</p> : (
            <ul className="event-calendar__list" aria-label="国服活动">
              {visible.map((event) => {
                const stateName = calendarPhase(event, current);
                const isEnding = stateName === 'active' && event.endsAt !== null &&
                  event.endsAt > current && event.endsAt - current <= THREE_DAYS;
                const span = event.endsAt === null || event.startsAt === null ? 0 : event.endsAt - event.startsAt;
                const progress = span > 0 ? Math.min(100, Math.max(0,
                  Math.round((current - (event.startsAt ?? current)) / span * 100))) : 0;
                const remainingLabel = stateName === 'upcoming' ? '距开始'
                  : stateName === 'ended' ? '已结束'
                  : stateName === 'unknown' ? '倒计时不可用' : '距结束';
                const remainingValue = stateName === 'upcoming' && event.startsAt !== null ? calendarCountdown(event.startsAt, current)
                  : stateName === 'ended' ? '已结束'
                  : stateName === 'unknown' || event.endsAt === null ? '官方时间待核实' : calendarCountdown(event.endsAt, current);
                return (
                  <li className="event-calendar__item" key={event.id}>
                    <div className="event-calendar__item-head">
                      <div className="event-calendar__tags">
                        <span className={'badge event-calendar__phase--' + (isEnding ? 'ending' : stateName)}>
                          {isEnding ? '即将结束' : stateName === 'active' ? '进行中' : stateName === 'upcoming' ? '未开始' : stateName === 'unknown' ? '时间待确认' : '已结束'}
                        </span>
                        <span className="badge">{event.category || '其他'}</span>
                        {event.allDay ? <span className="badge">全天</span> : null}
                      </div>
                      <span className="event-calendar__countdown" aria-label={remainingLabel + remainingValue}>
                        <small>{remainingLabel}</small><strong>{remainingValue}</strong>
                      </span>
                    </div>
                    <h4 className="event-calendar__title">{event.title}</h4>
                    <p className="event-calendar__time">
                      开始：{event.startsAt === null ? '暂无可靠时间' : chinaTime(event.startsAt)}
                      <span>结束：{event.endsAt === null ? '尚未公布' : chinaTime(event.endsAt)}</span>
                    </p>
                    {stateName === 'active' && span > 0 ? (
                      <div className="event-calendar__progress" role="progressbar"
                        aria-label={event.title + ' 活动进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                        <span style={{ width: progress + '%' }} />
                      </div>
                    ) : null}
                    {event.location ? <p className="event-calendar__meta">地点：{event.location}</p> : null}
                    {event.description ? <details className="event-calendar__details"><summary>活动说明</summary>
                      <p>{event.description}</p></details> : null}
                    {event.sourceUrl ? <a className="event-calendar__source" href={event.sourceUrl}
                      target="_blank" rel="noreferrer noopener">查看活动原文 ↗</a> : null}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="event-calendar__footer">
            <span>{state.data.source.stale ? '数据源更新失败，正在展示缓存（可能过期）' :
              '上次获取：' + chinaTime(state.data.source.checkedAtMs)}</span>
            <a href={state.data.source.homeUrl} target="_blank" rel="noreferrer noopener">访问官方新闻中心 ↗</a>
          </div>
          <p className="panel__muted">数据直接来自盛趣游戏官方公告接口。仅对官方正文中明确写明的完整起止时刻提供倒计时；其他活动显示“时间待确认”，不推测。</p>
        </>
      ) : null}
    </section>
  );
}
