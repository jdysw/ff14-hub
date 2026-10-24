import {env,SELF} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {issueAdminSession} from '../modules/events/calendar-admin-auth';
import {applyCatalogSeed,NAV_CATALOG_SEED,readCatalog} from '../modules/nav/catalog';
import {contentStates,saveContentState} from '../modules/admin/content-state';
import {readGameData,saveGameData} from '../modules/admin/game-data';
import {DEFAULT_GAME_DATA,frontlineAt} from '@ff14-hub/shared';
import {applyCalendarEdits} from '../modules/events/calendar-editor';
import {checkedJobs,replaceLocalJobs} from '../modules/reminders/local-push';
import {demoFish} from './fixtures/fish';
import {readFish} from '../modules/fish/service';
let token='';
const request=(path:string,method='GET',body?:unknown,auth=token)=>SELF.fetch('https://example.com/api/v1/admin/'+path,{method,headers:{Authorization:'Bearer '+auth,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
beforeEach(async()=>{
  await env.DB.batch(['admin_content_state','admin_content_audit','site_game_data','site_game_data_history','nav_catalog_audit','nav_catalog_edits','nav_catalog_links','calendar_admin_sessions','calendar_admin_accounts'].map(table=>env.DB.prepare('DELETE FROM '+table)));
  await env.DB.prepare("INSERT INTO calendar_admin_accounts(id,username,password_salt,password_hash,totp_ciphertext,activated_at,created_at) VALUES('owner','owner','fixture','fixture','fixture',1,1)").run();token=await issueAdminSession(env.DB);
});
it('requires owner authorization for deletion and game rules, but publishes only validated public data',async()=>{
  expect((await request('content-state','GET',undefined,'')).status).toBe(401);
  expect((await request('game-data','PUT',{expectedRevision:0,data:DEFAULT_GAME_DATA},'')).status).toBe(401);
  const response=await SELF.fetch('https://example.com/api/v1/site/data');expect(response.status).toBe(200);expect(await response.json()).toMatchObject({revision:0,data:DEFAULT_GAME_DATA});
});
it('navigation deletion survives reseeding and restore preserves the original record',async()=>{
  await applyCatalogSeed({db:env.DB,now:Date.now()});const id=NAV_CATALOG_SEED[0]!.id;
  const deleted=await request('content-state','PUT',{domain:'navigation',contentId:id,state:'trash',expectedRevision:0});expect(deleted.status).toBe(200);
  await applyCatalogSeed({db:env.DB,now:Date.now()+1});expect((await readCatalog({db:env.DB})).some(entry=>entry.id===id)).toBe(false);
  expect((await request('content-state','PUT',{domain:'navigation',contentId:id,state:'active',expectedRevision:0})).status).toBe(409);
  expect((await request('content-state','PUT',{domain:'navigation',contentId:id,state:'active',expectedRevision:1})).status).toBe(200);
  expect((await readCatalog({db:env.DB})).some(entry=>entry.id===id)).toBe(true);
});
it('permanent deletion keeps its source tombstone and cannot be restored indirectly',async()=>{
  const input={domain:'calendar' as const,contentId:'official:sample',title:'测试活动'};
  await saveContentState(env.DB,{...input,state:'trash',expectedRevision:0});await saveContentState(env.DB,{...input,state:'deleted',expectedRevision:1});
  await expect(saveContentState(env.DB,{...input,state:'trash',expectedRevision:2})).rejects.toThrow('彻底删除');
  expect((await contentStates(env.DB))[0]?.state).toBe('deleted');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_content_audit').first<{n:number}>())?.n).toBe(2);
});
it('deleted official events stay absent after a refreshed source snapshot',async()=>{
  await saveContentState(env.DB,{domain:'calendar',contentId:'official:sample',title:'样例',state:'trash',expectedRevision:0});
  const result=await applyCalendarEdits(env.DB,{serverTimeMs:1,source:{name:'来源',homeUrl:'https://ff.web.sdo.com/',checkedAtMs:1,stale:false},events:[{id:'official:sample',region:'cn',title:'新的源标题',description:'',category:'测试',location:'',sourceUrl:null,startsAt:1,endsAt:2,allDay:false}]});expect(result.events).toEqual([]);
});
it('restores an official event from its deletion snapshot even after the upstream removes it',async()=>{
  const now=Date.now(),item={id:'official:recycled',region:'cn' as const,title:'来源后续移除的活动',description:'',category:'测试',location:'',sourceUrl:null,startsAt:now,endsAt:now+86400000,allDay:false};
  const calendar={serverTimeMs:now,source:{name:'官网',homeUrl:'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',checkedAtMs:now,stale:false},events:[item]};
  await env.DB.prepare("INSERT OR REPLACE INTO official_calendar_snapshots(source,payload,checked_at_ms) VALUES('cn',?,?)").bind(JSON.stringify(calendar),now).run();
  expect((await request('content-state','PUT',{domain:'calendar',contentId:item.id,state:'trash',expectedRevision:0})).status).toBe(200);
  await env.DB.prepare("UPDATE official_calendar_snapshots SET payload=? WHERE source='cn'").bind(JSON.stringify({...calendar,events:[]})).run();
  expect((await request('content-state','PUT',{domain:'calendar',contentId:item.id,state:'active',expectedRevision:1})).status).toBe(200);
  expect((await applyCalendarEdits(env.DB,{...calendar,events:[]})).events.map(row=>row.title)).toEqual([item.title]);
});
it('publishes versioned rules atomically, rejects stale writers and exposes them to mobile widgets',async()=>{
  const data=structuredClone(DEFAULT_GAME_DATA);data.pvp.version='test-runtime';data.pvp.frontline.maps=['甲','乙'];data.pvp.frontline.anchorIndex=0;
  expect((await saveGameData(env.DB,data,0)).revision).toBe(1);
  await expect(saveGameData(env.DB,DEFAULT_GAME_DATA,0)).rejects.toThrow('版本');
  expect((await readGameData(env.DB)).data.pvp.version).toBe('test-runtime');
  const mobile=await SELF.fetch('https://example.com/api/v1/widgets/v1/summary');expect(mobile.status).toBe(200);const result=await mobile.json<{generatedAtMs:number;pvp:{frontline:{current:string;ruleVersion:string}}}>();
  expect(result.pvp.frontline.current).toBe(frontlineAt(result.generatedAtMs,data.pvp).current);expect(result.pvp.frontline.ruleVersion).toBe('test-runtime');
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM site_game_data_history').first<{n:number}>())?.n).toBe(1);
});
it('keeps long-range todo reminders while preserving shorter public-source limits and supports undo',async()=>{
  const now=Date.now(),due=now+30*86400000;
  const job={key:'todo:test:'+due,title:'未来待办',body:'提醒',dueAt:due,expiresAt:due+600000};
  expect(checkedJobs([job],now)).toHaveLength(1);expect(checkedJobs([{...job,key:'event:public'}],now)).toHaveLength(0);
  await env.DB.prepare("INSERT INTO local_push_devices(id,token_hash,endpoint_hash,channel_ciphertext,expires_at,updated_at) VALUES('test','test','test','test',?,?)").bind(now+90*86400000,now).run();
  await replaceLocalJobs(env.DB,'test',[job],now);await replaceLocalJobs(env.DB,'test',[],now);await replaceLocalJobs(env.DB,'test',[job],now);
  expect((await env.DB.prepare("SELECT status FROM local_push_jobs WHERE device_id='test'").first<{status:string}>())?.status).toBe('queued');
});
it('publishes a new forecast rule to the server catalog with explicit unverified provenance',async()=>{
  const data=structuredClone(DEFAULT_GAME_DATA),rule={...demoFish('cn')[0]!.rule,fishId:90001,validationStatus:'verified' as const};
  data.fish.push({region:'cn',id:90001,fishType:'big',name:'人工修订样例',bait:['鱼饵'],conditions:[],rule,sourceUrl:'https://example.com/source',reason:'测试新增可预测规则'});
  const saved=await saveGameData(env.DB,data,0);expect(saved.revision).toBe(1);
  const record=(await readFish(env.DB,'cn')).find(fish=>fish.id===90001);expect(record?.fishType).toBe('big');expect(record?.rule.validationStatus).toBe('unverified');expect(record?.source.url).toBe('https://example.com/source');expect(record?.source.verificationStatus).toBe('unverified');
  data.fish[0]!.rule=null;await saveGameData(env.DB,data,1);expect((await readFish(env.DB,'cn')).some(fish=>fish.id===90001)).toBe(false);
  const wrongRegion={...data,fish:[{...data.fish[0]!,rule:{...rule,region:'global'}}]};expect((await request('game-data','PUT',{expectedRevision:2,data:wrongRegion})).status).toBe(422);
});
