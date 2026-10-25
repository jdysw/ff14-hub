import { z } from 'zod';

export const regionSchema = z.enum(['cn', 'global']);
export const verificationSchema = z.enum(['verified', 'unverified', 'incomplete']);
export type FishRegion = z.infer<typeof regionSchema>;
export const ET_HOUR_MS = 175_000;
export const ET_DAY_MS = ET_HOUR_MS * 24;
export const WEATHER_PERIOD_MS = ET_HOUR_MS * 8;
const MAX_UTC = Date.UTC(2100, 0, 1);
export const utcSchema = z.number().int().min(0).max(MAX_UTC);

export function eorzeaTime(utcMs: number): { day: number; hour: number; minute: number } {
  utcSchema.parse(utcMs);
  return { day: Math.floor(utcMs / ET_DAY_MS), hour: Math.floor(utcMs / ET_HOUR_MS) % 24,
    minute: Math.floor((utcMs % ET_HOUR_MS) * 60 / ET_HOUR_MS) };
}

/** Adapted from node-eorzea-weather, MIT, 900314c8. See THIRD_PARTY_NOTICES.md. */
export function forecastTarget(utcMs: number): number {
  utcSchema.parse(utcMs);
  const seconds = Math.floor(utcMs / 1000);
  const bell = seconds / 175;
  const increment = (bell + 8 - (bell % 8)) % 24;
  const days = Math.floor(seconds / 4200) >>> 0;
  const base = days * 100 + increment;
  const step1 = ((base << 11) ^ base) >>> 0;
  return (((step1 >>> 8) ^ step1) >>> 0) % 100;
}

export const weatherRateSchema = z.object({ weather: z.string().min(1).max(60), chance: z.number().int().min(1).max(100) }).strict();
export const weatherRatesSchema = z.array(weatherRateSchema).min(1).max(20)
  .refine((rates) => rates.reduce((sum, rate) => sum + rate.chance, 0) === 100, '天气概率合计须为100');
export type WeatherRates = z.infer<typeof weatherRatesSchema>;
export function weatherAt(utcMs: number, rates: WeatherRates): string {
  const target = forecastTarget(utcMs);
  let threshold = 0;
  for (const rate of weatherRatesSchema.parse(rates)) {
    threshold += rate.chance;
    if (target < threshold) {return rate.weather;}
  }
  throw new RangeError('invalid weather table');
}

export const fishRuleSchema = z.object({
  schemaVersion: z.literal(1), region: regionSchema, fishId: z.number().int().positive(),
  version: z.string().min(1).max(80), zoneId: z.string().min(1).max(80),
  startHour: z.number().min(0).max(24), endHour: z.number().min(0).max(24),
  weatherRates: weatherRatesSchema,
  currentWeather: z.array(z.string().min(1).max(60)).max(20),
  previousWeather: z.array(z.string().min(1).max(60)).max(20),
  // Additional mechanisms remain explicit requirements, never silently treated as satisfied.
  conditions: z.array(z.object({ kind: z.enum(['intuition', 'predators', 'bait', 'folklore', 'fishEyes', 'unknown']),
    description: z.string().min(1).max(300) }).strict()).max(20),
  validationStatus: verificationSchema,
}).strict().refine((r) => r.startHour !== r.endHour, '全天请显式使用0到24小时')
  .refine((r) => [...r.currentWeather, ...r.previousWeather].every((w) => r.weatherRates.some((rate) => rate.weather === w)), '条件引用未知天气');
export type FishRule = z.infer<typeof fishRuleSchema>;
export const fishSourceSchema = z.object({ url: z.url().startsWith('https://'), version: z.string().min(1).max(100),
  fetchedAt: utcSchema, authorizationStatus: z.enum(['permitted','unverified']), verificationStatus: verificationSchema }).strict();
export const fishRecordSchema = z.object({ id: z.number().int().positive(), region: regionSchema,
  name: z.string().min(1).max(100), fishType: z.enum(['normal','big','legendary']),
  source: fishSourceSchema, rule: fishRuleSchema, demo: z.boolean() }).strict()
  .refine((f) => f.region === f.rule.region && f.id === f.rule.fishId, '规则与鱼类身份不一致');
export type FishRecord = z.infer<typeof fishRecordSchema>;
export const fishDataBundleSchema = z.object({ schemaVersion: z.literal(1), region: regionSchema,
  records: z.array(fishRecordSchema).max(5000) }).strict().refine((b) =>
  b.records.every((f) => f.region === b.region) && new Set(b.records.map((f) => f.id)).size === b.records.length, '区服或ID不一致');
export interface FishWindow {
  occurrenceKey: string; region: FishRegion; fishId: number; ruleVersion: string;
  startsAtUtcMs: number; endsAtUtcMs: number;
  weatherChain: { previous: string; current: string };
  validationStatus: z.infer<typeof verificationSchema>; candidateOnly: boolean;
  conditions: FishRule['conditions'];
  /** No finite opening/closing boundary exists for the time/weather predicate. */
  unrestricted?: boolean;
  weatherSegments?: {startsAtUtcMs:number;endsAtUtcMs:number;previous:string;current:string}[];
}

type WeatherSegment=NonNullable<FishWindow['weatherSegments']>[number];
interface WindowQuery {readonly region:FishRegion;readonly from:number;readonly to:number}

/** One validated rule owns its weather cache and interval traversal. */
class RuleWindowQuery {
  private readonly rule:FishRule;
  private readonly query:WindowQuery;
  private readonly result:FishWindow[];
  private readonly cache=new Map<number,string>();

  constructor(rule:FishRule,query:WindowQuery,result:FishWindow[]){
    this.rule=rule;this.query=query;this.result=result;
  }
  private weather(period:number):string{
    const cached=this.cache.get(period);
    if(cached!==undefined){return cached;}
    const target=forecastTarget(period);
    let threshold=0;
    for(const entry of this.rule.weatherRates){
      threshold+=entry.chance;
      if(target<threshold){this.cache.set(period,entry.weather);return entry.weather;}
    }
    throw new RangeError('天气概率无效');
  }
  private chain(period:number){
    return {previous:period===0?'unknown':this.weather(period-WEATHER_PERIOD_MS),current:this.weather(period)};
  }
  private matches(period:number):boolean{
    if(period===0&&this.rule.previousWeather.length>0){return false;}
    const state=this.chain(period),rule=this.rule;
    return (!rule.currentWeather.length||rule.currentWeather.includes(state.current))&&
      (!rule.previousWeather.length||rule.previousWeather.includes(state.previous));
  }
  private append(segments:WeatherSegment[],unrestricted=false):void{
    const {rule,query,result}=this;
    const start=segments[0]?.startsAtUtcMs??(unrestricted&&rule.previousWeather.length>0?WEATHER_PERIOD_MS:0);
    const end=segments.at(-1)?.endsAtUtcMs??MAX_UTC;
    if(start>=query.to||end<=query.from){return;}
    if(end>MAX_UTC||segments.length>1000){throw new RangeError('完整窗口超过可确认范围');}
    const incomplete=rule.validationStatus==='incomplete'||rule.conditions.some(c=>['intuition','predators','unknown'].includes(c.kind));
    const first=segments[0];
    result.push({
      occurrenceKey:query.region+':'+String(rule.fishId)+':'+rule.version+':'+String(start),
      region:query.region,fishId:rule.fishId,ruleVersion:rule.version,startsAtUtcMs:start,endsAtUtcMs:end,
      weatherChain:first?{previous:first.previous,current:first.current}:{previous:'不限',current:'不限'},
      validationStatus:incomplete?'incomplete':rule.validationStatus,
      candidateOnly:rule.conditions.length>0||rule.validationStatus!=='verified',conditions:rule.conditions,
      ...(unrestricted?{unrestricted:true}:{weatherSegments:segments}),
    });
    if(result.length>5000){throw new RangeError('窗口结果超出上限，请缩小范围');}
  }
  private appendIfPresent(segments:WeatherSegment[]):void{
    if(segments.length){this.append(segments);}
  }
  private weatherRun(period:number):WeatherSegment[]{
    const limit=168*3_600_000;
    let start=period;
    while(start>=WEATHER_PERIOD_MS&&this.matches(start-WEATHER_PERIOD_MS)){
      start-=WEATHER_PERIOD_MS;
      if(period-start>limit){throw new RangeError('天气连续窗口起点尚不能确认');}
    }
    const segments:WeatherSegment[]=[];
    let end=start;
    while(this.matches(end)){
      if(end+WEATHER_PERIOD_MS>MAX_UTC||end-period>limit+this.query.to-this.query.from){
        throw new RangeError('天气连续窗口终点尚不能确认');
      }
      segments.push({startsAtUtcMs:end,endsAtUtcMs:end+WEATHER_PERIOD_MS,...this.chain(end)});
      end+=WEATHER_PERIOD_MS;
    }
    return segments;
  }
  private weatherOnlyWindows():void{
    let period=Math.floor(this.query.from/WEATHER_PERIOD_MS)*WEATHER_PERIOD_MS;
    while(period<this.query.to){
      if(!this.matches(period)){period+=WEATHER_PERIOD_MS;continue;}
      const segments=this.weatherRun(period);
      this.append(segments);
      period=segments.at(-1)!.endsAtUtcMs;
    }
  }
  private dailySegments(start:number,end:number):void{
    let segments:WeatherSegment[]=[];
    for(let period=Math.floor(start/WEATHER_PERIOD_MS)*WEATHER_PERIOD_MS;period<end;period+=WEATHER_PERIOD_MS){
      if(!this.matches(period)){this.appendIfPresent(segments);segments=[];continue;}
      segments.push({startsAtUtcMs:Math.max(start,period),endsAtUtcMs:Math.min(end,period+WEATHER_PERIOD_MS),...this.chain(period)});
    }
    this.appendIfPresent(segments);
  }
  private dailyWindows():void{
    const {from,to}=this.query,rule=this.rule;
    const firstDay=Math.max(0,Math.floor(from/ET_DAY_MS)-1),lastDay=Math.floor(to/ET_DAY_MS);
    for(let day=firstDay;day<=lastDay;day++){
      const start=Math.round(day*ET_DAY_MS+rule.startHour*ET_HOUR_MS);
      const end=Math.round(day*ET_DAY_MS+(rule.endHour<=rule.startHour?rule.endHour+24:rule.endHour)*ET_HOUR_MS);
      this.dailySegments(start,end);
    }
  }
  run():void{
    const rule=this.rule;
    const allDay=rule.startHour===0&&rule.endHour===24;
    const allWeather=(!rule.currentWeather.length||rule.weatherRates.every(r=>rule.currentWeather.includes(r.weather)))&&
      (!rule.previousWeather.length||rule.weatherRates.every(r=>rule.previousWeather.includes(r.weather)));
    if(allDay&&allWeather){this.append([],true);return;}
    if(allDay){this.weatherOnlyWindows();return;}
    this.dailyWindows();
  }
}

/** Returns full intervals intersecting [from,to), never clipped identities. */
export function fishWindows(input:{region:FishRegion;rules:readonly FishRule[];from:number;to:number}):FishWindow[]{
  const {region,from,to}=input;
  regionSchema.parse(region);utcSchema.parse(from);utcSchema.parse(to);
  if(to<=from||to-from>168*3_600_000||input.rules.length>50){throw new RangeError('窗口查询超出计算上限');}
  const result:FishWindow[]=[];
  for(const raw of input.rules){
    const rule=fishRuleSchema.parse(raw);
    if(rule.region!==region){throw new RangeError('规则区服不匹配');}
    new RuleWindowQuery(rule,input,result).run();
  }
  return result.sort((a,b)=>a.startsAtUtcMs-b.startsAtUtcMs||a.fishId-b.fishId);
}
