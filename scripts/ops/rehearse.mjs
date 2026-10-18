import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,readConfig,inspectReleaseConfig} from './release-config.mjs';
import {sha256,migrationInventory,writeManifest,verifyBackup} from './backup.mjs';

const runDir=path.join(root,'.wrangler','ops',`rehearsal-${randomUUID()}`);
const wrangler=path.join(root,'node_modules','wrangler','bin','wrangler.js');
const children=new Set();let serial=0;
const childEnv={...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'};
const check=(condition,label)=>{if(!condition)throw new Error(label);};
const privateFile=(file,body)=>writeFile(file,body,{flag:'wx',mode:0o600});

function launch(args,cwd){
  const child=spawn(process.execPath,[wrangler,...args,'--env='],{cwd,env:childEnv,stdio:['ignore','pipe','pipe'],shell:false});
  children.add(child);child.once('close',()=>children.delete(child));return child;
}
function stop(child){
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise((resolve)=>{
    child.once('close',resolve);
    if(process.platform==='win32'){
      const killer=spawn('C:\\Windows\\System32\\taskkill.exe',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',shell:false});
      killer.once('error',()=>child.kill());
    }else child.kill('SIGTERM');
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);timer.unref();
  });
}
async function command(config,args,label){
  const child=launch([...args,'--config',config],path.dirname(config));let stdout='';let stderr='';
  const timer=setTimeout(()=>{void stop(child);},120000);timer.unref();
  child.stdout.on('data',(v)=>{stdout+=v.toString();if(stdout.length>32*1048576)void stop(child);});child.stderr.on('data',(v)=>{stderr=(stderr+v.toString()).slice(-1048576);});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  clearTimeout(timer);
  if(exit!==0){
    await privateFile(path.join(runDir,`diagnostic-${++serial}.log`),stderr+stdout);
    throw new Error(`本地操作失败：${label}（诊断仅保留在隔离目录）`);
  }
  return stdout;
}
async function query(config,sql){
  const output=await command(config,['d1','execute','DB','--local','--json','--command',sql],'数据库查询');
  let result;try{result=JSON.parse(output);}catch{throw new Error('本地查询响应不是有效JSON');}
  check(Array.isArray(result)&&result.every((row)=>row.success===true&&Array.isArray(row.results)),'查询响应不完整');
  return result.map((row)=>row.results);
}
const canonical=(value)=>{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
async function fingerprint(config){
  const [schema]=await query(config,"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name");
  const names=schema.filter((v)=>v.type==='table').map((v)=>v.name).sort();
  const [sequenceExists]=await query(config,"SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'");
  if(sequenceExists.length>0)names.push('sqlite_sequence');
  const rows=names.length===0?[]:await query(config,names.map((name)=>`SELECT * FROM "${name.replaceAll('"','""')}"`).join(';'));
  const tables=names.map((name,i)=>({name,rows:rows[i].length,sha256:sha256(rows[i].map(canonical).sort().join('\n'))}));
  return {sha256:sha256(canonical({schema,tables})),tables};
}
async function integrity(config){
  const [fk,checks]=await query(config,'PRAGMA foreign_key_check;PRAGMA quick_check');
  check(fk.length===0&&checks.length===1&&Object.values(checks[0])[0]==='ok','恢复数据库完整性校验失败');
}
async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();check(address!==null&&typeof address==='object','本地端口分配失败');
  const port=address.port;await new Promise((resolve)=>server.close(resolve));return port;
}
async function start(config,bootstrapSecret,testScheduled=false){
  const port=await freePort();const base=`http://127.0.0.1:${port}`;
  const child=launch(['dev','--local','--ip','127.0.0.1','--port',String(port),'--config',config,'--var',`BOOTSTRAP_SECRET:${bootstrapSecret}`,...(testScheduled?['--test-scheduled']:[])],path.dirname(config));
  // Startup output can contain test vars. Keep it private, never forward it to CI stdout.
  let log='';child.stdout.on('data',(v)=>{log=(log+v.toString()).slice(-32768);});child.stderr.on('data',(v)=>{log=(log+v.toString()).slice(-32768);});
  const deadline=Date.now()+60000;
  while(Date.now()<deadline&&child.exitCode===null){
    try{if((await fetch(`${base}/api/v1/health`,{signal:AbortSignal.timeout(1000)})).ok)return {base,stop:()=>stop(child)};}catch{/* bounded readiness retry */}
    await new Promise((resolve)=>setTimeout(resolve,300));
  }
  await stop(child);await privateFile(path.join(runDir,`startup-${++serial}.log`),log);throw new Error('隔离本地服务未就绪');
}
async function api(base,pathname,{token,body,method=body===undefined?'GET':'POST',status=200,bootstrapSecret}={}){
  const response=await fetch(`${base}/api/v1${pathname}`,{method,headers:{
    ...(token===undefined?{}:{Authorization:`Bearer ${token}`}),...(body===undefined?{}:{'Content-Type':'application/json'}),
    ...(bootstrapSecret===undefined?{}:{'X-Bootstrap-Secret':bootstrapSecret}),
  },...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});
  check(response.status===status,`HTTP验收失败：${method} ${pathname.split('?')[0]}，状态${response.status}`);
  if(status===204){await response.body?.cancel();return null;}
  check(response.headers.get('Cache-Control')?.includes('no-store'),'私有响应缺少no-store');
  try{return await response.json();}catch{throw new Error('HTTP响应不是有效JSON');}
}
async function makeConfig(directory,source){
  await mkdir(directory,{recursive:false});
  const config={name:'ff14-hub-local-rehearsal',main:path.join(root,'worker/index.ts'),compatibility_date:source.compatibility_date,
    assets:{...source.assets,directory:path.join(root,'apps/web/public')},triggers:{crons:[]},
    vars:{ENVIRONMENT:'development',ENABLE_TEST_ROUTES:'0',ALLOWED_ORIGINS:''},
    d1_databases:[{binding:'DB',database_name:'ff14-hub-local-rehearsal',database_id:'00000000-0000-0000-0000-0000000000dd',migrations_dir:path.join(root,'migrations')}]};
  const file=path.join(directory,'wrangler.json');await privateFile(file,JSON.stringify(config));return file;
}
async function seed(base,bootstrapSecret){
  const identity=await api(base,'/identity/bootstrap',{body:{deviceName:'Local recovery rehearsal'},bootstrapSecret,status:201});
  const token=identity.deviceToken;
  for(const name of ['ff14.navigation','ff14.events','ff14.fishing','ff14.sync']){
    await api(base,`/me/modules/${name}`,{token,method:'PATCH',body:{action:'enable',expectedRevision:0}});
  }
  const page=await api(base,'/me/pages',{token,status:201,body:{name:'Recovery rehearsal page',operationId:randomUUID()}});
  const link=await api(base,'/me/navigation/links',{token,status:201,body:{title:'Recovery tombstone',url:'https://example.com/recovery',region:'cn',operationId:randomUUID()}});
  await api(base,`/me/navigation/links/${link.link.id}`,{token,method:'DELETE',body:{expectedRevision:link.link.revision,operationId:randomUUID()}});
  await api(base,'/me/events',{token,status:201,body:{title:'Recovery event',region:'cn',startsAt:Date.now()+3600000,endsAt:Date.now()+7200000,operationId:randomUUID()}});
  const pairing=await api(base,'/identity/pairing',{token,body:{},status:201});
  const revoked=await api(base,'/identity/pairing/claim',{status:201,body:{pairingCode:pairing.pairingCode,deviceName:'Revoked before backup'}});
  await api(base,`/me/devices/${revoked.device.id}`,{token,method:'DELETE',status:204});
  const preview=await api(base,'/me/fish-sync/preview',{token,body:{region:'cn',changes:[
    {fishId:9999999,field:'caught',value:true,expectedRevision:0},
    {fishId:9999999,field:'pinned',value:true,expectedRevision:0},
    {fishId:9999999,field:'alarm',value:true,expectedRevision:0},
  ]}});
  const operationId=randomUUID();const applied=await api(base,'/me/fish-sync/apply',{token,body:{token:preview.token,operationId}});
  const stale=await api(base,'/me/fish-sync/preview',{token,body:{region:'cn',changes:[{fishId:9999999,field:'caught',value:false,expectedRevision:1}]}});
  const competing=await api(base,'/me/fish-sync/preview',{token,body:{region:'cn',changes:[{fishId:9999999,field:'alarm',value:false,expectedRevision:1}]}});
  await api(base,'/me/fish-sync/apply',{token,body:{token:competing.token,operationId:randomUUID()}});
  const snapshot=await api(base,'/me/fish-sync?region=cn',{token});
  return {token,revokedToken:revoked.deviceToken,pageId:page.page.id,linkId:link.link.id,previewToken:preview.token,operationId,auditId:applied.auditId,staleToken:stale.token,snapshot};
}
async function restoredApi(base,state){
  const {token}=state;
  await api(base,'/me/profile',{token});await api(base,'/me/profile',{token:state.revokedToken,status:401});
  await api(base,'/me/profile',{status:401});
  const operations=await api(base,'/me/operations?region=cn',{token});
  check(operations.scheduler.last?.status==='succeeded'&&operations.scheduler.lastSuccessAt===state.schedulerObservedAt,'运维调度记录恢复失败');
  check(operations.scheduler.cadenceVerified===false&&operations.sync.webdavFreshnessAvailable===false,'诊断错误声称已验证外部新鲜度');
  await api(base,'/me/operations?region=cn',{status:401});
  assert.deepEqual(await api(base,'/me/fish-sync?region=cn',{token}),state.snapshot);
  check((await api(base,'/me/fish-sync?region=global',{token})).fields.length===0,'区服隔离恢复失败');
  const replay=await api(base,'/me/fish-sync/apply',{token,body:{token:state.previewToken,operationId:state.operationId}});
  check(replay.replayed===true&&replay.auditId===state.auditId,'幂等回执恢复失败');
  await api(base,'/me/fish-sync/apply',{token,status:409,body:{token:state.staleToken,operationId:randomUUID()}});
  const pages=await api(base,'/me/pages',{token});check(pages.pages.some((page)=>page.id===state.pageId),'工作台页面恢复失败');
  const links=await api(base,'/me/navigation/links',{token});check(!links.links.some((link)=>link.id===state.linkId),'墓碑被错误恢复为活跃链接');
  const next=await api(base,'/me/fish-sync/preview',{token,body:{region:'cn',changes:[{fishId:9999999,field:'caught',value:false,expectedRevision:1}]}});
  await api(base,'/me/fish-sync/apply',{token,body:{token:next.token,operationId:randomUUID()}});
  const after=await api(base,'/me/fish-sync?region=cn',{token});
  check(after.watermark>state.snapshot.watermark&&after.fields.find((field)=>field.field==='caught')?.revision===2,'恢复后水位或字段修订未递增');
}

async function main(){
  await mkdir(runDir,{recursive:true,mode:0o700});
  const source=await readConfig();const release=inspectReleaseConfig(source);
  const sourceConfig=await makeConfig(path.join(runDir,'source'),source);
  const targetConfig=await makeConfig(path.join(runDir,'restored'),source);
  const migrations=await migrationInventory(path.join(root,'migrations'));
  await command(sourceConfig,['d1','migrations','apply','DB','--local'],'迁移');
  const bootstrapSecret=`rehearsal-only-${randomBytes(32).toString('hex')}`;
  const server=await start(sourceConfig,bootstrapSecret,true);let state;
  try{
    state=await seed(server.base,bootstrapSecret);
    const trigger=await fetch(`${server.base}/__scheduled?cron=${encodeURIComponent('* * * * *')}`,{signal:AbortSignal.timeout(15000)});
    check(trigger.ok,'本地调度触发失败');await trigger.body?.cancel();
    for(let attempt=0;attempt<20;attempt++){
      const observed=await api(server.base,'/me/operations?region=cn',{token:state.token});
      if(observed.scheduler.last?.status==='succeeded'){state.schedulerObservedAt=observed.scheduler.lastSuccessAt;break;}
      check(observed.scheduler.last?.status!=='failed','本地调度未完成');
      await new Promise((resolve)=>setTimeout(resolve,100));
    }
    check(Number.isSafeInteger(state.schedulerObservedAt),'未观察到本地调度成功完成');
  }finally{await server.stop();}
  // Source is quiesced before fingerprint/export: no background writers or scheduled delivery.
  await integrity(sourceConfig);const before=await fingerprint(sourceConfig);
  const backupDir=path.join(runDir,'backup');await mkdir(backupDir,{mode:0o700});
  await command(sourceConfig,['d1','export','DB','--local','--output',path.join(backupDir,'database.sql')],'导出');
  const sql=await readFile(path.join(backupDir,'database.sql'));
  for(const credential of [bootstrapSecret,state.token,state.revokedToken])check(!sql.includes(Buffer.from(credential)),'备份中出现原始身份凭证');
  check((await fingerprint(sourceConfig)).sha256===before.sha256,'导出期间源数据库发生变化');
  await writeManifest(backupDir,migrations,before.sha256);
  const manifest=await verifyBackup(backupDir,migrations);
  const [existing]=await query(targetConfig,"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'");
  check(existing.length===0,'恢复目标非空；拒绝覆盖');
  await command(targetConfig,['d1','execute','DB','--local','--file',path.join(backupDir,'database.sql')],'导入');
  await integrity(targetConfig);const after=await fingerprint(targetConfig);
  await privateFile(path.join(runDir,'fingerprint-source.json'),JSON.stringify(before,null,2));
  await privateFile(path.join(runDir,'fingerprint-restored.json'),JSON.stringify(after,null,2));
  check(after.sha256===manifest.fingerprint,'整库恢复指纹不一致');
  const restored=await start(targetConfig,bootstrapSecret);
  try{await restoredApi(restored.base,state);}finally{await restored.stop();}
  const report={formatVersion:1,kind:'local-only-recovery-rehearsal',passed:true,createdAt:new Date().toISOString(),
    release,backupSha256:manifest.sql.sha256,databaseFingerprint:before.sha256,tables:before.tables,
    checks:['quiesced-source','manifest-and-migration-hashes','empty-target-only','all-table-schema-and-row-digests','foreign-keys','d1-quick-check',
      'live-device-auth','revoked-device-denied','anonymous-denied','workbench-page','navigation-tombstone','fish-fields-and-region','idempotency-replay','stale-preview-rejected','monotonic-watermark',
      'scheduled-handler-observed','private-operations-snapshot']};
  await privateFile(path.join(runDir,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,report:path.relative(root,path.join(runDir,'report.json')),tableCount:before.tables.length,
    releaseConfigurationReady:release.configurationReady,secretsVerified:false,remoteResourcesVerified:false},null,2));
}
process.once('SIGINT',()=>{void Promise.all([...children].map(stop)).finally(()=>process.exit(130));});
process.once('SIGTERM',()=>{void Promise.all([...children].map(stop)).finally(()=>process.exit(143));});
try{await main();}catch(error){console.error(`本地恢复演练未通过：${error instanceof Error?error.message:'未知错误'}。现场保留于${path.relative(root,runDir)}`);process.exitCode=1;}
finally{await Promise.all([...children].map(stop));}
