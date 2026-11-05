import {useEffect,useState} from 'react';
import {HOUSING_SOURCE,housingAreas,housingResponseSchema,housingSizes,housingUses,housingWorlds,type HousingPlot} from '@ff14-hub/shared/housing';
import {chinaDateTime} from '../events/public-calendar-utils';
import '../market/market.css';

const states = ['状态待确认','报名中','结果公示','准备中','阶段已结束，待上报'];
const filters = [
  ['Area','住宅区',housingAreas], ['Size','尺寸',housingSizes],
  ['RegionType','用途',housingUses], ['State','抽签状态',states],
] as const;
const pageSize = 30;
type Result = {plots: HousingPlot[]; fetchedAt: number; observedAt: number} | {error: true};

function phase(plot: HousingPlot, now: number) {
  if (plot.EndTime > 0 && plot.EndTime * 1000 <= now) return 4;
  return plot.State;
}

function displayTime(seconds: number) {
  return seconds > 0 ? chinaDateTime(seconds * 1000) : '—';
}

export function HousingBoard() {
  const [world,setWorld] = useState('1167');
  const [refresh,setRefresh] = useState(0);
  const [result,setResult] = useState<Result | null>(null);
  const [selection,setSelection] = useState<Record<string,string>>({});
  const [page,setPage] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/housing?world=${world}`, {signal:controller.signal, credentials:'omit'});
        if (!response.ok) throw new Error('Housing lookup failed');
        const value = housingResponseSchema.parse(await response.json());
        if (!controller.signal.aborted) setResult({...value, observedAt:Date.now()});
      } catch {
        if (!controller.signal.aborted) setResult({error:true});
      }
    };
    void load();
    return () => controller.abort();
  }, [world,refresh]);

  const now = result && 'observedAt' in result ? result.observedAt : 0;
  const plots = result && 'plots' in result ? result.plots.filter(plot =>
    plot.PurchaseType === 2 && filters.every(([key]) => {
      const selected = selection[key];
      return !selected || selected === String(key === 'State' ? phase(plot,now) : plot[key]);
    })) : [];
  const pageCount = Math.max(1, Math.ceil(plots.length / pageSize));

  return <div className="market-board">
    <p>查询国服可抽签房源。房源由玩家上报，报名和查看结果请前往游戏内告示牌。</p>
    <div className="market-scope">
      <label>服务器<select value={world} onChange={event => {
        setResult(null);
        setWorld(event.target.value);
        setPage(0);
      }}>
        {Object.entries(housingWorlds).map(([group,worlds]) => <optgroup key={group} label={group}>
          {worlds.map(([id,name]) => <option key={id} value={id}>{name}</option>)}
        </optgroup>)}
      </select></label>
      {filters.map(([key,label,options]) => <label key={key}>{label}<select value={selection[key] ?? ''} onChange={event => {
        setSelection({...selection,[key]:event.target.value});
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
        setResult(null);
        setRefresh(value => value + 1);
      }}>刷新</button>
    </div>
    {!result && <output>正在查询房源…</output>}
    {result && 'error' in result && <p role="alert">暂时无法获取售楼中心数据，请刷新重试。</p>}
    {result && 'plots' in result && <>
      <output style={{display:'block'}}>{plots.length ? `找到 ${plots.length} 条房源` : '没有符合当前筛选条件的房源。'}</output>
      {plots.length > 0 && <div className="market-table-scroll" role="region" tabIndex={0} aria-label="房源列表">
        <table className="market-table">
          <thead><tr>{['位置','尺寸 / 用途','价格（金币）','状态','参与人数','阶段截止','房源上报'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{plots.slice(page * pageSize, (page + 1) * pageSize).map(plot => <tr key={`${plot.Area}-${plot.Slot}-${plot.ID}`}>
            <td>{housingAreas[plot.Area]} {plot.Slot + 1} 区 {plot.ID} 号</td>
            <td>{housingSizes[plot.Size] ?? '待确认'} / {housingUses[plot.RegionType]}</td>
            <td>{plot.Price > 0 ? plot.Price.toLocaleString('zh-CN') : '—'}</td>
            <td>{states[phase(plot,now)]}{plot.State === 2 && plot.UpdateTime > 0 && plot.Winner > 0 ? ` · 上报中选号 ${plot.Winner}` : ''}</td>
            <td>{plot.UpdateTime > 0 && (plot.State === 1 || plot.State === 2) ? plot.Participate : '—'}</td>
            <td>{displayTime(plot.EndTime)}</td>
            <td>{displayTime(plot.LastSeen)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {pageCount > 1 && <div className="market-source">
        <button type="button" className="market-refresh" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button>
        <span>第 {page + 1} / {pageCount} 页</span>
        <button type="button" className="market-refresh" disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>下一页</button>
      </div>}
    </>}
  </div>;
}
