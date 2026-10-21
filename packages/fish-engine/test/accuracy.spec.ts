import {describe,it,expect} from 'vitest';
import {fishWindows,forecastTarget,ET_HOUR_MS as H,ET_DAY_MS as D,WEATHER_PERIOD_MS as W,type FishRule} from '../src/index';
const base:FishRule={schemaVersion:1,region:'cn',fishId:1,version:'audit-1',zoneId:'test',startHour:6,endHour:18,
  weatherRates:[{weather:'clear',chance:50},{weather:'rain',chance:50}],currentWeather:[],previousWeather:[],conditions:[],validationStatus:'verified'};
const windows=(rule:FishRule,from:number,to:number)=>fishWindows({region:'cn',rules:[rule],from,to});

describe('natural fish-window boundaries',()=>{
  it('does not invent closures at ET 08:00 or 16:00',()=>{
    const result=windows(base,6*H,19*H);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({startsAtUtcMs:6*H,endsAtUtcMs:18*H});
    expect(result[0]?.weatherSegments).toHaveLength(3);
    expect(windows(base,10*H,11*H)[0]?.occurrenceKey).toBe(result[0]?.occurrenceKey);
  });
  it('keeps an overnight window intact when entered after ET midnight',()=>{
    const rule={...base,startHour:22,endHour:4};
    const first=windows(rule,D+23*H,2*D+3*H)[0]!;
    const second=windows(rule,2*D+H,2*D+2*H)[0]!;
    expect(first.startsAtUtcMs).toBe(D+22*H);
    expect(first.endsAtUtcMs).toBe(2*D+4*H);
    expect(second).toEqual(first);
  });
  it('merges weather-only runs across ET days and keeps their true start',()=>{
    const rule={...base,startHour:0,endHour:24,currentWeather:['clear']};
    const result=windows(rule,0,30*W);
    expect(result.length).toBeGreaterThan(1);
    for(const item of result){
      expect(item.weatherSegments?.every(s=>s.current==='clear')).toBe(true);
      for(let at=item.startsAtUtcMs;at<item.endsAtUtcMs;at+=W)expect(forecastTarget(at)).toBeLessThan(50);
      if(item.startsAtUtcMs>=W)expect(forecastTarget(item.startsAtUtcMs-W)).toBeGreaterThanOrEqual(50);
      expect(forecastTarget(item.endsAtUtcMs)).toBeGreaterThanOrEqual(50);
      const inside=windows(rule,item.startsAtUtcMs+1,Math.min(item.endsAtUtcMs,item.startsAtUtcMs+1000))[0];
      expect(inside?.occurrenceKey).toBe(item.occurrenceKey);
      expect(inside?.endsAtUtcMs).toBe(item.endsAtUtcMs);
    }
  });
  it('never merges across a disallowed weather gap',()=>{
    const rule={...base,startHour:0,endHour:24,currentWeather:['rain']};
    const result=windows(rule,0,20*W);
    for(let i=1;i<result.length;i++)expect(result[i]!.startsAtUtcMs).toBeGreaterThan(result[i-1]!.endsAtUtcMs);
  });
  it('checks prior weather as well as current weather at every period',()=>{
    const rule={...base,startHour:0,endHour:24,currentWeather:['clear'],previousWeather:['rain']};
    const result=windows(rule,0,50*W);
    expect(result.length).toBeGreaterThan(0);
    for(const item of result)for(const segment of item.weatherSegments??[]){
      expect(segment.previous).toBe('rain');expect(segment.current).toBe('clear');
    }
  });
  it('represents no time/weather limit explicitly rather than recurring closing timers',()=>{
    const rule={...base,startHour:0,endHour:24};
    const result=windows(rule,100*D,101*D);
    expect(result).toHaveLength(1);
    expect(result[0]?.unrestricted).toBe(true);
    expect(windows(rule,100*D+H,101*D)[0]?.occurrenceKey).toBe(result[0]?.occurrenceKey);
  });
  it('does not mistake temporal matching for fulfilled intuition or predators',()=>{
    const rule={...base,conditions:[{kind:'predators' as const,description:'前置鱼 × 3'}]};
    expect(windows(rule,0,D)[0]).toMatchObject({candidateOnly:true,validationStatus:'incomplete'});
  });
  it('preserves fractional ET minutes',()=>{
    expect(windows({...base,startHour:9.5,endHour:10.5},0,D)[0]).toMatchObject({startsAtUtcMs:9.5*H,endsAtUtcMs:10.5*H});
  });
  it('matches uint32 weather targets against independent BigInt arithmetic over historical dates',()=>{
    const reference=(ms:number)=>{
      const slot=Math.floor(ms/1_400_000);
      const day=Math.floor(ms/4_200_000);
      const base=BigInt(day*100+((slot+1)*8)%24);
      const mask=0xFFFF_FFFFn;
      const mixed=((base<<11n)^base)&mask;
      return Number((((mixed>>8n)^mixed)&mask)%100n);
    };
    for(const year of [1970,2013,2020,2024,2026,2099])for(let day=0;day<30;day++){
      const at=Date.UTC(year,0,1)+day*86_400_000+37_123;
      expect(forecastTarget(at)).toBe(reference(at));
    }
  });
});
