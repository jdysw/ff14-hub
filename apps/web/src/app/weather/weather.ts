import {z} from 'zod';
import {eorzeaTime,weatherAt,weatherRatesSchema,WEATHER_PERIOD_MS,ET_DAY_MS,ET_HOUR_MS} from '@ff14-hub/shared';
export const weatherZoneSchema=z.object({
  id:z.number().int().positive(),name:z.string().min(1).max(100),region:z.string().min(1),expansion:z.string().min(1),
  kind:z.enum(['town','field','housing']),rates:weatherRatesSchema,
}).strict();
export const weatherCatalogSchema=z.object({
  schemaVersion:z.literal(1),region:z.literal('cn'),version:z.string().min(1),generatedAt:z.iso.datetime(),
  source:z.literal('https://xivapi-v2.xivcdn.com/api/sheet/TerritoryType'),scope:z.string(),
  excluded:z.array(z.object({id:z.number().int().positive(),name:z.string(),reason:z.string()})),
  zones:z.array(weatherZoneSchema).min(1).max(500),
}).strict().refine(value=>new Set(value.zones.map(zone=>zone.id)).size===value.zones.length&&new Set(value.zones.map(zone=>zone.name)).size===value.zones.length,'地图重复');
export type WeatherZone=z.infer<typeof weatherZoneSchema>;
export type WeatherCatalog=z.infer<typeof weatherCatalogSchema>;
let catalog:Promise<WeatherCatalog>|undefined;
export function loadWeatherCatalog():Promise<WeatherCatalog>{
  if(!catalog){
    catalog=fetch('/weather/catalog-cn.json',{credentials:'omit',redirect:'error'})
      .then(async response=>{if(!response.ok){throw new Error('地图天气表暂时无法读取');}return weatherCatalogSchema.parse(await response.json());});
    void catalog.catch(()=>{catalog=undefined;});
  }
  return catalog;
}
export function weatherPeriods(zone:WeatherZone,now:number,count=9){
  if(!Number.isInteger(count)||count<1||count>72){throw new RangeError('天气时段数须为 1–72');}
  const start=Math.floor(now/WEATHER_PERIOD_MS)*WEATHER_PERIOD_MS;
  return Array.from({length:count},(_,index)=>{
    const startsAt=start+index*WEATHER_PERIOD_MS;
    return {startsAt,endsAt:startsAt+WEATHER_PERIOD_MS,weather:weatherAt(startsAt,zone.rates),hour:eorzeaTime(startsAt).hour};
  });
}
/** Display convention, independent of an area's scripted lighting. */
export function eorzeaDaylight(now:number){
  const et=eorzeaTime(now),dayStart=Math.floor(now/ET_DAY_MS)*ET_DAY_MS;
  const daytime=et.hour>=6&&et.hour<18;
  let boundary=dayStart+6*ET_HOUR_MS;
  if(daytime){boundary=dayStart+18*ET_HOUR_MS;}
  else if(et.hour>=18){boundary+=ET_DAY_MS;}
  return {daytime,boundary,hour:et.hour,minute:et.minute};
}
export function clockText(now:number){
  const et=eorzeaTime(now);return String(et.hour).padStart(2,'0')+':'+String(et.minute).padStart(2,'0');
}
export function weatherCountdown(until:number,now:number){
  const seconds=Math.max(0,Math.ceil((until-now)/1000));
  return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
}
export function beijingWeatherTime(utc:number){
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(utc);
}
export function filterWeatherZones(zones:readonly WeatherZone[],text:string,favorites:readonly number[],onlyFavorites=false){
  const query=text.normalize('NFKC').trim().toLocaleLowerCase();
  return zones.filter(zone=>(!onlyFavorites||favorites.includes(zone.id))&&(!query||[zone.name,zone.region,zone.expansion].some(value=>value.toLocaleLowerCase().includes(query))));
}
