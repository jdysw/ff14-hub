import {useEffect,useState} from 'react';
import {useGameData} from '../admin/game-data';
import {
  beijingDate,beijingHour,crystallineAt,crystallineSchedule,
  formatPvpCountdown,frontlineAt,frontlineSchedule,
} from './rotation';

interface PvpBoardProps {
  readonly expanded?:boolean;
  readonly onOpenDetail?:()=>void;
}

function useRotationClock():number{
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    const update=()=>setNow(Date.now());
    const timer=window.setInterval(update,1_000);
    document.addEventListener('visibilitychange',update);
    window.addEventListener('focus',update);
    return()=>{
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange',update);
      window.removeEventListener('focus',update);
    };
  },[]);
  return now;
}

/** 首页只保留两种 PVP 当前地图；详情继承网站统一的原位展开/收起交互。 */
export function PvpBoard({expanded=false,onOpenDetail}:PvpBoardProps){
  const now=useRotationClock();
  const rules=useGameData().pvp;
  const frontline=frontlineAt(now,rules);
  const crystal=crystallineAt(now,rules);
  const countdownFrontline=formatPvpCountdown(frontline.changesAt,now);
  const countdownCrystal=formatPvpCountdown(crystal.changesAt,now);
  const tomorrow=beijingDate(frontline.changesAt);

  return <section className={expanded?'pvp-board pvp-board--expanded':'pvp-board pvp-board--home'}
    aria-label="PVP 战场地图轮换" data-testid="pvp-board">
    {!expanded?<header className="pvp-board__heading">
      <h2>PVP 战场</h2>
      <button type="button" onClick={onOpenDetail} className="pvp-board__expand">完整轮换 ↗</button>
    </header>:<header className="pvp-board__detail-heading">
      <h3>PVP 地图轮换</h3>
      <p>自动按北京时间计算，无需刷新页面。</p>
    </header>}
    <div className="pvp-board__current">
      {!expanded?<>{([{name:'纷争前线',status:frontline,countdown:countdownFrontline},{name:'水晶冲突',status:crystal,countdown:countdownCrystal}]).map(item=><article className="pvp-home-row" key={item.name}><div className="pvp-home-row__main"><h3>{item.name}</h3><strong>{item.status.current}</strong><p>下{item.name==='纷争前线'?'轮':'张'}：{item.status.next}</p></div><div className="pvp-home-row__timer"><span>距换图</span><strong>{item.countdown}</strong><small>北京时间 {beijingHour(item.status.changesAt)}</small></div></article>)}</>:<>
      <article className="pvp-board__mode">
        <div className="pvp-board__mode-head"><h3>纷争前线</h3><span>北京时间 {beijingHour(frontline.changesAt)} 轮换</span></div>
        <strong className="pvp-board__map">{frontline.current}</strong>
        <div className="pvp-board__meta">
          <span>下轮：{frontline.next} · 北京时间 {beijingHour(frontline.changesAt)}</span>
          <span className="pvp-board__countdown" title="距下一张地图">{countdownFrontline}</span>
        </div>
      </article>
      <article className="pvp-board__mode">
        <div className="pvp-board__mode-head"><h3>水晶冲突</h3><span>每 {rules.crystalline.period/60000} 分钟</span></div>
        <strong className="pvp-board__map">{crystal.current}</strong>
        <div className="pvp-board__meta">
          <span>下张：{crystal.next} · 北京时间 {beijingHour(crystal.changesAt)}</span>
          <span className="pvp-board__countdown" title="距下一张地图">{countdownCrystal}</span>
        </div>
      </article>
      </>}
    </div>
    {expanded?<div className="pvp-board__schedules">
      <section className="pvp-board__schedule" aria-label="纷争前线未来八天">
        <h3>纷争前线 · 未来 8 天</h3>
        <p>每日北京时间 23:00 更换地图，下一次为 {tomorrow} 23:00。</p>
        <ol>{frontlineSchedule(now,8,rules).map((entry,index)=><li key={entry.startsAt} aria-current={index===0?'time':undefined}>
          <span className="pvp-board__schedule-time">{entry.date} {beijingHour(entry.startsAt)} {index===0?'（本轮）':''}</span>
          <span className="pvp-board__schedule-map">{entry.current}</span>
        </li>)}</ol>
      </section>
      <section className="pvp-board__schedule" aria-label="水晶冲突未来八小时">
        <h3>水晶冲突 · 接下来 8 小时</h3>
        <p>每小时整点切换；时间均为北京时间。</p>
        <ol>{crystallineSchedule(now,8,rules).map((entry,index)=><li key={entry.startsAt} aria-current={index===0?'time':undefined}>
          <span className="pvp-board__schedule-time">{entry.date} {entry.startHour}–{entry.endHour}</span>
          <span className="pvp-board__schedule-map">{entry.current}</span>
        </li>)}</ol>
      </section>
    </div>:null}
    {expanded?<p className="pvp-board__footnote">基于当前提供的轮换顺序和 2026-10-21 锚点推算；若官方调整地图轮换或维护规则，需要校准时间表。</p>:null}
  </section>;
}
