import { describe,it,expect } from 'vitest';
import { createWebDavClient,DavConflict } from '../src/webdav';
import { touchedSince,type FishDocument } from '../src/index';
const original:FishDocument={completed:[1],pinned:[],alarmFish:[9],future:{preserve:true}};
function server(){
  const files=new Map<string,{text:string;etag:string}>();let seq=0;let ignoreConditions=false;let failFish=false;let loseFishResponse=false;
  const requests:{path:string;method:string;headers:Headers}[]=[];
  const write=(path:string,text:string)=>{const row={text,etag:`"${String(++seq)}"`};files.set(path,row);return row;};
  const network:typeof fetch=async(input,init)=>{
    const address=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    const path=new URL(address).pathname.split('/').at(-1)??'';const headers=new Headers(init?.headers);const method=init?.method??'GET';
    requests.push({path,method,headers});expect(address).toMatch(/^https:\/\/dav.test\/private\//);expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');
    const row=files.get(path);
    if(method==='GET')return row===undefined?new Response(null,{status:404}):new Response(row.text,{headers:{ETag:row.etag}});
    if(!ignoreConditions&&((headers.get('If-None-Match')==='*'&&row!==undefined)||(headers.has('If-Match')&&headers.get('If-Match')!==row?.etag)))return new Response(null,{status:412});
    if(method==='DELETE'){files.delete(path);return new Response(null,{status:204});}
    if(path==='fish.json'&&failFish){failFish=false;throw new Error('interrupted');}
    const stored=write(path,typeof init?.body==='string'?init.body:await new Response(init?.body).text());
    if(path==='fish.json'&&loseFishResponse){loseFishResponse=false;throw new Error('response lost');}
    return new Response(null,{status:201,headers:{ETag:stored.etag}});
  };
  const client=()=>createWebDavClient({baseUrl:'https://dav.test/private/',hubOrigin:'https://hub.test',username:'dav-user',password:'client-only',fetch:network});
  return {files,requests,write,client,ignore:()=>{ignoreConditions=true;},interrupt:()=>{failFish=true;},lose:()=>{loseFishResponse=true;}};
}
describe('conditional dual-file protocol',()=>{
  it('creates and updates both files with strong conditions and preserves data plus independent field revisions',async()=>{
    const s=server();const client=s.client();const one=await client.commit(original,'cn',await client.readPair());
    expect(one.sidecarFresh).toBe(true);expect(one.metadata?.revision).toBe(1);
    const two=await client.commit({...original,completed:[],pinned:[2]},'cn',one);
    expect(two.document?.completed).toEqual([]);expect(two.document?.['future']).toEqual({preserve:true});
    expect(touchedSince(one.metadata?.fieldRevisions??{},two.metadata?.fieldRevisions??{})).toEqual(new Set(['completed:1','pinned:2']));
    expect(s.requests.filter((r)=>r.method==='PUT').every((r)=>r.headers.has('If-Match')||r.headers.has('If-None-Match'))).toBe(true);
  });
  it.each(['before','after'] as const)('recovers interruption %s the fish write using the prepared record',async(when)=>{
    const s=server();s.write('fish.json',JSON.stringify(original));const client=s.client();const before=await client.readPair();
    if(when==='before')s.interrupt();else s.lose();
    await expect(client.commit({...original,completed:[]},'cn',before)).rejects.toThrow();
    const pending=await s.client().readPair();expect(pending.metadata?.state).toBe('prepared');
    const final=await s.client().resume(pending);expect(final.document?.completed).toEqual([]);expect(final.metadata?.state).toBe('committed');expect(final.sidecarFresh).toBe(true);
  });
  it('stops instead of overwriting an external concurrent edit during recovery',async()=>{
    const s=server();s.write('fish.json',JSON.stringify(original));const client=s.client();s.interrupt();
    await expect(client.commit({...original,completed:[]},'cn',await client.readPair())).rejects.toThrow();
    const other={...original,completed:[7]};s.write('fish.json',JSON.stringify(other));
    await expect(s.client().resume(await s.client().readPair())).rejects.toBeInstanceOf(DavConflict);
    expect(JSON.parse(s.files.get('fish.json')?.text??'null') as unknown).toEqual(other);
  });
  it('rejects a server ignoring conditions before touching either user file',async()=>{
    const s=server();s.ignore();const client=s.client();await expect(client.commit(original,'cn',await client.readPair())).rejects.toThrow();
    expect(s.files.has('fish.json')).toBe(false);expect(s.files.has('fish.sync.json')).toBe(false);
  });
  it('cannot send WebDAV credentials to the Hub, HTTP or embedded credentials',()=>{
    for(const baseUrl of ['http://dav.test/','https://hub.test/dav/','https://u:p@dav.test/'])expect(()=>createWebDavClient({baseUrl,hubOrigin:'https://hub.test',username:'a',password:'b'})).toThrow();
  });
  it('rejects stale metadata etags and cross-region reuse',async()=>{
    const s=server();const c=s.client();const stale=await c.readPair();await c.commit(original,'cn',stale);
    await expect(c.commit(original,'cn',stale)).rejects.toBeInstanceOf(DavConflict);
    await expect(c.commit(original,'global',await c.readPair())).rejects.toBeInstanceOf(DavConflict);
  });
  it('refuses weak/missing ETags without writing user data',async()=>{
    const s=server();s.files.set('fish.json',{text:JSON.stringify(original),etag:'W/"weak"'});
    await expect(s.client().readPair()).rejects.toThrow('强ETag');
    expect(s.requests.some((r)=>r.method==='PUT'&&r.path==='fish.json')).toBe(false);
  });
});
