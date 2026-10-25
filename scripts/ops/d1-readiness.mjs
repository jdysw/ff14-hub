/** D1 只读业务就绪核查。不会执行 migrations、DDL、数据写入或生产部署。 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const requiredTables=[
 'auth_rate_limits','nav_catalog_links','events','fish_catalog','official_calendar_snapshots',
 'calendar_admin_accounts','calendar_admin_sessions','calendar_admin_rate_limits',
 'calendar_editor_entries','calendar_admin_audit','site_admin_settings',
 'site_admin_settings_audit','nav_catalog_edits','nav_catalog_audit','local_push_devices','local_push_jobs',
 'admin_content_state','admin_content_audit','admin_sync_runs','site_game_data','site_game_data_history',
];
export const READ_ONLY_QUERIES=Object.freeze({
 tables:"SELECT name FROM sqlite_master WHERE type='table'",
 migrations:"SELECT name FROM d1_migrations ORDER BY id",
 fish:"SELECT region,COUNT(*) AS entries FROM fish_catalog GROUP BY region",
 foreignKeys:"PRAGMA foreign_key_check",
});
export function readResults(raw){
 const value=JSON.parse(raw);
 if(!Array.isArray(value)||value.length!==1||value[0]?.success!==true||!Array.isArray(value[0].results)){
   throw new Error('Wrangler 返回非预期 D1 查询结构，拒绝判定为就绪');
 }
 return value[0].results;
}
export function assessReadiness({tables,migrations,fish,foreignKeys}){
 const known=new Set(tables.map(row=>row.name));
 const missingTables=requiredTables.filter(name=>!known.has(name));
 const names=migrations.map(row=>row.name);
 const firstBaseline=names.includes('0001_core.sql');
 const oldChain=names.some(name=>/^00(?:0[2-9]|1\d|2[01])_/.test(name));
 const partialLegacy=oldChain&&!names.some(name=>name.startsWith('0021_'));
 const fishCounts=Object.fromEntries(fish.map(row=>[row.region,Number(row.entries)]));
 const absentFish=['cn','global'].filter(region=>!Number.isSafeInteger(fishCounts[region])||fishCounts[region]<=0);
 const ready=missingTables.length===0&&firstBaseline&&!partialLegacy&&foreignKeys.length===0&&absentFish.length===0;
 return {ready,schemaReady:missingTables.length===0&&firstBaseline&&!partialLegacy,
   missingTables,firstBaseline,partialLegacy,missingFishRegions:absentFish,
   fishCounts:{cn:fishCounts.cn??0,global:fishCounts.global??0},
   foreignKeyViolations:foreignKeys.length,
   historicalTables:[...known].filter(name=>/^(workspace_|workspaces$|device_pairings$|widget_|workbench_)/.test(name)).sort((a,b)=>a.localeCompare(b)),
   migrationsApplied:names.length};
}
export function runReadOnlyQuery(environment,mode,sql,{runner=spawnSync}={}){
 // 该函数可被直接调用，必须在构造子进程参数前独立验证全部输入。
 // SQL 只允许模块内固定的四条只读语句，绝不让外部文本进入 --command。
 if(!['development','preview','production'].includes(environment)||
    !['--local','--remote'].includes(mode)||
    (environment==='development'&&mode!=='--local')||
    !Object.values(READ_ONLY_QUERIES).includes(sql)){
   throw new Error('非法 D1 只读查询参数');
 }
 const wrangler=path.join(root,'node_modules','wrangler','bin','wrangler.js');
 const query=Object.values(READ_ONLY_QUERIES).find(allowed=>allowed===sql);
 const target=environment==='production'?'production':'preview';
 const location=mode==='--local'?'--local':'--remote';
 const args=[wrangler,'d1','execute','DB',...(environment==='development'?[]:['--env',target]),location,'--command',query,'--json'];
 const response=runner(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024,timeout:45000});
 if(response.error||response.status!==0)throw new Error('D1 只读查询失败：检查 Wrangler 凭据、环境与迁移状态');
 return readResults(response.stdout);
}
export function inspectD1(environment,mode,options={}){
 if(!['development','preview','production'].includes(environment)||!['--local','--remote'].includes(mode)||
    (environment==='development'&&mode!=='--local'))throw new Error('必须显式选择 development--local 或 preview/production 的 --local/--remote');
 const query=(sql)=>runReadOnlyQuery(environment,mode,sql,options);
 const tables=query(READ_ONLY_QUERIES.tables);
 const known=new Set(tables.map(row=>row.name));
 const migrations=known.has('d1_migrations')?query(READ_ONLY_QUERIES.migrations):[];
 const fish=known.has('fish_catalog')?query(READ_ONLY_QUERIES.fish):[];
 const foreignKeys=query(READ_ONLY_QUERIES.foreignKeys);
 return {environment,location:mode==='--remote'?'remote':'local',
   ...assessReadiness({tables,migrations,fish,foreignKeys})};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
   const result=inspectD1(process.argv[2],process.argv[3]);
   console.log(JSON.stringify(result,null,2));
   if(!result.ready)process.exitCode=2;
 }catch(error){console.error(error instanceof Error?error.message:'就绪检查失败');process.exitCode=1;}
}
