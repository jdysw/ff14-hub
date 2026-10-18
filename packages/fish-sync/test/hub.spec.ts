import {describe,it,expect,vi} from 'vitest';
import {createHubSyncPort} from '../src/hub';
import {createBrowserProfileLock} from '../src/browser-lock';

const workspaceId='11111111-1111-4111-8111-111111111111';
const otherId='22222222-2222-4222-8222-222222222222';
const token='volatile-device-token';
const opts={hubOrigin:'https://hub.test',workspaceId,region:'cn' as const,getToken:()=>token};
const changes=[{fishId:42,field:'caught' as const,value:true,expectedRevision:0}];
const json=(v:unknown)=>Promise.resolve(Response.json(v));
const urlOf=(input:RequestInfo|URL)=>typeof input==='string'?input:input instanceof URL?input.href:input.url;
const bodyText=(body:BodyInit|null|undefined)=>typeof body==='string'?body:'';

describe('fixed Hub sync transport',()=>{
  it('binds requests to the trusted workspace and sends only minimal intent',async()=>{
    const calls:{url:string;init:RequestInit|undefined}[]=[];
    const network:typeof fetch=(input,init)=>{
      const url=urlOf(input);calls.push({url,init});
      if(url.endsWith('/profile'))return json({id:workspaceId});
      if(url.endsWith('/preview'))return json({region:'cn',token:crypto.randomUUID(),watermark:3,expiresAt:Date.now()+600000,changes});
      if(url.endsWith('/apply'))return json({auditId:crypto.randomUUID(),applied:1,replayed:true});
      return json({region:'cn',watermark:3,fields:[],audits:[],lastSyncedAt:null});
    };
    const port=createHubSyncPort({...opts,fetch:network});
    await expect(port.snapshot('cn')).resolves.toEqual({region:'cn',watermark:3,fields:[]});
    const preview=await port.preview('cn',changes);
    await expect(port.apply({token:preview.token,operationId:crypto.randomUUID()})).resolves.toEqual({applied:1,replayed:true});
    expect(calls.filter((c)=>c.url.endsWith('/profile'))).toHaveLength(3);
    for(const c of calls){
      expect(new Headers(c.init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
      expect(c.url).not.toContain(token);expect(c.init?.credentials).toBe('omit');
      expect(c.init?.redirect).toBe('error');expect(c.init?.cache).toBe('no-store');
      expect(bodyText(c.init?.body)).not.toContain(token);
    }
    const previewCall=calls.find((c)=>c.url.endsWith('/preview'));
    expect(JSON.parse(bodyText(previewCall?.init?.body)) as unknown).toEqual({region:'cn',changes});
  });

  it('refuses unsafe origins, missing credentials and the wrong region before fetching',async()=>{
    for(const origin of ['http://public.test','https://u:p@hub.test','https://hub.test/path','https://hub.test?x=y','https://hub.test#fragment']){
      expect(()=>createHubSyncPort({...opts,hubOrigin:origin})).toThrow();
    }
    const network=vi.fn<typeof fetch>();
    await expect(createHubSyncPort({...opts,fetch:network}).snapshot('global')).rejects.toMatchObject({code:'scope-mismatch'});
    await expect(createHubSyncPort({...opts,getToken:()=>null,fetch:network}).snapshot('cn')).rejects.toMatchObject({code:'unauthorized'});
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects workspace replacement and session changes between identity and the private operation',async()=>{
    const mismatch=vi.fn<typeof fetch>(()=>Promise.resolve(json({id:otherId})));
    await expect(createHubSyncPort({...opts,fetch:mismatch}).preview('cn',changes)).rejects.toMatchObject({code:'scope-mismatch'});
    expect(mismatch).toHaveBeenCalledTimes(1);
    let current=token;
    const swapped=vi.fn<typeof fetch>(()=>{current='replacement';return Promise.resolve(json({id:workspaceId}));});
    await expect(createHubSyncPort({...opts,getToken:()=>current,fetch:swapped}).snapshot('cn')).rejects.toMatchObject({code:'session-changed'});
    expect(swapped).toHaveBeenCalledTimes(1);
  });

  it('rejects extra credentials and oversized/duplicate intents without a network write',async()=>{
    const network=vi.fn<typeof fetch>();const port=createHubSyncPort({...opts,fetch:network});
    const unsafe={...changes[0]!,password:'private'};
    await expect(port.preview('cn',[unsafe])).rejects.toThrow();
    await expect(port.preview('cn',[...changes,...changes])).rejects.toThrow();
    await expect(port.preview('cn',Array.from({length:201},(_,i)=>({...changes[0]!,fishId:i+1})))).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    {region:'global',watermark:1,fields:[]},
    {region:'cn',watermark:1,fields:[{fishId:42,field:'caught',value:true,revision:1},{fishId:42,field:'caught',value:true,revision:1}]},
    {region:'cn',watermark:-1,fields:[]},
  ])('rejects inconsistent snapshots %#',async(payload)=>{
    const network:typeof fetch=(input)=>json(urlOf(input).endsWith('/profile')?{id:workspaceId}:payload);
    await expect(createHubSyncPort({...opts,fetch:network}).snapshot('cn')).rejects.toMatchObject({code:'invalid-response'});
  });

  it('rejects a preview that changes the submitted intent',async()=>{
    const network:typeof fetch=(input)=>json(urlOf(input).endsWith('/profile')?{id:workspaceId}:{region:'cn',token:crypto.randomUUID(),watermark:1,expiresAt:1,changes:[{...changes[0],value:false}]});
    await expect(createHubSyncPort({...opts,fetch:network}).preview('cn',changes)).rejects.toMatchObject({code:'invalid-response'});
  });

  it('bounds streamed response bodies and redacts server/transport failures',async()=>{
    let cancelled=false;
    const network:typeof fetch=()=>Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller){controller.enqueue(new Uint8Array(1048576));},cancel(){cancelled=true;},
    }),{headers:{'Content-Type':'application/json'}}));
    await expect(createHubSyncPort({...opts,fetch:network}).snapshot('cn')).rejects.toMatchObject({code:'invalid-response'});
    expect(cancelled).toBe(true);
    for(const status of [401,403,409,500]){
      const denied:typeof fetch=()=>Promise.resolve(new Response(`echo ${token}`,{status}));
      await expect(createHubSyncPort({...opts,fetch:denied}).snapshot('cn')).rejects.not.toThrow(token);
    }
    const failure:typeof fetch=()=>Promise.reject(new Error(token));
    await expect(createHubSyncPort({...opts,fetch:failure}).snapshot('cn')).rejects.toThrow(/^Hub同步请求失败（network/u);
  });
});

describe('browser profile lock failure boundaries',()=>{
  it('fails closed when the browser API is absent or denied',async()=>{
    await expect(createBrowserProfileLock(null).acquire(workspaceId)).rejects.toMatchObject({code:'lock-unavailable'});
    const manager={request:()=>Promise.reject(new Error('denied'))} as unknown as LockManager;
    await expect(createBrowserProfileLock(manager).acquire(workspaceId)).rejects.toMatchObject({code:'lock-unavailable'});
  });
});
