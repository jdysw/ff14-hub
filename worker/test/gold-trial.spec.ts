import {expect,it,vi} from 'vitest';
import {type EventCalendarResponse} from '@ff14-hub/shared';
import {parseGoldTrial,withGoldTrial} from '../modules/events/gold-trial';
const active={ActiveID:'20261030',ActiveName:'87',StartTime_Terri:'2026/10/30 13:00:00',EndTime_Terri:'2026/11/1 23:59:59',StartTime_Reward:'2026/10/30 13:00:00',EndTime_Reward:'2026/11/5 13:00:00',StartTime_Result:'2026/11/5 13:00:00'};
it('uses official challenge and registration dates independently instead of inventing weekly periods',()=>{
 const events=parseGoldTrial({result:'1',currentActive:active,nextActive:{ActiveID:''}});
 expect(events).toHaveLength(2);
 expect(events[0]?.endsAt).toBe(Date.UTC(2026,10,1,15,59,59));
 expect(events[1]?.endsAt).toBe(Date.UTC(2026,10,5,5));
 expect(events[1]?.title).toContain('第87期 · 试炼登记期');
 expect(events[0]?.id).not.toBe(events[1]?.id);
});
it('keeps verified future configurations and does not follow signed configuration URLs',()=>{
 const next={...active,ActiveID:'20261106',ActiveName:'88',StartTime_Terri:'2026/11/6 13:00:00',EndTime_Terri:'2026/11/8 23:59:59',StartTime_Reward:'2026/11/6 13:00:00',EndTime_Reward:'2026/11/12 13:00:00'};
 const events=parseGoldTrial({result:'1',currentActive:active,nextActive:next,configURL:'https://untrusted.invalid/config'});
 expect(events).toHaveLength(4);expect(events.every(event=>event.sourceUrl?.startsWith('https://actff1.web.sdo.com/'))).toBe(true);
});
it('rejects bad dates and failed upstream responses',()=>{
 expect(()=>parseGoldTrial({result:'0'})).toThrow();
 expect(()=>parseGoldTrial({result:'1',currentActive:{...active,StartTime_Terri:'2026/2/30 13:00:00'}})).toThrow();
 expect(()=>parseGoldTrial({result:'1',currentActive:{...active,EndTime_Reward:'2026/10/1 13:00:00'}})).toThrow();
});
it('caches anonymous public phases and preserves primary data and last known phases on failure',async()=>{
 const payload={result:'1',currentActive:active,configURL:'https://untrusted.invalid/private',PlayerAccount:'not-for-clients'};
 const fetcher=vi.fn().mockImplementation((input:RequestInfo,init?:RequestInit)=>{
  // Exercise workerd's Request validation even when the upstream is mocked.
  const request=new Request(input,init);
  expect(request.redirect).toBe('manual');
  return Promise.resolve(Response.json(payload));
 });
 vi.stubGlobal('fetch',fetcher);
 const base:EventCalendarResponse={events:[],serverTimeMs:1,source:{name:'官方公告',homeUrl:'https://ff.web.sdo.com/',checkedAtMs:1,stale:false}};
 try{
  const initial=await withGoldTrial(base);expect(initial.events).toHaveLength(2);expect(initial.source.stale).toBe(false);
  expect(JSON.stringify(initial)).not.toContain('not-for-clients');expect(JSON.stringify(initial)).not.toContain('untrusted.invalid');
  await withGoldTrial(base);expect(fetcher).toHaveBeenCalledTimes(1);
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+16*60_000);
  fetcher.mockResolvedValue(new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/redirect'}}));
  const redirected=await withGoldTrial(base);
  expect(redirected.events).toHaveLength(2);expect(redirected.source.stale).toBe(true);
  await withGoldTrial(base);expect(fetcher).toHaveBeenCalledTimes(2);
  vi.spyOn(Date,'now').mockReturnValue(now+18*60_000);
  fetcher.mockRejectedValue(new Error('offline'));
  const fallback=await withGoldTrial({...base,events:[initial.events[0]!]});
  expect(fallback.events).toHaveLength(2);expect(fallback.source.stale).toBe(true);
  expect(fallback.source.checkedAtMs).toBe(1);
 }finally{vi.restoreAllMocks();vi.unstubAllGlobals();}
});
