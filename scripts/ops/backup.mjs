import {createHash} from 'node:crypto';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';

export const sha256=(value)=>createHash('sha256').update(value).digest('hex');
export async function migrationInventory(directory){
  const names=(await readdir(directory)).filter((name)=>/^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  if(names.length===0)throw new Error('迁移目录为空');
  return Promise.all(names.map(async(name)=>({name,sha256:sha256(await readFile(path.join(directory,name)))})));
}
export const MAX_BACKUP_BYTES=128*1048576;
const hash=/^[a-f0-9]{64}$/u;
export async function writeManifest(directory,migrations,fingerprint){
  const file=path.join(directory,'database.sql');const size=(await stat(file)).size;
  if(size<1||size>MAX_BACKUP_BYTES)throw new Error('备份大小不在演练支持范围内');
  const manifest={formatVersion:1,kind:'local-d1-rehearsal-backup',createdAt:new Date().toISOString(),
    sql:{name:'database.sql',bytes:size,sha256:sha256(await readFile(file))},migrations,fingerprint};
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  return manifest;
}
/** Verify before issuing any restore command. A checksum detects corruption, not a forged manifest. */
export async function verifyBackup(directory,migrations){
  const manifestPath=path.join(directory,'manifest.json');
  if((await stat(manifestPath)).size>65536)throw new Error('备份清单过大');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest?.formatVersion!==1||manifest.kind!=='local-d1-rehearsal-backup'||manifest.sql?.name!=='database.sql'||
    !hash.test(manifest.sql.sha256??'')||!hash.test(manifest.fingerprint??'')||!Number.isSafeInteger(manifest.sql.bytes)||
    manifest.sql.bytes<1||manifest.sql.bytes>MAX_BACKUP_BYTES||JSON.stringify(manifest.migrations)!==JSON.stringify(migrations))throw new Error('备份清单或迁移版本不匹配');
  const file=path.join(directory,'database.sql');
  if((await stat(file)).size!==manifest.sql.bytes||sha256(await readFile(file))!==manifest.sql.sha256)throw new Error('SQL备份校验失败；禁止恢复');
  return manifest;
}
