// @vitest-environment jsdom
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {FishingBoard,type FishDetailSelection} from '../src/app/fish/FishingBoard';
import {forecastCatalog} from '../src/app/fish/forecast';
import type {CatalogFish,FishingCatalog} from '../src/app/fish/catalog';
import type {FishRegion} from '@ff14-hub/shared';
import type {ModuleDataPort} from '../src/app/widgets/types';
import {readFileSync} from 'node:fs';
import {fishingCatalogSchema} from '../src/app/fish/catalog';
const source=fishingCatalogSchema.parse(JSON.parse(readFileSync('public/fishing/catalog-cn.json','utf8')) as unknown);
const base=source.fish.find(f=>f.id===7678)!;
const fish:CatalogFish[]=Array.from({length:34},(_,i)=>({...base,id:1000+i,name:`测试鱼${i}`,rule:base.rule?{...base.rule,fishId:1000+i,startHour:0,endHour:24}:null}));
const fixture: FishingCatalog={...source,fish,coverage:{total:34,forecast:34,always:0,unknown:0}};
class ForecastWorker {
  onmessage:((event:MessageEvent)=>void)|null=null;
  postMessage(input:{fish:CatalogFish[];region:FishRegion;from:number;hours:number}){
    const forecasts=forecastCatalog(input.fish,input.region,input.from,input.hours);
    queueMicrotask(()=>this.onmessage?.(new MessageEvent('message',{data:{forecasts}})));
  }
  terminate(){this.onmessage=null;}
}
beforeEach(()=>vi.stubGlobal('Worker',ForecastWorker));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const publicPort=(catalog=fixture):ModuleDataPort=>({moduleId:'ff14.fishing',operations:['fish.catalog'],call:<T,>()=>Promise.resolve(catalog as T)});

it('renders actionable fish directly, and searches beyond the first 30 records',async()=>{
  render(<FishingBoard data={publicPort()} compact/>);
  await screen.findByText('测试鱼0');
  expect(document.querySelectorAll('.fish-board__row')).toHaveLength(6);
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索鱼类'}),{target:{value:'测试鱼31'}});
  await screen.findByText('测试鱼31');
  expect(document.querySelectorAll('.fish-board__row')).toHaveLength(1);
  fireEvent.click(screen.getByText('测试鱼31'));
  expect(document.querySelector('details')?.open).toBe(true);
  expect(screen.getByText(/鱼饵路径：沟鼠尾巴/)).toBeDefined();
});
it('shows fish lacking rules in full catalog without a false all-day claim',async()=>{
  const unknown={...base,id:9999,name:'条件待补鱼',always:false,rule:null};
  render(<FishingBoard data={publicPort({...fixture,fish:[unknown],coverage:{total:1,forecast:0,always:0,unknown:1}})}/>);
  fireEvent.click(screen.getByRole('button',{name:'全部鱼类'}));
  await screen.findByText('条件待补鱼');
  expect(screen.getByText('窗口资料待补')).toBeDefined();
  expect(screen.queryByText('全天')).toBeNull();
  expect(screen.getByRole('button',{name:'收藏 条件待补鱼'}).hasAttribute('disabled')).toBe(true);
});
it('keeps failed mutation intent and retries the identical operation',async()=>{
  let attempts=0;const intents:unknown[]=[];
  const call=vi.fn((operation:string,input?:unknown):Promise<unknown>=>{
    if(operation==='fish.catalog')return Promise.resolve({...fixture,fish:[fish[0]],coverage:{total:1,forecast:1,always:0,unknown:0}});
    if(operation==='fish.progress.read')return Promise.resolve({fields:[],watermark:0});
    intents.push(input);if(attempts++===0)return Promise.reject(new Error('temporary network failure'));return Promise.resolve({});
  });
  const data:ModuleDataPort={moduleId:'ff14.fishing',operations:['fish.catalog','fish.progress','fish.progress.read'],call:<T,>(op:string,input?:unknown)=>call(op,input) as Promise<T>};
  render(<FishingBoard data={data}/>);
  const pin=await screen.findByRole('button',{name:'收藏 测试鱼0'});
  await waitFor(()=>expect(pin.hasAttribute('disabled')).toBe(false));
  fireEvent.click(pin);
  await screen.findByRole('button',{name:'重试保存'});
  fireEvent.click(screen.getByRole('button',{name:'重试保存'}));
  await waitFor(()=>expect(intents).toHaveLength(2));
  expect(intents[1]).toEqual(intents[0]);
});

it('home keeps four scannable fish windows and opens the complete filtered list',async()=>{
  class ScheduledWorker {
    onmessage:((event:MessageEvent)=>void)|null=null;
    postMessage(input:{fish:CatalogFish[];region:FishRegion;from:number;hours:number}){
      const forecasts=input.fish.map((entry,index)=>{
        const startsAtUtcMs=input.from+(index<17?3:12)*3_600_000;
        return {id:entry.id,failed:false,windows:[{
          occurrenceKey:`test:${entry.id}`,region:input.region,fishId:entry.id,ruleVersion:'test',
          startsAtUtcMs,endsAtUtcMs:startsAtUtcMs+20*60_000,
          weatherChain:{previous:'晴',current:'晴'},validationStatus:'unverified',
          candidateOnly:true,conditions:[],
        }]};
      });
      queueMicrotask(()=>this.onmessage?.(new MessageEvent('message',{data:{forecasts}})));
    }
    terminate(){this.onmessage=null;}
  }
  vi.stubGlobal('Worker',ScheduledWorker);
  const onOpenDetail=vi.fn<(selection:FishDetailSelection)=>void>();
  render(<FishingBoard data={publicPort()} embedded onOpenDetail={onOpenDetail}/>);
  await screen.findByText('测试鱼0');
  await waitFor(()=>expect(document.querySelectorAll('.fish-glance__item')).toHaveLength(4));
  expect(document.querySelectorAll('.fish-board__row')).toHaveLength(0);
  expect(screen.queryByRole('searchbox',{name:'搜索鱼类'})).toBeNull();
  expect(screen.getByRole('button',{name:/显示其余 13 种鱼窗/})).toBeDefined();
  expect(screen.queryByText('测试鱼16')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:/显示其余 13 种鱼窗/}));
  expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({region:'cn',view:'windows',kind:'rare',windowHours:6}));
  const selection=onOpenDetail.mock.calls[0]?.[0];
  expect(selection).toBeDefined();
  cleanup();
  render(<FishingBoard data={publicPort()} expanded initialFilters={selection}/>);
  await waitFor(()=>expect(document.querySelectorAll('.fish-board__row')).toHaveLength(17));
  expect(screen.getByText('测试鱼16')).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:'24 小时'}));
  await waitFor(()=>expect(document.querySelectorAll('.fish-board__row')).toHaveLength(34));
  expect(screen.getByText('测试鱼33')).toBeDefined();
});
it('clicking an individual home fish opens detail prefiltered to that fish',async()=>{
  class OpenWorker {
    onmessage:((event:MessageEvent)=>void)|null=null;
    postMessage(input:{fish:CatalogFish[];region:FishRegion;from:number;hours:number}){
      queueMicrotask(()=>this.onmessage?.(new MessageEvent('message',{data:{forecasts:input.fish.map(f=>({
        id:f.id,failed:false,windows:[{
          occurrenceKey:`open:${f.id}`,region:input.region,fishId:f.id,ruleVersion:'test',
          startsAtUtcMs:input.from-60_000,endsAtUtcMs:input.from+1200_000,
          weatherChain:{previous:'晴',current:'晴'},validationStatus:'unverified',
          candidateOnly:true,conditions:[],
        }],
      }))}})));
    }
    terminate(){this.onmessage=null;}
  }
  vi.stubGlobal('Worker',OpenWorker);
  const onOpenDetail=vi.fn<(selection:FishDetailSelection)=>void>();
  render(<FishingBoard data={publicPort()} embedded onOpenDetail={onOpenDetail}/>);
  await screen.findByText('测试鱼0');
  fireEvent.click(screen.getByRole('button',{name:'查看测试鱼0的完整鱼窗'}));
  expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({region:'cn',text:'测试鱼0',view:'windows'}));
});
