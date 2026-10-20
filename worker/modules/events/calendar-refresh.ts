import {eventCalendarResponseSchema,type EventCalendarResponse} from '@ff14-hub/shared';
import {consumeRateLimit} from '../../lib/rate-limit';
import {CN_CALENDAR_CACHE_MS,readCnCalendar} from './calendar-feed';

/** Only replace a public snapshot with a complete, recent response from the fixed official source. */
export async function storeOfficialCalendarSnapshot(db:D1Database,value:EventCalendarResponse,nowMs=Date.now()):Promise<boolean>{
  const calendar=eventCalendarResponseSchema.parse(value);
  if(calendar.source.stale||calendar.events.length===0||
    calendar.source.homeUrl!=='https://ff.web.sdo.com/web8/index.html#/newstab/newslist'||
    calendar.source.checkedAtMs>nowMs+60_000||nowMs-calendar.source.checkedAtMs>CN_CALENDAR_CACHE_MS||
    calendar.events.some(item=>item.region!=='cn'||!item.id.startsWith('official:')))return false;
  const result=await db.prepare(`INSERT INTO official_calendar_snapshots(source,payload,checked_at_ms)
    VALUES('cn',?,?) ON CONFLICT(source) DO UPDATE SET payload=excluded.payload,checked_at_ms=excluded.checked_at_ms
    WHERE official_calendar_snapshots.checked_at_ms<=excluded.checked_at_ms`)
    .bind(JSON.stringify(calendar),calendar.source.checkedAtMs).run();
  return (result.meta.changes??0)>0;
}

/** Request-driven refresh. A shared D1 quota prevents every edge/client from fetching the origin. */
export async function refreshOfficialCalendarSnapshot(db:D1Database,nowMs=Date.now(),load=readCnCalendar,force=false):Promise<boolean>{
  let stage:'quota'|'origin'|'snapshot'='quota';
  try{
    // Force is only used by the authenticated, separately throttled owner endpoint.
    if(!force){
      const quota=await consumeRateLimit(db,'public-calendar:official-refresh:cn',{limit:1,windowMs:CN_CALENDAR_CACHE_MS});
      if(!quota.allowed)return false;
    }
    stage='origin';
    const value=await load(nowMs,AbortSignal.timeout(20_000),force);
    stage='snapshot';
    const stored=await storeOfficialCalendarSnapshot(db,value,Date.now());
    console.info(JSON.stringify({event:'official_calendar_refresh',stored,partial:value.source.stale,count:value.events.length}));
    return stored;
  }catch(error){
    // A failed upstream refresh never removes or retimestamps the last verified snapshot.
    console.warn(JSON.stringify({event:'official_calendar_refresh_failure',stage,kind:error instanceof Error?error.name:'unknown'}));
    return false;
  }
}
