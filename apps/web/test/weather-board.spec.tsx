// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ET_DAY_MS,ET_HOUR_MS} from '@ff14-hub/shared';
import {WeatherBoard} from '../src/app/weather/WeatherBoard';
import {WeatherHome} from '../src/app/weather/WeatherHome';
import {loadWeatherCatalog,weatherCatalogSchema} from '../src/app/weather/weather';
import {readWeatherPreferences,saveWeatherPreferences} from '../src/app/weather/weather-state';
vi.mock('../src/app/weather/weather',async original=>({...await original<{loadWeatherCatalog:typeof loadWeatherCatalog;weatherCatalogSchema:typeof weatherCatalogSchema}>(),loadWeatherCatalog:vi.fn()}));
const catalog=weatherCatalogSchema.parse(JSON.parse(readFileSync('public/weather/catalog-cn.json','utf8')) as unknown);
beforeEach(()=>{vi.mocked(loadWeatherCatalog).mockResolvedValue(catalog);});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.useRealTimers();localStorage.clear();});
it('renders the selected map, nine periods, source coverage and a Chinese searchable selector',async()=>{
  render(<WeatherBoard initialZoneId={134}/>);
  expect(await screen.findByRole('heading',{name:'中拉诺西亚'})).toBeTruthy();
  expect(within(screen.getByRole('region',{name:'当前及后续八个天气时段'})).getAllByRole('listitem')).toHaveLength(9);
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索地图'}),{target:{value:'黄金港'}});
  expect(screen.getByRole('combobox',{name:/选择地图/}).textContent).toContain('黄金港');
  fireEvent.change(screen.getByRole('combobox',{name:/选择地图/}),{target:{value:'628'}});
  expect(screen.getByRole('heading',{name:'黄金港'})).toBeTruthy();
  expect(readWeatherPreferences().selected).toBe(628);
});
it('updates homepage favorites immediately and persists an explicit unfavorite',async()=>{
  render(<><WeatherHome onOpenDetail={()=>{}}/><WeatherBoard initialZoneId={134}/></>);
  const home=screen.getByRole('region',{name:'艾欧泽亚时间与天气'});
  await screen.findByRole('button',{name:'取消关注中拉诺西亚'});
  expect(within(home).getByRole('button',{name:'查看中拉诺西亚天气'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'取消关注中拉诺西亚'}));
  await waitFor(()=>expect(within(home).queryByRole('button',{name:'查看中拉诺西亚天气'})).toBeNull());
  expect(readWeatherPreferences().favorites).not.toContain(134);
});
it('keeps the selected map stable while a filter has no matches and offers a reset',async()=>{
  render(<WeatherBoard initialZoneId={134}/>);
  await screen.findByRole('heading',{name:'中拉诺西亚'});
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索地图'}),{target:{value:'不在目录中的地图'}});
  expect(screen.getByRole('heading',{name:'中拉诺西亚'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'查看全部地图'}));
  expect(screen.getAllByRole('option')).toHaveLength(70);
});
it('retries failed map loading while the ET clock stays available',async()=>{
  vi.mocked(loadWeatherCatalog).mockRejectedValueOnce(new Error('offline'));
  render(<WeatherBoard/>);
  expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.getByText('艾欧泽亚时间')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'重试'}));
  expect(await screen.findByRole('heading',{name:'中拉诺西亚'})).toBeTruthy();
});
it('ticks across a weather boundary and restores the clock after a focus event',async()=>{
  vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
  const boundary=Math.floor(Date.UTC(2026,9,28)/ET_DAY_MS)*ET_DAY_MS+8*ET_HOUR_MS;
  vi.setSystemTime(boundary-500);
  const view=render(<WeatherHome onOpenDetail={()=>{}}/>);
  await act(async()=>{await Promise.resolve();});
  expect(screen.getByLabelText('艾欧泽亚时间 07:59')).toBeTruthy();
  await act(()=>vi.advanceTimersByTime(1000));
  expect(screen.getByLabelText('艾欧泽亚时间 08:00')).toBeTruthy();
  vi.setSystemTime(boundary+10*ET_HOUR_MS);
  await act(()=>window.dispatchEvent(new Event('focus')));
  expect(screen.getByLabelText('艾欧泽亚时间 18:00')).toBeTruthy();
  view.unmount();expect(vi.getTimerCount()).toBe(0);
});
it('rejects oversized or malformed preferences and handles unavailable storage honestly',()=>{
  localStorage.setItem('ff14-hub:weather-places:v1','{"selected":0,"favorites":[]}');
  expect(readWeatherPreferences().selected).toBe(134);
  expect(()=>saveWeatherPreferences({selected:134,favorites:[1,2,3,4,5,6,7]})).toThrow();
  const failure=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('disabled');});
  expect(saveWeatherPreferences({selected:134,favorites:[]})).toBe(false);failure.mockRestore();
});
