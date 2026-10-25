import {retrySequential} from "../../packages/shared/src/sequential-tasks.mjs";
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {verifyLive} from './verify-live.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
/** 人工发布必须来自 clean main checkout；不能只凭使用者自填 WORKERS_CI_BRANCH。 */
export function checkoutState(){
  const executable=process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'/usr/bin/git';
  const git=(args)=>execFileSync(executable,args,{cwd:root,encoding:'utf8',timeout:10000}).trim();
  return {branch:git(['branch','--show-current']),clean:git(['status','--porcelain']).length===0};
}
export function releaseGuard(environment,variables,checkout=null){
  if(!['production','preview'].includes(environment))throw new Error('Unknown release environment');
  if(environment!=='production')return;
  const workersBuilds=variables.WORKERS_CI==='1'&&variables.WORKERS_CI_BRANCH==='main';
  if(workersBuilds)return;
  const manual=variables.FF14_MANUAL_RELEASE_APPROVAL==='ff14-hub-production';
  if(!manual)throw new Error('Production release requires main Workers Builds or explicit manual approval');
  if(checkout?.branch!=='main'||!checkout.clean)throw new Error('Manual production release requires a clean main checkout');
}
export function checkedWranglerArguments(args){
  if(!Array.isArray(args)||args.some(value=>typeof value!=='string')){throw new Error('Invalid release command');}
  const upload=args.length===9&&args[0]==='versions'&&args[1]==='upload'&&args[2]==='--env'&&
    args[4]==='--keep-vars'&&args[5]==='--tag'&&args[7]==='--message';
  const deploy=args.length===8&&args[0]==='versions'&&args[1]==='deploy'&&args[3]==='--env'&&
    args[5]==='--yes'&&args[6]==='--message';
  if(!upload&&!deploy){throw new Error('Invalid release command');}
  const environment=upload?args[3]:args[4];
  if(environment!=='production'&&environment!=='preview'){throw new Error('Invalid release target');}
  if(upload){
    const revision=String(args[8]).slice('Verified CI release '.length);
    if(args[6]!=='automated-'+environment||args[8]!=='Verified CI release '+revision||
      !/^(?:[a-f0-9]{12}|verified-build)$/.test(revision)){throw new Error('Invalid upload arguments');}
    return ['versions','upload','--env',environment,'--keep-vars','--tag','automated-'+environment,'--message','Verified CI release '+revision];
  }
  const revision=String(args[7]).slice('Verified main release '.length);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}@100$/i.test(args[2])||
    args[7]!=='Verified main release '+revision||!/^(?:[a-f0-9]{12}|verified-build)$/.test(revision)){
    throw new Error('Invalid deployment arguments');
  }
  return ['versions','deploy',args[2],'--env',environment,'--yes','--message','Verified main release '+revision];
}
async function wrangler(args){
  const checked=checkedWranglerArguments(args);
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),...checked],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});let output='';
    child.stdout.on('data',chunk=>{output+=chunk.toString();process.stdout.write(chunk);});child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error('Wrangler failed with exit '+code)));
  });
}
export async function releaseWorker(environment,{variables=process.env,run=wrangler,verify=verifyLive,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const manual=environment==='production'&&!(variables.WORKERS_CI==='1'&&variables.WORKERS_CI_BRANCH==='main');
  releaseGuard(environment,variables,manual?checkoutState():null);
  const revision=/^[a-f0-9]{40}$/.test(variables.WORKERS_CI_COMMIT_SHA??'')?variables.WORKERS_CI_COMMIT_SHA.slice(0,12):'verified-build';
  const output=await run(['versions','upload','--env',environment,'--keep-vars','--tag','automated-'+environment,'--message','Verified CI release '+revision]);
  const version=/Worker Version ID:\s*([a-f0-9]{8}-[a-f0-9-]{27})/i.exec(output)?.[1];
  if(!version)throw new Error('Uploaded version was not confirmed; traffic was not changed');
  await run(['versions','deploy',version+'@100','--env',environment,'--yes','--message','Verified main release '+revision]);
  const report=await retrySequential(5,()=>verify(environment),()=>sleep(5000));
  return {version,...report};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await releaseWorker(process.argv[2])));}catch(error){console.error(error instanceof Error?error.message:'Release failed');process.exitCode=1;}
}
