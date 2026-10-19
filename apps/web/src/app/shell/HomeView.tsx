/** 首页只投影现有控制器；不安装模块、不创建实例、不保存布局。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NavController } from '../nav/use-nav';
import type { WorkbenchController } from '../workbench/use-workbench';
import { WidgetHost } from '../widgets/WidgetHost';
import type { ModuleAccess, ModuleDataPort } from '../widgets/types';
import type { ShellView } from './shell-view';
import { NavigationDirectory } from './NavigationDirectory';
import { HomeOfficialEvents } from './HomeOfficialEvents';
import { PUBLIC_EVENTS_PREF_CHANGE, readPublicEventsPreference, savePublicEventsPreference } from '../events/public-events-preferences';

interface HomeViewProps {
  readonly nav: NavController;
  readonly workbench: Pick<WorkbenchController, 'activePage' | 'status' | 'error' | 'instances' | 'persistedRects' | 'dirty' | 'conflict' | 'reload'>;
  readonly authenticated: boolean;
  readonly access: (id: string) => ModuleAccess;
  readonly dataPortFor: (id: string) => ModuleDataPort | undefined;
  readonly onOpen: (view: ShellView) => void;
}

export function HomeView({ nav, workbench, authenticated, access, dataPortFor, onOpen }: HomeViewProps) {
  const [publicEvents, setPublicEvents] = useState(readPublicEventsPreference);
  useEffect(() => {
    const refresh = () => setPublicEvents(readPublicEventsPreference());
    window.addEventListener(PUBLIC_EVENTS_PREF_CHANGE, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PUBLIC_EVENTS_PREF_CHANGE, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const calendarModule = <HomeOfficialEvents onOpenCalendar={() => onOpen('calendar')}
    onHide={() => savePublicEventsPreference({ ...publicEvents, visible: false })}/>;
  const loadCatalog = nav.loadCatalog;
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      const target = event.target;
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey ||
          (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const configured = workbench.activePage !== null;
  const ordered = useMemo(() => {
    const rects = new Map(workbench.persistedRects.map(rect => [rect.i, rect]));
    return [...workbench.instances].filter(instance => !instance.hidden).sort((a, b) => {
      const left = rects.get(a.id);
      const right = rects.get(b.id);
      return (left?.y ?? 0) - (right?.y ?? 0) || (left?.x ?? 0) - (right?.x ?? 0) || a.id.localeCompare(b.id);
    });
  }, [workbench.instances, workbench.persistedRects]);

  return <div className="home" data-testid="home-view">
    <form className="home-search" role="search" onSubmit={event => {
      event.preventDefault(); document.getElementById('home-navigation')?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }}>
      <label className="visually-hidden" htmlFor="home-search">搜索导航中的网站、攻略或工具</label>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input ref={searchRef} id="home-search" type="search" value={nav.filter.text ?? ''} placeholder="搜索网站、攻略或工具" onChange={event => nav.patchFilter({ text: event.target.value })} aria-controls="home-navigation"/>
      <button className="home-search__submit" type="submit" aria-label="查看搜索结果">搜索 <span aria-hidden="true">↵</span></button>
    </form>
    <p className="home-search__hint">搜索当前导航 <span aria-hidden="true">·</span> 按 / 快速搜索</p>

    {!publicEvents.visible && <div className="home-official-restore" role="status">
      国服活动模块已隐藏。
      <button className="text-button" type="button" onClick={() => savePublicEventsPreference({ ...publicEvents, visible: true })}>重新显示国服活动</button>
      <button className="text-button" type="button" onClick={() => onOpen('calendar')}>查看完整日历 ↗</button>
    </div>}
    {publicEvents.visible && publicEvents.position === 'before-nav' ? calendarModule : null}

    {authenticated && (workbench.status === 'loading' || workbench.status === 'idle') ? <p className="home-state" role="status">正在读取你的首页配置…</p> :
      workbench.error !== null ? <div className="notice notice--error" role="alert">首页配置读取失败。<button className="text-button" onClick={() => { void workbench.reload(); }}>重试</button></div> :
      configured ? <section className="home-workbench" aria-label="已配置的首页模块">
        <header className="home-section-heading"><h2>{workbench.activePage?.name}</h2><button className="text-button" onClick={() => onOpen('workbench')}>自定义布局 <span aria-hidden="true">↗</span></button></header>
        {workbench.dirty || workbench.conflict !== null ? <p className="notice notice--warn" role="status">布局草稿已保留，首页显示已保存的顺序。<button className="text-button" onClick={() => onOpen('workbench')}>继续编辑</button></p> : null}
        {ordered.length === 0 ? <p className="home-state">此页面没有可见模块。<button className="text-button" onClick={() => onOpen('workbench')}>添加模块</button></p> :
          <WidgetHost instances={ordered.map(instance => ({ instanceId: instance.id, moduleId: instance.moduleId, widgetId: instance.widgetType, config: instance.config, configVersion: instance.configVersion, hidden: false }))} access={access} dataPortFor={dataPortFor}/>}
      </section> : <section className="home-daily home-daily--single" aria-label="日常信息">
        <section><header className="home-section-heading"><h2>钓鱼提醒</h2><span className="home-section-kicker">FISHING</span></header>
          <p className="home-state">{authenticated ? '还没有配置鱼窗模块。' : '连接工作空间后，查看鱼窗与钓获进度。'}</p>
          <button className="text-button" onClick={() => onOpen(authenticated ? 'fishing' : 'credentials')}>{authenticated ? '查看钓鱼手账' : '连接工作空间'} <span aria-hidden="true">↗</span></button>
        </section>
      </section>}

    <NavigationDirectory nav={nav} authenticated={authenticated} onOpen={onOpen}/>
    {publicEvents.visible && publicEvents.position === 'after-nav' ? calendarModule : null}
  </div>;
}
