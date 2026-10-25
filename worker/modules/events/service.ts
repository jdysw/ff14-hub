/** 当前公开活动列表读取；个人活动由浏览器本机数据承担，不再创建工作空间。 */
import {
  EVENT_VERIFICATION_STATUSES,filterEvents,sortEvents,
  type EventPhase,type EventRegion,type EventSortOrder,type EventVerificationStatus,
  type PublicEvent,type PublicEventListResponse,
} from '@ff14-hub/shared';

const PUBLIC_EVENT_COLUMNS='id, region, title, description, starts_at, ends_at, source_url, source_name, verification_status, created_at, updated_at';

interface PublicEventRow {
  readonly id:string;
  readonly region:EventRegion;
  readonly title:string;
  readonly description:string;
  readonly starts_at:number;
  readonly ends_at:number;
  readonly source_url:string;
  readonly source_name:string;
  readonly verification_status:string;
  readonly created_at:number;
  readonly updated_at:number;
}

export interface PublicEventListInput {
  readonly region?:EventRegion|null;
  readonly phase?:EventPhase|null;
  readonly text?:string|null;
  readonly nowMs:number;
  readonly sort?:EventSortOrder;
}

function toPublicEvent(row:PublicEventRow):PublicEvent{
  const verificationStatus:EventVerificationStatus=
    (EVENT_VERIFICATION_STATUSES as readonly string[]).includes(row.verification_status)
      ? row.verification_status as EventVerificationStatus:'unverified';
  return {
    id:row.id,region:row.region,title:row.title,description:row.description,
    startsAt:row.starts_at,endsAt:row.ends_at,sourceUrl:row.source_url,
    sourceName:row.source_name,verificationStatus,
    createdAt:row.created_at,updatedAt:row.updated_at,
  };
}

export async function listPublicEvents(db:D1Database,input:PublicEventListInput):Promise<PublicEventListResponse>{
  const result=await db.prepare(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events`).all<PublicEventRow>();
  const events=sortEvents(filterEvents(result.results.map(toPublicEvent),{
    region:input.region??null,phase:input.phase??null,text:input.text??null,nowMs:input.nowMs,
  }),input.sort??'startsAt');
  return {events,serverTimeMs:input.nowMs};
}
