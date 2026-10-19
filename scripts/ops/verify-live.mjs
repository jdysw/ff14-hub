import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const targets={production:'https://ff14.zhixia.uk',preview:'https://ff14-preview.zhixia.uk'};
const sha256=(value)=>createHash('sha256').update(new Uint8Array(value)).digest('hex');

export async function verifyLive(environment,{fetcher=fetch,readAsset=(asset)=>readFile(path.join(root,'apps/web/dist',asset))}={}){
  if(!Object.hasOwn(targets,environment))throw new Error('Unknown release environment');
  const base=targets[environment];
  const request=async(route)=>{
    const response=await fetcher(`${base}${route}`,{redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15000)});
    if(response.status!==200)throw new Error(`Unexpected HTTP status for ${route}`);
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
  for(const asset of assets){
    const [local,remote]=await Promise.all([readAsset(asset),request(asset).then((assetResponse)=>assetResponse.arrayBuffer())]);
    if(sha256(local)!==sha256(remote))throw new Error('Live frontend differs from verified build');
  }
  return {environment,baseUrl:base,assetsVerified:assets.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let passed=false;
  for(let attempt=1;attempt<=5;attempt++){
    try{console.log(JSON.stringify(await verifyLive(process.argv[2])));passed=true;break;}
    catch{console.error(`Public deployment verification attempt ${attempt}/5 failed`);}
    if(attempt<5)await new Promise((resolve)=>setTimeout(resolve,5000));
  }
  if(!passed)process.exitCode=1;
}
