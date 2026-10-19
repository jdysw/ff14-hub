import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PBKDF2_ITERATIONS, issueAdminSession, startAdminSetup, totpForTests, validateAdminCredentials } from '../modules/events/calendar-admin-auth';
import type { EventCalendarResponse } from '@ff14-hub/shared';

const API='https://example.com/api/v1/events';
const AUTH_API='https://example.com/api/v1/admin';
const SITE_API='https://example.com/api/v1/site';
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
  // 仅测试程序从可信进程内直接种入已有 owner；HTTP 从此不提供注册／确认接口。
  const binding=await startAdminSetup(env.DB,INIT_KEY,USER,PASSWORD);
  const code=await currentCode(binding.secret);
  expect(await validateAdminCredentials(env.DB,INIT_KEY,USER,PASSWORD,code,true)).toBe(true);
  const token=await issueAdminSession(env.DB);
  return {token,totpKey:binding.secret};
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
  await env.DB.prepare('DELETE FROM site_admin_settings_audit').run();
  await env.DB.prepare('DELETE FROM site_admin_settings').run();
  await env.DB.prepare('DELETE FROM calendar_admin_audit').run();
  await env.DB.prepare('DELETE FROM calendar_editor_entries').run();
  await env.DB.prepare('DELETE FROM calendar_admin_sessions').run();
  await env.DB.prepare('DELETE FROM calendar_admin_accounts').run();
  await env.DB.prepare('DELETE FROM calendar_admin_rate_limits').run();
  await source();
});

describe('独立管理员账号密码 + TOTP 双因子',()=>{
  it('密码 PBKDF2 单次迭代严格遵守 Cloudflare 生产运行时 100k 上限',()=>{
    expect(ADMIN_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(100_000);
    expect(ADMIN_PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
  });
  it('开户与二次绑定 HTTP 端点完全不可用，唯一已激活 owner 仍可登录',async()=>{
    const forbidden=await SELF.fetch(API+'/admin/setup',{
      method:'POST',headers:{'Content-Type':'application/json','X-Calendar-Setup-Key':INIT_KEY},
      body:JSON.stringify({username:USER,password:PASSWORD}),
    });
    expect([404,405]).toContain(forbidden.status);
    expect([404,405]).toContain((await request('/setup','POST',undefined,{username:USER,password:PASSWORD},true)).status);
    expect([404,405]).toContain((await request('/setup/confirm','POST',undefined,{username:USER,password:PASSWORD,code:'123456'},true)).status);
    expect([404,405]).toContain((await SELF.fetch(API+'/admin/provisioning')).status);
    const {token}=await setupAdmin();
    const row=await env.DB.prepare("SELECT password_hash,password_salt,activated_at FROM calendar_admin_accounts WHERE id='owner'")
      .first<{password_hash:string;password_salt:string;activated_at:number|null}>();
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256-100k-hmac-v2:[a-f0-9]{64}$/);
    expect(row?.password_hash).not.toContain(PASSWORD);
    expect(row?.password_salt).toMatch(/^[a-f0-9]{32}$/);
    expect(row?.activated_at).toBeTypeOf('number');
    expect((await request('/session','GET',token)).status).toBe(200);
    expect((await request('/calendar/items','GET',token)).status).toBe(200);
    expect((await request('/calendar/items','GET','ffh_dev_zzzz')).status).toBe(401);
    expect((await request('/logout','POST',token)).status).toBe(200);
    expect((await request('/session','GET',token)).status).toBe(401);
  });
  it('全站配置仅 owner 可以保存，并公开脱敏后的展示字段',async()=>{
    const published=await SELF.fetch(SITE_API);
    expect(published.status).toBe(200);
    const initial=await published.json<{revision:number;settings:{siteName:string}}>();
    expect(initial.revision).toBe(0);
    expect(initial.settings.siteName).toBe('FF14 Hub');
    expect((await request('/settings','PUT',undefined,{
      expectedRevision:0,settings:{siteName:'新标题',announcement:'维护公告',announcementEnabled:true,homeCalendarEnabled:false},
    })).status).toBe(401);
    const {token}=await setupAdmin();
    const update={expectedRevision:0,settings:{
      siteName:'站点维护',announcement:'今晚维护',announcementEnabled:true,homeCalendarEnabled:false,
    }};
    expect((await request('/settings','PUT',token,update)).status).toBe(200);
    const current=await (await SELF.fetch(SITE_API)).json<{revision:number;settings:{siteName:string;homeCalendarEnabled:boolean}}>();
    expect(current.revision).toBe(1);
    expect(current.settings.siteName).toBe('站点维护');
    expect(current.settings.homeCalendarEnabled).toBe(false);
    expect((await request('/settings','PUT',token,update)).status).toBe(409);
    expect((await request('/settings','PUT',token,{
      expectedRevision:1,settings:{...update.settings,BOOTSTRAP_SECRET:'not allowed'},
    })).status).toBe(422);
    const audit=await env.DB.prepare('SELECT COUNT(*) AS total FROM site_admin_settings_audit').first<{total:number}>();
    expect(audit?.total).toBe(1);
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
    const created=await request('/calendar/items','POST',token,{expectedRevision:0,item:item()});
    expect(created.status).toBe(201);
    const row=await created.json<{id:string;revision:number}>();
    expect(row.id).toMatch(/^manual:/);
    const update=await request('/calendar/items/'+row.id,'PUT',token,{
      expectedRevision:1,item:{...item(),title:'管理员修订活动'},
    });
    expect(update.status).toBe(200);
    const shown=await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>();
    expect(shown.events.some(e=>e.title==='管理员修订活动')).toBe(true);
    expect(await (await SELF.fetch(API+'/calendar.ics')).text()).toContain('管理员修订活动');
    expect((await request('/calendar/items/'+row.id+'/hide','POST',token,{expectedRevision:2})).status).toBe(200);
    const hidden=await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>();
    expect(hidden.events.some(e=>e.id===row.id)).toBe(false);
    expect((await request('/calendar/items/'+row.id+'/restore','POST',token,{expectedRevision:3})).status).toBe(200);
    expect((await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>())
      .events.some(e=>e.id===row.id)).toBe(true);
    const audit=await env.DB.prepare('SELECT COUNT(*) AS total FROM calendar_admin_audit WHERE event_id=?')
      .bind(row.id).first<{total:number}>();
    expect(audit?.total).toBe(4);
    expect((await request('/calendar/items/'+row.id,'PUT',token,{
      expectedRevision:1,item:item(),
    })).status).toBe(409);
  });

  it('官方项目人工覆盖与恢复不改变原始抓取快照',async()=>{
    const {token}=await setupAdmin();
    const edit=await request('/calendar/items/official:123','PUT',token,{
      expectedRevision:0,item:{...item(),title:'守护天节（人工修正）'},
    });
    expect(edit.status).toBe(200);
    expect((await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>())
      .events.find(x=>x.id==='official:123')?.title).toBe('守护天节（人工修正）');
    expect((await request('/calendar/items/official:123/restore','POST',token,{expectedRevision:1})).status).toBe(200);
    expect((await (await SELF.fetch(API+'/calendar')).json<EventCalendarResponse>())
      .events.find(x=>x.id==='official:123')?.title).toBe('守护天节');
    const original=await env.DB.prepare("SELECT payload FROM official_calendar_snapshots WHERE source='cn'")
      .first<{payload:string}>();
    expect(original?.payload).not.toContain('人工修正');
  });
});
