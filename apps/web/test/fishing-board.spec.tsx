// @vitest-environment jsdom
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {FishingBoard,type FishDetailSelection} from '../src/app/fish/FishingBoard';
import {forecastCatalog} from '../src/app/fish/forecast';
import type {CatalogFish,FishingCatalog} from '../src/app/fish/catalog';
import type {FishRegion} from '@ff14-hub/shared';
import type {DataPort} from '../src/lib/data-port';
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
const reminderSettings=vi.hoisted(()=>new Map<string,unknown>());
vi.mock('../src/app/local/secure-storage',()=>({readDeviceRecord:(key:string)=>Promise.resolve(reminderSettings.get(key)??null),updateDeviceRecord:(key:string,change:(previous:unknown)=>unknown)=>{const next=change(reminderSettings.get(key)??null);reminderSettings.set(key,next);return Promise.resolve(next);}}));
beforeEach(()=>{reminderSettings.clear();vi.stubGlobal('Worker',ForecastWorker);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const publicPort=(catalog=fixture):DataPort=>({moduleId:'ff14.fishing',operations:['fish.catalog'],call:<T,>()=>Promise.resolve(catalog as T)});

it('shows filled intuition duration with its source and the corrected mooch comparison',async()=>{
  const selected=source.fish.filter(f=>f.id===46195||f.id===24994);
  render(<FishingBoard data={publicPort({...source,fish:selected,coverage:{total:2,forecast:2,always:0,unknown:0}})} initialFilters={{region:'cn',view:'all',kind:'all',text:'',hideCaught:false,windowHours:24}}/>);
  await screen.findByText('巨蛇头鳢');
  expect(screen.getByText('鱼识持续 350 秒（鱼糕补充）；尚未计算前置鱼准备的可行性。')).toBeTruthy();
  expect(screen.getByText(/已按鱼糕补全鱼识持续时间：350 秒/)).toBeTruthy();
  expect(screen.getByText(/橙彩鱼：合并泳饵依赖后 ET 4–8，与 Tracker 一致/)).toBeTruthy();
  expect(screen.queryByText(/准备时间条件存在差异/)).toBeNull();
  expect(screen.getByText(/24 条一致、8 条已按鱼糕补全时长、0 条资料待补、0 条条件差异/)).toBeTruthy();
});

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

function editablePort(){
  let fields:{region:'cn';fishId:number;field:'caught'|'pinned'|'alarm';value:boolean;revision:number;updatedAt:number}[]=[],watermark=0;
  const writes:{field:string;value:boolean;expectedRevision:number;operationId:string}[]=[];
  const data:DataPort={moduleId:'ff14.fishing',operations:['fish.catalog','fish.progress','fish.progress.read'],call:<T,>(op:string,input?:unknown):Promise<T>=>{
    if(op==='fish.catalog')return Promise.resolve({...fixture,fish:[fish[0]],coverage:{total:1,forecast:1,always:0,unknown:0}} as T);
    if(op==='fish.progress.read')return Promise.resolve({fields:structuredClone(fields),watermark} as T);
    const edit=input as typeof fields[number]&{expectedRevision:number;operationId:string};const previous=fields.find(f=>f.field===edit.field);
    if((previous?.revision??0)!==edit.expectedRevision)return Promise.reject(new Error('conflict'));
    writes.push(edit);fields=fields.filter(f=>f.field!==edit.field);fields.push({region:'cn',fishId:1000,field:edit.field,value:edit.value,revision:edit.expectedRevision+1,updatedAt:Date.now()});watermark++;
    return Promise.resolve({} as T);
  }};
  return {data,writes,concurrentEdit(){fields=fields.map(f=>({...f,revision:f.revision+1}));watermark++;}};
}
it('undo restores a caught fish after it disappears, using a new revision and operation',async()=>{
  const {data,writes}=editablePort();render(<FishingBoard data={data} initialFilters={{region:'cn',view:'all',kind:'all',text:'',hideCaught:true,windowHours:24}}/>);
  const caught=await screen.findByRole('button',{name:'钓获 测试鱼0'});await waitFor(()=>expect(caught.hasAttribute('disabled')).toBe(false));fireEvent.click(caught);
  const undo=await screen.findByRole('button',{name:'撤销'});expect(screen.queryByRole('button',{name:'钓获 测试鱼0'})).toBeNull();fireEvent.click(undo);
  await screen.findByRole('button',{name:'钓获 测试鱼0'});expect(writes.map(w=>[w.value,w.expectedRevision])).toEqual([[true,0],[false,1]]);expect(writes[0]?.operationId).not.toBe(writes[1]?.operationId);
});
it('undo refuses to overwrite a record changed by another tab or synchronization',async()=>{
  const f=editablePort();render(<FishingBoard data={f.data}/>);const button=await screen.findByRole('button',{name:'钓获 测试鱼0'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);
  const undo=await screen.findByRole('button',{name:'撤销'});f.concurrentEdit();fireEvent.click(undo);await screen.findByText('这条鱼已被其他页面或同步更新，未覆盖新记录。');expect(f.writes).toHaveLength(1);
});
it('shows home filters and opens the full catalog without hidden caught or rarity filters',()=>{
  const open=vi.fn();render(<FishingBoard data={publicPort()} embedded onOpenDetail={open}/>);
  expect(screen.getByRole('button',{name:'未钓获'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'查看全部鱼类'}));expect(open).toHaveBeenCalledWith(expect.objectContaining({view:'all',kind:'all',hideCaught:false}));
});
it('saves an individual alarm and lead time without pretending browser permission is enabled',async()=>{
  const f=editablePort();render(<FishingBoard data={f.data}/>);const button=await screen.findByRole('button',{name:'提醒 测试鱼0'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);
  await screen.findByRole('region',{name:'测试鱼0的提醒'});const save=screen.getByRole('button',{name:'保存提醒标记'});await waitFor(()=>expect(save.hasAttribute('disabled')).toBe(false));fireEvent.change(screen.getByRole('combobox',{name:'单鱼提醒提前时间'}),{target:{value:'15'}});fireEvent.click(save);
  await screen.findByText('已保存这条鱼的提醒标记');expect(f.writes[0]).toMatchObject({field:'alarm',value:true});expect(reminderSettings.get('notifications')).toMatchObject({browser:false,fishLeadMinutes:{'cn:1000':15}});
  fireEvent.click(screen.getByRole('button',{name:'提醒 测试鱼0'}));await screen.findByRole('button',{name:'取消这条鱼的提醒'});fireEvent.click(screen.getByRole('button',{name:'取消这条鱼的提醒'}));await screen.findByText('已取消这条鱼的提醒');expect(f.writes[1]).toMatchObject({field:'alarm',value:false,expectedRevision:1});
});
it('notification targeting identifies exactly one fish even when caught and opens its details',async()=>{
  render(<FishingBoard data={publicPort()} expanded initialFilters={{region:'cn',view:'all',kind:'all',text:'',hideCaught:false,windowHours:24,fishId:1031}}/>);
  await screen.findByText('测试鱼31');expect(document.querySelectorAll('.fish-board__row')).toHaveLength(1);expect(document.querySelector('.fish-board__row details')?.hasAttribute('open')).toBe(true);
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
  const data:DataPort={moduleId:'ff14.fishing',operations:['fish.catalog','fish.progress','fish.progress.read'],call:<T,>(op:string,input?:unknown)=>call(op,input) as Promise<T>};
  render(<FishingBoard data={data}/>);
  const pin=await screen.findByRole('button',{name:'收藏 测试鱼0'});
  await waitFor(()=>expect(pin.hasAttribute('disabled')).toBe(false));
  fireEvent.click(pin);
  await screen.findByRole('button',{name:'重试保存'});
  fireEvent.click(screen.getByRole('button',{name:'重试保存'}));
  await waitFor(()=>expect(intents).toHaveLength(2));
  expect(intents[1]).toEqual(intents[0]);
});

it('home uses 24 hours and retains every matched fish in its scrollable list',async()=>{
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
  fireEvent.click(screen.getByRole('button',{name:'未来鱼窗'}));
  await screen.findByText('测试鱼0');
  await waitFor(()=>expect(document.querySelectorAll('.fish-glance__item')).toHaveLength(34));
  expect(document.querySelectorAll('.fish-board__row')).toHaveLength(0);
  expect(screen.queryByRole('searchbox',{name:'搜索鱼类'})).toBeNull();
  expect(screen.getByRole('list',{name:'鱼窗列表'}).tabIndex).toBe(0);
  expect(screen.getByText('测试鱼16')).toBeDefined();
  expect(document.querySelector('.fish-glance__more')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'全部鱼窗 ↗'}));
  expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({region:'cn',view:'windows',kind:'rare',windowHours:24}));
  const selection=onOpenDetail.mock.calls[0]?.[0];
  expect(selection).toBeDefined();
  cleanup();
  render(<FishingBoard data={publicPort()} expanded initialFilters={selection}/>);
  await waitFor(()=>expect(document.querySelectorAll('.fish-board__row')).toHaveLength(34));
  expect(screen.getByText('测试鱼16')).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:'未来 6 小时'}));
  await waitFor(()=>expect(document.querySelectorAll('.fish-board__row')).toHaveLength(17));
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
  const preview=screen.getByRole('region',{name:'钓鱼鱼窗概览'});
  expect(preview.querySelectorAll('.fish-glance__time')).toHaveLength(34);
  expect(preview.querySelector('.fish-glance__time')?.textContent).toMatch(/\d{2}:\d{2}:\d{2} 后结束/);
  expect(preview.querySelector('.fish-glance__time strong')).toBeNull();
  expect(preview.querySelector('progress')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'查看测试鱼0的完整鱼窗'}));
  expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({region:'cn',text:'测试鱼0',view:'windows'}));
});

it('home defaults to finite open windows, shows next times in future, and unions followed flags without hiding normal or caught fish',async()=>{
  const entries=[fish[0]!,{...fish[1]!,kind:'normal' as const},{...fish[2]!,kind:'normal' as const}];
  class PhaseWorker{
    onmessage:((event:MessageEvent)=>void)|null=null;
    postMessage(input:{from:number;region:FishRegion}){
      const make=(id:number,start:number,end:number,unrestricted=false)=>({occurrenceKey:`phase:${id}:${start}`,region:input.region,fishId:id,ruleVersion:'test',startsAtUtcMs:start,endsAtUtcMs:end,weatherChain:{previous:'晴',current:'晴'},validationStatus:'unverified',candidateOnly:true,conditions:[],...(unrestricted?{unrestricted:true}:{})});
      const forecasts=entries.map((entry,index)=>({id:entry.id,failed:false,windows:index===0?[make(entry.id,input.from-60000,input.from+60000),make(entry.id,input.from+3600000,input.from+3660000)]:index===1?[make(entry.id,input.from+7200000,input.from+7260000)]:[make(entry.id,0,Date.UTC(2100,0,1),true)]}));
      queueMicrotask(()=>this.onmessage?.(new MessageEvent('message',{data:{forecasts}})));
    }
    terminate(){this.onmessage=null;}
  }
  vi.stubGlobal('Worker',PhaseWorker);
  const fields=[{fishId:1001,field:'alarm'},{fishId:1001,field:'pinned'},{fishId:1002,field:'pinned'},{fishId:1002,field:'caught'}].map(f=>({...f,region:'cn',value:true,revision:1,updatedAt:1}));
  const data:DataPort={moduleId:'ff14.fishing',operations:['fish.catalog','fish.progress.read'],call:<T,>(operation:string)=>Promise.resolve((operation==='fish.catalog'?{...fixture,fish:entries,coverage:{total:3,forecast:3,always:0,unknown:0}}:{fields,watermark:1}) as T)};
  const open=vi.fn();render(<FishingBoard data={data} embedded onOpenDetail={open}/>);
  await screen.findByRole('button',{name:'查看测试鱼0的完整鱼窗'});expect(document.querySelectorAll('.fish-glance__item')).toHaveLength(1);expect(screen.queryByText('测试鱼2')).toBeNull();
  expect(screen.getByRole('button',{name:'开放中鱼窗'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'未来鱼窗'}));expect(document.querySelector('.fish-glance__time')?.textContent).toContain('后开始');expect(document.querySelector('.fish-glance__time')?.textContent).not.toContain('后结束');
  fireEvent.click(screen.getByRole('button',{name:'关注鱼窗'}));await screen.findByText('测试鱼1');expect(screen.getByText('测试鱼2')).toBeTruthy();expect(document.querySelectorAll('.fish-glance__item')).toHaveLength(2);expect(screen.queryByText('测试鱼0')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'全部鱼窗 ↗'}));expect(open).toHaveBeenCalledWith(expect.objectContaining({view:'followed',kind:'all',hideCaught:false}));
});
