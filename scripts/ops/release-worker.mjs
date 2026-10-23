import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {verifyLive} from './verify-live.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function releaseGuard(environment,variables){
  if(!['production','preview'].includes(environment))throw new Error('Unknown release environment');
  if(environment==='production'&&(variables.WORKERS_CI!=='1'||variables.WORKERS_CI_BRANCH!=='main'))throw new Error('Automatic production release requires a main-branch Workers Builds run');
}
async function wrangler(args){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),...args],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',chunk=>{output+=chunk.toString();process.stdout.write(chunk);});child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error('Wrangler failed with exit '+code)));
  });
}
export async function releaseWorker(environment,{variables=process.env,run=wrangler,verify=verifyLive,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  releaseGuard(environment,variables);
  const revision=/^[a-f0-9]{40}$/.test(variables.WORKERS_CI_COMMIT_SHA??'')?variables.WORKERS_CI_COMMIT_SHA.slice(0,12):'verified-build';
  const output=await run(['versions','upload','--env',environment,'--keep-vars','--tag','automated-'+environment,'--message','Verified CI release '+revision]);
  const version=/Worker Version ID:\s*([a-f0-9]{8}-[a-f0-9-]{27})/i.exec(output)?.[1];
  if(!version)throw new Error('Uploaded version was not confirmed; traffic was not changed');
  await run(['versions','deploy',version+'@100','--env',environment,'--yes','--message','Verified main release '+revision]);
  let last;
  for(let attempt=0;attempt<5;attempt++){
    try{return {version,...await verify(environment)};}catch(error){last=error;if(attempt<4)await sleep(5000);}
  }
  throw last;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await releaseWorker(process.argv[2])));}catch(error){console.error(error instanceof Error?error.message:'Release failed');process.exitCode=1;}
}
