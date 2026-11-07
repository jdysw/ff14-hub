import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {root} from './release-config.mjs';
import {sha256,writeManifest,verifyBackup} from './backup.mjs';


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

test('manifest cannot redirect a restore to another SQL path',async()=>{
  const {directory,migrations}=await backup();const file=path.join(directory,'manifest.json');
  const value=JSON.parse(await readFile(file,'utf8'));value.sql.name='../outside.sql';await writeFile(file,JSON.stringify(value));
  await assert.rejects(verifyBackup(directory,migrations),/清单/u);
});
