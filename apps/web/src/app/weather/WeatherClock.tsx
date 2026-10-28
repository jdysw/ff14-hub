import {clockText,eorzeaDaylight,weatherCountdown} from './weather';
import {WeatherIcon} from './WeatherIcon';
export function WeatherClock({now}:Readonly<{now:number}>){
  const daylight=eorzeaDaylight(now);
  const percent=(daylight.hour+daylight.minute/60)/24*100;
  return <div className={'weather-clock '+(daylight.daytime?'weather-clock--day':'weather-clock--night')}>
    <div className="weather-clock__eyebrow"><span>艾欧泽亚时间 <abbr title="Eorzea Time">ET</abbr></span><span><WeatherIcon night={!daylight.daytime}/>{daylight.daytime?'昼间':'夜间'}</span></div>
    <div className="weather-clock__time" aria-label={'艾欧泽亚时间 '+clockText(now)}>{clockText(now)}</div>
    <div className="weather-clock__until">{daylight.daytime?'距夜间':'距昼间'} <strong>{weatherCountdown(daylight.boundary,now)}</strong><span>现实时间</span></div>
    <div className="weather-clock__track" aria-hidden="true"><div/><i style={{left:percent+'%'}}/></div>
    <div className="weather-clock__hours" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
  </div>;
}
