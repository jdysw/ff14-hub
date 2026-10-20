import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {API_ROUTES,type NavCatalogEntry} from '@ff14-hub/shared';
import {HomeOfficialEvents} from '../shell/HomeOfficialEvents';
import {PublicCalendarPage} from '../events/PublicCalendarPage';
import {FishingBoard} from '../fish/FishingBoard';
import {createLocalStore,type LocalData} from './store';
import {localFishPort} from './fish-port';
import {LocalSettings} from './LocalSettings';
import {navCatalogResponseSchema} from '../nav/nav-api';
import {PwaStatusBar} from '../pwa/PwaStatusBar';
import {useSiteSettings} from '../admin/site-settings';
import {useCalendarAdminSession} from '../events/calendar-admin-session';
import './local.css';

const SiteAdminPage=lazy(()=>import('../admin/SiteAdminPage').then(module=>({default:module.SiteAdminPage})));

function siteDomain(url:string):string{
  try{return new URL(url).hostname.replace(/^www\./,'');}
  catch{return url;}
}

export function LocalApp(){
  const [store]=useState(()=>createLocalStore());
  const dataPort=useMemo(()=>localFishPort(store),[store]);
  const [data,setData]=useState<LocalData|null>(null);
  const [catalog,setCatalog]=useState<NavCatalogEntry[]>([]);
  const [catalogError,setCatalogError]=useState(false);
  const [catalogReload,setCatalogReload]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [view,setView]=useState<'home'|'settings'|'calendar'|'fishing'|'notes'|'admin'>('home');
  const [settingsTab,setSettingsTab]=useState<'home'|'links'|'notes'|'fish'|'backup'>('home');
  const [category,setCategory]=useState('all');
  const siteSettings=useSiteSettings();
  const adminSession=useCalendarAdminSession();
  const adminClicks=useRef<number[]>([]);
  const openAdmin=()=>{
    const now=Date.now();
    adminClicks.current=[...adminClicks.current.filter(time=>now-time<4000),now];
    if(adminSession.authenticated||adminClicks.current.length>=5){adminClicks.current=[];setView('admin');}
  };
  useEffect(()=>{document.title=siteSettings.siteName;},[siteSettings.siteName]);
  const [search,setSearch]=useState('');
  const [favorites,setFavorites]=useState(false);
  const [visibleLimit,setVisibleLimit]=useState(36);
  const searchRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    let alive=true;let revision=-1;
    const refresh=()=>{void store.read().then(next=>{if(alive&&next.revision>=revision){revision=next.revision;setData(next);setError(null);}}).catch((cause:unknown)=>{if(alive)setError(cause instanceof Error?cause.message:'读取本机数据失败');});};
    refresh();const unsubscribe=store.subscribe(refresh);
    return()=>{alive=false;unsubscribe();};
  },[store]);
  useEffect(()=>{
    let alive=true;
    void fetch(API_ROUTES.navCatalog,{credentials:'omit',redirect:'error'}).then(async response=>{if(!response.ok)throw new Error('目录暂时无法读取');return navCatalogResponseSchema.parse(await response.json());})
      .then(result=>{if(alive){setCatalog([...result.entries]);setCatalogError(false);}}).catch(()=>{if(alive)setCatalogError(true);});
    return()=>{alive=false;};
  },[catalogReload]);
  useEffect(()=>{
    const shortcut=(event:KeyboardEvent)=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!(event.target instanceof HTMLElement&&(event.target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))){event.preventDefault();setView('home');requestAnimationFrame(()=>{document.getElementById('local-navigation')?.scrollIntoView({block:'nearest'});searchRef.current?.focus();});}};
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  },[]);
  const query=search.trim().toLocaleLowerCase();
  const links=useMemo(()=>{
    const personal=(data?.links??[]).map(link=>({...link,personal:true}));
    const existing=new Set(personal.map(link=>link.url));
    return [...personal,...catalog.filter(link=>!existing.has(link.url)).map(link=>({id:link.id,title:link.title,url:link.url,category:link.category,favorite:false,personal:false}))]
      .filter(link=>(!favorites||link.favorite)&&(!query||[link.title,link.url,link.category].join(' ').toLocaleLowerCase().includes(query)));
  },[data,catalog,query,favorites]);
  const groups=useMemo(()=>[...new Set([...(data?.links??[]),...catalog].map(link=>link.category||'常用网站'))].sort((a,b)=>a.localeCompare(b,'zh-CN')),[data,catalog]);
  const filteredLinks=useMemo(()=>category==='all'?links:links.filter(link=>(link.category||'常用网站')===category),[links,category]);
  useEffect(()=>{setVisibleLimit(36);},[search,category,favorites]);
  const enabledSections=data?.configuration.order.filter(section=>data.configuration.visible[section]&&(section!=='events'||siteSettings.homeCalendarEnabled))??[];
  const saveFavorite=(link:typeof links[number])=>{
    void store.change(document=>{
      const old=document.data.links.find(item=>item.url===link.url);
      if(old)old.favorite=!old.favorite;
      else document.data.links.push({id:crypto.randomUUID(),title:link.title,url:link.url,category:link.category,favorite:true});
    }).catch((cause:unknown)=>setError(cause instanceof Error?cause.message:'本机保存失败'));
  };

  return <div className="shell local-app">
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    <header className="shell__header">
      <button className="brand__home" type="button" onClick={()=>setView('home')} aria-label={siteSettings.siteName+' 首页'}>
        <span className="brand__mark" aria-hidden="true">XIV</span>
        <h1 className="brand__title">{siteSettings.siteName}</h1>
      </button>
      <div className="local-app__header-actions">
        {view!=='home'&&view!=='calendar'&&<button type="button" className="local-app__back" onClick={()=>setView('home')}>← <span>返回</span></button>}
        <button className="shell__settings" type="button" aria-label={view==='settings'?'返回首页':'设置'} aria-pressed={view==='settings'} onClick={()=>setView(view==='settings'?'home':'settings')}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l-1.8 1.8a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.7h-2.6v-.7a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-1.8-1.8a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4v-2.6h.7a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8L7.7 6.8a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V5h2.6v.6a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l1.8 1.8a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1h.7V14h-.7a1.6 1.6 0 0 0-1.5 1Z"/></svg>
          <span>设置</span>
        </button>
      </div>
    </header>
    <PwaStatusBar localMode/>
    <main id="main-content" className="shell__main local-app__main" tabIndex={-1}>
      {siteSettings.announcementEnabled&&siteSettings.announcement.trim()?<aside className="site-public-announcement" aria-label="站点公告">{siteSettings.announcement}</aside>:null}
      {error?<p role="alert" className="notice notice--error">{error}</p>:null}
      {view==='admin'?<Suspense fallback={<p role="status">正在打开站点后台…</p>}><SiteAdminPage onClose={()=>setView('settings')}/></Suspense>
        :!data?error?<p role="alert">本机数据读取失败。<button type="button" onClick={()=>window.location.reload()}>重试</button></p>:<p role="status">正在读取…</p>
        :view==='settings'?<LocalSettings key={settingsTab} initialTab={settingsTab} store={store} data={data} onSaved={()=>{}} onAdmin={openAdmin} adminAuthenticated={adminSession.authenticated}/>
        :view==='calendar'?<PublicCalendarPage onBack={()=>setView('home')}/>
        :view==='fishing'?<div className="local-detail local-detail--fishing">
          <FishingBoard data={dataPort} initialRegion={data.configuration.region} onImport={()=>{setSettingsTab('fish');setView('settings');}}/>
        </div>
        :view==='notes'?<section className="local-detail local-detail--notes" aria-label="全部备忘">
          <header className="local-detail__header"><h2>我的备忘</h2><button type="button" onClick={()=>{setSettingsTab('notes');setView('settings');}}>管理备忘 ↗</button></header>
          {data.notes.length?data.notes.map(note=><article className="local-detail__note" key={note.id}><h3>{note.title}</h3><p>{note.text}</p></article>):
            <p className="local-detail__empty">暂无备忘。可在设置中添加。</p>}
        </section>
        :<div className="local-dashboard">
          <section className="local-dashboard__modules" aria-label="功能模块">
            <header className="local-dashboard__section-heading">
              <h2>常用功能</h2>
              <button type="button" className="local-dashboard__manage" onClick={()=>{setSettingsTab('home');setView('settings');}}>自定义 <span aria-hidden="true">↗</span></button>
            </header>
            <div className="local-dashboard__module-grid">
              {enabledSections.length===0?<p className="local-dashboard__empty">
                <button type="button" onClick={()=>{setSettingsTab('home');setView('settings');}}>启用功能模块 ＋</button>
              </p>:enabledSections.map(section=><div className="local-dashboard__module" key={section} data-module={section}>
                {section==='events'?<HomeOfficialEvents maxItems={2} onOpenCalendar={()=>setView('calendar')}
                  onHide={()=>{void store.change(document=>{document.data.configuration.visible.events=false;}).catch(()=>setError('设置未能保存到本机'));}}/>:
                section==='fishing'?<FishingBoard data={dataPort} initialRegion={data.configuration.region} preview onOpenDetail={()=>setView('fishing')}/>:
                <section className="local-notes" aria-label="我的备忘">
                  <header className="local-notes__heading"><h3>备忘</h3>
                    <button type="button" className="local-dashboard__manage" onClick={()=>setView('notes')}>查看全部 ↗</button>
                  </header>
                  {data.notes.length?data.notes.slice(0,2).map(note=><article key={note.id}><h4>{note.title}</h4><p>{note.text}</p></article>):
                    <p className="local-notes__empty">暂无备忘 <button type="button" onClick={()=>{setSettingsTab('notes');setView('settings');}}>添加 ＋</button></p>}
                </section>}
              </div>)}
            </div>
          </section>
          <section id="local-navigation" className="local-directory" aria-label="导航站">
            <header className="local-dashboard__section-heading local-directory__heading">
              <div className="local-directory__heading-title"><h2>导航站</h2><span>{filteredLinks.length} 个网站</span></div>
              <div className="local-directory__heading-actions">
                <button type="button" className="local-dashboard__manage" aria-pressed={favorites} onClick={()=>setFavorites(value=>!value)}>{favorites?'★ 已收藏':'☆ 收藏'}</button>
                <button type="button" className="local-dashboard__manage" onClick={()=>{setSettingsTab('links');setView('settings');}}>管理 ↗</button>
              </div>
            </header>
            <div className="local-directory__toolbar">
              <form className="home-search" role="search" onSubmit={event=>{event.preventDefault();searchRef.current?.focus();}}>
                <label className="visually-hidden" htmlFor="local-search">搜索网站</label>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
                <input id="local-search" ref={searchRef} type="search" value={search} placeholder="搜索网站、攻略、工具…" onChange={event=>setSearch(event.target.value)}/>
                <kbd aria-hidden="true">/</kbd>
              </form>
              <nav className="local-directory__filters" aria-label="网站分类">
                <button type="button" aria-pressed={category==='all'} onClick={()=>setCategory('all')}>全部</button>
                {groups.map(group=><button type="button" key={group} aria-pressed={category===group} onClick={()=>setCategory(group)}>{group}</button>)}
              </nav>
            </div>
            {catalogError&&<div role="status" className="local-directory__notice">推荐目录无法加载 <button type="button" onClick={()=>setCatalogReload(value=>value+1)}>重试</button></div>}
            {filteredLinks.length===0?<div className="local-directory__empty">暂无匹配网站 <button type="button" onClick={()=>{setCategory('all');setFavorites(false);setSearch('');}}>清除筛选</button></div>:
              <ul className="local-directory__tiles">{filteredLinks.slice(0,visibleLimit).map(link=><li key={link.id} className="local-directory__tile">
                <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
                  <span className="local-directory__monogram" aria-hidden="true">{link.title.trim().slice(0,1)||'·'}</span>
                  <span className="local-directory__link-content">
                    <span className="local-directory__link-name">{link.title}</span>
                    <span className="local-directory__link-domain">{siteDomain(link.url)}</span>
                  </span>
                </a>
                <button type="button" className="local-directory__star" aria-label={(link.favorite?'取消收藏 ':'收藏 ')+link.title} aria-pressed={link.favorite} onClick={()=>saveFavorite(link)}>{link.favorite?'★':'☆'}</button>
              </li>)}</ul>}
            {filteredLinks.length>visibleLimit&&<button type="button" className="local-directory__more" onClick={()=>setVisibleLimit(v=>v+36)}>显示更多网站（剩余 {filteredLinks.length-visibleLimit}）</button>}
          </section>
        </div>}
    </main>
  </div>;
}
