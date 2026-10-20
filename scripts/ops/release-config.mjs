import ts from 'typescript';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function readConfig(file=path.join(root,'wrangler.jsonc')){
  const parsed=ts.parseConfigFileTextToJson(file,await readFile(file,'utf8'));
  if(parsed.error||!parsed.config||typeof parsed.config!=='object')throw new Error('配置不是有效JSONC对象');
  return parsed.config;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const forbidden=/(?:secret|password|passwd|private.?key|token|authorization|cookie|recovery.?key|webdav)/iu;
const originsValid=(value)=>typeof value==='string'&&(value===''||value.split(',').every((part)=>{
  try{const url=new URL(part.trim());return url.protocol==='https:'&&url.origin===part.trim();}catch{return false;}
}));

/** Static preparation check, deliberately cannot attest cloud resources or deployed secrets. */
export function inspectReleaseConfig(config){
  const targets=['preview','production'].map((environment)=>{
    const selected=config.env?.[environment];const blockers=[];
    const fail=(code)=>blockers.push(code);
    if(!selected){fail('missing-environment');return {environment,configurationReady:false,blockers};}
    if(selected.vars?.ENVIRONMENT!==environment)fail('environment-label');
    if(selected.vars?.ENABLE_TEST_ROUTES!=='0')fail('test-routes-not-explicitly-disabled');
    if(!originsValid(selected.vars?.ALLOWED_ORIGINS))fail('unsafe-or-missing-origins');
    if(Object.keys({...config.vars,...selected.vars}).some((key)=>forbidden.test(key)))fail('secret-in-public-vars');
    const databases=selected.d1_databases;
    if(!Array.isArray(databases)||databases.length!==1||databases[0]?.binding!=='DB')fail('database-binding');
    const db=databases?.[0];
    if(typeof db?.database_id!=='string'||!uuid.test(db.database_id)||db.database_id.startsWith('00000000-'))fail('placeholder-database-id');
    if(typeof db?.database_name!=='string'||db.database_name.length===0)fail('database-name');
    if(typeof selected.name!=='string'||selected.name.length===0)fail('worker-name');
    const assets=selected.assets??config.assets;
    if(assets?.binding!=='ASSETS'||assets.run_worker_first!==true||typeof assets.directory!=='string')fail('asset-security-boundary');
    const crons=(selected.triggers??config.triggers)?.crons;
    const localNotificationsOnly=environment==='production'&&Array.isArray(crons)&&crons.length===1&&crons[0]==='*/5 * * * *';
    if(!Array.isArray(crons)||(crons.length!==0&&!localNotificationsOnly))fail('cron-not-explicitly-disabled');
    return {environment,configurationReady:blockers.length===0,blockers};
  });
  const [a,b]=['preview','production'].map((name)=>config.env?.[name]);
  if(a&&b){
    const same=a.name===b.name||a.d1_databases?.[0]?.database_id===b.d1_databases?.[0]?.database_id||
      a.d1_databases?.[0]?.database_name===b.d1_databases?.[0]?.database_name;
    if(same)for(const target of targets){target.blockers.push('shared-environment-resource');target.configurationReady=false;}
  }
  return {formatVersion:1,kind:'static-configuration-check',configurationReady:targets.every((v)=>v.configurationReady),
    cloudResourcesVerified:false,secretsVerified:false,targets};
}
