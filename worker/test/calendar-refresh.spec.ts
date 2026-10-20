import {env} from 'cloudflare:test';
import {beforeEach,expect,it,vi} from 'vitest';
import type {EventCalendarResponse} from '@ff14-hub/shared';
import {refreshOfficialCalendarSnapshot,storeOfficialCalendarSnapshot} from '../modules/events/calendar-refresh';
import {readOfficialCalendarSnapshot} from '../modules/events/calendar-snapshot';

function feed(checkedAtMs=Date.now()):EventCalendarResponse{
  return {serverTimeMs:checkedAtMs,source:{name:'盛趣官方公告',homeUrl:'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',checkedAtMs,stale:false},events:[{
    id:'official:refresh-test',title:'官方活动',region:'cn',category:'活动',description:'',location:'',startsAt:checkedAtMs-1000,endsAt:checkedAtMs+86400000,sourceUrl:'https://ff.web.sdo.com/web8/index.html',allDay:false,
  }]};
}
beforeEach(async()=>{
  await env.DB.prepare("DELETE FROM official_calendar_snapshots WHERE source='cn'").run();
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE scope_key='public-calendar:official-refresh:cn'").run();
});
it('refreshes the durable official snapshot once for simultaneous readers',async()=>{
  const load=vi.fn(()=>Promise.resolve(feed()));
  const results=await Promise.all([refreshOfficialCalendarSnapshot(env.DB,Date.now(),load),refreshOfficialCalendarSnapshot(env.DB,Date.now(),load)]);
  expect(results.filter(Boolean)).toHaveLength(1);expect(load).toHaveBeenCalledOnce();
  expect((await readOfficialCalendarSnapshot(env.DB))?.events[0]?.title).toBe('官方活动');
  expect(await refreshOfficialCalendarSnapshot(env.DB,Date.now(),load)).toBe(false);expect(load).toHaveBeenCalledOnce();
});
it('preserves the last verified timestamp and data after an upstream failure',async()=>{
  const original=feed();await storeOfficialCalendarSnapshot(env.DB,original);
  const load=vi.fn(()=>Promise.reject(new Error('official origin unavailable')));
  expect(await refreshOfficialCalendarSnapshot(env.DB,Date.now(),load)).toBe(false);
  const saved=await readOfficialCalendarSnapshot(env.DB);
  expect(saved?.source.checkedAtMs).toBe(original.source.checkedAtMs);expect(saved?.events).toEqual(original.events);
});
it('keeps the shared automatic quota closed for six hours but permits an owner force refresh',async()=>{
  const load=vi.fn(()=>Promise.resolve(feed()));
  expect(await refreshOfficialCalendarSnapshot(env.DB,Date.now(),load)).toBe(true);
  await env.DB.prepare("UPDATE auth_rate_limits SET window_start=? WHERE scope_key='public-calendar:official-refresh:cn'")
    .bind(Date.now()-5*60_000).run();
  expect(await refreshOfficialCalendarSnapshot(env.DB,Date.now(),load)).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  expect(await refreshOfficialCalendarSnapshot(env.DB,Date.now(),load,true)).toBe(true);
  expect(load.mock.calls.at(-1)).toEqual([expect.any(Number),expect.any(AbortSignal),true]);
  await env.DB.prepare("UPDATE auth_rate_limits SET window_start=? WHERE scope_key='public-calendar:official-refresh:cn'")
    .bind(Date.now()-6*60*60_000-1).run();
  expect(await refreshOfficialCalendarSnapshot(env.DB,Date.now(),load)).toBe(true);
  expect(load).toHaveBeenCalledTimes(3);
});
it('does not overwrite a snapshot with empty, partial, private or out-of-order content',async()=>{
  const now=Date.now(),original=feed(now);await storeOfficialCalendarSnapshot(env.DB,original,now);
  expect(await storeOfficialCalendarSnapshot(env.DB,{...original,events:[]},now)).toBe(false);
  expect(await storeOfficialCalendarSnapshot(env.DB,{...original,source:{...original.source,stale:true}},now)).toBe(false);
  expect(await storeOfficialCalendarSnapshot(env.DB,{...original,events:[{...original.events[0]!,id:'private:1'}]},now)).toBe(false);
  expect(await storeOfficialCalendarSnapshot(env.DB,feed(now-1000),now)).toBe(false);
  expect((await readOfficialCalendarSnapshot(env.DB))?.source.checkedAtMs).toBe(now);
});
