import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {API_ROUTES,type NavCatalogEntry} from '@ff14-hub/shared';
import {HomeOfficialEvents} from '../shell/HomeOfficialEvents';
import {PublicCalendarPage} from '../events/PublicCalendarPage';
import {FishingBoard} from '../fish/FishingBoard';
import {createLocalStore,type LocalData,type HomeSection} from './store';
import {localFishPort} from './fish-port';
import {LocalSettings} from './LocalSettings';
import {navCatalogResponseSchema} from '../nav/nav-api';
import {PwaStatusBar} from '../pwa/PwaStatusBar';
import {useSiteSettings} from '../admin/site-settings';
import {useCalendarAdminSession} from '../events/calendar-admin-session';
import './local.css';

const SiteAdminPage=lazy(()=>import('../admin/SiteAdminPage').then(module=>({default:module.SiteAdminPage})));
type HomePanel='navigation'|HomeSection;
const panelNames:Record<HomePanel,string>={navigation:'导航',events:'活动',fishing:'钓鱼',notes:'备忘'};
const panelMarks:Record<HomePanel,string>={navigation:'◈',events:'◷',fishing:'◇',notes:'▤'};

export function LocalApp(){
  const [store]=useState(()=>createLocalStore());
  const dataPort=useMemo(()=>localFishPort(store),[store]);
  const [data,setData]=useState<LocalData|null>(null);
  const [catalog,setCatalog]=useState<NavCatalogEntry[]>([]);
  const [catalogError,setCatalogError]=useState(false);
  const [catalogReload,setCatalogReload]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [view,setView]=useState<'home'|'settings'|'calendar'|'admin'>('home');
  const [panel,setPanel]=useState<HomePanel>('navigation');
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
    const shortcut=(event:KeyboardEvent)=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!(event.target instanceof HTMLElement&&(event.target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))){event.preventDefault();setView('home');setPanel('navigation');requestAnimationFrame(()=>searchRef.current?.focus());}};
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  },[]);
  const query=search.trim().toLocaleLowerCase();
  const links=useMemo(()=>{
    const personal=(data?.links??[]).map(link=>({...link,personal:true}));
    const existing=new Set(personal.map(link=>link.url));
    return [...personal,...catalog.filter(link=>!existing.has(link.url)).map(link=>({id:link.id,title:link.title,url:link.url,category:link.category,favorite:false,personal:false}))]
      .filter(link=>(!favorites||link.favorite)&&(!query||[link.title,link.url,link.category].join(' ').toLocaleLowerCase().includes(query)));
  },[data,catalog,query,favorites]);
  const groups=useMemo(()=>[...new Set(links.map(link=>link.category||'常用网站'))],[links]);
  const filteredLinks=useMemo(()=>category==='all'?links:links.filter(link=>(link.category||'常用网站')===category),[links,category]);
  const enabledPanels=data?.configuration.order.filter(section=>data.configuration.visible[section]&&(section!=='events'||siteSettings.homeCalendarEnabled))??[];
  const activePanel=panel==='navigation'||enabledPanels.includes(panel)?panel:'navigation';
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
        <span className="brand__mark" aria-hidden="true"><span>✦</span></span>
        <h1 className="brand__title">{siteSettings.siteName}</h1>
        <span className="brand__edition" aria-hidden="true">XIV</span>
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
        :view==='settings'?<LocalSettings store={store} data={data} onSaved={()=>{}} onAdmin={openAdmin} adminAuthenticated={adminSession.authenticated}/>
        :view==='calendar'?<PublicCalendarPage onBack={()=>setView('home')}/>
        :<div className="local-dashboard">
          <aside className="local-dashboard__rail" aria-label="工作台">
            <div className="local-dashboard__seal" aria-hidden="true"><span>✦</span></div>
            <nav className="local-dashboard__tabs" aria-label="模块切换">
              {(['navigation',...enabledPanels] as HomePanel[]).map(item=><button key={item} type="button" className={activePanel===item?'local-dashboard__tab is-active':'local-dashboard__tab'} aria-current={activePanel===item?'page':undefined} onClick={()=>setPanel(item)}>
                <span className="local-dashboard__tab-icon" aria-hidden="true">{panelMarks[item]}</span><span>{panelNames[item]}</span>
              </button>)}
            </nav>
          </aside>
          <section className="local-dashboard__workspace" aria-label={panelNames[activePanel]}>
            <header className="local-dashboard__workspace-head">
              <h2>{panelNames[activePanel]}</h2>
              {activePanel==='navigation'&&<div className="local-dashboard__workspace-actions">
                <span className="local-dashboard__count">{links.length} 个网站</span>
                <button type="button" className="local-dashboard__favorite" aria-pressed={favorites} onClick={()=>setFavorites(value=>!value)}>{favorites?'★ 已收藏':'☆ 收藏'}</button>
              </div>}
              {activePanel==='notes'&&<button className="local-dashboard__action" type="button" onClick={()=>setView('settings')}>编辑备忘 ↗</button>}
            </header>
            <div className="local-dashboard__workspace-body">
              {activePanel==='navigation'&&<section id="local-navigation" className="local-directory" aria-label="网站目录">
                <form className="home-search" role="search" onSubmit={event=>{event.preventDefault();searchRef.current?.focus();}}>
                  <label className="visually-hidden" htmlFor="local-search">搜索网站</label>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
                  <input id="local-search" ref={searchRef} type="search" value={search} placeholder="搜索网站…" onChange={event=>setSearch(event.target.value)}/>
                  <kbd aria-hidden="true">/</kbd>
                </form>
                <nav className="local-directory__filters" aria-label="网站分类">
                  <button type="button" aria-pressed={category==='all'} onClick={()=>setCategory('all')}>全部</button>
                  {groups.map(group=><button type="button" key={group} aria-pressed={category===group} onClick={()=>setCategory(group)}>{group}</button>)}
                </nav>
                {catalogError&&<div role="status" className="local-directory__notice">推荐目录无法加载 <button type="button" onClick={()=>setCatalogReload(value=>value+1)}>重试</button></div>}
                {filteredLinks.length===0?<div className="local-directory__empty">暂无网站 <button type="button" onClick={()=>{setCategory('all');setFavorites(false);setSearch('');}}>清除筛选</button></div>:
                  <ul className="local-directory__tiles">{filteredLinks.map(link=><li key={link.id} className="local-directory__tile">
                    <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
                      <span className="local-directory__monogram" aria-hidden="true">{link.title.trim().slice(0,1)||'✦'}</span>
                      <span className="local-directory__link-name">{link.title}</span>
                      <span className="local-directory__link-arrow" aria-hidden="true">↗</span>
                    </a>
                    <button type="button" className="local-directory__star" aria-label={(link.favorite?'取消收藏 ':'收藏 ')+link.title} aria-pressed={link.favorite} onClick={()=>saveFavorite(link)}>{link.favorite?'★':'☆'}</button>
                  </li>)}</ul>}
              </section>}
              {activePanel==='events'&&<HomeOfficialEvents onOpenCalendar={()=>setView('calendar')} onHide={()=>{void store.change(document=>{document.data.configuration.visible.events=false;}).catch(()=>setError('设置未能保存到本机'));}}/>}
              {activePanel==='fishing'&&<FishingBoard data={dataPort} initialRegion={data.configuration.region} compact onImport={()=>setView('settings')}/>}
              {activePanel==='notes'&&<section className="local-notes" aria-label="我的备忘">
                {data.notes.length?data.notes.map(note=><article key={note.id}><h3>{note.title}</h3><p>{note.text}</p></article>):<div className="local-notes__empty"><span aria-hidden="true">✦</span><button type="button" onClick={()=>setView('settings')}>添加备忘 ＋</button></div>}
              </section>}
            </div>
          </section>
        </div>}
    </main>
  </div>;
}
