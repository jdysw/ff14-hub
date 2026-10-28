import {weatherPeriods,weatherCountdown} from './weather';
import {useEorzeaClock,useWeatherCatalog,useWeatherPreferences} from './weather-state';
import {WeatherClock} from './WeatherClock';
import {WeatherIcon} from './WeatherIcon';
import './weather.css';
export function WeatherHome({onOpenDetail}:Readonly<{onOpenDetail:(zoneId?:number)=>void}>){
  const now=useEorzeaClock(),{data,error,retry}=useWeatherCatalog(),[preferences]=useWeatherPreferences();
  const zones=data?.zones.filter(zone=>preferences.favorites.includes(zone.id))??[];
  return <section className="weather-home" aria-label="艾欧泽亚时间与天气">
    <header className="weather-heading"><h2>时间与天气</h2><button type="button" onClick={()=>onOpenDetail()}>查看天气 ↗</button></header>
    <WeatherClock now={now}/>
    {error?<p className="weather-notice" role="alert">{error} <button type="button" onClick={retry}>重试</button></p>:null}
    {!data&&!error?<output className="weather-muted">正在读取地图天气…</output>:null}
    {data?<div className="weather-home__places">{zones.map(zone=>{
      const current=weatherPeriods(zone,now,1)[0]!;
      return <button type="button" key={zone.id} onClick={()=>onOpenDetail(zone.id)} aria-label={'查看'+zone.name+'天气'}><span>{zone.name}</span><span><WeatherIcon weather={current.weather}/>{current.weather}</span></button>;
    })}{!zones.length?<button type="button" className="weather-home__add" onClick={()=>onOpenDetail()}>关注地图，在这里查看天气 ＋</button>:null}</div>:null}
    {zones[0]?<footer>距下个天气时段 <strong>{weatherCountdown(weatherPeriods(zones[0],now,1)[0]!.endsAt,now)}</strong><span>现实时间</span></footer>:null}
  </section>;
}
