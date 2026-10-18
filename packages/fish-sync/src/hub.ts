import {z} from 'zod';
import {canonicalJson,parseBoundedJson} from './index';
import type {HubPort,SyncRegion} from './coordinator';

const region=z.enum(['cn','global']);
const field=z.object({fishId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),field:z.enum(['caught','pinned','alarm']),value:z.boolean(),revision:z.number().int().positive()}).strict();
const change=field.omit({revision:true}).extend({expectedRevision:z.number().int().nonnegative()}).strict();
const intent=z.object({region,changes:z.array(change).min(1).max(200)}).strict()
  .refine((v)=>new Set(v.changes.map((c)=>`${c.fishId}:${c.field}`)).size===v.changes.length);
const snapshot=z.object({region,watermark:z.number().int().nonnegative(),fields:z.array(field).max(15000)});
const preview=z.object({region,token:z.uuid(),watermark:z.number().int().nonnegative(),expiresAt:z.number().int().positive(),changes:z.array(change).max(200)});
const result=z.object({auditId:z.uuid(),applied:z.number().int().min(0).max(200),replayed:z.boolean()});

export class HubTransportError extends Error{
  constructor(readonly code:'unauthorized'|'scope-mismatch'|'session-changed'|'network'|'invalid-response'|'http',readonly status=0){
    super(`Hub同步请求失败（${code}${status===0?'':`，${status}`}）；请保留检查点后重试`);this.name='HubTransportError';
  }
}

/** Fixed Hub endpoints only. Device tokens are read from a volatile closure, never serialized. */
export function createHubSyncPort(options:{hubOrigin:string;workspaceId:string;region:SyncRegion;getToken:()=>string|null|Promise<string|null>;fetch?:typeof fetch}):HubPort{
  const origin=new URL(options.hubOrigin);
  const local=origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  if((origin.protocol!=='https:'&&!local)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error('Hub必须为HTTPS源（本地回环除外）');
  const workspaceId=z.uuid().parse(options.workspaceId);const selectedRegion=region.parse(options.region);
  const network=options.fetch??fetch;
  const tokenOf=async():Promise<string>=>{
    const value=await options.getToken();
    if(value===null||value.length===0||value.length>4096||/\s/u.test(value))throw new HubTransportError('unauthorized');
    return value;
  };
  const assertSession=async(token:string):Promise<void>=>{if(await options.getToken()!==token)throw new HubTransportError('session-changed');};
  const request=async(path:string,token:string,body?:unknown):Promise<unknown>=>{
    await assertSession(token);
    let response:Response;
    try{response=await network(new URL(path,origin).href,{
      method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),
    });}catch{throw new HubTransportError('network');}
    if(!response.ok){await response.body?.cancel();throw new HubTransportError(response.status===401?'unauthorized':'http',response.status);}
    if(response.redirected || !(response.headers.get('Content-Type')??'').toLowerCase().startsWith('application/json')){
      await response.body?.cancel();throw new HubTransportError('invalid-response');
    }
    // Stream bound: do not trust Content-Length or allocate an unbounded response.text().
    let text='';let size=0;const reader=response.body?.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});
    try{
      if(reader!==undefined)while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(size>4*1048576){await reader.cancel();throw new Error('oversize');}text+=decoder.decode(part.value,{stream:true});}
      text+=decoder.decode();await assertSession(token);return parseBoundedJson(text,4*1048576);
    }catch(cause){if(cause instanceof HubTransportError)throw cause;throw new HubTransportError('invalid-response');}
    finally{reader?.releaseLock();}
  };
  const authorize=async():Promise<string>=>{
    const token=await tokenOf();
    const identity=z.object({id:z.uuid()}).safeParse(await request('/api/v1/me/profile',token));
    if(!identity.success)throw new HubTransportError('invalid-response');
    if(identity.data.id!==workspaceId)throw new HubTransportError('scope-mismatch');
    return token;
  };
  const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const parsed=schema.safeParse(value);if(!parsed.success)throw new HubTransportError('invalid-response');return parsed.data;};
  const assertRegion=(value:SyncRegion):void=>{if(value!==selectedRegion)throw new HubTransportError('scope-mismatch');};
  return {
    snapshot:async(value)=>{
      assertRegion(value);const state=parse(snapshot,await request(`/api/v1/me/fish-sync?region=${value}`,await authorize()));
      if(state.region!==value||new Set(state.fields.map((f)=>`${f.fishId}:${f.field}`)).size!==state.fields.length)throw new HubTransportError('invalid-response');
      return state;
    },
    preview:async(value,changes)=>{
      assertRegion(value);const body=intent.parse({region:value,changes});
      const state=parse(preview,await request('/api/v1/me/fish-sync/preview',await authorize(),body));
      if(state.region!==value||canonicalJson(state.changes)!==canonicalJson(body.changes))throw new HubTransportError('invalid-response');
      return {token:state.token,watermark:state.watermark,expiresAt:state.expiresAt};
    },
    apply:async(input)=>{
      const body=z.object({token:z.uuid(),operationId:z.uuid()}).strict().parse(input);
      const state=parse(result,await request('/api/v1/me/fish-sync/apply',await authorize(),body));
      return {applied:state.applied,replayed:state.replayed};
    },
  };
}
