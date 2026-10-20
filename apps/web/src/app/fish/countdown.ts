/** Remaining real time, rounded up to the next second and never negative. */
export function fishCountdown(milliseconds:number):string{
  let seconds=Number.isFinite(milliseconds)?Math.max(0,Math.ceil(milliseconds/1000)):0;
  const days=Math.floor(seconds/86400);seconds%=86400;
  const hours=Math.floor(seconds/3600);seconds%=3600;
  const minutes=Math.floor(seconds/60);seconds%=60;
  const time=[hours,minutes,seconds].map(value=>String(value).padStart(2,'0')).join(':');
  return days?`${days} 天 ${time}`:time;
}
