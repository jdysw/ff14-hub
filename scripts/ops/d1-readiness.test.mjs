import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessReadiness,readResults,READ_ONLY_QUERIES,runReadOnlyQuery,inspectD1} from './d1-readiness.mjs';
const required=[
 'auth_rate_limits','nav_catalog_links','events','fish_catalog','official_calendar_snapshots',
 'calendar_admin_accounts','calendar_admin_sessions','calendar_admin_rate_limits',
 'calendar_editor_entries','calendar_admin_audit','site_admin_settings',
 'site_admin_settings_audit','nav_catalog_edits','nav_catalog_audit','local_push_devices','local_push_jobs',
];
const valid=()=>({tables:[...required,'d1_migrations'].map(name=>({name})),migrations:[{name:'0001_core.sql'}],fish:[{region:'cn',entries:23},{region:'global',entries:11}],foreignKeys:[]});
test('empty D1 and no imported fish never register ready',()=>{
 const result=assessReadiness({tables:[],migrations:[],fish:[],foreignKeys:[]});
 assert.equal(result.ready,false);assert.equal(result.missingTables.length,16);
 const withTables=valid();withTables.fish=[];assert.deepEqual(assessReadiness(withTables).missingFishRegions,['cn','global']);
});
test('fresh baseline with both fish regions returns ready',()=>{
 const result=assessReadiness(valid());assert.equal(result.ready,true);assert.equal(result.schemaReady,true);
});
test('incomplete historical migrations must not pretend the latest table set was migrated',()=>{
 const values=valid();values.migrations.push({name:'0019_site_admin_settings.sql'});
 assert.equal(assessReadiness(values).partialLegacy,true);assert.equal(assessReadiness(values).ready,false);
 values.migrations.push({name:'0021_local_notifications.sql'});
 assert.equal(assessReadiness(values).ready,true);
});
test('foreign key defects and missing schema block readiness; legacy tables are diagnostic only',()=>{
 const values=valid();values.foreignKeys.push({table:'local_push_jobs'});values.tables.push({name:'workspace_pages'});
 assert.equal(assessReadiness(values).ready,false);
 const report=assessReadiness(values);assert.deepEqual(report.historicalTables,['workspace_pages']);
 values.foreignKeys=[];values.tables=values.tables.filter(row=>row.name!=='fish_catalog');
 assert.ok(assessReadiness(values).missingTables.includes('fish_catalog'));
});
test('Wrangler JSON result must be successful single query array',()=>{
 assert.deepEqual(readResults('[{"success":true,"results":[{"name":"x"}]}]'),[{name:'x'}]);
 for(const invalid of ['{}','[]','[{"success":false,"results":[]}]','[{"success":true,"results":[]},{"success":true,"results":[]}]']){
   assert.throws(()=>readResults(invalid));
 }
});
test('CLI only emits read-only SELECT/PRAGMA and cannot select implicit remote environment',()=>{
 const calls=[];const results={
  [READ_ONLY_QUERIES.tables]:valid().tables,
  [READ_ONLY_QUERIES.migrations]:valid().migrations,
  [READ_ONLY_QUERIES.fish]:valid().fish,
  [READ_ONLY_QUERIES.foreignKeys]:[],
 };
 const runner=(bin,args)=>{const sql=args[args.indexOf('--command')+1];calls.push({bin,args,sql});return {status:0,stdout:JSON.stringify([{success:true,results:results[sql]}])};};
 assert.equal(inspectD1('preview','--local',{runner}).ready,true);
 assert.equal(calls.length,4);
 for(const call of calls){assert.ok(/^(SELECT|PRAGMA) /.test(call.sql));assert.ok(call.args.includes('--local'));assert.ok(!call.args.includes('--remote'));}
 assert.throws(()=>inspectD1('production',undefined,{runner}));
 assert.throws(()=>inspectD1('staging','--remote',{runner}));
 assert.throws(()=>inspectD1('development','--remote',{runner}));
 const start=calls.length;
 assert.equal(inspectD1('development','--local',{runner}).ready,true);
 for(const call of calls.slice(start))assert.ok(!call.args.includes('--env'));

 assert.throws(()=>runReadOnlyQuery('preview','--local','SELECT 1',{runner:()=>({status:1,stdout:''})}));
});
