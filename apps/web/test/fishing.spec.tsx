// @vitest-environment jsdom
import { cleanup,render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,it,expect,vi } from 'vitest';
import { FISH_MODULE_ID,fishDataBundleSchema } from '@ff14-hub/shared';
import { FishingPanel } from '../src/app/fish/FishingPanel';
import bundle from '../../../data/fish-demo-cn.json';
import type { ModuleDataPort } from '../src/app/widgets/types';
afterEach(cleanup);
const demoFish=()=>fishDataBundleSchema.parse(bundle).records;
it('shows unverified synthetic rules and saves only the selected field through the port',async()=>{
  const calls:unknown[]=[];
  const response={fish:{fish:demoFish(),offset:0,total:1},windows:{windows:[],from:4200000,to:8400000},progress:{fields:[],watermark:0}};
  const port:ModuleDataPort={moduleId:FISH_MODULE_ID,operations:['fish.snapshot','fish.progress'],
    call:<T,>(operation:string,input?:unknown):Promise<T>=>{calls.push({operation,input});return Promise.resolve(response as T);}};
  render(<FishingPanel data={port}/>);
  expect(await screen.findByText('示例·海港鱼（非真实鱼类）')).toBeDefined();
  expect(screen.getByText('示例数据')).toBeDefined();
  expect(screen.getByText('规则未验证')).toBeDefined();
  expect(screen.getByRole('group',{name:'鱼窗状态筛选'})).toBeDefined();
  await userEvent.click(screen.getByRole('button',{name:'已钓获'}));
  expect(calls).toContainEqual({operation:'fish.progress',input:expect.objectContaining({region:'cn',field:'caught',value:true,expectedRevision:0}) as unknown});
  expect(screen.getByRole('button',{name:'收藏'}).getAttribute('aria-pressed')).toBe('false');
});
it('keeps failed write intent for retry and exposes the error',async()=>{
  const call=vi.fn((operation:string,_input?:unknown):Promise<unknown>=>operation==='fish.progress'?Promise.reject(new Error('进度已被其他设备修改')):
    Promise.resolve({fish:{fish:demoFish(),offset:0,total:1},windows:{windows:[],from:4200000,to:8400000},progress:{fields:[],watermark:0}}));
  const port:ModuleDataPort={moduleId:FISH_MODULE_ID,operations:['fish.snapshot','fish.progress'],call:<T,>(operation:string,input?:unknown)=>call(operation,input) as Promise<T>};
  render(<FishingPanel data={port}/>);
  await screen.findByText('示例·海港鱼（非真实鱼类）');
  await userEvent.click(screen.getByRole('button',{name:'收藏'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('未保存的选择已保留'));
});
it('has an explicit disabled-module empty state',()=>{
  render(<FishingPanel data={undefined}/>);
  expect(screen.getByRole('status').textContent).toContain('启用钓鱼手账');
});

it('sorts active windows first and shows a live countdown without claiming verified catches',async()=>{
  const now=Date.now();
  const first=demoFish()[0]!;
  const future={...first,id:9000002,name:'稍后出现的示例鱼',rule:{...first.rule,fishId:9000002}};
  const currentWindow={occurrenceKey:'demo-now',region:'cn',fishId:first.id,ruleVersion:'synthetic-v1',
    startsAtUtcMs:now-60_000,endsAtUtcMs:now+600_000,weatherChain:{previous:'示例晴天',current:'示例雨天'},
    validationStatus:'unverified',candidateOnly:true,conditions:[]};
  const port:ModuleDataPort={moduleId:FISH_MODULE_ID,operations:['fish.snapshot'],
    call:<T,>():Promise<T>=>Promise.resolve({fish:{fish:[future,first],offset:0,total:2},windows:{
      windows:[currentWindow],from:now,to:now+3600000},progress:{fields:[],watermark:0}} as T)};
  render(<FishingPanel data={port}/>);
  expect(await screen.findByText('窗口进行中')).toBeDefined();
  expect(screen.getByText(/距离关闭/)).toBeDefined();
  expect(screen.queryByRole('button',{name:'已钓获'})).toBeNull();
  const articles=document.querySelectorAll('.fishing-entry');
  expect(articles[0]?.textContent).toContain(first.name);
  await userEvent.click(screen.getByRole('button',{name:'进行中'}));
  expect(document.querySelectorAll('.fishing-entry')).toHaveLength(1);
});
