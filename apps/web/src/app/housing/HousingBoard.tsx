import {useState} from 'react';
import {HOUSING_SOURCE,housingSizes,housingUses,housingWorlds} from '@ff14-hub/shared/housing';
import {chinaDateTime} from '../events/public-calendar-utils';
import {displayTime,housingFilters,participation,phase,plotLocation,states,useHousing} from './housing-state';
import '../market/market.css';

const pageSize = 30;

export function HousingBoard() {
  const {world,selection,result,plots,now,changeWorld,changeFilter,reload} = useHousing();
  const [page,setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(plots.length / pageSize));

  return <div className="market-board">
    <p>查询国服可抽签房源。房源由玩家上报，报名和查看结果请前往游戏内告示牌。</p>
    <div className="market-scope">
      <label>服务器<select value={world} onChange={event => {
        changeWorld(event.target.value);
        setPage(0);
      }}>
        {Object.entries(housingWorlds).map(([group,worlds]) => <optgroup key={group} label={group}>
          {worlds.map(([id,name]) => <option key={id} value={id}>{name}</option>)}
        </optgroup>)}
      </select></label>
      {housingFilters.map(([key,label,options]) => <label key={key}>{label}<select value={selection[key] ?? ''} onChange={event => {
        changeFilter(key,event.target.value);
        setPage(0);
      }}>
        <option value="">全部</option>
        {options.map((option,index) => <option key={option} value={index}>{option}</option>)}
      </select></label>)}
    </div>
    <div className="market-source">
      <a href={HOUSING_SOURCE} target="_blank" rel="noreferrer">数据来源：艾欧泽亚售楼中心 ↗</a>
      {result && 'fetchedAt' in result && <span>获取于 {chinaDateTime(result.fetchedAt)}</span>}
      <button className="market-refresh" type="button" disabled={!result} onClick={() => {
        setPage(0);
        reload();
      }}>刷新</button>
    </div>
    {!result && <output>正在查询房源…</output>}
    {result && 'error' in result && <p role="alert">暂时无法获取售楼中心数据，请刷新重试。</p>}
    {result && 'plots' in result && <>
      <output style={{display:'block'}}>{plots.length ? `找到 ${plots.length} 条房源` : '没有符合当前筛选条件的房源。'}</output>
      {plots.length > 0 && <section className="market-table-scroll" aria-label="房源列表">
        <table className="market-table">
          <thead><tr>{['位置','尺寸 / 用途','价格（金币）','状态','参与人数','阶段截止','房源上报'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{plots.slice(page * pageSize, (page + 1) * pageSize).map(plot => <tr key={`${plot.Area}-${plot.Slot}-${plot.ID}`}>
            <td>{plotLocation(plot)}</td>
            <td>{housingSizes[plot.Size] ?? '待确认'} / {housingUses[plot.RegionType]}</td>
            <td>{plot.Price > 0 ? plot.Price.toLocaleString('zh-CN') : '—'}</td>
            <td>{states[phase(plot,now)]}{plot.State === 2 && plot.UpdateTime > 0 && plot.Winner > 0 ? ` · 上报中选号 ${plot.Winner}` : ''}</td>
            <td>{participation(plot)}</td>
            <td>{displayTime(plot.EndTime)}</td>
            <td>{displayTime(plot.LastSeen)}</td>
          </tr>)}</tbody>
        </table>
      </section>}
      {pageCount > 1 && <div className="market-source">
        <button type="button" className="market-refresh" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button>
        <span>第 {page + 1} / {pageCount} 页</span>
        <button type="button" className="market-refresh" disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>下一页</button>
      </div>}
    </>}
  </div>;
}
