import {forEachSequential,retrySequential} from "../../packages/shared/src/sequential-tasks.mjs";
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const targets={production:'https://ff14.zhixia.uk',preview:'https://ff14-preview.zhixia.uk'};
const workerTargets={production:'https://ff14-hub.3347759490.workers.dev',preview:'https://ff14-hub-preview.3347759490.workers.dev'};
const sha256=(value)=>createHash('sha256').update(new Uint8Array(value)).digest('hex');
class BrowserChallengeError extends Error {}

export async function verifyLive(environment,{fetcher=fetch,readAsset=(asset)=>readFile(path.join(root,'apps/web/dist',asset))}={}){
  if(!Object.hasOwn(targets,environment))throw new Error('Unknown release environment');
  const verifyAt=async(base)=>{
  const request=async(route)=>{
    const response=await fetcher(`${base}${route}`,{redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15000)});
    if(response.status===403&&response.headers.get('cf-mitigated')==='challenge')throw new BrowserChallengeError('Cloudflare browser challenge');
    if(response.status!==200)throw new Error(`Unexpected HTTP ${response.status} for ${route}`);
    return response;
  };
  const healthResponse=await request('/api/v1/health');
  const health=await healthResponse.json();
  if(health.status!=='ok'||health.environment!==environment||health.database!=='ok')throw new Error('Live environment/database health mismatch');
  if(!healthResponse.headers.get('Cache-Control')?.includes('no-store'))throw new Error('Health response must not be cached');
  const response=await request('/');
  if(!response.headers.get('Content-Security-Policy')?.includes("script-src 'self'"))throw new Error('Missing expected security policy');
  const html=await response.text();
  const assets=[...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9_.-]+)"/g)].map((match)=>match[1]))];
  if(assets.length<2)throw new Error('Missing frontend asset references');
  await forEachSequential(assets,async (asset)=>{
    const [local,remote]=await Promise.all([readAsset(asset),request(asset).then((assetResponse)=>assetResponse.arrayBuffer())]);
    if(sha256(local)!==sha256(remote))throw new Error('Live frontend differs from verified build');
  });
  return {environment,baseUrl:base,assetsVerified:assets.length};
  };
  try{return {...await verifyAt(targets[environment]),customDomainVerified:true};}
  catch(error){
    // This existing public hostname serves the same Worker. Do not change zone security
    // or claim a custom-domain check passed when a browser challenge prevents it.
    if(!(error instanceof BrowserChallengeError))throw error;
    return {...await verifyAt(workerTargets[environment]),customDomainVerified:false,
      warning:'Custom domain browser challenge; same Worker verified via existing workers.dev endpoint'};
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const report=await retrySequential(5,async attempt=>{
      try{return await verifyLive(process.argv[2]);}
      catch(error){console.error('Public deployment verification attempt '+(attempt+1)+'/5 failed');throw error;}
    },()=>new Promise(resolve=>setTimeout(resolve,5000)));
    console.log(JSON.stringify(report));
    if(!report.customDomainVerified){console.warn(report.warning);}
  }catch{process.exitCode=1;}
}
