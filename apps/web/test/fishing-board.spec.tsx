// @vitest-environment jsdom
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {FishingBoard,HOME_FISH_PREVIEW_LIMIT,type FishDetailSelection} from '../src/app/fish/FishingBoard';
import {forecastCatalog} from '../src/app/fish/forecast';
import type {CatalogFish,FishingCatalog} from '../src/app/fish/catalog';
import type {FishRegion} from '@ff14-hub/shared';
import type {FishingData} from '../src/app/fish/data';
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
const publicPort=(catalog=fixture):FishingData=>({loadCatalog:()=>Promise.resolve(catalog)});

it('renders actionable fish directly, and searches beyond the first 30 records',async()=>{
  render(<FishingBoard data={publicPort()} compact/>);
  fireEvent.click(screen.getByRole('button',{name:'时间天气不限'}));
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
  const data:FishingData={
    loadCatalog:()=>Promise.resolve({...fixture,fish:[fish[0]!],coverage:{total:1,forecast:1,always:0,unknown:0}}),
    readProgress:()=>Promise.resolve({fields:structuredClone(fields),watermark}),
    saveProgress:edit=>{
      const previous=fields.find(f=>f.field===edit.field);
      if((previous?.revision??0)!==edit.expectedRevision)return Promise.reject(new Error('conflict'));
      writes.push(edit);fields=fields.filter(f=>f.field!==edit.field);fields.push({region:'cn',fishId:1000,field:edit.field,value:edit.value,revision:edit.expectedRevision+1,updatedAt:Date.now()});watermark++;
      return Promise.resolve();
    },
  };
  return {data,writes,concurrentEdit(){fields=fields.map(f=>({...f,revision:f.revision+1}));watermark++;}};
}
it('undo restores a caught fish after it disappears, using a new revision and operation',async()=>{
  const {data,writes}=editablePort();render(<FishingBoard data={data} initialFilters={{region:'cn',view:'all',kind:'all',text:'',hideCaught:true,windowHours:24}}/>);
  const caught=await screen.findByRole('button',{name:'钓获 测试鱼0'});await waitFor(()=>expect(caught.hasAttribute('disabled')).toBe(false));fireEvent.click(caught);
  const undo=await screen.findByRole('button',{name:'撤销'});expect(screen.queryByRole('button',{name:'钓获 测试鱼0'})).toBeNull();fireEvent.click(undo);
  await screen.findByRole('button',{name:'钓获 测试鱼0'});expect(writes.map(w=>[w.value,w.expectedRevision])).toEqual([[true,0],[false,1]]);expect(writes[0]?.operationId).not.toBe(writes[1]?.operationId);
});
it('undo refuses to overwrite a record changed by another tab or synchronization',async()=>{
  const f=editablePort();render(<FishingBoard data={f.data}/>);fireEvent.click(screen.getByRole('button',{name:'时间天气不限'}));const button=await screen.findByRole('button',{name:'钓获 测试鱼0'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));fireEvent.click(button);
  const undo=await screen.findByRole('button',{name:'撤销'});f.concurrentEdit();fireEvent.click(undo);await screen.findByText('这条鱼已被其他页面或同步更新，未覆盖新记录。');expect(f.writes).toHaveLength(1);
});

it('notification targeting identifies exactly one fish even when caught and opens its details',async()=>{
  render(<FishingBoard data={publicPort()} expanded initialFilters={{region:'cn',view:'all',kind:'all',text:'',hideCaught:false,windowHours:24,fishId:1031}}/>);
  await screen.findByText('测试鱼31');expect(document.querySelectorAll('.fish-board__row')).toHaveLength(1);expect(document.querySelector('.fish-board__row details')?.hasAttribute('open')).toBe(true);
});

it('keeps failed mutation intent and retries the identical operation',async()=>{
  let attempts=0;const intents:unknown[]=[];
  const data:FishingData={
    loadCatalog:()=>Promise.resolve({...fixture,fish:[fish[0]!],coverage:{total:1,forecast:1,always:0,unknown:0}}),
    readProgress:()=>Promise.resolve({fields:[],watermark:0}),
    saveProgress:input=>{intents.push(input);if(attempts++===0)return Promise.reject(new Error('temporary network failure'));return Promise.resolve();},
  };
  render(<FishingBoard data={data}/>);
  fireEvent.click(screen.getByRole('button',{name:'时间天气不限'}));
  const pin=await screen.findByRole('button',{name:'收藏 测试鱼0'});
  await waitFor(()=>expect(pin.hasAttribute('disabled')).toBe(false));
  fireEvent.click(pin);
  await screen.findByRole('button',{name:'重试保存'});
  fireEvent.click(screen.getByRole('button',{name:'重试保存'}));
  await waitFor(()=>expect(intents).toHaveLength(2));
  expect(intents[1]).toEqual(intents[0]);
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
  expect(preview.querySelectorAll('.fish-glance__time')).toHaveLength(HOME_FISH_PREVIEW_LIMIT);
  expect(screen.getByText('展示前 5 条，另有 29 条')).toBeDefined();
  expect(preview.querySelector('.fish-glance__time')?.textContent).toMatch(/\d{2}:\d{2}:\d{2} 后结束/);
  expect(preview.querySelector('.fish-glance__time strong')).toBeNull();
  expect(preview.querySelector('progress')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'查看测试鱼0的完整鱼窗'}));
  expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({region:'cn',text:'',view:'all',fishId:1000,kind:'all',hideCaught:false}));
});
