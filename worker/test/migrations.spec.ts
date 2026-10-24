/**
 * 单用户 D1 初始基线回归。真实 workerd/D1；从空数据库应用 migrations/0001_core.sql。
 * 不再要求旧设备、工作空间、服务器端工作台和旧通知表存在。
 */
import {applyD1Migrations,env} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';

const LIVE_TABLES=[
  'auth_rate_limits','nav_catalog_links','events','fish_catalog',
  'official_calendar_snapshots','calendar_admin_accounts','calendar_admin_sessions',
  'calendar_admin_rate_limits','calendar_editor_entries','calendar_admin_audit',
  'site_admin_settings','site_admin_settings_audit','nav_catalog_edits','nav_catalog_audit',
  'local_push_devices','local_push_jobs',
] as const;
const RETIRED_TABLES=[
  'workspaces','devices','device_pairings','identity_audit','workspace_bootstrap_guard',
  'workspace_modules','workspace_events','workspace_nav_links','workspace_nav_groups',
  'workspace_nav_memberships','workspace_workbench_state','workspace_pages',
  'notification_jobs','push_subscriptions','fish_state_fields','fish_progress_changes',
  'scheduler_observations','curated_calendar_events','site_admin_devices',
] as const;
const INDEXES=[
  'idx_auth_rate_limits_window','idx_nav_catalog_links_category','idx_nav_catalog_links_region',
  'idx_events_region_start','idx_events_start','idx_calendar_admin_sessions_expires',
  'idx_calendar_editor_entries_updated','idx_calendar_admin_audit_recent',
  'local_push_due','local_push_digest_due',
] as const;
const TRIGGERS=[
  'calendar_admin_audit_insert','calendar_admin_audit_update',
  'site_admin_settings_audit_insert','site_admin_settings_audit_update',
  'nav_catalog_audit_insert','nav_catalog_audit_update',
] as const;
async function schemaNames(type:'table'|'index'|'trigger'):Promise<Set<string>>{
  const result=await env.DB.prepare('SELECT name FROM sqlite_master WHERE type=?').bind(type).all<{name:string}>();
  return new Set(result.results.map(row=>row.name));
}

describe('单文件初始迁移',()=>{
  it('只登记一份现行迁移且重复调用迁移接口不会重新执行',async()=>{
    const before=await env.DB.prepare('SELECT name FROM d1_migrations').all<{name:string}>();
    expect(before.results.map(row=>row.name)).toEqual(['0001_core.sql','0022_content_management.sql']);
    await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
    const after=await env.DB.prepare('SELECT name FROM d1_migrations').all<{name:string}>();
    expect(after.results.map(row=>row.name)).toEqual(['0001_core.sql','0022_content_management.sql']);
  });

  it('精确包含当前 16 张表，不再创建旧身份与工作空间表',async()=>{
    const tables=await schemaNames('table');
    for(const table of LIVE_TABLES)expect(tables.has(table),`缺少现行表 ${table}`).toBe(true);
    for(const table of RETIRED_TABLES)expect(tables.has(table),`仍在新基线创建废弃表 ${table}`).toBe(false);
    const visible=[...tables].filter(name=>name!=='d1_migrations'&&name!=='sqlite_sequence'&&!name.startsWith('_cf_'));
    expect(visible.sort()).toEqual([...LIVE_TABLES,'admin_content_state','admin_content_audit','site_game_data','site_game_data_history','admin_sync_runs'].sort());
  });

  it('保留查询索引和 owner 操作审计触发器',async()=>{
    const indexes=await schemaNames('index');
    const triggers=await schemaNames('trigger');
    for(const index of INDEXES)expect(indexes.has(index),`缺少索引 ${index}`).toBe(true);
    for(const trigger of TRIGGERS)expect(triggers.has(trigger),`缺少触发器 ${trigger}`).toBe(true);
  });

  it('公共鱼类与活动的基本数据约束仍由 D1 拒绝非法记录',async()=>{
    await expect(env.DB.prepare("INSERT INTO fish_catalog(region,fish_id,record_json) VALUES ('eu',1,'{}')").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO fish_catalog(region,fish_id,record_json) VALUES ('cn',1,'broken-json')").run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO fish_catalog(region,fish_id,record_json) VALUES ('cn',1,'{}')").run();
    await expect(env.DB.prepare("INSERT INTO events(id,region,title,starts_at,ends_at,source_url,verification_status,created_at,updated_at) VALUES ('event-a','both','a',1,2,'https://x.test','unverified',1,1)").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO events(id,region,title,starts_at,ends_at,source_url,verification_status,created_at,updated_at) VALUES ('event-b','cn','b',2,1,'https://x.test','unverified',1,1)").run()).rejects.toThrow();
  });

  it('通知任务只能属于现行订阅设备，删除设备会级联清理队列',async()=>{
    const insertJob=(deviceId:string)=>env.DB.prepare("INSERT INTO local_push_jobs(device_id,job_key,payload,due_at,expires_at) VALUES (?,'job','{}',1,2)").bind(deviceId).run();
    await expect(insertJob('not-exists')).rejects.toThrow();
    await env.DB.prepare("INSERT INTO local_push_devices(id,token_hash,endpoint_hash,channel_ciphertext,expires_at,updated_at) VALUES ('notify-unit','token-unit','endpoint-unit','encrypted',100,1)").run();
    await insertJob('notify-unit');
    await env.DB.prepare("DELETE FROM local_push_devices WHERE id='notify-unit'").run();
    const row=await env.DB.prepare("SELECT 1 AS present FROM local_push_jobs WHERE device_id='notify-unit'").first();
    expect(row).toBeNull();
  });

  it('站点设置和导航编辑保留自动审计轨迹',async()=>{
    await env.DB.prepare("INSERT INTO site_admin_settings(singleton,payload,revision,updated_at) VALUES (1,'{}',1,100)").run();
    await env.DB.prepare("UPDATE site_admin_settings SET revision=2,updated_at=101 WHERE singleton=1").run();
    const settings=await env.DB.prepare('SELECT COUNT(*) AS n FROM site_admin_settings_audit').first<{n:number}>();
    expect(settings?.n).toBe(2);
    await env.DB.prepare("INSERT INTO nav_catalog_edits(id,payload,canonical_url,revision,updated_at) VALUES ('catalog-a','{}','https://example.test/',1,100)").run();
    await env.DB.prepare("UPDATE nav_catalog_edits SET revision=2,updated_at=101 WHERE id='catalog-a'").run();
    const audit=await env.DB.prepare("SELECT COUNT(*) AS n FROM nav_catalog_audit WHERE catalog_id='catalog-a'").first<{n:number}>();
    expect(audit?.n).toBe(2);
  });
});
