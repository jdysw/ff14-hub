import './setup-d1';
import {env,SELF} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {issueAdminSession} from '../modules/events/calendar-admin-auth';
import {applyCatalogSeed,NAV_CATALOG_SEED,readCatalog} from '../modules/nav/catalog';
import {readGameData,saveGameData} from '../modules/admin/game-data';
import {DEFAULT_GAME_DATA,frontlineAt} from '@ff14-hub/shared';
import {applyCalendarEdits} from '../modules/events/calendar-editor';
let token='';
const request=(path:string,method='GET',body?:unknown,auth=token)=>SELF.fetch('https://example.com/api/v1/admin/'+path,{method,headers:{Authorization:'Bearer '+auth,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
beforeEach(async()=>{
  await env.DB.batch(['admin_content_state','admin_content_audit','site_game_data','site_game_data_history','nav_catalog_audit','nav_catalog_edits','nav_catalog_links','calendar_admin_sessions','calendar_admin_accounts'].map(table=>env.DB.prepare('DELETE FROM '+table)));
  await env.DB.prepare("INSERT INTO calendar_admin_accounts(id,username,password_salt,password_hash,totp_ciphertext,activated_at,created_at) VALUES('owner','owner','fixture','fixture','fixture',1,1)").run();token=await issueAdminSession(env.DB);
});

it('navigation deletion survives reseeding and restore preserves the original record',async()=>{
  await applyCatalogSeed({db:env.DB,now:Date.now()});const id=NAV_CATALOG_SEED[0]!.id;
  const deleted=await request('content-state','PUT',{domain:'navigation',contentId:id,state:'trash',expectedRevision:0});expect(deleted.status).toBe(200);
  await applyCatalogSeed({db:env.DB,now:Date.now()+1});expect((await readCatalog({db:env.DB})).some(entry=>entry.id===id)).toBe(false);
  expect((await request('content-state','PUT',{domain:'navigation',contentId:id,state:'active',expectedRevision:0})).status).toBe(409);
  expect((await request('content-state','PUT',{domain:'navigation',contentId:id,state:'active',expectedRevision:1})).status).toBe(200);
  expect((await readCatalog({db:env.DB})).some(entry=>entry.id===id)).toBe(true);
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
