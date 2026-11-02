import {expect,it} from 'vitest';
import type {EventCalendarItem} from '@ff14-hub/shared';
import {mergeOfficialActivityUpdates} from '../modules/events/calendar-activities';

const original:EventCalendarItem={
 id:'official:391233',region:'cn',title:'特惠专享 畅玩无忧！月卡启航计划现已开启！',
 description:'原活动介绍',category:'月卡与商城',location:'',allDay:false,
 startsAt:Date.UTC(2026,6,25,10),endsAt:Date.UTC(2027,1,1,6),
 sourceUrl:'https://ff.web.sdo.com/web8/index.html#/newstab/newscont/391233',
};
const extension:EventCalendarItem={...original,id:'official:395032',
 title:'特惠专享 畅玩无忧！月卡启航计划活动时间延长公告',
 description:'活动时间延长至2027年3月1日14:00',endsAt:Date.UTC(2027,2,1,6),
 sourceUrl:'https://ff.web.sdo.com/web8/index.html#/newstab/newscont/395032',
};
it('merges the verified extension into its original identity regardless of feed order',()=>{
 for(const events of [[original,extension],[extension,original]]){
  const result=mergeOfficialActivityUpdates(events);
  expect(result).toEqual([{...original,endsAt:extension.endsAt,description:extension.description,sourceUrl:extension.sourceUrl}]);
  expect(mergeOfficialActivityUpdates(result)).toEqual(result);
 }
 expect(original.endsAt).toBe(Date.UTC(2027,1,1,6));
});
it('keeps the same campaign identity when the original announcement leaves the news feed',()=>{
 expect(mergeOfficialActivityUpdates([extension])).toEqual([{...extension,id:original.id,title:'月卡启航计划'}]);
});
it('preserves known dates when an update has no confirmed schedule',()=>{
 const result=mergeOfficialActivityUpdates([original,{...extension,startsAt:null,endsAt:null}]);
 expect(result[0]?.startsAt).toBe(original.startsAt);expect(result[0]?.endsAt).toBe(original.endsAt);
});
it('uses the amended ending even if a later correction shortens the activity',()=>{
 const endsAt=Date.UTC(2026,11,1,6);
 expect(mergeOfficialActivityUpdates([original,{...extension,endsAt}])[0]?.endsAt).toBe(endsAt);
});
it('does not infer identity from similar titles, equal times, categories or manual entries',()=>{
 const other={...extension,id:'official:another-edition'};
 const manual={...extension,id:'manual:sample'};
 expect(mergeOfficialActivityUpdates([original,other,manual])).toEqual([original,other,manual]);
});
