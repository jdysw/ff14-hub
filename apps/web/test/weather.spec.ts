import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {ET_DAY_MS,ET_HOUR_MS,WEATHER_PERIOD_MS} from '@ff14-hub/shared';
import {weatherCatalogSchema,clockText,eorzeaDaylight,weatherPeriods,weatherCountdown,filterWeatherZones,beijingWeatherTime} from '../src/app/weather/weather';
const catalog=weatherCatalogSchema.parse(JSON.parse(readFileSync('public/weather/catalog-cn.json','utf8')) as unknown);
const day=ET_DAY_MS*10000;
it('uses the existing ET scale and rolls over midnight exactly',()=>{
  expect(clockText(day)).toBe('00:00');expect(clockText(day+ET_HOUR_MS*6)).toBe('06:00');
  expect(clockText(day+ET_DAY_MS-1)).toBe('23:59');expect(clockText(day+ET_DAY_MS)).toBe('00:00');
  expect(ET_DAY_MS).toBe(70*60000);expect(WEATHER_PERIOD_MS).toBe(23*60000+20000);
});
it('treats 06:00 as day and 18:00 as night with a future boundary',()=>{
  expect(eorzeaDaylight(day+6*ET_HOUR_MS-1)).toMatchObject({daytime:false,boundary:day+6*ET_HOUR_MS});
  expect(eorzeaDaylight(day+6*ET_HOUR_MS)).toMatchObject({daytime:true,boundary:day+18*ET_HOUR_MS});
  expect(eorzeaDaylight(day+18*ET_HOUR_MS)).toMatchObject({daytime:false,boundary:day+ET_DAY_MS+6*ET_HOUR_MS});
});
it('preserves period boundaries even when successive weather names are identical',()=>{
  const zone={id:1,name:'固定晴朗',region:'测试',expansion:'测试',kind:'field' as const,rates:[{weather:'晴朗',chance:100}]};
  const rows=weatherPeriods(zone,day+WEATHER_PERIOD_MS-1,3);
  expect(rows.map(row=>row.hour)).toEqual([0,8,16]);
  expect(rows[0]).toMatchObject({startsAt:day,endsAt:day+WEATHER_PERIOD_MS,weather:'晴朗'});
  expect(weatherPeriods(zone,day+WEATHER_PERIOD_MS,1)[0]?.startsAt).toBe(day+WEATHER_PERIOD_MS);
  expect(rows).toHaveLength(3);
  expect(()=>weatherPeriods(zone,day,0)).toThrow();expect(()=>weatherPeriods(zone,day,73)).toThrow();
});
it('keeps the complete transformed catalog valid and excludes incomplete source tables',()=>{
  expect(catalog.zones).toHaveLength(70);
  expect(catalog.zones.find(zone=>zone.name==='海雾村')?.id).toBe(339);
  expect(catalog.zones.find(zone=>zone.id===979)).toBeUndefined();
  expect(catalog.excluded.find(zone=>zone.id===979)?.name).toBe('穹顶皓天');
  expect(catalog.zones.every(zone=>zone.rates.reduce((sum,rate)=>sum+rate.chance,0)===100)).toBe(true);
  expect(()=>weatherCatalogSchema.parse({...catalog,zones:[...catalog.zones,catalog.zones[0]]})).toThrow();
  expect(()=>weatherCatalogSchema.parse({...catalog,zones:[{...catalog.zones[0],rates:[{weather:'晴朗',chance:90}]}]})).toThrow();
});
it('filters Chinese map names and regions without changing the saved favorites',()=>{
  const favorites=[134,148];
  expect(filterWeatherZones(catalog.zones,'中拉诺西亚',favorites).map(zone=>zone.id)).toEqual([134]);
  expect(filterWeatherZones(catalog.zones,'',favorites,true).map(zone=>zone.id)).toEqual(favorites);
  expect(filterWeatherZones(catalog.zones,'不存在的地图',favorites)).toEqual([]);
  expect(favorites).toEqual([134,148]);
});
it('formats countdowns without negative values and explicit Beijing forecast timestamps',()=>{
  expect(weatherCountdown(1001,1000)).toBe('00:01');expect(weatherCountdown(1000,1001)).toBe('00:00');
  expect(beijingWeatherTime(Date.UTC(2026,0,1,0,0,0))).toContain('08:00:00');
});
