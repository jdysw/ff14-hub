import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Deliberately fixed deployment targets: never send release credentials to a caller-provided URL.
const environment=process.argv[2];
if(environment!=='preview'&&environment!=='production'){
  throw new Error('Choose preview or production');
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// 目标域名必须为常量，不能从 argv 拼接主机名。
const baseUrl=environment==='preview'?'https://ff14-preview.zhixia.uk':'https://ff14.zhixia.uk';
const legacyBaseUrl=environment==='preview'
  ?'https://ff14-hub-preview.3347759490.workers.dev'
  :'https://ff14-hub.3347759490.workers.dev';
const directory=path.join(root,'.wrangler','release');await mkdir(directory,{recursive:true,mode:0o700});
const ownerFile=path.join(directory,`access.${environment}.json`);
const reportFile=path.join(directory,`smoke.${environment}.json`);
const seededFile=path.join(directory,`seeded.${environment}.json`);
const checks=[];
const check=(value,name)=>{if(!value)throw new Error(`Release check failed: ${name}`);checks.push(name);};
/** 只在固定发布域名内选择经过路径白名单验证的 API/静态资源。 */
function releaseRequestUrl(route){
  if(typeof route!=='string'||route.includes('#')){
    throw new Error('Invalid release verification path');
  }
  const separator=route.indexOf('?');
  const pathname=separator===-1?route:route.slice(0,separator);
  const query=separator===-1?'':route.slice(separator+1);
  const segments=pathname.split('/').slice(1);
  if(!pathname.startsWith('/')||pathname.startsWith('//')||
    (pathname!=='/'&&segments.some((segment)=>!segment||segment==='.'||segment==='..'||!/^[a-zA-Z0-9._~-]+$/.test(segment)))){
    throw new Error('Unexpected release verification route');
  }
  // 修改 URL 的 pathname/search 不会修改已固定的 origin；不会向用户输入的主机发送凭证。
  const target=new URL(baseUrl);
  target.pathname=pathname;
  target.search=query;
  if(target.origin!==baseUrl)throw new Error('Release origin mismatch');
  return target;
}
async function request(route,{token,body,method=body===undefined?'GET':'POST',status=200,headers={}}={}){
  const response=await fetch(releaseRequestUrl(route),{method,headers:{...headers,
    ...(token===undefined?{}:{Authorization:`Bearer ${token}`}),...(body===undefined?{}:{'Content-Type':'application/json'}),
  },...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(20000)});
  if(response.status!==status)throw new Error(`HTTP ${response.status} for ${method} ${route.split('?')[0]}; expected ${status}`);
  if(route.startsWith('/api/'))check(response.headers.get('Cache-Control')?.includes('no-store'),`no-store ${route.split('?')[0]}`);
  return response;
}
const api=async(route,options)=>{const response=await request(`/api/v1${route}`,options);return response.status===204?null:response.json();};
const digest=(value)=>createHash('sha256').update(value instanceof ArrayBuffer?new Uint8Array(value):value).digest('hex');
async function main(){
  const htmlResponse=await request('/');const html=await htmlResponse.text();
  check(htmlResponse.headers.get('Content-Security-Policy')?.includes("script-src 'self'"),'strict CSP');
  check(htmlResponse.headers.has('Strict-Transport-Security'),'HTTPS HSTS');
  const assetPaths=[...html.matchAll(/(?:src|href)="(\/assets\/[a-zA-Z0-9._~-]+)"/g)].map((m)=>m[1]);
  check(assetPaths.length>=2,'HTML references built assets');
  for(const route of new Set(assetPaths)){
    const local=await readFile(path.join(root,'apps/web/dist',route));
    check(digest(await (await request(route)).arrayBuffer())===digest(local),`asset integrity ${route}`);
  }
  const health=await api('/health');check(health.status==='ok'&&health.environment===environment,'live environment and database');
  await api('/me/profile',{status:401});checks.push('anonymous private access denied');
  await api('/__test__/boom',{status:404});checks.push('test route disabled');
  let owner;
  try{owner=JSON.parse(await readFile(ownerFile,'utf8'));}
  catch(error){
    if(error?.code!=='ENOENT')throw error;
    const secrets=JSON.parse(await readFile(path.join(directory,`secrets.${environment}.json`),'utf8'));
    const created=await api('/identity/bootstrap',{status:201,body:{deviceName:'Alpha owner desktop'},headers:{'X-Bootstrap-Secret':secrets.BOOTSTRAP_SECRET}});
    owner={baseUrl,workspaceId:created.workspaceId,deviceId:created.device.id,deviceToken:created.deviceToken,recoveryKey:created.recoveryKey,createdAt:new Date().toISOString()};
    if(typeof owner.deviceToken!=='string'||typeof owner.recoveryKey!=='string')throw new Error('Initialization returned incomplete credentials',{cause:error});
    // Save immediately before any later mutation. Never print credential-bearing API responses.
    await writeFile(ownerFile,JSON.stringify(owner,null,2),{flag:'wx',mode:0o600});
  }
  check(owner.baseUrl===baseUrl||owner.baseUrl===legacyBaseUrl,'credential target matches environment');
  if(owner.baseUrl===legacyBaseUrl){
    owner.baseUrl=baseUrl;
    await writeFile(ownerFile,JSON.stringify(owner,null,2),{mode:0o600});
  }
  const token=owner.deviceToken;
  const profile=await api('/me/profile',{token});check(profile.id===owner.workspaceId,'owner authenticated');
  for(const id of ['ff14.navigation','ff14.events']){
    const current=(await api(`/me/modules/${id}`,{token})).module;
    if(current.status!=='enabled')await api(`/me/modules/${id}`,{token,method:'PATCH',body:{action:'enable',expectedRevision:current.revision}});
  }
  let seeded=false;
  try{await readFile(seededFile,'utf8');seeded=true;}
  catch(error){if(error?.code!=='ENOENT')throw error;}
  if(!seeded){
    const pages=(await api('/me/pages',{token})).pages;
    const page=pages.find((p)=>p.name==='起始页')??(await api('/me/pages',{token,status:201,body:{name:'起始页',operationId:randomUUID()}})).page;
    const existing=(await api(`/me/pages/${page.id}/widgets`,{token})).instances;
    for(const [widgetType,config] of [['nav-search',{title:'个人导航搜索'}],['nav-quick-links',{title:'常用网站',favoritesOnly:false}],['events-upcoming',{}]]){
      if(!existing.some((item)=>item.widgetType===widgetType))await api(`/me/pages/${page.id}/widgets`,{token,status:201,body:{widgetType,config,operationId:randomUUID()}});
    }
    await writeFile(seededFile,JSON.stringify({pageId:page.id}),{flag:'wx',mode:0o600});
  }
  const link=(await api('/me/navigation/links',{token,status:201,body:{title:'上线验证临时链接',url:'https://example.com/alpha-release-check',region:'cn',operationId:randomUUID()}})).link;
  check((await api('/me/navigation/links',{token})).links.some((row)=>row.id===link.id),'navigation write/read');
  await api(`/me/navigation/links/${link.id}`,{token,method:'DELETE',body:{expectedRevision:link.revision,operationId:randomUUID()}});
  check(!(await api('/me/navigation/links',{token})).links.some((row)=>row.id===link.id),'navigation deletion preserved');
  await api('/me/navigation/links',{token,status:403,body:{title:'must not be created',url:'https://example.com',region:'cn',operationId:randomUUID()},headers:{Origin:'https://foreign.invalid'}});
  checks.push('foreign Origin rejected');
  const event=(await api('/me/events',{token,status:201,body:{title:'上线验证临时活动',region:'cn',startsAt:Date.now()+3600000,endsAt:Date.now()+7200000,operationId:randomUUID()}})).event;
  await api(`/me/events/${event.id}`,{token,method:'DELETE',body:{expectedRevision:event.revision,operationId:randomUUID()}});checks.push('manual event write/delete');
  const backup=await api('/me/workbench/backup',{token});check(!JSON.stringify(backup).includes(token),'workbench backup excludes device token');
  const operations=await api('/me/operations?region=cn',{token});
  check(operations.scheduler.cadenceVerified===false&&operations.sync.webdavFreshnessAvailable===false,'unfinished integrations labeled');
  if(environment==='production'){
    const previewOwner=JSON.parse(await readFile(path.join(directory,'access.preview.json'),'utf8'));
    await api('/me/profile',{token:previewOwner.deviceToken,status:401});checks.push('preview credential rejected in production');
  }
  const report={environment,baseUrl,checkedAt:new Date().toISOString(),passed:true,checks};
  await writeFile(reportFile,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({environment,baseUrl,passed:true,checks:checks.length,report:path.relative(root,reportFile),credentials:path.relative(root,ownerFile)},null,2));
}
try{await main();}catch(error){console.error(error instanceof Error?error.message:'Alpha verification failed');process.exitCode=1;}
