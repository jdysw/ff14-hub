type LocalView='home'|'settings'|'admin';
type LocalModuleKind='events'|'fishing'|'pvp'|'notes'|'plan'|'market';
type OpenModule=(kind:LocalModuleKind,fishFilters?:FishDetailSelection,eventId?:string,marketQuery?:string)=>void;

function LocalHeader({setView,view,siteSettings,setSearchOpen,focusSearchResult,searchOpen,showSearch,searchRef,search,setSearch,closeSearch,data,openModule}:Readonly<{setView:Dispatch<SetStateAction<LocalView>>;view:LocalView;siteSettings:SiteSettings;setSearchOpen:Dispatch<SetStateAction<boolean>>;focusSearchResult:() => void;searchOpen:boolean;showSearch:() => void;searchRef:RefObject<HTMLInputElement | null>;search:string;setSearch:Dispatch<SetStateAction<string>>;closeSearch:() => void;data:LocalData|null;openModule:OpenModule}>){
return <header className="shell__header shell__header--unified">
      <button className="brand__home" type="button" onClick={()=>setView('home')} aria-current={view==='home'?'page':undefined} aria-label={siteSettings.siteName+' 首页'}>
        <img className="brand__aetheryte" src="/icons/aetheryte.svg" alt="" width="38" height="38"/>
        <h1 className="brand__title">{siteSettings.siteName}</h1>
      </button>
      <div className="home-global-search">
        <form role="search" aria-label="全站搜索" onSubmit={event=>{event.preventDefault();setSearchOpen(true);focusSearchResult();}}>
          <button className="home-global-search__label" type="button" aria-label="全站搜索" aria-expanded={searchOpen} aria-controls="global-search-results" onClick={showSearch}><UiIcon name="search"/></button>
          <label className="visually-hidden" htmlFor="global-search-input">全站搜索关键词</label>
          <input id="global-search-input" ref={searchRef} type="search" value={search} maxLength={100} autoComplete="off" placeholder="网站、鱼名、活动或功能" aria-controls="global-search-results" onFocus={showSearch} onClick={()=>setSearchOpen(true)} onChange={event=>{setSearch(event.target.value);setSearchOpen(true);}} onKeyDown={event=>{
            if(event.nativeEvent.isComposing){return;}
            if(event.key==='Escape'){event.preventDefault();closeSearch();}
            if(event.key==='ArrowDown'){event.preventDefault();setSearchOpen(true);focusSearchResult();}
          }}/>
          {search?<button type="button" className="home-global-search__clear" aria-label="清空搜索" onClick={()=>{setSearch('');showSearch();}}>×</button>:<kbd aria-hidden="true">/</kbd>}
        </form>
      </div>
      <div className="local-app__header-actions">
        <button className="site-discovery-trigger" type="button" disabled={!data} onClick={()=>openModule('notes')}>我的待办</button>
        {view==='home'&&data?<a className="local-app__nav-jump" href="#local-navigation">导航站 ↓</a>:null}
        {view!=='home'&&<button type="button" className="local-app__back" onClick={()=>setView('home')}>← <span>返回</span></button>}
        <button className="shell__settings" type="button" aria-label={view==='settings'?'返回首页':'设置'} aria-pressed={view==='settings'} onClick={()=>setView(view==='settings'?'home':'settings')}>
          <UiIcon name="gear"/>
          <span>设置</span>
        </button>
      </div>
    </header>;
}

function DirectorySection({hasFilters,filteredLinks,allLinks,favorites,setFavorites,setVisibleLimit,setSettingsTab,setView,clearFilters,category,setCategory,setSubcategory,groups,subgroups,subcategory,catalogError,reloadCatalog,catalogLoading,visibleLimit,saveFavorite}:Readonly<{hasFilters:boolean;filteredLinks:BrowserLink[];allLinks:BrowserLink[];favorites:boolean;setFavorites:Dispatch<SetStateAction<boolean>>;setVisibleLimit:Dispatch<SetStateAction<number>>;setSettingsTab:Dispatch<SetStateAction<SettingsTab>>;setView:Dispatch<SetStateAction<LocalView>>;clearFilters:() => void;category:string;setCategory:Dispatch<SetStateAction<string>>;setSubcategory:Dispatch<SetStateAction<string>>;groups:string[];subgroups:string[];subcategory:string;catalogError:boolean;reloadCatalog:() => void;catalogLoading:boolean;visibleLimit:number;saveFavorite:(link: ReturnType<typeof directoryLinks>[number]) => void}>){
return <section id="local-navigation" className="local-directory" aria-label="导航站">
            <header className="local-dashboard__section-heading local-directory__heading">
              <div className="local-directory__heading-title"><h2>导航站</h2><output aria-live="polite" aria-atomic="true">{hasFilters?`${filteredLinks.length} / ${allLinks.length}`:allLinks.length} 个网站</output></div>
              <div className="local-directory__heading-actions">
                <button type="button" className="local-dashboard__manage local-directory__favorites" aria-pressed={favorites} onClick={()=>{setFavorites(value=>!value);setVisibleLimit(36);}}><UiIcon name={favorites?'starFill':'star'}/>{favorites?'已收藏':'收藏'}</button>
                <button type="button" className="local-dashboard__manage" onClick={()=>{setSettingsTab('links');setView('settings');}}>管理 ↗</button>
              </div>
            </header>
            {hasFilters?<div className="local-directory__toolbar"><button type="button" className="local-directory__reset" onClick={clearFilters}>清除筛选</button></div>:null}
            <div className="local-directory__category-row">
              <nav className="local-directory__filters" aria-label="网站分类">
                <button type="button" aria-pressed={category==='all'} onClick={()=>{setCategory('all');setSubcategory('all');setVisibleLimit(36);}}>全部</button>
                {groups.map(group=><button type="button" key={group} aria-pressed={category===group} onClick={()=>{setCategory(group);setSubcategory('all');setVisibleLimit(36);}}>{group}</button>)}
              </nav>
            </div>
            {subgroups.length>0&&<nav className="local-directory__subcategories" aria-label="网站子分类"><button type="button" aria-pressed={subcategory==='all'} onClick={()=>{setSubcategory('all');setVisibleLimit(36);}}>全部{category}</button>{subgroups.map(sub=><button type="button" key={sub} aria-pressed={subcategory===sub} onClick={()=>{setSubcategory(sub);setVisibleLimit(36);}}>{sub}</button>)}</nav>}
            {catalogError&&<output className="local-directory__notice" style={{display:'block'}}>公共目录暂时无法更新，本机网站和已加载内容仍可使用。 <button type="button" onClick={reloadCatalog}>重试</button></output>}
            {catalogLoading?<output className="local-directory__loading" style={{display:'block'}}>正在更新网站目录…</output>:null}
            {filteredLinks.length===0?(!catalogLoading&&<div id="directory-results" className="local-directory__empty"><h3>{directoryEmptyHeading({hasFilters,catalogError})}</h3><p>{hasFilters?'试试取消收藏筛选，或选择其他分类。':'可以在设置中添加自己的常用网站。'}</p>{hasFilters?<button type="button" onClick={clearFilters}>查看全部网站</button>:<button type="button" onClick={()=>{setSettingsTab('links');setView('settings');}}>添加个人网站</button>}</div>):
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
          </section>;
}
import type {Dispatch,SetStateAction,RefObject} from 'react';

function LocalMainContent({view,setView,data,error,settingsTab,dataSection,store,openAdmin,adminSession,setSettingsTab,enabledSections,siteSettings,openModule,setError,fishingData,subscribeProgress,hasFilters,filteredLinks,allLinks,favorites,setFavorites,setVisibleLimit,clearFilters,category,setCategory,setSubcategory,groups,subgroups,subcategory,catalogError,reloadCatalog,catalogLoading,visibleLimit,saveFavorite}:Readonly<{view:LocalView;setView:Dispatch<SetStateAction<LocalView>>;data:LocalData | null;error:string | null;settingsTab:SettingsTab;dataSection:DataSection;store:ReturnType<typeof createLocalStore>;openAdmin:() => void;adminSession:ReturnType<typeof useCalendarAdminSession>;setSettingsTab:Dispatch<SetStateAction<SettingsTab>>;enabledSections:LocalData['configuration']['order'];siteSettings:ReturnType<typeof useSiteSettings>;openModule:OpenModule;setError:Dispatch<SetStateAction<string | null>>;fishingData:ReturnType<typeof localFishingData>;subscribeProgress:(listener: () => void) => () => void;hasFilters:boolean;filteredLinks:ReturnType<typeof directoryLinks>;allLinks:ReturnType<typeof directoryLinks>;favorites:boolean;setFavorites:Dispatch<SetStateAction<boolean>>;setVisibleLimit:Dispatch<SetStateAction<number>>;clearFilters:() => void;category:string;setCategory:Dispatch<SetStateAction<string>>;setSubcategory:Dispatch<SetStateAction<string>>;groups:string[];subgroups:string[];subcategory:string;catalogError:boolean;reloadCatalog:() => void;catalogLoading:boolean;visibleLimit:number;saveFavorite:(link: ReturnType<typeof directoryLinks>[number]) => void}>){
if(view==='admin'){return <Suspense fallback={<output style={{display:'block'}}>正在打开站点后台…</output>}><SiteAdminPage onClose={()=>setView('settings')}/></Suspense>;}
if(!data){if(error){return <p role="alert">本机数据读取失败。<button type="button" onClick={()=>window.location.reload()}>重试</button></p>;}
return <output style={{display:'block'}}>正在读取…</output>;}
if(view==='settings'){return <LocalSettings key={settingsTab+dataSection} initialTab={settingsTab} initialDataSection={dataSection} store={store} data={data} onSaved={()=>{}} onAdmin={openAdmin} adminAuthenticated={adminSession.authenticated}/>;}
return <div className="local-dashboard">
          <section className="local-dashboard__modules" aria-label="功能模块">
            <header className="local-dashboard__section-heading">
              <h2>常用功能</h2>
              <button type="button" className="local-dashboard__manage" onClick={()=>{setSettingsTab('home');setView('settings');}}>自定义 <span aria-hidden="true">↗</span></button>
            </header>
            <ModuleGrid identity={enabledSections.join(',')} mode={siteSettings.presentation?.home.layout??'auto'}>
              {enabledSections.length===0?<p className="local-dashboard__empty">
                <button type="button" onClick={()=>{setSettingsTab('home');setView('settings');}}>启用功能模块 ＋</button>
              </p>:enabledSections.map(section=><div className="local-dashboard__module" key={section} data-module={section}>
                {<HomeModuleContent {...{section,openModule,store,setError,fishingData,subscribeProgress,data}}/>}
              </div>)}
            </ModuleGrid>
          </section>
          <div className="field-divider" aria-hidden="true"/>
          {<DirectorySection {...{hasFilters,filteredLinks,allLinks,favorites,setFavorites,setVisibleLimit,setSettingsTab,setView,clearFilters,category,setCategory,setSubcategory,groups,subgroups,subcategory,catalogError,reloadCatalog,catalogLoading,visibleLimit,saveFavorite}}/>}
        </div>;
}

function ExpandedModuleContent({expanded,data,store,setExpanded,fishingData,subscribeProgress,setSettingsTab,setView,setDataSection}:Readonly<{expanded:{ kind: LocalModuleKind; origin: ModuleOrigin; fishFilters?: FishDetailSelection; eventId?: string; marketQuery?: string; };data:LocalData;store:ReturnType<typeof createLocalStore>;setExpanded:Dispatch<SetStateAction<{ kind: LocalModuleKind; origin: ModuleOrigin; fishFilters?: FishDetailSelection; eventId?: string; } | null>>;fishingData:ReturnType<typeof localFishingData>;subscribeProgress:(listener: () => void) => () => void;setSettingsTab:Dispatch<SetStateAction<SettingsTab>>;setView:Dispatch<SetStateAction<LocalView>>;setDataSection:Dispatch<SetStateAction<DataSection>>}>){
if(expanded.kind==='plan'){return <TodoBoard data={data} store={store} expanded/>;}
if(expanded.kind==='events'){return <PublicCalendarPage overlay {...(expanded.eventId?{initialEventId:expanded.eventId}:{})} onBack={()=>setExpanded(null)}/>;}
if(expanded.kind==='fishing'){return <FishingBoard data={fishingData} subscribeProgress={subscribeProgress} initialRegion={data.configuration.region} onNotificationSettings={()=>{setExpanded(null);setSettingsTab('notifications');setView('settings');}}
          initialFilters={expanded.fishFilters} expanded onImport={()=>{
            setExpanded(null);setDataSection('fish');setSettingsTab('data');setView('settings');
          }}/>;}
if(expanded.kind==='pvp'){return <PvpBoard expanded/>;}
if(expanded.kind==='market'){return <Suspense fallback={<p role="status">正在打开市场…</p>}><MarketBoard initialQuery={expanded.marketQuery??''}/></Suspense>;}
return <TodoBoard data={data} store={store} expanded/>;
}

function directoryEmptyHeading({hasFilters,catalogError}:Readonly<{hasFilters:boolean;catalogError:boolean}>){
if(hasFilters){return '没有找到匹配的网站';}
if(catalogError){return '暂时无法读取公共目录';}
return '还没有网站';
}

function HomeModuleContent({section,openModule,store,setError,fishingData,subscribeProgress,data}:Readonly<{section:HomeSection;openModule:OpenModule;store:ReturnType<typeof createLocalStore>;setError:Dispatch<SetStateAction<string | null>>;fishingData:ReturnType<typeof localFishingData>;subscribeProgress:(listener: () => void) => () => void;data:LocalData}>){
if(section==='events'){return <HomeOfficialEvents onOpenCalendar={()=>openModule('events')}
                  onHide={()=>{void store.change(document=>{document.data.configuration.visible.events=false;}).catch(()=>setError('设置未能保存到本机'));}}/>;}
if(section==='fishing'){return <FishingBoard data={fishingData} subscribeProgress={subscribeProgress} initialRegion={data.configuration.region} embedded onOpenDetail={selection=>openModule('fishing',selection)}/>;}
if(section==='pvp'){return <PvpBoard onOpenDetail={()=>openModule('pvp')}/>;}
if(section==='market'){return <MarketHome onOpenDetail={query=>openModule('market',undefined,undefined,query)}/>;}
return <TodoBoard data={data} store={store} onExpand={()=>openModule('notes')}/>;
}

function moduleReturnFocus(){
if(document.activeElement instanceof HTMLElement){return document.activeElement;}
return null;
}
import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {withMarketModule,canonicalNavUrl,splitDirectoryCategory,resolveDirectoryCategory,DEFAULT_CATEGORIES} from '@ff14-hub/shared';
import {directoryLinks,type BrowserLink} from './directory-links';
import {useNavigationCatalog} from './use-navigation-catalog';
import {HomeOfficialEvents} from '../shell/HomeOfficialEvents';
import {PublicCalendarPage} from '../events/PublicCalendarPage';
import {FishingBoard,type FishDetailSelection} from '../fish/FishingBoard';
import {parseFishLink} from '../fish/fish-link';
import {PvpBoard} from '../pvp/PvpBoard';
import {MarketHome} from '../market/MarketHome';
import {LocalModuleOverlay,type ModuleOrigin} from './LocalModuleOverlay';
import {createLocalStore,type LocalData,type HomeSection} from './store';
import {localFishingData} from './fish-port';
import {LocalSettings,type SettingsTab} from './LocalSettings';
import type {DataSection} from './DataManagementPanel';
import {startLocalNotifications} from './local-notifications';
import {startFishcakeSync} from './fishcake-sync';
import {SiteIcon} from './SiteIcon';
import {UiIcon} from './UiIcon';
import {PwaStatusBar} from '../pwa/PwaStatusBar';
import {useSiteSettings,type SiteSettings} from '../admin/site-settings';
import {useCalendarAdminSession} from '../events/calendar-admin-session';
import './local.css';
import './local-tools.css';
import './unified-search.css';
import {GlobalSearch} from './GlobalSearch';
import {TodoBoard} from './TodoBoard';
import {ModuleGrid} from './ModuleGrid';
import type {FeatureTarget,FishSearchTarget} from './site-search';

const SiteAdminPage=lazy(()=>import('../admin/SiteAdminPage').then(module=>({default:module.SiteAdminPage})));
const MarketBoard=lazy(()=>import('../market/MarketBoard').then(module=>({default:module.MarketBoard})));

function siteDomain(url:string):string{
  try{return new URL(url).hostname.replace(/^www\./,'');}
  catch{return url;}
}

export function LocalApp(){
  const [store]=useState(()=>createLocalStore());
  const subscribeProgress=useCallback((listener:()=>void)=>store.subscribe(listener),[store]);
  const fishingData=useMemo(()=>localFishingData(store),[store]);
  const [data,setData]=useState<LocalData|null>(null);
  const {catalog,catalogError,catalogLoading,reloadCatalog}=useNavigationCatalog();
  const [error,setError]=useState<string|null>(null);
  const [fishEntry,setFishEntry]=useState(()=>parseFishLink(location.search));
  const handledFishEntry=useRef('');
  useEffect(()=>{const changed=()=>{handledFishEntry.current='';setFishEntry(parseFishLink(location.search));};window.addEventListener('popstate',changed);return()=>window.removeEventListener('popstate',changed);},[]);
  const notificationEntry=['notifications','reminders'].includes(new URLSearchParams(location.search).get('view')??'');
  const [view,setView]=useState<LocalView>(notificationEntry?'settings':'home');
  const [expanded,setExpanded]=useState<null|{
    kind:LocalModuleKind;
    origin:ModuleOrigin;
    fishFilters?:FishDetailSelection;
    eventId?:string;
    marketQuery?:string;
  }>(null);
  // 共用一个从模块位置展开的详情层；关闭后保留首页的筛选和滚动位置。
  const openModule=useCallback((kind:LocalModuleKind,fishFilters?:FishDetailSelection,eventId?:string,marketQuery?:string)=>{
    const active=moduleReturnFocus();
    const source=active?.closest('#global-search-results')?active:document.querySelector<HTMLElement>(`[data-module="${kind}"]`);
    const {top,left,width,height}=source?.getBoundingClientRect()??{top:80,left:window.innerWidth/2,width:0,height:0};
    setExpanded({
      kind,origin:{rect:{top,left,width,height},...(source?{element:source}:{}),returnFocus:active?.closest('dialog')?document.querySelector<HTMLElement>('button[aria-label="全站搜索"]'):active},
      ...(fishFilters?{fishFilters}:{}),
      ...(eventId?{eventId}:{}),
      ...(marketQuery?{marketQuery}:{}),
    });
  },[]);
  const dataReady=data!==null;
  useEffect(()=>{
    if(!dataReady||!fishEntry){return;}
    const key=JSON.stringify(fishEntry);if(handledFishEntry.current===key){return;}handledFishEntry.current=key;
    setView('home');openModule('fishing',{...fishEntry,view:'all',kind:'all',text:'',hideCaught:false,windowHours:24});
  },[dataReady,fishEntry,openModule]);
  const [settingsTab,setSettingsTab]=useState<SettingsTab>(notificationEntry?'notifications':'home');
  const [dataSection,setDataSection]=useState<DataSection>('sync');
  const [search,setSearch]=useState('');
  const [searchOpen,setSearchOpen]=useState(false);
  const searchRef=useRef<HTMLInputElement>(null);
  const openFish=(target:FishSearchTarget)=>{setView('home');openModule('fishing',{...target,view:'all',kind:'all',text:'',hideCaught:false,windowHours:24});};
  const openEvent=(id:string)=>{setView('home');openModule('events',undefined,id);};
  const openFeature=(target:FeatureTarget)=>{
    if(target==='notes'||target==='plan'){openModule('notes');return;}
    if(target==='sync'||target==='backup'||target==='notifications'){
      setSearchOpen(false);setExpanded(null);setSettingsTab(target==='notifications'?'notifications':'data');if(target==='sync'||target==='backup'){setDataSection(target);}setView('settings');
    }else {openModule(target);}
  };
  useEffect(()=>startLocalNotifications(store),[store]);
  useEffect(()=>startFishcakeSync(store),[store]);
  const [category,setCategory]=useState('all');
  const [subcategory,setSubcategory]=useState('all');
  const siteSettings=useSiteSettings();
  const adminSession=useCalendarAdminSession();
  const openAdmin=()=>setView('admin');
  useEffect(()=>{document.title=siteSettings.siteName;},[siteSettings.siteName]);
  const [favorites,setFavorites]=useState(false);
  const [visibleLimit,setVisibleLimit]=useState(36);
  const showSearch=useCallback(()=>{
    setSearchOpen(true);
    requestAnimationFrame(()=>{const input=searchRef.current;if(!input?.isConnected||document.querySelector('dialog[open]')||document.activeElement?.closest('#global-search-results')){return;}input.focus({preventScroll:true});window.scrollTo({top:0,behavior:'auto'});});
  },[]);
  const closeSearch=()=>{searchRef.current?.focus({preventScroll:true});setSearchOpen(false);};
  const focusSearchResult=()=>{const first=document.querySelector<HTMLElement>('#global-search-results [data-search-result]');if(first){first.focus();}else {requestAnimationFrame(()=>document.querySelector<HTMLElement>('#global-search-results [data-search-result]')?.focus());}};
  useEffect(()=>{
    let alive=true;let revision=-1;
    const refresh=()=>{void store.read().then(next=>{if(alive&&next.revision>=revision){revision=next.revision;setData(next);setError(null);}}).catch((cause:unknown)=>{if(alive){setError(cause instanceof Error?cause.message:'读取本机数据失败');}});};
    refresh();const unsubscribe=store.subscribe(refresh);
    return()=>{alive=false;unsubscribe();};
  },[store]);

  useEffect(()=>{
    const shortcut=(event:KeyboardEvent)=>{
      if(event.isComposing||event.defaultPrevented||document.querySelector('dialog[open]')){return;}
      const editing=event.target instanceof HTMLElement&&(event.target.isContentEditable||Boolean(event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')));
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='k'||event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!editing){event.preventDefault();showSearch();}
    };
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  },[showSearch]);
  // 合并系统与本地目录：本地收藏和人工简介优先，搜索覆盖系统别名与标签。
  const allLinks=useMemo(()=>directoryLinks(catalog,data?.links??[]).map(link=>({...link,category:resolveDirectoryCategory(link.category,siteSettings.presentation?.categoryAliases)})),[catalog,data,siteSettings.presentation?.categoryAliases]);
  const links=useMemo(()=>allLinks.filter(link=>!favorites||link.favorite),[allLinks,favorites]);
  const taxonomy=siteSettings.presentation?.categories??DEFAULT_CATEGORIES;
  const groups=useMemo(()=>{const names=new Set(allLinks.map(link=>splitDirectoryCategory(link.category).main));return [...taxonomy.map(group=>group.name).filter(name=>names.delete(name)),...names];},[allLinks,taxonomy]);
  const subgroups=useMemo(()=>category==='all'?[]:[...new Set(allLinks.filter(link=>splitDirectoryCategory(link.category).main===category).map(link=>splitDirectoryCategory(link.category).sub).filter(Boolean))].sort((a,b)=>{const order=taxonomy.find(g=>g.name===category)?.children??[];return (order.includes(a)?order.indexOf(a):100)-(order.includes(b)?order.indexOf(b):100);}),[category,allLinks,taxonomy]);
  const filteredLinks=useMemo(()=>links.filter(link=>{const group=splitDirectoryCategory(link.category);return (category==='all'||group.main===category)&&(subcategory==='all'||group.sub===subcategory);}),[links,category,subcategory]);
  const hasFilters=Boolean(favorites||category!=='all');
  const clearFilters=()=>{setCategory('all');setSubcategory('all');setFavorites(false);setVisibleLimit(36);};
  const sectionOrder=withMarketModule(data&&(data.configuration.orderCustomized||data.configuration.order.join(',')!=='events,fishing,pvp,notes')?data.configuration.order:siteSettings.presentation?.home.order??data?.configuration.order??[]);
  const enabledSections=sectionOrder.filter(section=>(data?.configuration.visible[section]??true)&&(siteSettings.presentation?.home.enabled[section]??true)&&(section!=='events'||siteSettings.homeCalendarEnabled));
  const saveFavorite=(link:typeof links[number])=>{
    void store.change(document=>{
      const old=document.data.links.find(item=>canonicalNavUrl(item.url)===canonicalNavUrl(link.url));
      if(old){old.favorite=!old.favorite;}
      else {document.data.links.push({id:crypto.randomUUID(),title:link.title,url:link.url,category:link.category,categoryCustomized:link.personal,description:link.description??'',...(link.faviconUrl?{faviconUrl:link.faviconUrl}:{}),favorite:true});}
    }).catch((cause:unknown)=>setError(cause instanceof Error?cause.message:'本机保存失败'));
  };

  return <div className="shell local-app">
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    {<LocalHeader {...{setView,view,siteSettings,setSearchOpen,focusSearchResult,searchOpen,showSearch,searchRef,search,setSearch,closeSearch,data,openModule}}/>}
    <PwaStatusBar localMode/>
    <main id="main-content" className="shell__main local-app__main" tabIndex={-1}>
      {data&&searchOpen?<GlobalSearch query={search} links={allLinks} linksLoading={catalogLoading} linksError={catalogError} onRetryLinks={reloadCatalog} initialRegion={data.configuration.region} onFish={openFish} onEvent={openEvent} onFeature={openFeature} onClose={closeSearch}/>:null}
      {siteSettings.announcementEnabled&&siteSettings.announcement.trim()?<aside className="site-public-announcement" aria-label="站点公告">{siteSettings.announcement}</aside>:null}
      {error?<p role="alert" className="notice notice--error">{error}</p>:null}
      {<LocalMainContent {...{view,setView,data,error,settingsTab,dataSection,store,openAdmin,adminSession,setSettingsTab,enabledSections,siteSettings,openModule,setError,fishingData,subscribeProgress,hasFilters,filteredLinks,allLinks,favorites,setFavorites,setVisibleLimit,clearFilters,category,setCategory,setSubcategory,groups,subgroups,subcategory,catalogError,reloadCatalog,catalogLoading,visibleLimit,saveFavorite}}/>}
    </main>
    {expanded&&data&&view!=='admin'?<LocalModuleOverlay
      key={expanded.kind+':'+String(expanded.fishFilters?.fishId??'')+':'+String(expanded.fishFilters?.windowStartsAt??'')+':'+String(expanded.eventId??'')}
      title={{events:'国服活动',fishing:'钓鱼',pvp:'PVP 战场',notes:'我的待办',plan:'我的待办',market:'市场行情'}[expanded.kind]}
      origin={expanded.origin}
      onClose={()=>setExpanded(null)}>
      {<ExpandedModuleContent {...{expanded,data,store,setExpanded,fishingData,subscribeProgress,setSettingsTab,setView,setDataSection}}/>}
    </LocalModuleOverlay>:null}
  </div>;
}
