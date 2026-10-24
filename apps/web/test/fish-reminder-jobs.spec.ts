import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {fishingCatalogSchema,loadFishingCatalog} from '../src/app/fish/catalog';
import type * as CatalogModule from '../src/app/fish/catalog';
import {buildNotificationJobs,defaultNotificationSettings} from '../src/app/local/local-notifications';
import {fishLinkFromJob,parseFishLink} from '../src/app/fish/fish-link';
vi.mock('../src/app/fish/catalog',async importOriginal=>({...await importOriginal<typeof CatalogModule>(),loadFishingCatalog:vi.fn()}));
const source=fishingCatalogSchema.parse(JSON.parse(readFileSync('public/fishing/catalog-cn.json','utf8')) as unknown),original=source.fish.find(f=>f.rule)!;
afterEach(()=>vi.restoreAllMocks());
it('creates honest community-window reminders, preserves a stable identity and honors an individual lead',async()=>{
  const now=Date.UTC(2026,9,23),start=now+8*60000,etHour=175000,startHour=(start%4200000)/etHour;
  const fish={...original,id:1,method:'rod' as const,rule:{...original.rule!,fishId:1,startHour,endHour:(startHour+1)%24,weatherRates:[{weather:'晴',chance:100}],currentWeather:[],previousWeather:[],validationStatus:'unverified' as const,conditions:[{kind:'bait' as const,description:'测试鱼饵'}]}};
  vi.mocked(loadFishingCatalog).mockResolvedValue({...source,fish:[fish]});
  const data={notes:[],fish:{cn:[{fishId:1,field:'alarm',value:true}],global:[]}} as unknown as Parameters<typeof buildNotificationJobs>[0];
  const settings={...defaultNotificationSettings,events:false,fishLeadMinutes:{'cn:1':5}};
  const jobs=await buildNotificationJobs(data,settings,now);expect(jobs[0]?.dueAt).toBe(start-5*60000);expect(jobs[0]?.body).toContain('候选鱼窗');expect(fishLinkFromJob(jobs[0]!.key)).toEqual({region:'cn',fishId:1,windowStartsAt:start});
  const first=(await buildNotificationJobs(data,{...settings,fishLeadMinutes:{}},now))[0]!,second=(await buildNotificationJobs(data,{...settings,fishLeadMinutes:{}},now+1000))[0]!;
  expect(first.dueAt).toBe(now);expect(first.key).toBe(second.key);
  vi.mocked(loadFishingCatalog).mockResolvedValue({...source,fish:[{...fish,rule:{...fish.rule,startHour:0,endHour:24}}]});expect(await buildNotificationJobs(data,settings,now)).toEqual([]);
  vi.mocked(loadFishingCatalog).mockResolvedValue({...source,fish:[{...fish,rule:{...fish.rule,conditions:[{kind:'unknown',description:'未建模条件'}]}}]});expect(await buildNotificationJobs(data,settings,now)).toEqual([]);
});
it('does not turn malformed notification data into external or ambiguous navigation',()=>{
  for(const query of ['view=fish&region=cn&fish=-1','view=fish&region=evil&fish=1','view=fish&region=cn&fish=1&window=NaN','view=fish&region=cn&fish=9007199254740992'])expect(parseFishLink(query)).toBeNull();
  expect(fishLinkFromJob('https://evil.test')).toBeNull();expect(parseFishLink('view=fish&region=global&fish=8754&window=123')).toEqual({region:'global',fishId:8754,windowStartsAt:123});
});
