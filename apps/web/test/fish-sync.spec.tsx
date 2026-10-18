// @vitest-environment jsdom
import { cleanup,render,screen,fireEvent,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,it,expect,vi } from 'vitest';
import { SYNC_MODULE_ID,type FishSyncSnapshot,type FishSyncPreview } from '@ff14-hub/shared';
import { SyncPanel } from '../src/app/fish-sync/SyncPanel';
import type { ModuleDataPort } from '../src/app/widgets/types';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('sends only field intent, requires a backup, and retains the input on conflict',async()=>{
  vi.stubGlobal('URL',{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>undefined});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>undefined);
  const snapshot:FishSyncSnapshot={region:'cn',fields:[],watermark:0,lastSyncedAt:null,audits:[]};
  const preview:FishSyncPreview={token:'00000000-0000-4000-8000-000000000001',region:'cn',watermark:0,expiresAt:2000000000000,
    changes:[{fishId:99,field:'caught',value:true,expectedRevision:0}],backup:[{fishId:99,field:'caught',value:false,expectedRevision:1}]};
  const calls:{op:string;input:unknown}[]=[];
  const data:ModuleDataPort={moduleId:SYNC_MODULE_ID,operations:['sync.snapshot','sync.preview','sync.apply'],call:<T,>(op:string,input?:unknown):Promise<T>=>{
    calls.push({op,input});if(op==='sync.apply')return Promise.reject(new Error('数据已变化，请重新预览'));
    return Promise.resolve((op==='sync.snapshot'?snapshot:preview) as T);
  }};
  render(<SyncPanel data={data}/>);
  const text=JSON.stringify({completed:[99],pinned:[],alarmFish:[],future:{note:'local-only'}});
  fireEvent.change(screen.getByLabelText('鱼糕JSON内容'),{target:{value:text}});await userEvent.click(screen.getByRole('button',{name:'预览导入'}));
  await screen.findByRole('heading',{name:'变更预览：1项'});
  expect(calls.find((c)=>c.op==='sync.preview')?.input).toEqual({region:'cn',changes:[{fishId:99,field:'caught',value:true,expectedRevision:0}]});
  await userEvent.click(screen.getByLabelText('我已核对区服与变更，确认应用'));
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'应用同步变更'}).disabled).toBe(true);
  await userEvent.click(screen.getByRole('button',{name:'下载变更前备份'}));await userEvent.click(screen.getByRole('button',{name:'应用同步变更'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('重新预览'));
  expect(screen.getByLabelText<HTMLTextAreaElement>('鱼糕JSON内容').value).toBe(text);
});
it('does not parse incomplete files as an empty progress overwrite',async()=>{
  const call=vi.fn(()=>Promise.resolve({region:'cn',fields:[],watermark:0,lastSyncedAt:null,audits:[]}));
  const data:ModuleDataPort={moduleId:SYNC_MODULE_ID,operations:['sync.snapshot'],call:<T,>()=>call() as Promise<T>};
  render(<SyncPanel data={data}/>);fireEvent.change(screen.getByLabelText('鱼糕JSON内容'),{target:{value:'{"completed":[]}'}});
  await userEvent.click(screen.getByRole('button',{name:'预览导入'}));await screen.findByRole('alert');
  expect(call).toHaveBeenCalledTimes(1);
});
