import {HOUSING_SOURCE,housingSizes,housingUses} from '@ff14-hub/shared/housing';
import {chinaDateTime} from '../events/public-calendar-utils';
import {housingFilters,participation,phase,plotLocation,states,useHousing} from './housing-state';
import './housing-home.css';

export function HousingHome({onOpen}: Readonly<{onOpen: () => void}>) {
  const {worldName,selection,hasPreferences,result,plots,now,reload} = useHousing();
  const labels = housingFilters.flatMap(([key,,options]) => {
    const choice = selection[key];
    return choice ? [options[Number(choice)]] : [];
  });

  return <section className="home-official housing-home" aria-label="房屋抽取">
    <header className="home-section-heading">
      <h2>房屋抽取</h2>
      <button className="text-button" type="button" onClick={onOpen}>{hasPreferences ? '筛选与详情 ↗' : '查询房源 ↗'}</button>
    </header>
    {!hasPreferences && <p className="home-state">选择服务器和筛选条件后，首页会显示匹配的房源。</p>}
    {hasPreferences && <>
      <p className="housing-home__scope">{[worldName,...labels].join(' · ')}</p>
      {!result && <output>正在查询房源…</output>}
      {result && 'error' in result && <p role="alert">暂时无法查询房源。 <button className="text-button" type="button" onClick={reload}>重试</button></p>}
      {result && 'plots' in result && <div className="housing-home__status">
        <output>{plots.length ? `匹配 ${plots.length} 条房源` : '没有符合当前筛选的房源。'}</output>
        <small>获取于 {chinaDateTime(result.fetchedAt)}</small>
      </div>}
      {plots.length > 0 && <ul className="housing-home__plots" aria-label="匹配房源预览">
        {plots.slice(0,4).map(plot => <li key={`${plot.Area}-${plot.Slot}-${plot.ID}`}>
          <strong>{plotLocation(plot)}</strong>
          <span>{housingSizes[plot.Size] ?? '尺寸待确认'} · {housingUses[plot.RegionType]} · {states[phase(plot,now)]}</span>
          <span>{plot.Price > 0 ? `${plot.Price.toLocaleString('zh-CN')} 金币` : '价格待确认'} · 报名 {participation(plot)}</span>
        </li>)}
      </ul>}
    </>}
    <a href={HOUSING_SOURCE} target="_blank" rel="noreferrer">艾欧泽亚售楼中心 ↗</a>
  </section>;
}
