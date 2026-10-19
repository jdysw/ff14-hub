import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { totpForTests } from '../modules/events/calendar-admin-auth';
import type { EventCalendarResponse } from '@ff14-hub/shared';

const API='https://example.com/api/v1/events';
const AUTH_API=API+'/admin';
const INIT_KEY='test-only-bootstrap-secret-value-0123456789';
const PASSWORD='SecurePassword-for-tests-only-2026!';
const USER='site_owner';

function base32Bytes(text:string):Uint8Array {
  const alpha='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits=0,buf=0;const result:number[]=[];
  for (const char of text.toUpperCase()) {
    const digit=alpha.indexOf(char);
    if(digit<0)throw new Error('invalid test base32');
    buf=(buf<<5)|digit;bits+=5;
    if(bits>=8){bits-=8;result.push((buf>>bits)&255);}
  }
  return Uint8Array.from(result);
}
function currentCode(key:string,offset=0){
  return totpForTests(base32Bytes(key),Date.now()+offset*30_000);
}
function request(path:string,method='GET',token?:string,body?:unknown,setup=false) {
  return SELF.fetch(AUTH_API+path,{
    method,
    headers:{
      ...(token?{Authorization:'Bearer '+token}:{}),
      ...(body?{'Content-Type':'application/json'}:{}),
      ...(setup?{'X-Calendar-Setup-Key':INIT_KEY}:{}),
    },
    ...(body?{body:JSON.stringify(body)}:{}),
  });
}
async function setupAdmin() {
  const setup=await request('/setup','POST',undefined,{username:USER,password:PASSWORD},true);
  expect(setup.status).toBe(201);
  const {totpKey}=await setup.json<{totpKey:string}>();
  const code=await currentCode(totpKey);
  const confirmed=await request('/setup/confirm','POST',undefined,{
    username:USER,password:PASSWORD,code,
  },true);
  expect(confirmed.status).toBe(200);
  const {token}=await confirmed.json<{token:string}>();
  return {token,totpKey};
}
function item() {
  const now=Date.now();
  return {title:'管理员新增联动',description:'手动活动',category:'限时联动',
    location:'',startsAt:now,endsAt:now+86_400_000,
    sourceUrl:'https://ff.web.sdo.com/web8/index.html',allDay:false};
}
async function source() {
  const now=Date.now();
  const official:EventCalendarResponse={
    serverTimeMs:now,source:{
      name:'盛趣游戏 · FF14 国服官方公告',
      homeUrl:'https://ff.web.sdo.com/web8/index.html#/newstab/newslist',
      checkedAtMs:now,stale:false,
    },
    events:[{id:'official:123',region:'cn',title:'守护天节',category:'季节活动',
      description:'',location:'',startsAt:now-60_000,endsAt:now+86_400_000,
      allDay:false,sourceUrl:'https://ff.web.sdo.com/web8/index.html'}],
  };
  await env.DB.prepare("INSERT INTO official_calendar_snapshots (source,payload,checked_at_ms) VALUES('cn',?,?) ON CONFLICT(source) DO UPDATE SET payload=excluded.payload,checked_at_ms=excluded.checked_at_ms")
    .bind(JSON.stringify(official),now).run();
}
beforeEach(async()=>{
  await env.DB.prepare('DELETE FROM calendar_admin_audit').run();
  await env.DB.prepare('DELETE FROM calendar_editor_entries').run();
  await env.DB.prepare('DELETE FROM calendar_admin_sessions').run();
  await env.DB.prepare('DELETE FROM calendar_admin_accounts').run();
  await env.DB.prepare('DELETE FROM calendar_admin_rate_limits').run();
  await source();
});

describe('独立管理员账号密码 + TOTP 双因子',()=>{
  it('拒绝匿名和工作空间设备令牌，只有一次性安全初始化可绑定 TOTP',async()=>{
    expect((await request('/status')).status).toBe(401);
    expect((await request('/items')).status).toBe(401);
    expect((await request('/setup','POST',undefined,{username:USER,password:PASSWORD})).status).toBe(401);
    const {token,totpKey}=await setupAdmin();
    expect(totpKey.length).toBeGreaterThanOrEqual(32);
    expect((await request('/status','GET',token)).status).toBe(200);
    expect((await request('/setup','POST',undefined,{username:'other',password:PASSWORD},true)).status).toBe(409);
    expect((await request('/status','GET','ffh_dev_zzzz')).status).toBe(401);
    expect((await SELF.fetch(API+'/calendar')).status).toBe(200);
    expect((await request('/logout','POST',token)).status).toBe(200);
    expect((await request('/status','GET',token)).status).toBe(401);
  });

  it('账户口令、TOTP 两个因素都必需，动态验证码不允许重放',async()=>{
    const {totpKey}=await setupAdmin();
    const future=await currentCode(totpKey,1);
    expect((await request('/login','POST',undefined,{
      username:USER,password:'invalid-password',code:future,
    })).status).toBe(401);
    expect((await request('/login','POST',undefined,{
      username:USER,password:PASSWORD,code:'000000',
    })).status).toBe(401);
    const logged=await request('/login','POST',undefined,{
      username:USER,password:PASSWORD,code:future,
    });
    expect(logged.status).toBe(200);
    const replay=await request('/login','POST',undefined,{
      username:USER,password:PASSWORD,code:future,
    });
    expect(replay.status).toBe(401);
  });

  it('管理员增删改恢复实时反映在公共日历与 ICS，数据源未污染，含审计',async()=>{
    const {token}=await setupAdmin();
    const created=await request('/items','POST',token,{expectedRevision:0,item:item()});
    expect(created.status).toBe(201);
    const row=await created.json<{id:string;revision:number}>();
    expect(row.id).toMatch(/^manual:/);
    const update=await request('/items/'+row.id,'PUT',token,{
      expectedRevision:1,item:{...item(),title:'管理员修订活动'},
    });
    expect(update.status).toBe(200);
    const shown=await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>();
    expect(shown.events.some(e=>e.title==='管理员修订活动')).toBe(true);
    expect(await (await SELF.fetch(API+'/calendar.ics')).text()).toContain('管理员修订活动');
    expect((await request('/items/'+row.id+'/hide','POST',token,{expectedRevision:2})).status).toBe(200);
    const hidden=await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>();
    expect(hidden.events.some(e=>e.id===row.id)).toBe(false);
    expect((await request('/items/'+row.id+'/restore','POST',token,{expectedRevision:3})).status).toBe(200);
    expect((await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>())
      .events.some(e=>e.id===row.id)).toBe(true);
    const audit=await env.DB.prepare('SELECT COUNT(*) AS total FROM calendar_admin_audit WHERE event_id=?')
      .bind(row.id).first<{total:number}>();
    expect(audit?.total).toBe(4);
    expect((await request('/items/'+row.id,'PUT',token,{
      expectedRevision:1,item:item(),
    })).status).toBe(409);
  });

  it('官方项目人工覆盖与恢复不改变原始抓取快照',async()=>{
    const {token}=await setupAdmin();
    const edit=await request('/items/official:123','PUT',token,{
      expectedRevision:0,item:{...item(),title:'守护天节（人工修正）'},
    });
    expect(edit.status).toBe(200);
    expect((await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>())
      .events.find(x=>x.id==='official:123')?.title).toBe('守护天节（人工修正）');
    expect((await request('/items/official:123/restore','POST',token,{expectedRevision:1})).status).toBe(200);
    expect((await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>())
      .events.find(x=>x.id==='official:123')?.title).toBe('守护天节');
    const original=await env.DB.prepare("SELECT payload FROM official_calendar_snapshots WHERE source='cn'")
      .first<{payload:string}>();
    expect(original?.payload).not.toContain('人工修正');
  });
});
