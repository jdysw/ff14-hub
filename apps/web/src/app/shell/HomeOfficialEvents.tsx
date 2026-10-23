/** 首页只显示值得关注的近期日程；完整历史、筛选与日期选择放入独立活动中心。 */
import { eventCalendarResponseSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  calendarOverview, chinaDateTime, displayCalendarTitle, eventStatus, isScheduled, SOON_MS,calendarCountdown,
} from '../events/public-calendar-utils';

export const HOME_EVENT_LIMIT = 4;
export const HOME_CALENDAR_POLL_MS = 6 * 60 * 60_000;

/**
 * 列表包含全部有效日程；界面最多同时显示 4 项，其余在列表内滚动。
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
    });
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
  const [phase,setPhase]=useState<'active'|'upcoming'>('active');

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let sequence=0;
    let lastRequestedAt=0;
    const load=async () => {
      lastRequestedAt=Date.now();
      const current=++sequence;
      try {
        const response = await fetch('/api/v1/events/calendar', {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        if (!response.ok) throw new Error('calendar_unavailable');
        const data: unknown = await response.json();
        const parsed = eventCalendarResponseSchema.safeParse(data);
        if (!parsed.success) throw new Error('calendar_contract_error');
        if (!controller.signal.aborted&&current===sequence) {
          setState({ kind: 'ready', value: parsed.data, offset: parsed.data.serverTimeMs - Date.now() });
        }
      } catch {
        if (!controller.signal.aborted&&current===sequence) setState(previous=>previous.kind==='ready'
          ?{...previous,value:{...previous.value,source:{...previous.value.source,stale:true}}}
          :{kind:'error'});
      }
    };
    void load();
    const visibleRefresh=()=>{
      if(document.visibilityState!=='hidden'&&Date.now()-lastRequestedAt>=HOME_CALENDAR_POLL_MS)void load();
    };
    const timer=window.setInterval(visibleRefresh,HOME_CALENDAR_POLL_MS);
    document.addEventListener('visibilitychange',visibleRefresh);
    return () => {controller.abort();window.clearInterval(timer);document.removeEventListener('visibilitychange',visibleRefresh);};
  }, [refresh]);

  const now = state.kind === 'ready' ? clock + state.offset : clock;
  const overview = useMemo(() =>
    calendarOverview(state.kind === 'ready' ? state.value.events : [], now), [state, now]);
  // 不截断数据；4 项的可视窗口由列表样式控制。
  const allEvents = state.kind === 'ready' ? state.value.events : [];
  const unknownCount = allEvents.filter(item => !isScheduled(item)).length;
  const highlights=homeEventHighlights(allEvents,now);
  const important=highlights.filter(item=>phase==='active'?item.startsAt!<=now&&item.endsAt!>now:item.startsAt!>now);
  const reload = () => { setRefresh(value => value + 1); };

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
    <div className="home-status-tabs" role="group" aria-label="首页活动切换">
      <button type="button" aria-pressed={phase==='active'} onClick={()=>setPhase('active')}>进行中活动</button>
      <button type="button" aria-pressed={phase==='upcoming'} onClick={()=>setPhase('upcoming')}>未来活动</button>
    </div>
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
      {important.length === 0 && <p className="home-state">{phase==='active'?'目前没有已确认时间的进行中活动，可切换“未来活动”查看。':'目前没有已确认时间的未来活动。'}{unknownCount > 0 ? '待核实公告可在完整日历查看。' : ''}</p>}
      {important.length > 0 && <ul key={phase} className="home-official__list" tabIndex={0} aria-label="国服活动列表">
        {important.map(item => <OfficialEventSummary key={item.id} item={item} now={now}/>)}
      </ul>}
    </>}
  </section>;
}
