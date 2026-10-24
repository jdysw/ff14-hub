import {z} from 'zod';
import {localBackupSchema,localDataSchema,type LocalData,type LocalStore} from './store';

export const remoteConfigSchema=z.object({provider:z.enum(['webdav','s3']),url:z.string().min(1).max(2048),
  username:z.string().max(500),password:z.string().max(2000),region:z.string().regex(/^[a-z0-9-]{1,50}$/),
  accessKey:z.string().max(256),secretKey:z.string().max(2000),sessionToken:z.string().max(4000)}).strict();
export type RemoteConfig=z.infer<typeof remoteConfigSchema>;
export const emptyRemoteConfig:RemoteConfig={provider:'webdav',url:'',username:'',password:'',region:'auto',accessKey:'',secretKey:'',sessionToken:''};
export class RemoteSyncError extends Error{
  constructor(readonly code:'config'|'network'|'auth'|'etag'|'format'|'conflict'|'read'|'write',message:string){super(message);this.name='RemoteSyncError';}
}
export function remoteFailureMessage(cause:unknown):string{
  if(cause instanceof RemoteSyncError)return cause.message;
  if(cause instanceof z.ZodError)return '配置或备份格式不正确，请检查必填项及备份来源；原有数据未被替换。';
  if(cause instanceof Error&&cause.message.startsWith('本机'))return '本机数据或配置已变化，请重新读取预览；远端已确认的写入仍会保留。';
  return '操作未完成，请检查配置并重新读取预览；写入中断时先读取远端确认结果。';
}
const encoder=new TextEncoder();
const hex=(raw:ArrayBuffer)=>Array.from(new Uint8Array(raw),b=>b.toString(16).padStart(2,'0')).join('');
const digest=async(text:string)=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
const hmac=async(key:Uint8Array,text:string)=>new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',new Uint8Array(key),{name:'HMAC',hash:'SHA-256'},false,['sign']),encoder.encode(text)));
export function remoteUrl(raw:string,hubOrigin=location.origin):URL{
  let url:URL;try{url=new URL(raw);}catch{throw new RemoteSyncError('config','请填写完整的 HTTPS 文件地址，例如 https://dav.example.com/ff14/personal.json。');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.origin===hubOrigin||url.pathname.endsWith('/'))throw new RemoteSyncError('config','请填写独立 HTTPS 服务上的完整文件地址，不要包含账号、查询参数或目录尾斜杠');
  return url;
}
/** AWS SigV4 for a single, exact S3 object URL (virtual-host or path style). */
export async function s3Headers(config:RemoteConfig,method:string,body:string,headers:Record<string,string>,now=new Date()):Promise<Record<string,string>>{
  const url=remoteUrl(config.url),date=now.toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8);
  const hash=await digest(body),signed:Record<string,string>={host:url.host,'x-amz-content-sha256':hash,'x-amz-date':date,...headers};
  if(config.sessionToken)signed['x-amz-security-token']=config.sessionToken;
  // SigV4 的 CanonicalHeaders 必须使用字节序，而不是受系统 locale 影响的排序。
   const names=Object.keys(signed).sort((a,b)=>{
     if(a<b)return -1;
     if(a>b)return 1;
     return 0;
   }),scope=`${day}/${config.region}/s3/aws4_request`;
  const canonical=[method,url.pathname,'',names.map(name=>`${name}:${signed[name]!.trim()}\n`).join(''),names.join(';'),hash].join('\n');
  let key=await hmac(encoder.encode('AWS4'+config.secretKey),day);
  for(const part of [config.region,'s3','aws4_request'])key=await hmac(key,part);
  const signature=hex((await hmac(key,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${await digest(canonical)}`)).buffer);
  const {host:_,...result}=signed;void _;
  return {...result,Authorization:`AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`};
}
export function createRemoteClient(input:RemoteConfig,fetcher:typeof fetch=fetch){
  const config=remoteConfigSchema.parse(input),url=remoteUrl(config.url).href;
  if(config.provider==='webdav'&&config.username.includes(':'))throw new RemoteSyncError('config','WebDAV 用户名不能包含冒号');
  if(config.provider==='s3'&&(!config.accessKey||!config.secretKey))throw new RemoteSyncError('config','请填写 S3 Access Key 和 Secret Key');
  async function request(method:string,body='',extra:Record<string,string>={}){
    let headers:Record<string,string>={...extra};
    if(config.provider==='s3')headers=await s3Headers(config,method,body,headers);
    else headers['Authorization']='Basic '+btoa(Array.from(encoder.encode(config.username+':'+config.password),b=>String.fromCharCode(b)).join(''));
    try{return await fetcher(url,{method,headers,...(method==='PUT'?{body}:{}),redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(30_000)});}
    catch{throw new RemoteSyncError('network','浏览器无法连接远端，可能是网络或 CORS 限制，无法在此准确区分。请检查地址、允许的 Origin 和请求头；写入中断后先重新预览。');}
  }
  return {
    async read(){
      const response=await request('GET');if(response.status===404)return {etag:null,data:null};
      if(response.status===401||response.status===403)throw new RemoteSyncError('auth',`远端拒绝访问（${response.status}），请检查账号、应用口令或对象读取权限。`);
      if(!response.ok)throw new RemoteSyncError('read',`远端读取失败（${response.status}），请检查服务状态后重试。`);
      const etag=response.headers.get('ETag');
      if(!etag||!/^"[^"\r\n]+"$/.test(etag))throw new RemoteSyncError('etag','已连接远端，但未取得强 ETag。请暴露 ETag 响应头，并确认服务提供强版本标识；暂不允许覆盖写入。');
      if(Number(response.headers.get('Content-Length')??0)>8*1024*1024)throw new Error('远端备份超过 8 MiB');
      const reader=response.body?.getReader();let text='',size=0;const decoder=new TextDecoder();
      if(reader){while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8*1024*1024){await reader.cancel();throw new Error('远端备份超过 8 MiB');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
      try{return {etag,data:localBackupSchema.parse(JSON.parse(text.replace(/^\uFEFF/,'')) as unknown).data};}
      catch{throw new RemoteSyncError('format','文件可读取，但不是本站的完整个人备份。请选择独立的 personal.json，不要填写鱼糕原始数据文件。');}
    },
    async write(data:LocalData,etag:string|null){
      const body=JSON.stringify(localBackupSchema.parse({format:'ff14-hub-local',version:1,exportedAt:new Date().toISOString(),data}));
      if(encoder.encode(body).byteLength>8*1024*1024)throw new Error('备份超过 8 MiB');
      const response=await request('PUT',body,{'content-type':'application/json',...(etag===null?{'if-none-match':'*'}:{'if-match':etag})});
      if(response.status===412||response.status===409)throw new RemoteSyncError('conflict','远端已被其他设备修改，请重新预览，未覆盖远端数据');
      if(response.status===401||response.status===403)throw new RemoteSyncError('auth',`远端拒绝写入（${response.status}），请检查对象写入权限；原预览不能证明可写。`);
      if(!response.ok)throw new RemoteSyncError('write',`远端写入失败（${response.status}），请重新读取确认远端结果。`);
    },
  };
}
const canonical=(value:unknown):string=>{
  if(value===undefined)return 'undefined';
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
};
export interface SyncConflict{key:string;label:string;local:unknown;remote:unknown}
function entries(data:LocalData){
  const map=new Map<string,unknown>([['configuration',data.configuration]]);
  for(const link of data.links)map.set('link:'+link.id,link);
  for(const note of data.notes)map.set('note:'+note.id,note);
  for(const region of ['cn','global'] as const)for(const field of data.fish[region])map.set(`fish:${region}:${field.fishId}:${field.field}`,field.value);
  return map;
}
export function mergePersonalData(base:LocalData|null,local:LocalData,remote:LocalData|null,choices:Record<string,'local'|'remote'>={}){
  if(!remote)return {data:localDataSchema.parse(local),conflicts:[] as SyncConflict[]};
  const b=base?entries(base):new Map<string,unknown>(),l=entries(local),r=entries(remote),out=new Map<string,unknown>(),conflicts:SyncConflict[]=[];
  for(const key of new Set([...b.keys(),...l.keys(),...r.keys()])){
    const before=b.get(key),left=l.get(key),right=r.get(key);let value:unknown;
    if(canonical(left)===canonical(right))value=left;
    else if(base&&canonical(left)===canonical(before))value=right;
    else if(base&&canonical(right)===canonical(before))value=left;
    else if(!base&&!l.has(key))value=right;
    else if(!base&&!r.has(key))value=left;
    else if(choices[key])value=choices[key]==='local'?left:right;
    else{const item=(left??right) as {title?:string}|undefined;conflicts.push({key,label:key==='configuration'?'首页设置':item?.title??key,local:left,remote:right});value=left;}
    if(value!==undefined)out.set(key,value);
  }
  const data:LocalData={...local,links:[],notes:[],fish:{cn:[],global:[]},configuration:out.get('configuration') as LocalData['configuration']};
  for(const [key,value] of out){
    if(key.startsWith('link:'))data.links.push(value as LocalData['links'][number]);
    if(key.startsWith('note:'))data.notes.push(value as LocalData['notes'][number]);
    if(key.startsWith('fish:')){const [,region,id,field]=key.split(':') as [string,'cn'|'global',string,'caught'|'pinned'|'alarm'];
      const old=local.fish[region].find(f=>f.fishId===Number(id)&&f.field===field);
      data.fish[region].push({region,fishId:Number(id),field,value:value as boolean,revision:(old?.revision??0)+1,updatedAt:Date.now()});}
  }
  return {data:localDataSchema.parse(data),conflicts};
}
export async function applyPersonalSync(store:LocalStore,expectedRevision:number,data:LocalData){
  await store.change(document=>{if(document.data.revision!==expectedRevision)throw new Error('本机数据已变化，请重新预览；远端同步结果已保留');document.data=localDataSchema.parse(data);document.operations=[];});
}
