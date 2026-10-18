import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {root,inspectReleaseConfig} from './release-config.mjs';
import {sha256,writeManifest,verifyBackup} from './backup.mjs';

function config(){return {main:'worker/index.ts',assets:{binding:'ASSETS',run_worker_first:true,directory:'./apps/web/dist'},triggers:{crons:[]},env:Object.fromEntries(
  ['preview','production'].map((name,i)=>[name,{name:`hub-${name}`,vars:{ENVIRONMENT:name,ENABLE_TEST_ROUTES:'0',ALLOWED_ORIGINS:''},
    d1_databases:[{binding:'DB',database_name:`db-${name}`,database_id:`${i+1}1111111-1111-4111-8111-111111111111`}]}]),
)};}

test('static preparation does not claim cloud resources or secrets have been checked',()=>{
  const result=inspectReleaseConfig(config());assert.equal(result.configurationReady,true);
  assert.equal(result.cloudResourcesVerified,false);assert.equal(result.secretsVerified,false);
});
test('placeholder or shared database/worker resources block release preparation',()=>{
  const value=config();value.env.preview.d1_databases[0].database_id='00000000-0000-0000-0000-000000000001';
  assert.ok(inspectReleaseConfig(value).targets[0].blockers.includes('placeholder-database-id'));
  const shared=config();shared.env.production.d1_databases[0].database_id=shared.env.preview.d1_databases[0].database_id;
  assert.ok(inspectReleaseConfig(shared).targets.every((v)=>v.blockers.includes('shared-environment-resource')));
});
test('vars must explicitly disable test routes in both environments',()=>{
  for(const unsafe of [undefined,'1',1]){
    const value=config();value.env.production.vars.ENABLE_TEST_ROUTES=unsafe;
    assert.ok(inspectReleaseConfig(value).targets[1].blockers.includes('test-routes-not-explicitly-disabled'));
  }
});
test('secret values and wildcard/HTTP origins fail without appearing in reports',()=>{
  for(const key of ['BOOTSTRAP_SECRET','API_TOKEN','VAPID_PRIVATE_KEY','WEBDAV_USERNAME']){
    const value=config();value.env.preview.vars[key]='test-private-value';
    const result=inspectReleaseConfig(value);assert.ok(result.targets[0].blockers.includes('secret-in-public-vars'));
    assert.ok(!JSON.stringify(result).includes('test-private-value'));
  }
  const value=config();value.env.preview.vars.BOOTSTRAP_SECRET='test-private-value';
  for(const origin of ['*','http://hub.test','https://hub.test/path','https://user:pass@hub.test']){
    value.env.preview.vars.ALLOWED_ORIGINS=origin;const result=inspectReleaseConfig(value);
    assert.equal(result.configurationReady,false);assert.ok(result.targets[0].blockers.includes('unsafe-or-missing-origins'));
    assert.ok(!JSON.stringify(result).includes('test-private-value'));
  }
});
test('scheduled delivery or bypassing Worker asset handling blocks this release boundary',()=>{
  const value=config();value.triggers.crons=['* * * * *'];value.assets.run_worker_first=false;
  const result=inspectReleaseConfig(value);assert.equal(result.configurationReady,false);
  assert.ok(result.targets.every((v)=>v.blockers.includes('asset-security-boundary')&&v.blockers.includes('cron-not-explicitly-disabled')));
});
test('preflight CLI exit status agrees with its actual report',()=>{
  const child=spawnSync(process.execPath,['scripts/ops/preflight.mjs'],{cwd:root,encoding:'utf8'});
  assert.ifError(child.error);const report=JSON.parse(child.stdout);
  assert.equal(child.status,report.configurationReady?0:2);assert.equal(report.kind,'static-configuration-check');
});

async function backup(){
  const directory=path.join(root,'.wrangler','ops-unit',randomUUID());await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'database.sql'),'CREATE TABLE example (id INTEGER PRIMARY KEY);');
  const migrations=[{name:'0001_example.sql',sha256:sha256('migration')}];
  await writeManifest(directory,migrations,sha256('database fingerprint'));return {directory,migrations};
}
test('backup verifies unchanged SQL and refuses overwriting a manifest',async()=>{
  const {directory,migrations}=await backup();assert.equal((await verifyBackup(directory,migrations)).formatVersion,1);
  await assert.rejects(writeManifest(directory,migrations,sha256('database fingerprint')));
});
test('corrupted SQL is rejected before restoring any data',async()=>{
  const {directory,migrations}=await backup();const file=path.join(directory,'database.sql');
  const original=await readFile(file);const replacement=Buffer.from(original);replacement[0]=88;await writeFile(file,replacement);
  await assert.rejects(verifyBackup(directory,migrations),/校验失败/u);
});
test('different migration content and unsupported backup versions fail closed',async()=>{
  const {directory,migrations}=await backup();await assert.rejects(verifyBackup(directory,[{...migrations[0],sha256:sha256('modified migration')}]),/迁移版本/u);
  const file=path.join(directory,'manifest.json');const value=JSON.parse(await readFile(file,'utf8'));value.formatVersion=9;
  await writeFile(file,JSON.stringify(value));await assert.rejects(verifyBackup(directory,[]),/清单/u);
});
test('manifest cannot redirect a restore to another SQL path',async()=>{
  const {directory,migrations}=await backup();const file=path.join(directory,'manifest.json');
  const value=JSON.parse(await readFile(file,'utf8'));value.sql.name='../outside.sql';await writeFile(file,JSON.stringify(value));
  await assert.rejects(verifyBackup(directory,migrations),/清单/u);
});
