import {useEffect,useMemo,useState} from 'react';
import type {EventCalendarItem,FishRegion} from '@ff14-hub/shared';
import {loadFishingCatalog,type CatalogFish} from '../fish/catalog';
import {loadPublicCalendar} from './public-resources';
import {searchSite,type FeatureTarget,type FishSearchTarget} from './site-search';
import type {BrowserLink} from './directory-links';
import {SiteIcon} from './SiteIcon';

type Scope='all'|'links'|'fish'|'events'|'features';
const featureHint:Record<FeatureTarget,string>={plan:'安排今天的待办、关注鱼窗与活动节点',events:'查看活动日程和开始、结束时间',pvp:'纷争前线与水晶冲突地图轮换',notes:'记录自己的游戏备忘',sync:'连接鱼糕与跨设备同步',backup:'导出、恢复本机个人数据',notifications:'管理提醒方式与通知权限'};
export function GlobalSearch({query,links,linksLoading=false,linksError=false,onRetryLinks,initialRegion,onFish,onEvent,onFeature,onClose}:Readonly<{query:string;links:readonly BrowserLink[];linksLoading?:boolean;linksError?:boolean;onRetryLinks?:()=>void;initialRegion:FishRegion;onFish:(target:FishSearchTarget)=>void;onEvent:(id:string)=>void;onFeature:(target:FeatureTarget)=>void;onClose:()=>void}>){
  const [region,setRegion]=useState(initialRegion),[fish,setFish]=useState<CatalogFish[]>([]),[events,setEvents]=useState<EventCalendarItem[]>([]);
  const [fishError,setFishError]=useState(''),[eventError,setEventError]=useState(''),[loading,setLoading]=useState(true),[eventLoading,setEventLoading]=useState(true),[retry,setRetry]=useState(0),[limit,setLimit]=useState(6),[scope,setScope]=useState<Scope>('all');
  const searching=Boolean(query.trim());
  useEffect(()=>{
    if(!searching)return;
    let alive=true;
    void loadFishingCatalog(region).then(value=>{if(alive)setFish(value.fish);}).catch(()=>{if(alive)setFishError('鱼类目录暂不可用');}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[region,retry,searching]);
  useEffect(()=>{
    if(!searching)return;
    let alive=true;
    void loadPublicCalendar().then(value=>{if(alive)setEvents(value.events);}).catch(()=>{if(alive)setEventError('活动数据暂不可用');}).finally(()=>{if(alive)setEventLoading(false);});
    return()=>{alive=false;};
  },[retry,searching]);
  const results=useMemo(()=>searchSite(query,links,fish,events),[query,links,fish,events]);
  const total=results.links.length+results.fish.length+results.events.length+results.features.length;
  const selected=scope==='all'||results[scope].length?scope:'all';
  const scopes:readonly [Scope,string,number][]=[['all','全部',total],['links','网站',results.links.length],['fish','鱼类',results.fish.length],['events','活动',results.events.length],['features','功能',results.features.length]];
  const visible=(type:Scope)=>selected==='all'||selected===type;
  return <section id="global-search-results" className="global-search-results" aria-label="全站搜索结果" onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();onClose();return;}
    if(!['ArrowDown','ArrowUp'].includes(event.key))return;
    const items=[...event.currentTarget.querySelectorAll<HTMLElement>('[data-search-result]')];
    const index=items.findIndex(item=>item===document.activeElement);if(index<0)return;
    event.preventDefault();items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }}>
    <header className="global-search-results__heading"><div><h2>{searching?'搜索结果':'想找些什么？'}</h2><p>{searching?'网站、鱼类、活动与功能，一处查找。':'输入名称、鱼饵、网站别名或用途，也可以从常用功能开始。'}</p></div><button type="button" className="global-search-results__close" onClick={onClose}>收起 <kbd>Esc</kbd></button></header>
    {searching?<div className="global-search-results__toolbar"><div className="global-search-results__scopes" role="group" aria-label="搜索结果类型">{scopes.filter(([value,,count])=>value==='all'||count>0).map(([value,label,count])=><button type="button" key={value} aria-pressed={selected===value} onClick={()=>{setScope(value);setLimit(6);}}>{label}<span>{count}</span></button>)}</div><label className="global-search-results__region">鱼类区服<select aria-label="全站搜索鱼类区服" value={region} onChange={e=>{setFish([]);setFishError('');setLoading(true);setRegion(e.target.value as FishRegion);setLimit(6);}}><option value="cn">国服</option><option value="global">国际服</option></select></label></div>:null}
    {searching?<output className="global-search-results__status" style={{display:'block'}}>找到 {total} 项结果{loading||eventLoading||linksLoading?' · 其他资料加载中':''}</output>:null}
    {searching&&(fishError||eventError||linksError)?<output className="global-search-results__notice" style={{display:'block'}}>{[linksError?'公共网站目录暂不可用':'',fishError,eventError].filter(Boolean).join('；')}。已加载的结果仍可使用。<button type="button" onClick={()=>{setFishError('');setEventError('');setLoading(true);setEventLoading(true);setRetry(n=>n+1);if(linksError)onRetryLinks?.();}}>重试数据加载</button></output>:null}
    {!searching?<div className="global-search-results__shortcuts">{results.features.filter(f=>['notes','events','pvp','backup'].includes(f.id)).map(f=><button type="button" key={f.id} data-search-result onClick={()=>onFeature(f.id)}>{f.title}<small>{featureHint[f.id]}</small></button>)}</div>:<div className="global-search-results__grid">
      {visible('links')&&results.links.length>0?<section aria-label="网站搜索结果"><h3>网站 <span>{results.links.length}</span></h3><ul>{results.links.slice(0,limit).map(l=><li key={l.id}><a data-search-result href={l.url} target="_blank" rel="noopener noreferrer"><SiteIcon url={l.url} title={l.title} faviconUrl={l.faviconUrl}/><span><strong>{l.title}</strong><small>{l.category} · {l.description||new URL(l.url).hostname}</small></span><span className="global-search-results__external" aria-hidden="true">↗</span></a></li>)}</ul></section>:null}
      {visible('fish')&&results.fish.length>0?<section aria-label="鱼类搜索结果"><h3>鱼类 <span>{results.fish.length}</span></h3><ul>{results.fish.slice(0,limit).map(f=><li key={f.id}><button type="button" data-search-result onClick={()=>onFish({fishId:f.id,region})}><strong>{f.name}</strong><small>{f.location||f.zone} · {f.bait.join(' → ')||'鱼饵资料待补'}</small></button></li>)}</ul></section>:null}
      {visible('events')&&results.events.length>0?<section aria-label="活动搜索结果"><h3>活动 <span>{results.events.length}</span></h3><ul>{results.events.slice(0,limit).map(e=><li key={e.id}><button type="button" data-search-result onClick={()=>onEvent(e.id)}><strong>{e.title}</strong><small>{e.category||'官方活动'}</small></button></li>)}</ul></section>:null}
      {visible('features')&&results.features.length>0?<section aria-label="功能搜索结果"><h3>功能 <span>{results.features.length}</span></h3><ul>{results.features.map(f=><li key={f.id}><button type="button" data-search-result onClick={()=>onFeature(f.id)}><strong>{f.title}</strong><small>{featureHint[f.id]}</small></button></li>)}</ul></section>:null}
    </div>}
    {searching&&Math.max(...(['links','fish','events'] as const).filter(type=>visible(type)).map(type=>results[type].length),0)>limit?<button type="button" className="global-search-results__more" onClick={()=>setLimit(n=>n+12)}>显示更多结果</button>:null}
    {searching&&!loading&&!eventLoading&&!linksLoading&&!total?<div className="global-search-results__empty"><h3>还没有找到匹配项</h3><p>试试更短的名称、鱼饵、网站别名，或“备份”“PVP”等功能用途。</p></div>:null}
  </section>;
}
