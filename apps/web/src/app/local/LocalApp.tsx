import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import {API_ROUTES,matchesDirectorySearch,canonicalNavUrl,type NavCatalogEntry} from '@ff14-hub/shared';
import {directoryLinks} from './DirectoryBrowser';
import {HomeOfficialEvents} from '../shell/HomeOfficialEvents';
import {PublicCalendarPage} from '../events/PublicCalendarPage';
import {FishingBoard,type FishDetailSelection} from '../fish/FishingBoard';
import {LocalModuleOverlay,type ModuleOrigin} from './LocalModuleOverlay';
import {createLocalStore,type LocalData} from './store';
import {localFishPort} from './fish-port';
import {LocalSettings} from './LocalSettings';
import {SiteIcon} from './SiteIcon';
import {UiIcon} from './UiIcon';
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
  const [catalogLoading,setCatalogLoading]=useState(true);
  const [catalogReload,setCatalogReload]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [view,setView]=useState<'home'|'settings'|'admin'>('home');
  const [expanded,setExpanded]=useState<null|{
    kind:'events'|'fishing'|'notes';
    origin:ModuleOrigin;
    fishFilters?:FishDetailSelection;
  }>(null);
  // 共用一个从模块位置展开的详情层；关闭后保留首页的筛选和滚动位置。
  const openModule=(kind:'events'|'fishing'|'notes',fishFilters?:FishDetailSelection)=>{
    const source=document.querySelector<HTMLElement>(`[data-module="${kind}"]`);
    if(!source)return;
    const {top,left,width,height}=source.getBoundingClientRect();
    setExpanded({
      kind,origin:{rect:{top,left,width,height},element:source,returnFocus:document.activeElement instanceof HTMLElement?document.activeElement:null},
      ...(fishFilters?{fishFilters}:{}),
    });
  };
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
      .then(result=>{if(alive){setCatalog([...result.entries]);setCatalogError(false);}}).catch(()=>{if(alive)setCatalogError(true);})
      .finally(()=>{if(alive)setCatalogLoading(false);});
    return()=>{alive=false;};
  },[catalogReload]);
  const reloadCatalog=()=>{setCatalogLoading(true);setCatalogError(false);setCatalogReload(value=>value+1);};
  useEffect(()=>{const refresh=()=>{setCatalogLoading(true);setCatalogError(false);setCatalogReload(value=>value+1);};window.addEventListener('ff14hub:directory-changed',refresh);return()=>window.removeEventListener('ff14hub:directory-changed',refresh);},[]);
  useEffect(()=>{
    const shortcut=(event:KeyboardEvent)=>{if(document.querySelector('dialog[open]'))return;if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!(event.target instanceof HTMLElement&&(event.target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))){event.preventDefault();setView('home');requestAnimationFrame(()=>searchRef.current?.focus());}};
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  },[]);
  const query=search.trim();
  // 合并系统与本地目录：本地收藏和人工简介优先，搜索覆盖系统别名与标签。
  const allLinks=useMemo(()=>directoryLinks(catalog,data?.links??[]),[catalog,data]);
  const links=useMemo(()=>allLinks.filter(link=>
    (!favorites||link.favorite)&&matchesDirectorySearch(link,query)
  ),[allLinks,query,favorites]);
  const groups=useMemo(()=>[...new Set(allLinks.map(link=>link.category||'常用网站'))].sort((a,b)=>a.localeCompare(b,'zh-CN')),[allLinks]);
  const primaryGroups=['副本与战斗','生产采集与钓鱼','市场与经济','幻化与外观','社区与创作'].filter(group=>groups.includes(group));
  const extraGroups=groups.filter(group=>!primaryGroups.includes(group));
  const filteredLinks=useMemo(()=>category==='all'?links:links.filter(link=>(link.category||'常用网站')===category),[links,category]);
  const hasFilters=Boolean(query||favorites||category!=='all');
  const clearFilters=()=>{setCategory('all');setFavorites(false);setSearch('');setVisibleLimit(36);};
  const enabledSections=data?.configuration.order.filter(section=>data.configuration.visible[section]&&(section!=='events'||siteSettings.homeCalendarEnabled))??[];
  const saveFavorite=(link:typeof links[number])=>{
    void store.change(document=>{
      const old=document.data.links.find(item=>canonicalNavUrl(item.url)===canonicalNavUrl(link.url));
      if(old)old.favorite=!old.favorite;
      else document.data.links.push({id:crypto.randomUUID(),title:link.title,url:link.url,category:link.category,description:link.description??'',...(link.faviconUrl?{faviconUrl:link.faviconUrl}:{}),favorite:true});
    }).catch((cause:unknown)=>setError(cause instanceof Error?cause.message:'本机保存失败'));
  };

  return <div className="shell local-app">
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    <header className="shell__header">
      <button className="brand__home" type="button" onClick={()=>setView('home')} aria-current={view==='home'?'page':undefined} aria-label={siteSettings.siteName+' 首页'}>
        <span className="brand__mark" aria-hidden="true">XIV</span>
        <h1 className="brand__title">{siteSettings.siteName}</h1>
      </button>
      <div className="local-app__header-actions">
        {view==='home'&&data?<a className="local-app__nav-jump" href="#local-navigation">导航站 ↓</a>:null}
        {view!=='home'&&<button type="button" className="local-app__back" onClick={()=>setView('home')}>← <span>返回</span></button>}
        <button className="shell__settings" type="button" aria-label={view==='settings'?'返回首页':'设置'} aria-pressed={view==='settings'} onClick={()=>setView(view==='settings'?'home':'settings')}>
          <UiIcon name="gear"/>
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
                {section==='events'?<HomeOfficialEvents onOpenCalendar={()=>openModule('events')}
                  onHide={()=>{void store.change(document=>{document.data.configuration.visible.events=false;}).catch(()=>setError('设置未能保存到本机'));}}/>:
                section==='fishing'?<FishingBoard data={dataPort} initialRegion={data.configuration.region} embedded onOpenDetail={selection=>openModule('fishing',selection)}/>:
                <section className="local-notes" aria-label="我的备忘">
                  <header className="local-notes__heading"><h3>备忘</h3>
                    <button type="button" className="local-dashboard__manage" onClick={()=>openModule('notes')}>查看全部 ↗</button>
                  </header>
                  {data.notes.length?data.notes.slice(0,2).map(note=><article key={note.id}><h4>{note.title}</h4><p>{note.text}</p></article>):
                    <p className="local-notes__empty">暂无备忘 <button type="button" onClick={()=>{setSettingsTab('notes');setView('settings');}}>添加 ＋</button></p>}
                </section>}
              </div>)}
            </div>
          </section>
          <div className="field-divider" aria-hidden="true"/>
          <section id="local-navigation" className="local-directory" aria-label="导航站">
            <header className="local-dashboard__section-heading local-directory__heading">
              <div className="local-directory__heading-title"><h2>导航站</h2><output aria-live="polite" aria-atomic="true">{hasFilters?`${filteredLinks.length} / ${allLinks.length}`:allLinks.length} 个网站</output></div>
              <div className="local-directory__heading-actions">
                <button type="button" className="local-dashboard__manage local-directory__favorites" aria-pressed={favorites} onClick={()=>{setFavorites(value=>!value);setVisibleLimit(36);}}><UiIcon name={favorites?'starFill':'star'}/>{favorites?'已收藏':'收藏'}</button>
                <button type="button" className="local-dashboard__manage" onClick={()=>{setSettingsTab('links');setView('settings');}}>管理 ↗</button>
              </div>
            </header>
            <div className="local-directory__toolbar">
              <form className="home-search" role="search" onSubmit={event=>{event.preventDefault();searchRef.current?.focus();}}>
                <label className="visually-hidden" htmlFor="local-search">搜索网站</label>
                <UiIcon name="search"/>
                <input id="local-search" ref={searchRef} type="search" value={search} placeholder="搜索网站、攻略、工具…" aria-controls="directory-results" onChange={event=>{setSearch(event.target.value);setVisibleLimit(36);}} onKeyDown={event=>{if(event.key==='Escape'){setSearch('');setVisibleLimit(36);}}}/>
                <kbd aria-hidden="true">/</kbd>
              </form>
              {hasFilters?<button type="button" className="local-directory__reset" onClick={clearFilters}>清除筛选</button>:null}
            </div>
            <div className="local-directory__category-row">
              <nav className="local-directory__filters" aria-label="网站分类">
                <button type="button" aria-pressed={category==='all'} onClick={()=>{setCategory('all');setVisibleLimit(36);}}>全部</button>
                {primaryGroups.map(group=><button type="button" key={group} aria-pressed={category===group} onClick={()=>{setCategory(group);setVisibleLimit(36);}}>{group}</button>)}
                {extraGroups.length?<label className="atlas-more-categories"><span className="visually-hidden">更多分类</span><select value={extraGroups.includes(category)?category:''} onChange={event=>{if(event.target.value){setCategory(event.target.value);setVisibleLimit(36);}}}><option value="">更多分类</option>{extraGroups.map(group=><option key={group} value={group}>{group}</option>)}</select></label>:null}
              </nav>
              <label className="local-directory__category-select"><span>网站分类</span><select value={category} onChange={event=>{setCategory(event.target.value);setVisibleLimit(36);}}><option value="all">全部分类</option>{groups.map(group=><option key={group} value={group}>{group}</option>)}</select></label>
            </div>
            {catalogError&&<div role="status" className="local-directory__notice">公共目录暂时无法更新，本机网站和已加载内容仍可使用。 <button type="button" onClick={reloadCatalog}>重试</button></div>}
            {catalogLoading?<p role="status" className="local-directory__loading">正在更新网站目录…</p>:null}
            {filteredLinks.length===0?(!catalogLoading&&<div id="directory-results" className="local-directory__empty"><h3>{hasFilters?'没有找到匹配的网站':catalogError?'暂时无法读取公共目录':'还没有网站'}</h3><p>{hasFilters?(favorites?'试试取消收藏筛选，或更换关键词与分类。':'试试网站名称、别名或用途，或选择其他分类。'):'可以在设置中添加自己的常用网站。'}</p>{hasFilters?<button type="button" onClick={clearFilters}>查看全部网站</button>:<button type="button" onClick={()=>{setSettingsTab('links');setView('settings');}}>添加个人网站</button>}</div>):
              <ul id="directory-results" className="local-directory__tiles">{filteredLinks.slice(0,visibleLimit).map(link=><li key={link.id} className="local-directory__tile">
                <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
                  <SiteIcon key={link.url} url={link.url} title={link.title} faviconUrl={link.faviconUrl}/>
                  <span className="local-directory__link-content">
                    <span className="local-directory__link-name">{link.title}</span>
                    {link.description?<span className="local-directory__link-description" title={link.description}>{link.description}</span>:null}
                    <span className="local-directory__link-domain">{siteDomain(link.url)}</span>
                  </span>
                </a>
                <button type="button" className="local-directory__star" aria-label={(link.favorite?'取消收藏 ':'收藏 ')+link.title} aria-pressed={link.favorite} title={link.favorite?'取消收藏':'收藏网站'} onClick={()=>saveFavorite(link)}><UiIcon name={link.favorite?'starFill':'star'}/></button>
              </li>)}</ul>}
            {filteredLinks.length>visibleLimit&&<button type="button" className="local-directory__more" onClick={()=>setVisibleLimit(v=>v+36)}>显示更多网站（剩余 {filteredLinks.length-visibleLimit}）</button>}
          </section>
        </div>}
    </main>
    {expanded&&data&&view==='home'?<LocalModuleOverlay
      key={expanded.kind}
      title={{events:'国服活动',fishing:'钓鱼',notes:'我的备忘'}[expanded.kind]}
      origin={expanded.origin}
      onClose={()=>setExpanded(null)}>
      {expanded.kind==='events'?<PublicCalendarPage overlay onBack={()=>setExpanded(null)}/>:
        expanded.kind==='fishing'?<FishingBoard data={dataPort} initialRegion={data.configuration.region}
          initialFilters={expanded.fishFilters} expanded onImport={()=>{
            setExpanded(null);setSettingsTab('fish');setView('settings');
          }}/>:
        <section className="local-detail local-detail--notes" aria-label="全部备忘">
          <header className="local-detail__header"><h2>我的备忘</h2>
            <button type="button" onClick={()=>{setExpanded(null);setSettingsTab('notes');setView('settings');}}>管理备忘 ↗</button>
          </header>
          {data.notes.length?data.notes.map(note=><article className="local-detail__note" key={note.id}>
            <h3>{note.title}</h3><p>{note.text}</p>
          </article>):<p className="local-detail__empty">暂无备忘。可在设置中添加。</p>}
        </section>}
    </LocalModuleOverlay>:null}
  </div>;
}
