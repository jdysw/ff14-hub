/**
 * PVP 地图轮换纯计算：按北京时间锚点换算绝对 UTC 时间。
 * 不依赖浏览器时区、不请求后台，也不按进入页面的时刻累计计时。
 * 若游戏运营调整轮换表或临时停服，需要更新锚点/规则。
 */
import {z} from 'zod';
export const PVP_DAY_MS=86_400_000;
export const CRYSTAL_PERIOD_MS=3_600_000;
const CN_OFFSET_MS=8*CRYSTAL_PERIOD_MS;
export const PVP_RULE_VERSION='2026-10-21-cn-v2';

// 国服每日 23:00 换图；10-20 23:00 至 10-21 23:00 为第 5 个“尘封秘岩”。
export const FRONTLINE_ANCHOR_UTC=Date.UTC(2026,9,20,15,0,0);
// 北京时间 2026-10-21 10:00—11:00 为“赤土红沙”，紧接着回到“角力学校”。
export const CRYSTAL_ANCHOR_UTC=Date.UTC(2026,9,21,2,0,0);

export const FRONTLINE_MAPS=[
  '尘封秘岩（争夺战）',
  '荣誉野（碎冰战）',
  '昂萨哈凯尔（竞争战）',
  '沃刻其特（演习战）',
  '尘封秘岩（争夺战）',
  '周边遗迹群（阵地战）',
  '昂萨哈凯尔（竞争战）',
  '沃刻其特（演习战）',
] as const;

export const CRYSTAL_MAPS=[
  '角力学校','火山之心','海岸斗场','九霄云上','机关大殿','休兵书库','赤土红沙',
] as const;

function modulo(n:number,size:number):number{
  return ((n%size)+size)%size;
}
const rotationRule=z.object({anchor:z.number().int().nonnegative(),anchorIndex:z.number().int().nonnegative(),period:z.number().int().min(60000).max(7*86400000),maps:z.array(z.string().trim().min(1).max(60)).min(1).max(12)}).strict().refine(rule=>rule.anchorIndex<rule.maps.length,'锚点序号超出地图范围');
export const pvpRulesSchema=z.object({version:z.string().trim().min(1).max(80),frontline:rotationRule,crystalline:rotationRule}).strict();
export type PvpRules=ReturnType<typeof pvpRulesSchema.parse>;
export const DEFAULT_PVP_RULES:PvpRules={version:PVP_RULE_VERSION,frontline:{anchor:FRONTLINE_ANCHOR_UTC,anchorIndex:4,period:PVP_DAY_MS,maps:[...FRONTLINE_MAPS]},crystalline:{anchor:CRYSTAL_ANCHOR_UTC,anchorIndex:6,period:CRYSTAL_PERIOD_MS,maps:[...CRYSTAL_MAPS]}};

export interface PvpRotationStatus {
  readonly current:string;
  readonly next:string;
  readonly index:number;
  readonly startsAt:number;
  readonly changesAt:number;
}

function statusAt(now:number,anchor:number,period:number,maps:readonly string[],anchorIndex=0):PvpRotationStatus{
  const step=Math.floor((now-anchor)/period);
  const index=modulo(step+anchorIndex,maps.length);
  return {
    current:maps[index]!,
    next:maps[(index+1)%maps.length]!,
    index,
    startsAt:anchor+step*period,
    changesAt:anchor+(step+1)*period,
  };
}

export function frontlineAt(now:number,rules=DEFAULT_PVP_RULES):PvpRotationStatus{
  const rule=rules.frontline;return statusAt(now,rule.anchor,rule.period,rule.maps,rule.anchorIndex);
}

export function crystallineAt(now:number,rules=DEFAULT_PVP_RULES):PvpRotationStatus{
  const rule=rules.crystalline;return statusAt(now,rule.anchor,rule.period,rule.maps,rule.anchorIndex);
}

export function formatPvpCountdown(until:number,now:number):string{
  const seconds=Math.max(0,Math.ceil((until-now)/1_000));
  const hours=Math.floor(seconds/3_600);
  const minutes=Math.floor(seconds%3_600/60);
  const remainder=seconds%60;
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`;
}

export function beijingDate(utc:number):string{
  return new Date(utc+CN_OFFSET_MS).toISOString().slice(0,10);
}

export function beijingHour(utc:number):string{
  return new Date(utc+CN_OFFSET_MS).toISOString().slice(11,16);
}

export function frontlineSchedule(now:number,count=8,rules=DEFAULT_PVP_RULES){
  const current=frontlineAt(now,rules);
  return Array.from({length:count},(_,step)=>{
    const at=current.startsAt+step*rules.frontline.period;
    return {date:beijingDate(at),...frontlineAt(at,rules)};
  });
}

export function crystallineSchedule(now:number,count=8,rules=DEFAULT_PVP_RULES){
  const current=crystallineAt(now,rules);
  return Array.from({length:count},(_,step)=>{
    const at=current.startsAt+step*rules.crystalline.period;
    return {date:beijingDate(at),startHour:beijingHour(at),endHour:beijingHour(at+rules.crystalline.period),...crystallineAt(at,rules)};
  });
}
