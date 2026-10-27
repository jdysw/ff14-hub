import {afterEach,expect,it,vi} from 'vitest';
import {applyPersonalSync,createRemoteClient,emptyRemoteConfig,mergePersonalData,remoteUrl,s3Headers} from '../src/app/local/remote-sync';
import type {LocalData,LocalStore} from '../src/app/local/store';
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]});
afterEach(()=>vi.unstubAllGlobals());
it('keeps unchanged fish revisions when another device adds a note',()=>{
  const field={region:'cn' as const,fishId:1,field:'caught' as const,value:true,revision:4,updatedAt:123};
  const base={...empty(),fish:{cn:[field],global:[]}};
  const remote={...base,notes:[{id:crypto.randomUUID(),title:'另一设备',text:'新增'}]};
  const result=mergePersonalData(base,base,remote);
  expect(result.data.fish.cn[0]).toEqual(field);expect(result.data.notes).toEqual(remote.notes);
});
it('retains accepted operation IDs while importing remote changes',async()=>{
  const document={data:empty(),operations:[{id:'already-accepted'}]};
  const store={change:(update:(value:typeof document)=>unknown)=>Promise.resolve(update(document))} as unknown as LocalStore;
  await applyPersonalSync(store,0,{...empty(),notes:[{id:crypto.randomUUID(),title:'远端',text:'记录'}]});
  expect(document.operations).toEqual([{id:'already-accepted'}]);expect(document.data.notes).toHaveLength(1);
});
it('preserves deletions and exposes competing edits instead of choosing a device silently',()=>{
  const note={id:crypto.randomUUID(),title:'备忘',text:'原始'},base={...empty(),notes:[note]};
  const local={...base,notes:[{...note,text:'本机修改'}]},remote={...base,notes:[{...note,text:'远端修改'}]};
  const result=mergePersonalData(base,local,remote);expect(result.conflicts).toHaveLength(1);
  expect(mergePersonalData(base,local,remote,{['note:'+note.id]:'remote'}).data.notes[0]?.text).toBe('远端修改');
  expect(mergePersonalData(base,base,{...base,notes:[]}).data.notes).toEqual([]);
});
it('honors a cancelled caught flag and isolates both regions',()=>{
  const field={region:'cn' as const,fishId:1,field:'caught' as const,value:true,revision:1,updatedAt:1};
  const base={...empty(),fish:{cn:[field],global:[]}};
  const local={...base,fish:{cn:[{...field,value:false,revision:2}],global:[]}};
  const result=mergePersonalData(base,local,base);
  expect(result.data.fish.cn[0]?.value).toBe(false);expect(result.data.fish.global).toEqual([]);
});
it('refuses Hub targets, cleartext endpoints, embedded credentials and ambiguous object URLs',()=>{
  for(const target of ['http://dav.example/file','https://a:b@dav.example/file','https://hub.example/file','https://dav.example/file?token=bad','https://dav.example/folder/'])expect(()=>remoteUrl(target,'https://hub.example')).toThrow();
});
it('uses conditional writes and stops on concurrent remote modification',async()=>{
  vi.stubGlobal('location',{origin:'https://hub.example'});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('',{status:412}));
  const client=createRemoteClient({...emptyRemoteConfig,url:'https://dav.example/personal.json',username:'test',password:'test-only'},fetcher);
  await expect(client.write(empty(),'"v1"')).rejects.toThrow('远端已被其他设备修改');
  const request=fetcher.mock.calls[0]![1]!;
  expect(request.redirect).toBe('error');expect(request.credentials).toBe('omit');expect(request.headers).toMatchObject({'if-match':'"v1"'});
  await expect(client.write(empty(),null)).rejects.toThrow();expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({'if-none-match':'*'});
});
it('requires an exposed strong ETag before importing a remote file',async()=>{
  vi.stubGlobal('location',{origin:'https://hub.example'});
  const client=createRemoteClient({...emptyRemoteConfig,url:'https://dav.example/personal.json'},vi.fn<typeof fetch>().mockResolvedValue(new Response('{}',{status:200})));
  await expect(client.read()).rejects.toThrow('ETag');
});
it('signs S3 payload and preconditions without sending host as a forbidden browser header',async()=>{
  vi.stubGlobal('location',{origin:'https://hub.example'});
  const config={...emptyRemoteConfig,provider:'s3' as const,url:'https://s3.example/bucket/personal.json',region:'auto',accessKey:'test-id',secretKey:'test-only-secret'};
  const headers=await s3Headers(config,'PUT','{}',{'if-match':'"v1"'},new Date('2026-10-21T00:00:00Z'));
  expect(headers['Authorization']).toContain('Credential=test-id/20261021/auto/s3/aws4_request');
  expect(headers['Authorization']).toContain('SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date');
  expect(headers).not.toHaveProperty('host');expect(JSON.stringify(headers)).not.toContain(config.secretKey);
  const changed=await s3Headers(config,'PUT','{"x":1}',{'if-match':'"v1"'},new Date('2026-10-21T00:00:00Z'));
  expect(changed['Authorization']).not.toBe(headers['Authorization']);
});
