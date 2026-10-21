import { describe,it,expect } from 'vitest';
import { ET_DAY_MS,ET_HOUR_MS,WEATHER_PERIOD_MS,eorzeaTime,forecastTarget,fishWindows,fishRuleSchema,weatherAt,type FishRule } from '../src/index';
const rule:FishRule={schemaVersion:1,region:'cn',fishId:1,version:'v1',zoneId:'test',startHour:22,endHour:4,
  weatherRates:[{weather:'clear',chance:100}],currentWeather:[],previousWeather:[],conditions:[],validationStatus:'verified'};
describe('ET and weather vectors',()=>{
  // Epoch and boundaries derived from 175 earth seconds per ET hour, not the implementation.
  it('uses UTC without local timezone and crosses ET days',()=>{
    expect(eorzeaTime(0)).toEqual({day:0,hour:0,minute:0});
    expect(eorzeaTime(ET_HOUR_MS-1)).toEqual({day:0,hour:0,minute:59});
    expect(eorzeaTime(ET_DAY_MS)).toEqual({day:1,hour:0,minute:0});
    expect(eorzeaTime(ET_DAY_MS*100+ET_HOUR_MS*23)).toEqual({day:100,hour:23,minute:0});
  });
  // Manual uint32 arithmetic: base=8 -> step1=16392 -> step2=16456 -> 56.
  it('matches independently calculated epoch forecast targets',()=>{
    expect(forecastTarget(0)).toBe(56);
    expect(forecastTarget(WEATHER_PERIOD_MS-1)).toBe(56);
    expect(forecastTarget(WEATHER_PERIOD_MS)).toBe(12);
    expect(forecastTarget(WEATHER_PERIOD_MS*2)).toBe(0);
    expect(weatherAt(0,[{weather:'dry',chance:56},{weather:'wet',chance:44}])).toBe('wet');
  });
  it.each([-1,NaN,Infinity])('rejects unsupported UTC %s',(value)=>expect(()=>forecastTarget(value)).toThrow());
});
describe('window semantics and cost',()=>{
  it('crosses midnight, uses half-open intervals, and keeps occurrence identity when queried inside a window',()=>{
    const from=ET_DAY_MS+23*ET_HOUR_MS;
    const first=fishWindows({region:'cn',rules:[rule],from,to:from+ET_HOUR_MS});
    const second=fishWindows({region:'cn',rules:[rule],from:from+1,to:from+ET_HOUR_MS});
    expect(first).toHaveLength(1);expect(first[0]?.occurrenceKey).toBe(second[0]?.occurrenceKey);
    expect(first[0]?.startsAtUtcMs).toBe(ET_DAY_MS+22*ET_HOUR_MS);
    expect(first[0]?.endsAtUtcMs).toBe(2*ET_DAY_MS+4*ET_HOUR_MS);
  });
  it('checks previous AND current weather and marks additional conditions incomplete',()=>{
    const r={...rule,startHour:0,endHour:24,previousWeather:['clear'],currentWeather:['clear'],conditions:[{kind:'intuition' as const,description:'前置鱼'}]};
    const result=fishWindows({region:'cn',rules:[r],from:ET_DAY_MS,to:2*ET_DAY_MS});
    expect(result).toHaveLength(1);expect(result.every((w)=>w.candidateOnly && w.validationStatus==='incomplete')).toBe(true);
    expect(result[0]?.unrestricted).toBe(true);
    expect(fishRuleSchema.safeParse({...r,currentWeather:['unknown']}).success).toBe(false);
  });
  it('isolates regions and bounds horizon, fish count and results',()=>{
    expect(()=>fishWindows({region:'global',rules:[rule],from:0,to:ET_DAY_MS})).toThrow();
    expect(()=>fishWindows({region:'cn',rules:[rule],from:0,to:169*3600000})).toThrow();
    expect(()=>fishWindows({region:'cn',rules:Array.from({length:51},()=>rule),from:0,to:ET_DAY_MS})).toThrow();
  });
});
