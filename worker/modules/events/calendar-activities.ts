import type {EventCalendarItem} from '@ff14-hub/shared';

// Verified against both official articles: 395032 extends 391233's CardBill campaign.
// Explicit identities avoid merging unrelated editions merely because their titles look alike.
const OFFICIAL_ACTIVITY_UPDATES=[{
  id:'official:391233',title:'月卡启航计划',updates:['official:395032'],
}];

export function mergeOfficialActivityUpdates(events:EventCalendarItem[]):EventCalendarItem[]{
  const result=new Map(events.map(event=>[event.id,event]));
  for(const activity of OFFICIAL_ACTIVITY_UPDATES){
    for(const updateId of activity.updates){
      const update=result.get(updateId);
      if(!update)continue;
      const original=result.get(activity.id);
      result.set(activity.id,{
        ...(original??update),id:activity.id,title:original?.title??activity.title,
        startsAt:original?.startsAt??update.startsAt,
        endsAt:update.endsAt??original?.endsAt??null,
        description:update.description||original?.description||'',
        sourceUrl:update.sourceUrl??original?.sourceUrl??null,
      });
      result.delete(updateId);
    }
  }
  return [...result.values()];
}
