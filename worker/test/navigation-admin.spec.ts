import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalNavUrl, directoryItemSchema, type DirectoryRecord, type NavCatalogEntry } from '@ff14-hub/shared';
import { issueAdminSession, revokeAdminSession } from '../modules/events/calendar-admin-auth';
import { applyCatalogSeed, NAV_CATALOG_SEED } from '../modules/nav/catalog';

const URL='https://example.com/api/v1/admin/navigation/items';
let token='';
const call=(method='GET',suffix='',body?:unknown,credential:string|undefined=token)=>SELF.fetch(URL+suffix,{
  method,headers:{...(credential?{Authorization:'Bearer '+credential}:{}),...(body?{'Content-Type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),
});
async function records(){const response=await call();expect(response.status).toBe(200);return (await response.json<{records:DirectoryRecord[]}>()).records;}
async function published(){const response=await SELF.fetch('https://example.com/api/v1/navigation/catalog');expect(response.status).toBe(200);return (await response.json<{entries:NavCatalogEntry[]}>()).entries;}
const item=()=>({title:'测试网站',url:'https://example.org/tool',description:'测试说明',category:'测试分类',tags:['标签'],aliases:['别名'],icon:'🔗',openMode:'new_tab',region:'cn',sortOrder:1});

beforeEach(async()=>{
  await env.DB.batch(['DELETE FROM nav_catalog_audit','DELETE FROM nav_catalog_edits','DELETE FROM nav_catalog_links',
    'DELETE FROM calendar_admin_sessions','DELETE FROM calendar_admin_accounts'].map(sql=>env.DB.prepare(sql)));
  // Trusted test fixture only; no HTTP provisioning endpoint is introduced.
  await env.DB.prepare(`INSERT INTO calendar_admin_accounts(id,username,password_salt,password_hash,totp_ciphertext,activated_at,created_at)
    VALUES('owner','test-owner','fixture','fixture','fixture',1,1)`).run();
  token=await issueAdminSession(env.DB);
});

describe('系统网站目录 owner 管理',()=>{
  it('匿名、普通设备凭证以及撤销后的管理员会话均不能读写管理目录',async()=>{
    for(const credential of ['', 'ffh_dev_not-an-admin']){
      expect((await call('GET','',undefined,credential)).status).toBe(401);
      expect((await call('POST','',{expectedRevision:0,item:item()},credential)).status).toBe(401);
      expect((await call('POST','/some-id/hide',{expectedRevision:0},credential)).status).toBe(401);
    }
    await revokeAdminSession(env.DB,'Bearer '+token);
    expect((await call()).status).toBe(401);
  });
  it('新增、编辑、刷新、下架、再次应用种子与恢复均真实持久化，审计留痕',async()=>{
    const created=await call('POST','',{expectedRevision:0,item:item()});expect(created.status).toBe(201);
    const first=await created.json<DirectoryRecord>();
    expect(first.revision).toBe(1);
    expect((await published()).find(entry=>entry.id===first.entry.id)?.title).toBe('测试网站');
    expect((await records()).find(record=>record.entry.id===first.entry.id)?.revision).toBe(1);
    const edited=await call('PUT','/'+first.entry.id,{expectedRevision:1,item:{...item(),title:'已改名',aliases:['别称搜索']}});
    expect(edited.status).toBe(200);
    expect((await published()).find(entry=>entry.id===first.entry.id)?.aliases).toEqual(['别称搜索']);
    expect((await call('POST','/'+first.entry.id+'/hide',{expectedRevision:2})).status).toBe(200);
    await applyCatalogSeed({db:env.DB,now:Date.now()});
    expect((await published()).some(entry=>entry.id===first.entry.id)).toBe(false);
    const hidden=(await records()).find(record=>record.entry.id===first.entry.id);expect(hidden?.hidden).toBe(true);
    expect((await call('POST','/'+first.entry.id+'/restore',{expectedRevision:3})).status).toBe(200);
    expect((await published()).find(entry=>entry.id===first.entry.id)?.title).toBe('已改名');
    const audit=await env.DB.prepare('SELECT COUNT(*) AS n FROM nav_catalog_audit WHERE catalog_id=?').bind(first.entry.id).first<{n:number}>();
    expect(audit?.n).toBe(4);
  });
  it('种子条目的编辑/下架不会被读取、种子升级或目录导入复活',async()=>{
    const original=(await records())[0]!;const body=directoryItemSchema.strip().parse(original.entry);
    expect((await call('PUT','/'+original.entry.id,{expectedRevision:0,item:{...body,title:'站长修订'}})).status).toBe(200);
    await env.DB.prepare('UPDATE nav_catalog_links SET source_version=1,title=? WHERE id=?').bind('旧源标题',original.entry.id).run();
    await applyCatalogSeed({db:env.DB,now:Date.now()});
    expect((await published()).find(entry=>entry.id===original.entry.id)?.title).toBe('站长修订');
    expect((await call('POST','/'+original.entry.id+'/hide',{expectedRevision:1})).status).toBe(200);
    await applyCatalogSeed({db:env.DB,now:Date.now()});
    expect((await published()).some(entry=>entry.id===original.entry.id)).toBe(false);
  });
  it('重复网址、隐藏条目的重复创建与过期修订被拒绝，同站不同功能入口仍可保存',async()=>{
    const response=await call('POST','',{expectedRevision:0,item:item()});const first=await response.json<DirectoryRecord>();
    const duplicate=await call('POST','',{expectedRevision:0,item:{...item(),url:item().url+'?utm_source=test'}});
    expect(duplicate.status).toBe(409);
    expect((await call('PUT','/'+first.entry.id,{expectedRevision:0,item:item()})).status).toBe(409);
    expect((await call('POST','/'+first.entry.id+'/hide',{expectedRevision:1})).status).toBe(200);
    expect((await call('POST','',{expectedRevision:0,item:item()})).status).toBe(409);
    expect((await call('POST','',{expectedRevision:0,item:{...item(),url:'https://example.org/other#route'}})).status).toBe(201);
    const candidates=await Promise.all([call('POST','',{expectedRevision:0,item:{...item(),url:'https://example.org/race'}}),call('POST','',{expectedRevision:0,item:{...item(),url:'https://example.org/race'}})]);
    expect(candidates.map(result=>result.status).sort()).toEqual([201,409]);
  });
  it('源快照无重复 URL，重复导入不改变行数，输入拒绝脚本网址及额外敏感字段',async()=>{
    const urls=NAV_CATALOG_SEED.map(entry=>canonicalNavUrl(entry.url));expect(new Set(urls).size).toBe(urls.length);
    const first=await applyCatalogSeed({db:env.DB,now:Date.now()});
    const next=await applyCatalogSeed({db:env.DB,now:Date.now()});expect(first.entryCount).toBeGreaterThan(100);expect(next.changedRows).toBe(0);
    expect((await call('POST','',{expectedRevision:0,item:{...item(),url:'javascript:alert(1)'}})).status).toBe(422);
    expect((await call('POST','',{expectedRevision:0,item:{...item(),workspaceId:'foreign'}})).status).toBe(422);
    const existing=NAV_CATALOG_SEED[0]!;
    expect((await call('POST','',{expectedRevision:0,item:{...item(),url:existing.url}})).status).toBe(409);
  });
});
