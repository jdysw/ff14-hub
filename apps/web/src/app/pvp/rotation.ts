/**
 * PVP 地图轮换纯计算：按北京时间锚点换算绝对 UTC 时间。
 * 不依赖浏览器时区、不请求后台，也不按进入页面的时刻累计计时。
 * 若游戏运营调整轮换表或临时停服，需要更新锚点/规则。
 */
export const PVP_DAY_MS=86_400_000;
export const CRYSTAL_PERIOD_MS=3_600_000;
const CN_OFFSET_MS=8*CRYSTAL_PERIOD_MS;

// 北京时间 2026-10-21 00:00 对应第 5 个“尘封秘岩”；22 日接“周边遗迹群”。
export const FRONTLINE_ANCHOR_UTC=Date.UTC(2026,9,20,16,0,0);
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

export interface PvpRotationStatus {
  readonly current:string;
  readonly next:string;
  readonly index:number;
  readonly startsAt:number;
  readonly changesAt:number;
}

function statusAt(now:number,anchor:number,period:number,maps:readonly string[]):PvpRotationStatus{
  const step=Math.floor((now-anchor)/period);
  const index=modulo(step,maps.length);
  return {
    current:maps[index]!,
    next:maps[(index+1)%maps.length]!,
    index,
    startsAt:anchor+step*period,
    changesAt:anchor+(step+1)*period,
  };
}

export function frontlineAt(now:number):PvpRotationStatus{
  return statusAt(now,FRONTLINE_ANCHOR_UTC,PVP_DAY_MS,FRONTLINE_MAPS);
}

export function crystallineAt(now:number):PvpRotationStatus{
  return statusAt(now,CRYSTAL_ANCHOR_UTC,CRYSTAL_PERIOD_MS,CRYSTAL_MAPS);
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

export function frontlineSchedule(now:number,count=8){
  const current=frontlineAt(now);
  return Array.from({length:count},(_,step)=>{
    const at=current.startsAt+step*PVP_DAY_MS;
    return {date:beijingDate(at),...frontlineAt(at)};
  });
}

export function crystallineSchedule(now:number,count=8){
  const current=crystallineAt(now);
  return Array.from({length:count},(_,step)=>{
    const at=current.startsAt+step*CRYSTAL_PERIOD_MS;
    return {date:beijingDate(at),startHour:beijingHour(at),endHour:beijingHour(at+CRYSTAL_PERIOD_MS),...crystallineAt(at)};
  });
}
