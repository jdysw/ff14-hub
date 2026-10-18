import { z } from 'zod';
import { changedDocumentKeys,fishDocumentSchema,parseBoundedJson,parseFishDocument,serializeFishDocument,type FishDocument } from './index';
const strongTag=z.string().regex(/^"[^"\r\n]*"$/);
const common={schemaVersion:z.literal(1),region:z.enum(['cn','global']),revision:z.number().int().positive(),
  transactionId:z.uuid(),document:fishDocumentSchema,documentHash:z.string().regex(/^[a-f0-9]{64}$/),fieldRevisions:z.record(z.string().regex(/^(?:completed|pinned|alarmFish):[1-9]\d*$|^extra:/),z.number().int().nonnegative()).default({})};
const committedSchema=z.object({...common,state:z.literal('committed'),previousDocument:fishDocumentSchema.nullable()}).strict();
const preparedSchema=z.object({...common,state:z.literal('prepared'),beforeHash:z.string().nullable(),beforeEtag:strongTag.nullable(),beforeDocument:fishDocumentSchema.nullable()}).strict();
export const sidecarSchema=z.discriminatedUnion('state',[committedSchema,preparedSchema]);
export type Sidecar=z.infer<typeof sidecarSchema>;
export interface DavFile{exists:boolean;etag:string|null;text:string|null}
export interface DavPair{fish:DavFile;sidecar:DavFile;document:FishDocument|null;metadata:Sidecar|null;sidecarFresh:boolean}
export class DavConflict extends Error{constructor(message='WebDAV已变化，请重新读取并预览'){super(message);this.name='DavConflict';}}
export async function documentHash(document:FishDocument):Promise<string>{
  const bytes=new TextEncoder().encode(serializeFishDocument(document));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map((b)=>b.toString(16).padStart(2,'0')).join('');
}
/** Browser-only capability. No request in this adapter is sent through the Hub API. */
export function createWebDavClient(options:{baseUrl:string;hubOrigin:string;username:string;password:string;fetch?:typeof fetch}){
  const base=new URL(options.baseUrl);
  if(base.protocol!=='https:'||base.username!==''||base.password!==''||base.search!==''||base.hash!==''||base.origin===new URL(options.hubOrigin).origin)
    throw new Error('WebDAV须使用独立HTTPS地址，不能嵌入凭证或指向Hub源');
  if(!base.pathname.endsWith('/'))base.pathname+='/';
  if(options.username.includes(':')||options.username.length>500||options.password.length>2000)throw new Error('WebDAV凭证格式不合法');
  const auth='Basic '+btoa(String.fromCharCode(...new TextEncoder().encode(`${options.username}:${options.password}`)));
  const network=options.fetch??fetch;
  let conditionalVerified=false;
  const request=async(name:string,method:string,body?:string,condition?:Record<string,string>):Promise<Response>=>{
    try{return await network(new URL(name,base).href,{method,headers:{Authorization:auth,...(body===undefined?{}:{'Content-Type':'application/json'}),...condition},
      ...(body===undefined?{}:{body}),redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});}
    catch{throw new Error('WebDAV网络或CORS请求失败；请重新读取以确认是否已写入');}
  };
  const textOf=async(response:Response):Promise<string>=>{
    if(Number(response.headers.get('Content-Length')??0)>4*1048576){await response.body?.cancel();throw new RangeError('WebDAV文件超过4MiB');}
    if(response.body===null)return '';
    const reader=response.body.getReader();const decoder=new TextDecoder();let bytes=0;let text='';
    while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
      if(bytes>4*1048576){await reader.cancel();throw new RangeError('WebDAV文件超过4MiB');}text+=decoder.decode(value,{stream:true});}
    return text+decoder.decode();
  };
  const read=async(name:string):Promise<DavFile>=>{
    const response=await request(name,'GET');
    if(response.status===404){await response.body?.cancel();return {exists:false,etag:null,text:null};}
    if(!response.ok){await response.body?.cancel();throw new Error(`WebDAV读取失败（${String(response.status)}）`);}
    const etag=strongTag.safeParse(response.headers.get('ETag'));
    if(!etag.success){await response.body?.cancel();throw new Error('WebDAV缺少可读的强ETag，已停止写入');}
    return {exists:true,etag:etag.data,text:await textOf(response)};
  };
  const put=async(name:string,text:string,etag:string|null):Promise<string>=>{
    if(!conditionalVerified)throw new Error('尚未验证条件写支持');
    parseBoundedJson(text,4*1048576);
    const response=await request(name,'PUT',text,etag===null?{'If-None-Match':'*'}:{'If-Match':strongTag.parse(etag)});
    await response.body?.cancel();
    if(response.status===409||response.status===412)throw new DavConflict();
    if(!response.ok)throw new Error(`WebDAV写入失败（${String(response.status)}），请恢复检查`);
    const tag=strongTag.safeParse(response.headers.get('ETag'));
    if(!tag.success)throw new Error('写入后缺少强ETag，请恢复检查');return tag.data;
  };
  const probe=async():Promise<void>=>{
    const name=`.ff14-hub-probe-${crypto.randomUUID()}.json`;let etag:string|null=null;
    try{
      const created=await request(name,'PUT','{}',{'If-None-Match':'*'});await created.body?.cancel();
      if(!created.ok)throw new Error('无法创建条件写探测文件');etag=strongTag.parse(created.headers.get('ETag'));
      const duplicate=await request(name,'PUT','{}',{'If-None-Match':'*'});await duplicate.body?.cancel();
      const stale=await request(name,'PUT','{}',{'If-Match':`"${crypto.randomUUID()}"`});await stale.body?.cancel();
      if(duplicate.status!==412||stale.status!==412)throw new Error('WebDAV未遵守条件写，已停止；未修改fish文件');
      conditionalVerified=true;
    }finally{if(etag!==null){try{const response=await request(name,'DELETE',undefined,{'If-Match':etag});await response.body?.cancel();}catch{/* Only an isolated probe may remain. */}}}
  };
  const readPair=async():Promise<DavPair>=>{
    // Metadata is read on both sides of fish.json, so a cooperative writer cannot hide its prepare.
    for(let attempt=0;attempt<3;attempt+=1){
      const before=await read('fish.sync.json');const fish=await read('fish.json');const after=await read('fish.sync.json');
      if(before.etag!==after.etag)continue;
      const document=fish.text===null?null:parseFishDocument(fish.text);
      const metadata=after.text===null?null:sidecarSchema.parse(parseBoundedJson(after.text,4*1048576));
      // Apply the same bounded/depth-safe parsing to sidecar copies, before using them.
      if(metadata!==null){parseFishDocument(JSON.stringify(metadata.document));
        if(await documentHash(metadata.document)!==metadata.documentHash)throw new DavConflict('同步元数据内容校验失败');
        if(metadata.state==='prepared'&&metadata.beforeDocument!==null)parseFishDocument(JSON.stringify(metadata.beforeDocument));
        if(metadata.state==='committed'&&metadata.previousDocument!==null)parseFishDocument(JSON.stringify(metadata.previousDocument));}
      return {fish,sidecar:after,document,metadata,sidecarFresh:document!==null&&metadata?.state==='committed'&&metadata.documentHash===await documentHash(document)};
    }
    throw new DavConflict('WebDAV在读取期间持续变化，已停止');
  };
  const resume=async(pair:DavPair):Promise<DavPair>=>{
    if(!conditionalVerified)await probe();
    const pending=pair.metadata;if(pending?.state!=='prepared')return pair;
    if(await documentHash(pending.document)!==pending.documentHash)throw new DavConflict('待恢复文档校验失败');
    const current=pair.document===null?null:await documentHash(pair.document);
    if(current!==pending.documentHash){
      if(current!==pending.beforeHash||pair.fish.etag!==pending.beforeEtag)throw new DavConflict('中断期间有其他修改，须重新合并；待恢复内容仍保留');
      await put('fish.json',serializeFishDocument(pending.document),pair.fish.etag);
    }
    const committed=z.object(committedSchema.shape).parse({schemaVersion:1,state:'committed',region:pending.region,revision:pending.revision,
      transactionId:pending.transactionId,document:pending.document,documentHash:pending.documentHash,fieldRevisions:pending.fieldRevisions,previousDocument:pending.beforeDocument});
    await put('fish.sync.json',JSON.stringify(committed),pair.sidecar.etag);
    const final=await readPair();
    if(!final.sidecarFresh||final.metadata?.transactionId!==pending.transactionId)throw new DavConflict('提交后检测到其他写入，请读取当前状态重新合并');
    return final;
  };
  const commit=async(document:FishDocument,region:'cn'|'global',expected:DavPair,touched:ReadonlySet<string>=new Set()):Promise<DavPair>=>{
    if(expected.metadata?.state==='prepared')throw new DavConflict('请先恢复上一次提交');
    if(expected.metadata!==null&&expected.metadata.region!==region)throw new DavConflict('WebDAV目录属于另一区服');
    if(!conditionalVerified)await probe();
    const serialized=serializeFishDocument(document);const verified=parseFishDocument(serialized);
    const revisions=new Map(Object.entries(expected.metadata?.fieldRevisions??{}));
    const changed=changedDocumentKeys(expected.document,verified);
    if(expected.metadata!==null&&expected.document!==null)for(const key of changedDocumentKeys(expected.metadata.document,expected.document))changed.add(key);
    for(const key of touched)changed.add(key);
    if(changed.size>20000)throw new RangeError('字段修订数量超出上限');
    for(const key of changed)revisions.set(key,(revisions.get(key)??0)+1);
    if(revisions.size>20000)throw new RangeError('累计字段修订数量超出上限');
    const prepared:z.infer<typeof preparedSchema>={schemaVersion:1,state:'prepared',region,revision:(expected.metadata?.revision??0)+1,
      transactionId:crypto.randomUUID(),beforeHash:expected.document===null?null:await documentHash(expected.document),
      beforeEtag:expected.fish.etag,beforeDocument:expected.document,document:verified,documentHash:await documentHash(verified),fieldRevisions:Object.fromEntries(revisions)};
    const tag=await put('fish.sync.json',JSON.stringify(preparedSchema.parse(prepared)),expected.sidecar.etag);
    return resume({...expected,metadata:prepared,sidecar:{exists:true,etag:tag,text:JSON.stringify(prepared)}});
  };
  return {readPair,probeConditionalWrites:probe,commit,resume};
}
