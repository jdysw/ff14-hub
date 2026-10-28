// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {RemoteSyncPanel} from '../src/app/local/RemoteSyncPanel';
import {emptyRemoteConfig} from '../src/app/local/remote-sync';
import type {LocalStore} from '../src/app/local/store';
import type {RemoteSyncSession} from '../src/app/local/remote-sync-session';
const sessionState=vi.hoisted(()=>({saved:null as RemoteSyncSession|null}));
vi.mock('../src/app/local/secure-storage',()=>{
  return {readDeviceRecord:()=>Promise.resolve(sessionState.saved),updateDeviceRecord:(_id:string,update:(previous:RemoteSyncSession|null)=>RemoteSyncSession)=>{sessionState.saved=update(sessionState.saved);return Promise.resolve(sessionState.saved);}};
});
const data={version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]};
beforeEach(()=>{sessionState.saved={config:{...emptyRemoteConfig,url:'https://dav.example/personal.json',username:'test',password:'test'},baseline:null};});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('a missing remote file stays read-only until explicit apply',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:404}));vi.stubGlobal('fetch',fetcher);
  render(<RemoteSyncPanel store={{read:()=>Promise.resolve(data)} as unknown as LocalStore}/>);
  const read=screen.getByRole('button',{name:'读取远端并预览'});
  await waitFor(()=>expect(read.hasAttribute('disabled')).toBe(false));fireEvent.click(read);
  await screen.findByText(/远端返回文件不存在，尚未写入/);
  expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  expect(screen.getByRole('button',{name:'应用双向同步'})).toBeTruthy();
  expect(screen.getByText('3. 核对差异').getAttribute('aria-current')).toBe('step');
});
it('authorization diagnostics never expose the saved password and offer no apply action',async()=>{
  vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockResolvedValue(new Response('secret server output',{status:401})));
  render(<RemoteSyncPanel store={{read:()=>Promise.resolve(data)} as unknown as LocalStore}/>);
  const read=screen.getByRole('button',{name:'读取远端并预览'});await waitFor(()=>expect(read.hasAttribute('disabled')).toBe(false));fireEvent.click(read);
  const alert=await screen.findByRole('alert');expect(alert.textContent).toMatch(/凭证|认证|口令|授权/);expect(alert.textContent).not.toContain('secret server output');
  expect(screen.queryByRole('button',{name:'应用双向同步'})).toBeNull();expect(emptyRemoteConfig.provider).toBe('webdav');
});
it('enables automatic mode only after a confirmed first sync and allows stopping it',async()=>{
  vi.stubGlobal('navigator',{locks:{request:(_name:string,action:()=>Promise<unknown>)=>action()}});
  vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null,{status:404})).mockResolvedValueOnce(new Response(null,{status:204})));
  render(<RemoteSyncPanel store={{read:()=>Promise.resolve(data)} as unknown as LocalStore}/>);
  const automatic=screen.getByRole('checkbox',{name:'开启跨设备自动同步'});
  expect(automatic.hasAttribute('disabled')).toBe(true);
  const read=screen.getByRole('button',{name:'读取远端并预览'});await waitFor(()=>expect(read.hasAttribute('disabled')).toBe(false));fireEvent.click(read);
  fireEvent.click(await screen.findByRole('button',{name:'应用双向同步'}));
  await waitFor(()=>expect(automatic.hasAttribute('disabled')).toBe(false));fireEvent.click(automatic);
  await screen.findByText('自动同步已开启');expect(sessionState.saved?.automatic).toBe(true);
  fireEvent.click(automatic);await screen.findByText('自动同步已关闭，资料仍保留在本机');expect(sessionState.saved?.automatic).toBe(false);
});
