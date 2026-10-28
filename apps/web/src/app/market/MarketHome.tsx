import {useState} from 'react';
import {UiIcon} from '../local/UiIcon';
import './market.css';

export function MarketHome({onOpenDetail}:Readonly<{onOpenDetail:(query?:string)=>void}>){
  const [query,setQuery]=useState('');
  return <section className="market-home" aria-label="市场行情">
    <header className="market-home__heading"><h2>市场行情</h2><button type="button" onClick={()=>onOpenDetail()}>打开市场 ↗</button></header>
    <p>查物价，也看成交。</p>
    <form role="search" aria-label="市场物品查询" onSubmit={event=>{event.preventDefault();onOpenDetail(query.trim());}}>
      <label className="visually-hidden" htmlFor="market-home-query">物品名称</label>
      <span className="market-home__input"><UiIcon name="search"/><input id="market-home-query" value={query} maxLength={80} onChange={event=>setQuery(event.target.value)} placeholder="输入简体中文物品名" autoComplete="off"/></span>
      <button type="submit">查价</button>
    </form>
    <div className="market-home__examples"><span>快捷查询</span>{['火之碎晶','冰之碎晶','风之碎晶'].map(name=><button type="button" key={name} onClick={()=>onOpenDetail(name)}>{name}</button>)}</div>
    <footer>Universalis <span>单服查价 · 跨服比价</span></footer>
  </section>;
}
