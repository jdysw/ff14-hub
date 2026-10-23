import {useEffect,useMemo,useRef,useState} from 'react';
import type {EventCalendarItem,FishRegion} from '@ff14-hub/shared';
import {loadFishingCatalog,type CatalogFish} from '../fish/catalog';
import {loadPublicCalendar} from './public-resources';
import {searchSite,type FeatureTarget,type FishSearchTarget} from './site-search';
import type {BrowserLink} from './directory-links';
export function GlobalSearch({links,initialRegion,onFish,onEvent,onFeature}:{links:readonly BrowserLink[];initialRegion:FishRegion;onFish:(target:FishSearchTarget)=>void;onEvent:(id:string)=>void;onFeature:(target:FeatureTarget)=>void}){
  const [query,setQuery]=useState(''),[region,setRegion]=useState(initialRegion),[fish,setFish]=useState<CatalogFish[]>([]),[events,setEvents]=useState<EventCalendarItem[]>([]);
  const [fishError,setFishError]=useState(''),[eventError,setEventError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[limit,setLimit]=useState(6);
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{input.current?.focus();},[]);
  useEffect(()=>{let alive=true;void loadFishingCatalog(region).then(value=>{if(alive)setFish(value.fish);}).catch(()=>{if(alive)setFishError('鱼类目录暂不可用');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[region,retry]);
  useEffect(()=>{let alive=true;void loadPublicCalendar().then(value=>{if(alive)setEvents(value.events);}).catch(()=>{if(alive)setEventError('活动数据暂不可用');});return()=>{alive=false;};},[retry]);
  const results=useMemo(()=>searchSite(query,links,fish,events),[query,links,fish,events]);
  const total=results.links.length+results.fish.length+results.events.length+results.features.length;
  return <section className="site-discovery" aria-label="全站搜索">
    <div className="site-discovery__search"><label>搜索网站、鱼类、活动和功能<input ref={input} type="search" aria-label="全站搜索关键词" value={query} maxLength={100} placeholder="例如：涅普特龙、PVP、备份" onChange={e=>{setQuery(e.target.value);setLimit(6);}}/></label><label>鱼类区服<select aria-label="全站搜索鱼类区服" value={region} onChange={e=>{setFish([]);setFishError('');setLoading(true);setRegion(e.target.value as FishRegion);}}><option value="cn">国服</option><option value="global">国际服</option></select></label></div>
    {loading?<p role="status">正在加载鱼类目录，网站与功能仍可搜索。</p>:null}
    {fishError||eventError?<p role="status">{[fishError,eventError].filter(Boolean).join('；')}。其他结果仍可使用。<button onClick={()=>{setFishError('');setEventError('');setLoading(true);setRetry(n=>n+1);}}>重试数据加载</button></p>:null}
    {query.trim()?<p role="status">找到 {total} 项结果</p>:<p>输入名称或用途，也可直接打开下面的功能。</p>}
    {results.features.length>0?<section aria-label="功能搜索结果"><h3>功能</h3><ul>{results.features.map(f=><li key={f.id}><button onClick={()=>onFeature(f.id)}>{f.title}<small>{f.description}</small></button></li>)}</ul></section>:null}
    {results.links.length>0?<section aria-label="网站搜索结果"><h3>网站 · {results.links.length}</h3><ul>{results.links.slice(0,limit).map(l=><li key={l.id}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.title}<small>{l.category} · {l.description||new URL(l.url).hostname}</small></a></li>)}</ul></section>:null}
    {results.fish.length>0?<section aria-label="鱼类搜索结果"><h3>鱼类 · {results.fish.length}</h3><ul>{results.fish.slice(0,limit).map(f=><li key={f.id}><button onClick={()=>onFish({fishId:f.id,region})}>{f.name}<small>{f.location||f.zone} · {f.bait.join(' → ')||'鱼饵资料待补'}</small></button></li>)}</ul></section>:null}
    {results.events.length>0?<section aria-label="活动搜索结果"><h3>活动 · {results.events.length}</h3><ul>{results.events.slice(0,limit).map(e=><li key={e.id}><button onClick={()=>onEvent(e.id)}>{e.title}<small>{e.category||'官方活动'}</small></button></li>)}</ul></section>:null}
    {Math.max(results.links.length,results.fish.length,results.events.length)>limit?<button onClick={()=>setLimit(n=>n+12)}>显示更多结果</button>:null}
    {query.trim()&&!loading&&!total?<p>没有找到匹配项，试试鱼名、鱼饵、网站别名或功能用途。</p>:null}
  </section>;
}
