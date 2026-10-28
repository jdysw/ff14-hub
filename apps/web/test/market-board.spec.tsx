// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type * as Universalis from '../src/app/market/universalis';
import {MarketHome} from '../src/app/market/MarketHome';
import {MarketBoard} from '../src/app/market/MarketBoard';
import {loadMarketCenters,searchMarketItems,loadMarketData,type MarketData} from '../src/app/market/universalis';
vi.mock('../src/app/market/universalis',async original=>({...await original<typeof Universalis>(),loadMarketCenters:vi.fn(),searchMarketItems:vi.fn(),loadMarketData:vi.fn()}));
const snapshot=(value=43):MarketData=>({itemID:2,lastUploadTime:Date.now(),listings:[{pricePerUnit:value,quantity:2,hq:false,worldName:'红玉海'}],recentHistory:[{pricePerUnit:42,quantity:3,hq:false,timestamp:1793155961}]});
beforeEach(()=>{
  vi.mocked(loadMarketCenters).mockResolvedValue([{name:'陆行鸟',region:'中国',worlds:[{id:1167,name:'红玉海'}]}]);
  vi.mocked(searchMarketItems).mockResolvedValue([{id:2,name:'火之碎晶'}]);
  vi.mocked(loadMarketData).mockResolvedValue(snapshot());
});
afterEach(()=>{cleanup();vi.resetAllMocks();localStorage.clear();});
it('opens searches from the homepage without requesting external data in the background',()=>{
  const open=vi.fn();render(<MarketHome onOpenDetail={open}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'物品名称'}),{target:{value:'碎晶'}});
  fireEvent.submit(screen.getByRole('search',{name:'市场物品查询'}));expect(open).toHaveBeenLastCalledWith('碎晶');
  fireEvent.click(screen.getByRole('button',{name:'火之碎晶'}));expect(open).toHaveBeenLastCalledWith('火之碎晶');
  expect(loadMarketCenters).not.toHaveBeenCalled();expect(loadMarketData).not.toHaveBeenCalled();
});
it('loads an initial item, exposes the source and changes upstream scope and quality',async()=>{
  render(<MarketBoard initialQuery="2"/>);
  expect(await screen.findByRole('heading',{name:'火之碎晶'})).toBeTruthy();
  expect(screen.queryByRole('combobox',{name:'物品名称语言'})).toBeNull();
  expect(screen.getByRole('link',{name:'Universalis 原站 ↗'}).getAttribute('href')).toContain('/market/2?server=');
  expect(screen.getByRole('cell',{name:'43'})).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox',{name:'服务器'}),{target:{value:'1167'}});
  await waitFor(()=>expect(loadMarketData).toHaveBeenLastCalledWith('1167',2,'all',expect.any(AbortSignal),false));
  await waitFor(()=>expect(new URL(screen.getByRole('link',{name:'Universalis 原站 ↗'}).getAttribute('href')!).searchParams.get('server')).toBe('红玉海'));
  fireEvent.click(screen.getByRole('button',{name:'高品质 HQ'}));
  await waitFor(()=>expect(loadMarketData).toHaveBeenLastCalledWith('1167',2,'hq',expect.any(AbortSignal),false));
  expect(JSON.parse(localStorage.getItem('ff14-hub:market-preferences:v1')??'{}')).toMatchObject({scope:'1167',quality:'hq'});
});
it('ignores a late response for the previous server and aborts it',async()=>{
  let complete!:(value:MarketData)=>void;
  vi.mocked(loadMarketData).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;})).mockResolvedValue(snapshot(77));
  render(<MarketBoard initialQuery="2"/>);
  await waitFor(()=>expect(loadMarketData).toHaveBeenCalledOnce());
  const firstSignal=vi.mocked(loadMarketData).mock.calls[0]![3];
  fireEvent.change(screen.getByRole('combobox',{name:'服务器'}),{target:{value:'1167'}});
  expect(await screen.findByRole('cell',{name:'77'})).toBeTruthy();expect(firstSignal.aborted).toBe(true);
  complete(snapshot(999));
  await waitFor(()=>expect(screen.queryByRole('cell',{name:'999'})).toBeNull());
  expect(screen.getByRole('cell',{name:'77'})).toBeTruthy();
});
it('keeps empty prices distinct from zero and lets a failed search retry',async()=>{
  vi.mocked(searchMarketItems).mockRejectedValueOnce(new Error('搜索暂不可用'));
  vi.mocked(loadMarketData).mockResolvedValue({itemID:2,lastUploadTime:0,listings:[],recentHistory:[],hasData:false});
  render(<MarketBoard initialQuery="2"/>);
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'重试搜索'}));
  expect(await screen.findByText('暂无在售')).toBeTruthy();expect(screen.getByText('暂无成交')).toBeTruthy();
  expect(screen.getByText(/快照已超过两小时/)).toBeTruthy();
});
it('switches data centers without retaining an unrelated server selection',async()=>{
  vi.mocked(loadMarketCenters).mockResolvedValue([
    {name:'陆行鸟',region:'中国',worlds:[{id:1167,name:'红玉海'}]},
    {name:'猫小胖',region:'中国',worlds:[{id:1043,name:'紫水栈桥'}]},
  ]);
  render(<MarketBoard initialQuery="火之碎晶"/>);
  await screen.findByRole('heading',{name:'火之碎晶'});
  fireEvent.change(screen.getByRole('combobox',{name:'服务器'}),{target:{value:'1167'}});
  await waitFor(()=>expect(loadMarketData).toHaveBeenLastCalledWith('1167',2,'all',expect.any(AbortSignal),false));
  fireEvent.change(screen.getByRole('combobox',{name:'大区 / 数据中心'}),{target:{value:'猫小胖'}});
  await waitFor(()=>expect(loadMarketData).toHaveBeenLastCalledWith('猫小胖',2,'all',expect.any(AbortSignal),false));
  expect(screen.getByRole('combobox',{name:'服务器'}).textContent).not.toContain('红玉海');
  expect(screen.getByRole('combobox',{name:'服务器'}).textContent).toContain('紫水栈桥');
});
it('shows records in readable pages and switches between listings and sales',async()=>{
  vi.mocked(loadMarketData).mockResolvedValue({...snapshot(),listings:Array.from({length:25},(_,index)=>({pricePerUnit:40+index,quantity:2,hq:false,worldName:'红玉海'}))});
  render(<MarketBoard initialQuery="火之碎晶"/>);
  await screen.findByRole('heading',{name:'火之碎晶'});
  expect(screen.getAllByRole('row')).toHaveLength(11);
  fireEvent.click(screen.getByRole('button',{name:'再显示 10 条'}));
  expect(screen.getAllByRole('row')).toHaveLength(21);
  fireEvent.click(screen.getByRole('button',{name:/近期成交 1/}));
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('columnheader',{name:'成交时间 / 品质'})).toBeTruthy();
  expect(screen.getByRole('columnheader',{name:'合计 Gil'})).toBeTruthy();
});
it('shows multiple matches before any market request and cancels requests on close',async()=>{
  vi.mocked(searchMarketItems).mockResolvedValue([{id:2,name:'火之碎晶'},{id:3,name:'冰之碎晶'}]);
  const view=render(<MarketBoard initialQuery="碎晶"/>);
  const result=await screen.findByRole('button',{name:/火之碎晶/});
  expect(loadMarketData).not.toHaveBeenCalled();
  fireEvent.click(result);await waitFor(()=>expect(loadMarketData).toHaveBeenCalledOnce());
  const requestSignal=vi.mocked(loadMarketData).mock.calls[0]![3];
  view.unmount();expect(requestSignal.aborted).toBe(true);
});
