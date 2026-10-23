import {eventCalendarResponseSchema,type EventCalendarResponse} from '@ff14-hub/shared';
let cached:{value:EventCalendarResponse;at:number}|undefined;
let pending:Promise<EventCalendarResponse>|undefined;
/** Share public reads between discovery panels; the server owns official-source polling. */
export function loadPublicCalendar():Promise<EventCalendarResponse>{
  if(cached&&Date.now()-cached.at<60_000)return Promise.resolve(cached.value);
  return pending??=fetch('/api/v1/events/calendar',{credentials:'omit',cache:'no-store',redirect:'error'})
    .then(async response=>{if(!response.ok)throw new Error('活动数据暂不可用');const value=eventCalendarResponseSchema.parse(await response.json());cached={value,at:Date.now()};return value;})
    .finally(()=>{pending=undefined;});
}
