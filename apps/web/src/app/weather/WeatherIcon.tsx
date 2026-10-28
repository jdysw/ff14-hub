import sun from 'bootstrap-icons/icons/sun.svg?url';
import moon from 'bootstrap-icons/icons/moon-stars.svg?url';
import cloud from 'bootstrap-icons/icons/cloud.svg?url';
import rain from 'bootstrap-icons/icons/cloud-rain-heavy.svg?url';
import thunder from 'bootstrap-icons/icons/cloud-lightning-rain.svg?url';
import fog from 'bootstrap-icons/icons/cloud-fog2.svg?url';
import snow from 'bootstrap-icons/icons/snow.svg?url';
import wind from 'bootstrap-icons/icons/wind.svg?url';
const icons={sun,moon,cloud,rain,thunder,fog,snow,wind};
export function weatherSymbol(weather:string):keyof typeof icons{
  if(/雷/.test(weather)){return 'thunder';}
  if(/雪/.test(weather)){return 'snow';}
  if(/雨/.test(weather)){return 'rain';}
  if(/风/.test(weather)){return 'wind';}
  if(/雾|尘|烟/.test(weather)){return 'fog';}
  if(/晴|碧空|热浪/.test(weather)){return 'sun';}
  return 'cloud';
}
export function WeatherIcon({weather,night=false}:Readonly<{weather?:string;night?:boolean}>){
  let symbol:keyof typeof icons=night?'moon':'sun';
  if(weather){symbol=weatherSymbol(weather);}
  return <span className={'weather-icon weather-icon--'+symbol} aria-hidden="true" style={{maskImage:'url("'+icons[symbol]+'")'}}/>;
}
