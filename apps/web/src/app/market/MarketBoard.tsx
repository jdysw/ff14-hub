import {useEffect,useState} from 'react';
import {UiIcon} from '../local/UiIcon';
import {loadMarketCenters,searchMarketItems,loadMarketData,marketSummary,keyedMarketRows,type MarketCenter,type MarketItem,type MarketData,type Quality} from './universalis';
import './market.css';

function preferences():{scope:string;quality:Quality}{
  try{
    const value:unknown=JSON.parse(localStorage.getItem('ff14-hub:market-preferences:v1')??'null');
    if(value&&typeof value==='object'){
      const record=value as Record<string,unknown>;
      return {scope:typeof record['scope']==='string'&&record['scope'].length<=60?record['scope']:'陆行鸟',
        quality:record['quality']==='hq'||record['quality']==='nq'?record['quality']:'all'};
    }
  }catch{/* Optional preferences; storage may be disabled. */}
  return {scope:'陆行鸟',quality:'all'};
}
function failure(error:unknown):string{
  if(error instanceof Error){
    if(error.name==='TimeoutError'){return '查询超时，请稍后重试。';}
    if(error.name==='TypeError'){return '无法连接行情服务，请检查网络后重试。';}
    return error.message;
  }
  return '查询失败，请重试。';
}
const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});
const regionNames:Record<string,string>={'中国':'国服',Japan:'日本',Europe:'欧洲','North-America':'北美',Oceania:'大洋洲','한국':'韩服','繁中服':'繁中服'};
function time(timestamp:number){
  if(!timestamp||!Number.isFinite(new Date(timestamp).getTime())){return '时间未知';}
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(timestamp);
}
function remember(scope:string,quality:Quality){
  try{localStorage.setItem('ff14-hub:market-preferences:v1',JSON.stringify({scope,quality}));}catch{/* Optional preference only. */}
}
type PriceView='listings'|'sales';
function PriceTable({data,view,scopeLabel}:Readonly<{data:MarketData;view:PriceView;scopeLabel:string}>){
  const [limit,setLimit]=useState(10);
  const rows=view==='listings'?[...data.listings].sort((a,b)=>a.pricePerUnit-b.pricePerUnit):[...data.recentHistory].sort((a,b)=>b.timestamp-a.timestamp);
  if(!rows.length){return <div className="market-empty"><UiIcon name="search"/><h4>{view==='listings'?'暂无在售记录':'暂无近期成交'}</h4><p>试试选择“全大区”或其他品质。</p></div>;}
  return <>
    <div className="market-table-scroll"><table>
      <caption className="visually-hidden">{view==='listings'?'按单价从低到高排列的在售快照':'按成交时间从新到旧排列的成交记录'}，时间为北京时间，金额未含购买税费</caption>
      <thead><tr><th scope="col">{view==='listings'?'服务器 / 品质':'成交时间 / 品质'}</th><th scope="col">单价 <span>Gil</span></th><th scope="col">数量</th><th scope="col">合计 <span>Gil</span></th></tr></thead>
      <tbody>{keyedMarketRows(rows).slice(0,limit).map(({row,key})=><tr key={key}>
        <td><div className="market-row-label"><span>{'timestamp' in row?time(row.timestamp*1000):row.worldName??scopeLabel}</span><span className={row.hq?'market-quality market-quality--hq':'market-quality'}>{row.hq?'HQ':'NQ'}</span></div>{'lastReviewTime' in row&&row.lastReviewTime?<small className="market-row-time">记录于 {time(row.lastReviewTime*1000)}</small>:null}</td>
        <td className="market-unit-price">{number.format(row.pricePerUnit)}</td><td>{number.format(row.quantity)}</td><td>{number.format(row.pricePerUnit*row.quantity)}</td>
      </tr>)}</tbody>
    </table></div>
    <div className="market-table-footer"><span>已展示 {Math.min(limit,rows.length)} / {rows.length} 条{view==='listings'?' · 单价从低到高':' · 最新成交在前'}</span>{limit<rows.length?<button type="button" onClick={()=>setLimit(value=>value+10)}>再显示 {Math.min(10,rows.length-limit)} 条</button>:null}</div>
  </>;
}
function MarketResults({item,data,scopeLabel,onRefresh}:Readonly<{item:MarketItem;data:MarketData;scopeLabel:string;onRefresh:()=>void}>){
  const summary=marketSummary(data);
  const [now]=useState(Date.now),[view,setView]=useState<PriceView>('listings');
  const old=!data.lastUploadTime||now-data.lastUploadTime>7200000;
  return <div className="market-results">
    <header className="market-results__item">
      {item.icon?<img src={item.icon} alt="" width="48" height="48" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}}/>:null}
      <div className="market-results__name"><h3>{item.name}</h3><span>{scopeLabel} · 玩家上传快照</span></div>
      <button type="button" className="market-refresh" onClick={onRefresh} title="重新读取行情快照">↻ 刷新</button>
    </header>
    <div className="market-metrics">
      <div><span>当前记录最低单价</span><strong>{summary.minimum===null?'暂无在售':number.format(summary.minimum)}{summary.minimum===null?null:<small> Gil</small>}</strong><small>本次返回的在售价格</small></div>
      <div><span>近期成交中位单价</span><strong>{summary.median===null?'暂无成交':number.format(summary.median)}{summary.median===null?null:<small> Gil</small>}</strong><small>参考实际成交，避免只看挂牌价</small></div>
    </div>
    <div className="market-source"><span>最近上传：{time(data.lastUploadTime)} · 北京时间</span><a href={'https://universalis.app/market/'+item.id+'?server='+encodeURIComponent(scopeLabel)} target="_blank" rel="noopener noreferrer">Universalis 原站 ↗</a></div>
    {old?<output className="market-warning">快照已超过两小时或尚无上传时间，价格可能已变化。</output>:null}
    <fieldset className="market-table-tabs"><legend className="visually-hidden">行情记录类型</legend>
      <button type="button" aria-pressed={view==='listings'} onClick={()=>setView('listings')}>当前在售 <span>{data.listings.length}</span></button>
      <button type="button" aria-pressed={view==='sales'} onClick={()=>setView('sales')}>近期成交 <span>{data.recentHistory.length}</span></button>
    </fieldset>
    <PriceTable key={view} data={data} view={view} scopeLabel={scopeLabel}/>
    <p className="market-footnote">最多读取 40 条在售、30 条成交。单价和合计均未含购买税费；数据由玩家上传，可能存在延迟。</p>
  </div>;
}

function useMarketSearch(query:string,retry:number){
  const key=JSON.stringify([query,retry]);
  const [result,setResult]=useState<{key:string;items:MarketItem[];error:string}>({key:'',items:[],error:''});
  useEffect(()=>{
    const controller=new AbortController();
    if(query.trim()){
      void searchMarketItems(query,controller.signal).then(items=>{
        if(!controller.signal.aborted){setResult({key,items,error:''});}
      }).catch(error=>{if(!controller.signal.aborted){setResult({key,items:[],error:failure(error)});}});
    }
    return()=>controller.abort();
  },[query,key]);
  const current=result.key===key,hasQuery=Boolean(query.trim());
  return {items:current?result.items:[],searching:hasQuery&&!current,
    searched:hasQuery&&current&&!result.error,error:current?result.error:''};
}
function useMarketSnapshot(selected:MarketItem|null,scope:string,quality:Quality,refresh:number){
  const key=JSON.stringify([selected?.id,scope,quality,refresh]);
  const [result,setResult]=useState<{key:string;data:MarketData|null;error:string}>({key:'',data:null,error:''});
  useEffect(()=>{
    const controller=new AbortController();
    if(selected&&scope){
      void loadMarketData(scope,selected.id,quality,controller.signal,refresh>0).then(data=>{
        if(!controller.signal.aborted){setResult({key,data,error:''});}
      }).catch(error=>{if(!controller.signal.aborted){setResult({key,data:null,error:failure(error)});}});
    }
    return()=>controller.abort();
  },[selected,scope,quality,refresh,key]);
  const current=result.key===key;
  return {data:current?result.data:null,error:current?result.error:'',loading:Boolean(selected&&scope)&&!current};
}

function resolveMarketScope(centers:readonly MarketCenter[],scope:string){
  const center=centers.find(item=>item.name===scope||item.worlds.some(world=>String(world.id)===scope))??centers.find(item=>item.region==='中国')??centers[0];
  const active=center?.worlds.some(world=>String(world.id)===scope)?scope:center?.name??'';
  return {center,scope:active,label:center?.worlds.find(world=>String(world.id)===active)?.name??active};
}
export function MarketBoard({initialQuery=''}:Readonly<{initialQuery?:string}>){
  const [saved]=useState(preferences);
  const [scope,setScope]=useState(saved.scope),[quality,setQuality]=useState<Quality>(saved.quality);
  const [metadataRetry,setMetadataRetry]=useState(0);
  const [metadata,setMetadata]=useState<{key:number;centers:MarketCenter[];error:string}>({key:0,centers:[],error:''});
  const centers=metadata.centers;
  const metadataError=metadata.key===metadataRetry?metadata.error:'';
  const [input,setInput]=useState(initialQuery),[query,setQuery]=useState(initialQuery),[searchRetry,setSearchRetry]=useState(0);
  const {items,searching,searched,error:searchError}=useMarketSearch(query,searchRetry);
  const [selection,setSelection]=useState<MarketItem|null>(null);
  const selected=items.find(item=>item.id===selection?.id)??items.find(item=>item.name===query.trim())??(items.length===1?items[0]!:null);
  const [refresh,setRefresh]=useState(0);
  const {center:activeCenter,scope:activeScope,label:scopeLabel}=resolveMarketScope(centers,scope);
  const {data,error:dataError,loading}=useMarketSnapshot(selected,activeScope,quality,refresh);
  const chooseScope=(next:string)=>{setScope(next);remember(next,quality);};
  useEffect(()=>{
    const controller=new AbortController();
    void loadMarketCenters(controller.signal).then(value=>{if(!controller.signal.aborted){setMetadata({key:metadataRetry,centers:value,error:''});}})
      .catch(error=>{if(!controller.signal.aborted){setMetadata({key:metadataRetry,centers:[],error:failure(error)});}});
    return()=>controller.abort();
  },[metadataRetry]);
  return <section className="market-board" aria-label="Universalis 市场行情">
    <header className="market-board__intro"><h3>物品查价</h3><p>输入简体中文物品名，查本服价格或跨服比价。</p></header>
    <form className="market-search" role="search" aria-label="物品搜索" aria-busy={searching} onSubmit={event=>{event.preventDefault();setSelection(null);setQuery(input.trim());setSearchRetry(value=>value+1);}}>
      <label className="visually-hidden" htmlFor="market-detail-query">物品名称</label>
      <div className="market-search__input"><UiIcon name="search"/><input id="market-detail-query" type="search" value={input} maxLength={80} required onChange={event=>setInput(event.target.value)} placeholder="输入物品名称，例如：火之碎晶" autoComplete="off"/></div>
      <button type="submit" disabled={searching||!input.trim()}>{searching?'搜索中…':'查价格'}</button>
    </form>
    <div className="market-controls">
      <div className="market-scope">
        <label>大区 / 数据中心<select value={activeCenter?.name??''} disabled={!centers.length} onChange={event=>chooseScope(event.target.value)}>{!centers.length?<option value="">读取中…</option>:null}{[...centers].sort((a,b)=>Number(b.region==='中国')-Number(a.region==='中国')).map(center=><option key={center.name} value={center.name}>{regionNames[center.region]??center.region} · {center.name}</option>)}</select></label>
        <label>服务器<select value={activeScope} disabled={!activeCenter} onChange={event=>chooseScope(event.target.value)}><option value={activeCenter?.name??''}>全大区（跨服）</option>{activeCenter?.worlds.map(world=><option key={world.id} value={world.id}>{world.name}</option>)}</select></label>
      </div>
      <fieldset><legend>品质</legend>{([['all','全部'],['nq','普通 NQ'],['hq','高品质 HQ']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={quality===value} onClick={()=>{setQuality(value);remember(activeScope||scope,value);}}>{label}</button>)}</fieldset>
    </div>
    {metadataError?<p className="market-error" role="alert">{metadataError} <button type="button" onClick={()=>setMetadataRetry(value=>value+1)}>重新读取服务器</button></p>:null}
    {searchError?<p className="market-error" role="alert">{searchError} <button type="button" onClick={()=>setSearchRetry(value=>value+1)}>重试搜索</button></p>:null}
    {searched&&!items.length?<output className="market-empty"><strong>没有找到这件物品</strong><span>请使用游戏内的简体中文名称，或缩短关键词。</span></output>:null}
    {items.length>1?<section className="market-search-matches" aria-label="选择物品"><header><h4>找到 {items.length} 件物品</h4><span>点击名称查看行情</span></header><div className="market-search-results">{items.map(item=><button type="button" aria-pressed={selected?.id===item.id} key={item.id} onClick={()=>setSelection(item)}>{item.icon?<img src={item.icon} alt="" width="30" height="30" loading="lazy" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}}/>:null}<span>{item.name}</span>{selected?.id===item.id?<small>已选</small>:null}</button>)}</div></section>:null}
    {loading?<output className="market-loading"><span className="market-loading__dot" aria-hidden="true"/>正在查询 {scopeLabel} 的市场快照…</output>:null}
    {dataError?<p className="market-error" role="alert">{dataError} <button type="button" onClick={()=>setRefresh(value=>value+1)}>重试行情</button></p>:null}
    {selected&&data?<MarketResults item={selected} data={data} scopeLabel={scopeLabel} onRefresh={()=>setRefresh(value=>value+1)}/>:null}
    {!query&&!selected?<div className="market-welcome"><UiIcon name="search"/><h4>想查什么物品？</h4><p>输入名称后，选择物品即可查看行情。</p><div>{['火之碎晶','冰之碎晶','风之碎晶'].map(name=><button type="button" key={name} onClick={()=>{setInput(name);setQuery(name);setSearchRetry(value=>value+1);}}>{name}</button>)}</div><a href="https://universalis.app/" target="_blank" rel="noopener noreferrer">数据来自 Universalis ↗</a></div>:null}
  </section>;
}
