#!/usr/bin/env node
/**
 * 零依赖 D1 初始基线静态守卫。
 * 精确限定只有一个 SQL 迁移，避免未来误恢复旧工作空间表；
 * SQL 语义/外键/触发器执行效果另由真实 workerd+D1 测试验证。
 */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const directory=fileURLToPath(new URL('../../migrations/',import.meta.url));
const files=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort((a,b)=>a.localeCompare(b));
assert.equal(files[0],'0001_core.sql','全新 D1 必须从 0001_core.sql 创建');
assert.ok(files.slice(1).every(file=>/^00(?:2[2-9]|[3-9]\d)_/.test(file)),'后续增量迁移从 0022 开始');
const sql=await readFile(new URL('../../migrations/0001_core.sql',import.meta.url),'utf8');
const statements=sql.split('\n').filter(line=>!line.trimStart().startsWith('--')).join('\n');
const capture=(regex)=>[...statements.matchAll(regex)].map(match=>match[1]);
const tables=capture(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi).sort((a,b)=>a.localeCompare(b));
const expected=[
  'auth_rate_limits','nav_catalog_links','events','fish_catalog','official_calendar_snapshots',
  'calendar_admin_accounts','calendar_admin_sessions','calendar_admin_rate_limits',
  'calendar_editor_entries','calendar_admin_audit',
  'site_admin_settings','site_admin_settings_audit',
  'nav_catalog_edits','nav_catalog_audit','local_push_devices','local_push_jobs',
].sort((a,b)=>a.localeCompare(b));
assert.deepEqual(tables,expected,'单用户 D1 的表清单发生了未审查变化');
const indexes=capture(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/gi).sort((a,b)=>a.localeCompare(b));
const triggers=capture(/CREATE TRIGGER IF NOT EXISTS\s+(\w+)/gi).sort((a,b)=>a.localeCompare(b));
assert.equal(indexes.length,10,'缺失或意外新增 SQL 索引');
assert.deepEqual(triggers,[
  'calendar_admin_audit_insert','calendar_admin_audit_update',
  'site_admin_settings_audit_insert','site_admin_settings_audit_update',
  'nav_catalog_audit_insert','nav_catalog_audit_update',
].sort((a,b)=>a.localeCompare(b)),'管理员审计触发器不完整');
assert.doesNotMatch(statements,/\b(?:DROP\s+TABLE|ALTER\s+TABLE|DELETE\s+FROM)\b/i,'基线不得进行破坏性 SQL 操作');
assert.doesNotMatch(statements,/\b(?:workspaces|device_pairings|workspace_\w+|notification_jobs|fish_state_fields|site_admin_devices|curated_calendar_events|scheduler_observations)\b/i,'新库不得重新引入退役表');
assert.match(statements,/REFERENCES\s+local_push_devices\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,'通知任务需由订阅设备外键约束');
console.log('D1 单文件初始基线静态检查通过：16 表、10 索引、6 触发器，无历史工作空间表。');
