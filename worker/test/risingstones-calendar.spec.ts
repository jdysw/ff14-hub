import {expect,it,vi} from 'vitest';
import type {EventCalendarResponse} from '@ff14-hub/shared';
import {mergeRisingstonesCalendar,parseRisingstonesCalendar,withRisingstonesCalendar} from '../modules/events/risingstones-calendar';

const item = {id:99,name:'月卡启航计划',url:'https://actff1.web.sdo.com/20260704_CardBill/index.html#/index',begin_time:1784973600,end_time:1801461600};
const payload = {code:10000,data:[item]};

it('preserves the original ID and latest announcement dates when the monthly calendar has not caught up',()=>{
 const addition=parseRisingstonesCalendar(payload)[0]!;
 const original={...addition,title:'月卡启航计划现已开启',description:'官方延期至2027年3月1日14:00',endsAt:Date.UTC(2027,2,1,6)};
 const result=mergeRisingstonesCalendar([original],[addition,addition]);
 expect(result).toEqual([original]);
});

it('keeps maintenance conditions, retains other activities, and fills genuinely missing dates',()=>{
 const magic=parseRisingstonesCalendar({code:10000,data:[{...item,id:102,name:'FF7联动-魔光键影'}]})[0]!;
 const original={...magic,endsAt:null,description:'活动结束条件：8.0版本更新维护前'};
 const other={...magic,id:'official:another',sourceUrl:null};
 expect(mergeRisingstonesCalendar([original,other],[magic])).toEqual([original,other]);
 expect(mergeRisingstonesCalendar([{...magic,startsAt:null,endsAt:null,description:'等待时间'}],[magic])[0])
  .toMatchObject({startsAt:magic.startsAt,endsAt:magic.endsAt});
});

it('deduplicates exact landing URLs and refreshes entries that came only from the monthly calendar',()=>{
 const event=parseRisingstonesCalendar({code:10000,data:[{...item,id:500}]})[0]!;
 const original={...event,id:'official:news-500',description:'公告时间已确认'};
 expect(mergeRisingstonesCalendar([original],[event])).toEqual([original]);
 const revised={...event,endsAt:event.endsAt!+86400000};
 expect(mergeRisingstonesCalendar([event],[revised])).toEqual([revised]);
 const second={...event,id:'official:separate',sourceUrl:'https://ff.web.sdo.com/news?id=2'};
 expect(mergeRisingstonesCalendar([{...original,sourceUrl:'https://ff.web.sdo.com/news?id=1'}],[second])).toHaveLength(2);
});

it('rejects invalid response codes, reversed dates, and non-official or credential-bearing links',()=>{
 expect(()=>parseRisingstonesCalendar({code:10001,data:[]})).toThrow();
 for(const url of ['https://evil.invalid/','https://user:password@ff.web.sdo.com/','http://ff.web.sdo.com/']) {
  expect(()=>parseRisingstonesCalendar({code:10000,data:[{...item,url}]})).toThrow();
 }
 expect(()=>parseRisingstonesCalendar({code:10000,data:[{...item,end_time:item.begin_time-1}]})).toThrow();
});

it('loads this and next China-calendar month once, rolls across years, and preserves data and timestamps on failure',async()=>{
 const now=Date.UTC(2026,11,31,14);
 const calendar:EventCalendarResponse={events:[],serverTimeMs:now,source:{name:'官方公告',homeUrl:'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',checkedAtMs:now,stale:false}};
 const fetcher=vi.fn((input:string,init:RequestInit)=>{
  const request=new Request(input,init);
  expect(request.redirect).toBe('manual');
  return Promise.resolve(Response.json(payload));
 });
 vi.stubGlobal('fetch',fetcher);
 try {
  const result=await withRisingstonesCalendar(calendar,now);
  expect(result.events).toHaveLength(1);
  expect(result.source.stale).toBe(false);
  expect(fetcher.mock.calls.map(([url])=>new URL(url).searchParams.get('month'))).toEqual(['2026-12','2027-01']);
  await withRisingstonesCalendar(calendar,now+1000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockRejectedValue(new Error('offline'));
  const fallback=await withRisingstonesCalendar(calendar,now+3600001);
  expect(fallback.events).toEqual(result.events);
  expect(fallback.source).toMatchObject({stale:true,checkedAtMs:now});
  await withRisingstonesCalendar(calendar,now+3601000);
  expect(fetcher).toHaveBeenCalledTimes(4);
  fetcher.mockImplementation(()=>Promise.resolve(Response.json(payload)));
  await withRisingstonesCalendar(calendar,Date.UTC(2026,11,31,16));
  expect(fetcher.mock.calls.slice(-2).map(([url])=>new URL(url).searchParams.get('month'))).toEqual(['2027-01','2027-02']);
 } finally {vi.unstubAllGlobals();}
});
