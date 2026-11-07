import {afterEach,expect,it,vi} from 'vitest';
import {createRemoteClient,emptyRemoteConfig,s3Headers} from '../src/app/local/remote-sync';
import type {LocalData} from '../src/app/local/store';
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]});
afterEach(()=>vi.unstubAllGlobals());

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
