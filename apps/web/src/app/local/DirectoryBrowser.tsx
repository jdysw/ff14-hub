import { useMemo, useState } from 'react';
import { canonicalNavUrl, matchesDirectorySearch, type NavCatalogEntry, type NavRegion } from '@ff14-hub/shared';
import type { LocalData } from './store';

export interface BrowserLink {
  id:string;title:string;url:string;category:string;description:string;tags:string[];aliases:string[];faviconUrl?:string|undefined;
  region:NavRegion;favorite:boolean;personal:boolean;
}

/** A favorite is a local copy; enrich it with public search metadata without mutating it. */
export function directoryLinks(catalog:readonly NavCatalogEntry[],personal:LocalData['links']):BrowserLink[]{
  const metadata=new Map(catalog.map(entry=>[canonicalNavUrl(entry.url),entry]));
  const result=new Map<string,BrowserLink>();
  for(const entry of personal){
    const key=canonicalNavUrl(entry.url);const base=metadata.get(key);
    result.set(key,{...entry,category:entry.category||'个人网站',description:entry.description?.trim()||base?.description||'',
      tags:base?.tags??[],aliases:base?.aliases??[],region:base?.region??'both',personal:true});
  }
  for(const entry of catalog){const key=canonicalNavUrl(entry.url);if(!result.has(key))result.set(key,{...entry,favorite:false,personal:false});}
  return [...result.values()];
}

const labels={cn:'国服',global:'国际服',both:'通用'};
export function DirectoryBrowser(props:{
  readonly catalog:readonly NavCatalogEntry[];readonly personal:LocalData['links'];readonly search:string;
  readonly onSearch:(query:string)=>void;readonly onFavorite:(link:BrowserLink)=>void;
  readonly failed:boolean;readonly onReload:()=>void;
}){
  const [category,setCategory]=useState('');
  const [region,setRegion]=useState('');
  const [favorites,setFavorites]=useState(false);
  const all=useMemo(()=>directoryLinks(props.catalog,props.personal),[props.catalog,props.personal]);
  const searched=all.filter(link=>(!favorites||link.favorite)&&(!region||link.region==='both'||link.region===region)&&matchesDirectorySearch(link,props.search));
  const categories=[...new Set(all.map(link=>link.category))];
  const visible=searched.filter(link=>!category||link.category===category);
  const groups=categories.filter(group=>visible.some(link=>link.category===group));
  return <section id="local-navigation" className="local-directory" aria-label="导航站">
    <header><div><h2>导航站</h2><p>按用途查找网站，支持名称、别名和标签搜索。收藏保存在本机。</p></div><button type="button" aria-pressed={favorites} onClick={()=>setFavorites(value=>!value)}>{favorites?'查看全部':'只看收藏'}</button></header>
    <div className="directory-controls"><label>适用区服<select value={region} onChange={event=>setRegion(event.target.value)}><option value="">全部区服</option><option value="cn">国服（含通用）</option><option value="global">国际服（含通用）</option></select></label><button type="button" onClick={props.onReload}>刷新目录</button>{props.search||category||region||favorites?<button type="button" onClick={()=>{setCategory('');setRegion('');setFavorites(false);props.onSearch('');}}>清空筛选</button>:null}<output aria-live="polite">{visible.length} / {all.length} 个网站</output></div>
    <nav className="directory-categories" aria-label="网站分类"><button type="button" aria-pressed={!category} onClick={()=>setCategory('')}>全部 {searched.length}</button>{categories.map(group=><button type="button" key={group} aria-pressed={category===group} onClick={()=>setCategory(group)}>{group} {searched.filter(link=>link.category===group).length}</button>)}</nav>
    {props.failed?<p role="status">公共目录暂时无法更新，已加载的网站与本机收藏仍可使用。<button type="button" onClick={props.onReload}>重试目录</button></p>:null}
    {visible.length===0?<p>没有匹配的网站。请调整搜索或清空筛选；也可以在设置中添加个人网站。</p>:groups.map(group=><section className="local-directory__group" key={group}><h3>{group}<small>{visible.filter(link=>link.category===group).length} 个网站</small></h3><ul>{visible.filter(link=>link.category===group).map(link=><li key={link.id}><div className="directory-link"><a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a><span className="directory-link__region">{labels[link.region]}</span><small>{new URL(link.url).hostname}</small>{link.description?<p>{link.description}</p>:null}</div><button type="button" aria-label={`${link.favorite?'取消收藏':'收藏'} ${link.title}`} aria-pressed={link.favorite} onClick={()=>props.onFavorite(link)}>{link.favorite?'已收藏':'收藏'}</button></li>)}</ul></section>)}
    <p className="directory-footnote">公开来源已记录；收录与内容核对不代表网站实时在线。国服与国际服功能请以目标网站说明为准。</p>
  </section>;
}
