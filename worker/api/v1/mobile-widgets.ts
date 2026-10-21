import {Hono} from 'hono';
import {
  CRYSTAL_ANCHOR_UTC,CRYSTAL_MAPS,CRYSTAL_PERIOD_MS,FRONTLINE_ANCHOR_UTC,FRONTLINE_MAPS,
  PVP_DAY_MS,crystallineAt,frontlineAt,fishWindows,
  mobileWidgetQueryV1Schema,mobileWidgetResponseV1Schema,
  type MobileWidgetResponseV1,
} from '@ff14-hub/shared';
import type {AppBindings} from '../../types';
import {noStoreJson} from '../../lib/response';
import {validateQuery} from '../../middleware/validation';
import {methodNotAllowed} from '../../middleware/error-handler';
import {readFish} from '../../modules/fish/service';
import {readOfficialCalendarSnapshot} from '../../modules/events/calendar-snapshot';
import {applyCalendarEdits} from '../../modules/events/calendar-editor';

const RULE_VERSION='2026-10-21-cn-v1';
export const mobileWidgetRoutes=new Hono<AppBindings>();

/** 无认证、公开只读；不得读取任何工作空间/用户标记或 WebDAV 密钥。 */
mobileWidgetRoutes.get('/v1/summary',validateQuery(mobileWidgetQueryV1Schema),async(c)=>{
  const params=mobileWidgetQueryV1Schema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const now=Date.now();
  const front=frontlineAt(now),crystal=crystallineAt(now);
  const pvp:MobileWidgetResponseV1['pvp']={
    frontline:{
      current:front.current,next:front.next,startsAtMs:front.startsAt,changesAtMs:front.changesAt,
      anchorUtcMs:FRONTLINE_ANCHOR_UTC,anchorIndex:4,periodMs:PVP_DAY_MS,
      cycle:[...FRONTLINE_MAPS],ruleVersion:RULE_VERSION,
    },
    crystalline:{
      current:crystal.current,next:crystal.next,startsAtMs:crystal.startsAt,changesAtMs:crystal.changesAt,
      anchorUtcMs:CRYSTAL_ANCHOR_UTC,anchorIndex:6,periodMs:CRYSTAL_PERIOD_MS,
      cycle:[...CRYSTAL_MAPS],ruleVersion:RULE_VERSION,
    },
  };
  let fish:MobileWidgetResponseV1['fish']={status:'selection_required',items:[]};
  if(params.fishIds?.length){
    try{
      const chosen=new Set(params.fishIds);
      const records=(await readFish(c.env.DB,params.region)).filter(record=>chosen.has(record.id));
      const windows=records.flatMap(record=>
        fishWindows({region:params.region,rules:[record.rule],from:now,to:now+24*3_600_000})
          .filter(window=>window.endsAtUtcMs>now)
          .slice(0,8)
          .map(window=>({
            fishId:record.id,name:record.name,
            startsAtMs:window.startsAtUtcMs,endsAtMs:window.endsAtUtcMs,
            validationStatus:window.validationStatus,candidateOnly:window.candidateOnly,
          }))
      ).sort((a,b)=>a.startsAtMs-b.startsAtMs||a.fishId-b.fishId);
      fish={status:'ready',items:windows.slice(0,20)};
    }catch{
      fish={status:'unavailable',items:[]};
    }
  }
  let events:MobileWidgetResponseV1['events']={status:'unavailable',sourceCheckedAtMs:null,items:[]};
  // 国服官方公告不能作为国际服日程。国际服请求不返回国服活动。
  if(params.region==='cn'){
    const snapshot=await readOfficialCalendarSnapshot(c.env.DB,now);
    if(snapshot){
      try{
        const calendar=await applyCalendarEdits(c.env.DB,snapshot);
        const items=calendar.events.filter(item=>
          item.startsAt!==null&&item.endsAt!==null&&item.endsAt>now
        ).sort((a,b)=>{
          const timeA=a.startsAt!<=now?a.endsAt!:a.startsAt!;
          const timeB=b.startsAt!<=now?b.endsAt!:b.startsAt!;
          return timeA-timeB||a.id.localeCompare(b.id);
        }).slice(0,5).map(item=>({
          id:item.id,title:item.title,startsAtMs:item.startsAt!,endsAtMs:item.endsAt!,
        }));
        events={status:calendar.source.stale?'stale':'ready',
          sourceCheckedAtMs:calendar.source.checkedAtMs,items};
      }catch{/* 未验证的源不得伪装为空活动列表。 */}
    }
  }
  const response:MobileWidgetResponseV1={
    schemaVersion:1,timezone:'Asia/Shanghai',region:params.region,
    generatedAtMs:now,refreshAfterMs:now+15*60_000,staleAfterMs:now+2*60*60_000,
    pvp,fish,events,
  };
  return noStoreJson(c,mobileWidgetResponseV1Schema.parse(response));
});
mobileWidgetRoutes.all('*',methodNotAllowed(['GET']));
