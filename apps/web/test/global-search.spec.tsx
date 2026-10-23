// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {GlobalSearch} from '../src/app/local/GlobalSearch';
import {loadFishingCatalog,fishingCatalogSchema} from '../src/app/fish/catalog';
import {loadPublicCalendar} from '../src/app/local/public-resources';
vi.mock('../src/app/fish/catalog',async original=>({...await original<{fishingCatalogSchema:typeof fishingCatalogSchema}>(),loadFishingCatalog:vi.fn()}));
vi.mock('../src/app/local/public-resources',()=>({loadPublicCalendar:vi.fn()}));
const catalog=fishingCatalogSchema.parse(JSON.parse(readFileSync('public/fishing/catalog-cn.json','utf8')) as unknown);
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('searches without issuing requests per keystroke and routes an exact fish result to its region and ID',async()=>{
  vi.mocked(loadFishingCatalog).mockResolvedValue(catalog);vi.mocked(loadPublicCalendar).mockRejectedValue(new Error('offline'));
  const onFish=vi.fn();render(<GlobalSearch links={[]} initialRegion="cn" onFish={onFish} onEvent={()=>{}} onFeature={()=>{}}/>);
  const input=screen.getByRole('searchbox',{name:'全站搜索关键词'});fireEvent.change(input,{target:{value:'涅普'}});fireEvent.change(input,{target:{value:'涅普特龙'}});
  const result=await screen.findByRole('button',{name:/涅普特龙/});fireEvent.click(result);expect(onFish).toHaveBeenCalledWith({region:'cn',fishId:8754});expect(loadFishingCatalog).toHaveBeenCalledTimes(1);expect(loadPublicCalendar).toHaveBeenCalledTimes(1);
});
it('keeps feature navigation usable if fish and event data both fail',async()=>{
  vi.mocked(loadFishingCatalog).mockRejectedValue(new Error('offline'));vi.mocked(loadPublicCalendar).mockRejectedValue(new Error('offline'));
  const open=vi.fn();render(<GlobalSearch links={[]} initialRegion="cn" onFish={()=>{}} onEvent={()=>{}} onFeature={open}/>);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'备份'}});await waitFor(()=>expect(screen.getByText(/鱼类目录暂不可用/)).toBeTruthy());fireEvent.click(screen.getByRole('button',{name:/备份与恢复/}));expect(open).toHaveBeenCalledWith('backup');
});
