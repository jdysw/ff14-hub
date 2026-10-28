import {useMemo,useState} from 'react';
import {WEATHER_PERIOD_MS} from '@ff14-hub/shared';
import {UiIcon} from '../local/UiIcon';
import {useEorzeaClock,useWeatherCatalog,useWeatherPreferences} from './weather-state';
import {weatherPeriods,clockText,filterWeatherZones,weatherCountdown,beijingWeatherTime,type WeatherCatalog} from './weather';
import {WeatherClock} from './WeatherClock';
import {WeatherIcon} from './WeatherIcon';
import './weather.css';

function MapWeather({catalog,now,initialZoneId}:Readonly<{catalog:WeatherCatalog;now:number;initialZoneId?:number}>){
  const [preferences,save]=useWeatherPreferences();
  const [selectedId,setSelectedId]=useState(initialZoneId??preferences.selected),[search,setSearch]=useState(''),[onlyFavorites,setOnlyFavorites]=useState(false),[notice,setNotice]=useState('');
  const zone=catalog.zones.find(item=>item.id===selectedId)??catalog.zones[0]!;
  const filtered=useMemo(()=>filterWeatherZones(catalog.zones,search,preferences.favorites,onlyFavorites),[catalog.zones,search,preferences.favorites,onlyFavorites]);
  const selectedVisible=filtered.some(item=>item.id===zone.id);
  const period=Math.floor(now/WEATHER_PERIOD_MS);
  const forecast=useMemo(()=>weatherPeriods(zone,period*WEATHER_PERIOD_MS),[zone,period]);
  const current=forecast[0]!,next=forecast[1]!;
  const favorite=preferences.favorites.includes(zone.id);
  const choose=(id:number)=>{setSelectedId(id);setNotice(save({...preferences,selected:id})?'':'当前浏览器无法保存偏好，本次选择仍可使用。');};
  const toggleFavorite=()=>{
    if(!favorite&&preferences.favorites.length>=6){setNotice('最多关注 6 张地图，请先取消一项。');return;}
    const favorites=favorite?preferences.favorites.filter(id=>id!==zone.id):[...preferences.favorites,zone.id];
    setNotice(save({...preferences,selected:zone.id,favorites})?'':'当前浏览器无法保存偏好，关注仅在本次打开有效。');
  };
  return <section className="weather-map" aria-label="地图天气查询">
    <div className="weather-map__search">
      <label className="weather-search"><span className="visually-hidden">搜索地图</span><UiIcon name="search"/><input type="search" value={search} onChange={event=>setSearch(event.target.value)} maxLength={80} placeholder="搜索地图或地区，如：中拉诺西亚"/></label>
      <button type="button" className="weather-favorites-filter" aria-pressed={onlyFavorites} onClick={()=>setOnlyFavorites(value=>!value)}><UiIcon name={onlyFavorites?'starFill':'star'}/>仅关注</button>
    </div>
    <label className="weather-select">选择地图<select value={selectedVisible?zone.id:''} onChange={event=>choose(Number(event.target.value))}>
      {!selectedVisible?<option value="" disabled>{filtered.length?'请选择搜索结果中的地图':'没有匹配地图'}</option>:null}
      {filtered.map(item=><option key={item.id} value={item.id}>{item.name} · {item.region}</option>)}
    </select><span>{filtered.length} 张地图{onlyFavorites?' · 仅显示关注':''}</span></label>
    {!filtered.length?<p className="weather-notice" role="status">没有找到匹配地图。<button type="button" onClick={()=>{setSearch('');setOnlyFavorites(false);}}>查看全部地图</button></p>:null}
    <header className="weather-map__heading"><div><span>{zone.expansion} · {zone.region}</span><h3>{zone.name}</h3></div><button type="button" aria-pressed={favorite} onClick={toggleFavorite} aria-label={(favorite?'取消关注':'关注')+zone.name}><UiIcon name={favorite?'starFill':'star'}/>{favorite?'已关注':'关注地图'}</button></header>
    {notice?<p className="weather-notice" role="status">{notice}</p>:null}
    <div className="weather-current"><div><WeatherIcon weather={current.weather}/><div><span>当前天气</span><strong>{current.weather}</strong></div></div><div><span>距下个时段</span><strong>{weatherCountdown(current.endsAt,now)}</strong><small>现实时间 · 下期{next.weather}</small></div></div>
    <section className="weather-forecast" aria-label="当前及后续八个天气时段">
      <header><h4>天气时段</h4><span>ET 00:00 / 08:00 / 16:00 切换</span></header>
      <ol>{forecast.map((entry,index)=><li key={entry.startsAt} aria-current={index===0?'time':undefined}>
        <div className="weather-forecast__weather"><WeatherIcon weather={entry.weather}/><strong>{entry.weather}</strong>{index===0?<span>当前</span>:null}</div>
        <span className="weather-forecast__et">ET {clockText(entry.startsAt)}–{clockText(entry.endsAt)}</span>
        <time dateTime={new Date(entry.startsAt).toISOString()}>{beijingWeatherTime(entry.startsAt)}</time>
      </li>)}</ol>
      <p>现实时间均为北京时间。相邻时段可能出现相同天气；每个时段为 8 ET 小时，即现实 23 分 20 秒。</p>
    </section>
    <details className="weather-sources"><summary>覆盖范围与计算说明</summary><p>收录 {catalog.zones.length} 张国服常规地图，天气表版本 {catalog.version}。{catalog.scope}</p><p>昼夜按 ET 06:00–18:00 划分，地图实际亮度及天气可能被剧情覆盖。预测依赖设备时钟，时间不准时请先校准系统时间。</p>{catalog.excluded.length?<p>暂未收录：{catalog.excluded.map(item=>item.name+'（'+item.reason+'）').join('、')}。</p>:null}<a href="https://xivapi-v2.xivcdn.com/api/sheet/TerritoryType" target="_blank" rel="noopener noreferrer">地图天气数据来源 ↗</a></details>
  </section>;
}
export function WeatherBoard({initialZoneId}:Readonly<{initialZoneId?:number}>){
  const now=useEorzeaClock(),{data,error,retry}=useWeatherCatalog();
  return <div className="weather-board"><header className="weather-board__intro"><h3>艾欧泽亚时间与天气</h3><p>找地图、看天气，把握下一个时段。</p></header><div className="weather-board__layout"><aside><WeatherClock now={now}/><p className="weather-board__clock-note">艾欧泽亚一天 = 现实 70 分钟<br/>昼夜时段：ET 06:00 / 18:00</p></aside>{data?<MapWeather catalog={data} now={now} {...(initialZoneId?{initialZoneId}:{})}/>:<section>{error?<p className="weather-notice" role="alert">{error}<button type="button" onClick={retry}>重试</button></p>:<p role="status">正在读取地图天气表…</p>}</section>}</div></div>;
}
