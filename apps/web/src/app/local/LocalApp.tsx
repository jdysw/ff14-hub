import {useEffect,useMemo,useRef,useState} from 'react';
import {API_ROUTES,type NavCatalogEntry} from '@ff14-hub/shared';
import {HomeOfficialEvents} from '../shell/HomeOfficialEvents';
import {PublicCalendarPage} from '../events/PublicCalendarPage';
import {FishingBoard} from '../fish/FishingBoard';
import {createLocalStore,type LocalData} from './store';
import {localFishPort} from './fish-port';
import {LocalSettings} from './LocalSettings';
import {navCatalogResponseSchema} from '../nav/nav-api';
import {PwaStatusBar} from '../pwa/PwaStatusBar';
import './local.css';

export function LocalApp(){
  const [store]=useState(()=>createLocalStore());
  const dataPort=useMemo(()=>localFishPort(store),[store]);
  const [data,setData]=useState<LocalData|null>(null);
  const [catalog,setCatalog]=useState<NavCatalogEntry[]>([]);
  const [catalogError,setCatalogError]=useState(false);
  const [catalogReload,setCatalogReload]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [view,setView]=useState<'home'|'settings'|'calendar'>('home');
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
    const shortcut=(event:KeyboardEvent)=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!(event.target instanceof HTMLElement&&(event.target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))){event.preventDefault();searchRef.current?.focus();}};
    window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
  },[]);
  const query=search.trim().toLocaleLowerCase();
  const links=useMemo(()=>{
    const personal=(data?.links??[]).map(link=>({...link,personal:true}));
    const existing=new Set(personal.map(link=>link.url));
    return [...personal,...catalog.filter(link=>!existing.has(link.url)).map(link=>({id:link.id,title:link.title,url:link.url,category:link.category,favorite:false,personal:false}))]
      .filter(link=>(!favorites||link.favorite)&&(!query||[link.title,link.url,link.category].join(' ').toLocaleLowerCase().includes(query)));
  },[data,catalog,query,favorites]);
  const groups=[...new Set(links.map(link=>link.category||'常用网站'))];
  const saveFavorite=(link:typeof links[number])=>{
    void store.change(document=>{
      const old=document.data.links.find(item=>item.url===link.url);
      if(old)old.favorite=!old.favorite;
      else document.data.links.push({id:crypto.randomUUID(),title:link.title,url:link.url,category:link.category,favorite:true});
    }).catch((cause:unknown)=>setError(cause instanceof Error?cause.message:'本机保存失败'));
  };
  return <div className="shell local-app">
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    <header className="shell__header"><button className="brand__home" type="button" onClick={()=>setView('home')} aria-label="FF14 Hub 首页"><span className="brand__mark" aria-hidden="true">XIV</span><h1 className="brand__title">FF14 Hub</h1></button>
      <button className="shell__settings" type="button" onClick={()=>setView(view==='home'?'settings':'home')}>{view==='home'?'设置':'返回首页'}</button></header>
    <PwaStatusBar localMode/>
    <main id="main-content" className="shell__main">
      {error?<p role="alert" className="notice notice--error">{error}</p>:null}
      {!data?error?<p>本机数据尚未读取，请检查浏览器站点存储权限后<button type="button" onClick={()=>window.location.reload()}>重新读取</button>。</p>:<p role="status">正在读取本机数据…</p>:view==='settings'?<LocalSettings store={store} data={data} onSaved={()=>{}}/>:view==='calendar'?<PublicCalendarPage onBack={()=>setView('home')}/>:<>
        <form className="home-search" role="search" onSubmit={event=>{event.preventDefault();document.getElementById('local-navigation')?.scrollIntoView({block:'start'});}}>
          <label className="visually-hidden" htmlFor="local-search">搜索导航中的网站、攻略或工具</label><input id="local-search" ref={searchRef} type="search" value={search} placeholder="搜索网站、攻略或工具" onChange={event=>setSearch(event.target.value)}/><button className="home-search__submit" type="submit">搜索</button>
        </form><p className="home-search__hint">按 / 快速搜索</p>
        {data.configuration.order.map(section=>!data.configuration.visible[section]?null:section==='events'?<HomeOfficialEvents key={section} onOpenCalendar={()=>setView('calendar')} onHide={()=>{void store.change(document=>{document.data.configuration.visible.events=false;}).catch(()=>setError('设置未能保存到本机'));}}/>:
          section==='fishing'?<FishingBoard key={section} data={dataPort} initialRegion={data.configuration.region} compact onImport={()=>setView('settings')}/>:<section key={section} className="local-notes" aria-label="我的备忘"><h2>我的备忘</h2>{data.notes.length?data.notes.map(note=><article key={note.id}><h3>{note.title}</h3><p>{note.text}</p></article>):<p>在设置中添加自己的备忘模块。</p>}</section>)}
        <section id="local-navigation" className="local-directory" aria-label="导航站"><header><h2>导航站</h2><button type="button" aria-pressed={favorites} onClick={()=>setFavorites(value=>!value)}>{favorites?'查看全部':'只看收藏'}</button></header>
          {catalogError?<p>推荐目录暂时无法读取，个人网站仍可使用。<button type="button" onClick={()=>setCatalogReload(value=>value+1)}>重试目录</button></p>:null}
          {links.length===0?<p>没有匹配的网站。可以在设置中添加个人导航。</p>:groups.map(group=><section className="local-directory__group" key={group}><h3>{group}</h3><ul>{links.filter(link=>(link.category||'常用网站')===group).map(link=><li key={link.id}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a><button type="button" aria-label={`${link.favorite?'取消收藏':'收藏'} ${link.title}`} aria-pressed={link.favorite} onClick={()=>saveFavorite(link)}>{link.favorite?'已收藏':'收藏'}</button></li>)}</ul></section>)}
        </section>
      </>}
    </main><footer className="shell__footer"><p>FF14 Hub · 非官方玩家工具</p><p>个人数据保存在本机 · 可从设置导出</p></footer>
  </div>;
}
