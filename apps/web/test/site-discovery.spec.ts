import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {searchSite} from '../src/app/local/site-search';
import {planFish,planEvents,chinaDayEnd} from '../src/app/local/today-plan';
import {localDataSchema,type LocalData} from '../src/app/local/store';
import {mergePersonalData,remoteFailureMessage,RemoteSyncError} from '../src/app/local/remote-sync';
import {fishingCatalogSchema} from '../src/app/fish/catalog';
import type {BrowserLink} from '../src/app/local/directory-links';
import type {EventCalendarItem} from '@ff14-hub/shared';
const catalog=fishingCatalogSchema.parse(JSON.parse(readFileSync('public/fishing/catalog-cn.json','utf8')) as unknown),base=catalog.fish.find(f=>f.rule)!;
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]});
it('searches aliases and bait locally, normalizes width/case, and ranks an exact fish before a partial name',()=>{
  const links=[{id:'1',title:'工具',url:'https://example.com',category:'导航',description:'',tags:['攻略'],aliases:['ＦＦ１４'],favorite:true,personal:true,region:'cn'}] as BrowserLink[];
  const fish=[{...base,name:'涅普特龙之谜',id:2,bait:['极地磷虾']},{...base,name:'涅普特龙',id:3,bait:['极地磷虾']}];
  expect(searchSite('ff14',links,[],[]).links).toHaveLength(1);expect(searchSite('涅普特龙',[],fish,[]).fish[0]?.id).toBe(3);
  expect(searchSite('极地 磷虾',[],fish,[]).fish).toHaveLength(2);expect(searchSite('备份',[],[],[]).features[0]?.id).toBe('backup');
});
it('plans every finite occurrence until China midnight without the board preview limit, excluding caught fish and deduplicating follows',()=>{
  const now=Date.parse('2026-10-23T16:00:00Z');
  const fish={...base,id:1,method:'rod' as const,rule:{...base.rule!,fishId:1,startHour:1,endHour:3,weatherRates:[{weather:'晴',chance:100}],currentWeather:[],previousWeather:[]}};
  const fields=[{region:'cn' as const,fishId:1,field:'pinned' as const,value:true,revision:1,updatedAt:1},{region:'cn' as const,fishId:1,field:'alarm' as const,value:true,revision:1,updatedAt:1}];
  const result=planFish([fish],fields,'cn',now);expect(result.watched).toBe(1);expect(result.rows.length).toBeGreaterThan(12);expect(result.rows.every(row=>row.startsAt<chinaDayEnd(now)&&row.endsAt>now)).toBe(true);
  expect(chinaDayEnd(now)).toBe(Date.parse('2026-10-24T16:00:00Z'));
  expect(planFish([fish],[...fields,{...fields[0]!,field:'caught' as const}],'cn',now).rows).toEqual([]);
  expect(planFish([{...fish,rule:{...fish.rule,startHour:0,endHour:24}}],fields,'cn',now)).toMatchObject({rows:[],unrestricted:1});
});
it('activity plan excludes unknown, ended and tomorrow-only events and respects the China day',()=>{
  const now=Date.parse('2026-10-23T15:00:00Z'),end=chinaDayEnd(now);
  const event={id:'one',title:'活动',region:'cn',category:'',startsAt:now-1,endsAt:now+1000,description:'',sourceUrl:null,location:'',allDay:false} as EventCalendarItem;
  expect(planEvents([event,{...event,id:'unknown',startsAt:null},{...event,id:'ended',endsAt:now-1},{...event,id:'tomorrow',startsAt:end,endsAt:end+1000}],now).map(e=>e.id)).toEqual(['one']);
});
it('old note backups remain valid and completed notes survive merge without resetting other personal data',()=>{
  const original={...empty(),notes:[{id:crypto.randomUUID(),title:'周常',text:'备忘'}]};expect(localDataSchema.parse(original).notes[0]?.completed).toBeUndefined();
  const remote={...original,notes:[{...original.notes[0]!,completed:true}]};expect(mergePersonalData(original,original,remote).data.notes[0]?.completed).toBe(true);
});
it('diagnostics distinguish actionable failures and never echo arbitrary exception text',()=>{
  expect(remoteFailureMessage(new RemoteSyncError('auth','账号权限检查失败'))).toBe('账号权限检查失败');
  expect(remoteFailureMessage(new Error('secret-token-must-not-show'))).not.toContain('secret-token');
});
