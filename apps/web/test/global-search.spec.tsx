// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {GlobalSearch} from '../src/app/local/GlobalSearch';
import {loadFishingCatalog,fishingCatalogSchema} from '../src/app/fish/catalog';
import {loadPublicCalendar} from '../src/app/local/public-resources';
import type {BrowserLink} from '../src/app/local/directory-links';
vi.mock('../src/app/fish/catalog',async original=>({...await original<{fishingCatalogSchema:typeof fishingCatalogSchema}>(),loadFishingCatalog:vi.fn()}));
vi.mock('../src/app/local/public-resources',()=>({loadPublicCalendar:vi.fn()}));
const catalog=fishingCatalogSchema.parse(JSON.parse(readFileSync('public/fishing/catalog-cn.json','utf8')) as unknown);
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('searches without issuing requests per keystroke and routes an exact fish result to its region and ID',async()=>{
  vi.mocked(loadFishingCatalog).mockResolvedValue(catalog);vi.mocked(loadPublicCalendar).mockRejectedValue(new Error('offline'));
  const onFish=vi.fn(),props={links:[],initialRegion:'cn' as const,onFish,onEvent:()=>{},onFeature:()=>{},onClose:()=>{}};
  const view=render(<GlobalSearch {...props} query=""/>);
  view.rerender(<GlobalSearch {...props} query="涅普"/>);view.rerender(<GlobalSearch {...props} query="涅普特龙"/>);
  const result=await screen.findByRole('button',{name:/涅普特龙/});fireEvent.click(result);expect(onFish).toHaveBeenCalledWith({region:'cn',fishId:8754});expect(loadFishingCatalog).toHaveBeenCalledTimes(1);expect(loadPublicCalendar).toHaveBeenCalledTimes(1);
});
it('keeps feature navigation usable if fish and event data both fail',async()=>{
  vi.mocked(loadFishingCatalog).mockRejectedValue(new Error('offline'));vi.mocked(loadPublicCalendar).mockRejectedValue(new Error('offline'));
  const open=vi.fn();render(<GlobalSearch query="备份" links={[]} initialRegion="cn" onFish={()=>{}} onEvent={()=>{}} onFeature={open} onClose={()=>{}}/>);
  await waitFor(()=>expect(screen.getByText(/鱼类目录暂不可用/)).toBeTruthy());fireEvent.click(screen.getByRole('button',{name:/备份与恢复/}));expect(open).toHaveBeenCalledWith('backup');
});
it('offers keyboard-accessible quick actions without loading catalogs for an empty query',()=>{
  const close=vi.fn();render(<GlobalSearch query="" links={[]} initialRegion="cn" onFish={()=>{}} onEvent={()=>{}} onFeature={()=>{}} onClose={close}/>);
  const first=screen.getByRole('button',{name:/今日计划/}),second=screen.getByRole('button',{name:/活动日历/});
  first.focus();fireEvent.keyDown(first,{key:'ArrowDown'});expect(document.activeElement).toBe(second);
  fireEvent.keyDown(second,{key:'ArrowUp'});expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first,{key:'Escape'});expect(close).toHaveBeenCalledOnce();
  expect(loadFishingCatalog).not.toHaveBeenCalled();expect(loadPublicCalendar).not.toHaveBeenCalled();
});
it('narrows mixed results by type without a second query field or another network search',async()=>{
  vi.mocked(loadFishingCatalog).mockResolvedValue(catalog);vi.mocked(loadPublicCalendar).mockResolvedValue({events:[],serverTimeMs:1,source:{name:'官方公告',homeUrl:'https://ff.web.sdo.com/',checkedAtMs:1,stale:false}});
  const links:BrowserLink[]=[{id:'guide',title:'涅普特龙攻略',url:'https://example.org/',category:'钓鱼',description:'钓法参考',tags:[],aliases:[],region:'cn',favorite:false,personal:false}];
  render(<GlobalSearch query="涅普特龙" links={links} initialRegion="cn" onFish={()=>{}} onEvent={()=>{}} onFeature={()=>{}} onClose={()=>{}}/>);
  await screen.findByRole('region',{name:'鱼类搜索结果'});expect(screen.getByRole('region',{name:'网站搜索结果'})).toBeTruthy();
  fireEvent.click(within(screen.getByRole('group',{name:'搜索结果类型'})).getByRole('button',{name:/鱼类/}));
  expect(screen.queryByRole('region',{name:'网站搜索结果'})).toBeNull();expect(screen.getByRole('region',{name:'鱼类搜索结果'})).toBeTruthy();
  expect(screen.queryByRole('searchbox')).toBeNull();expect(loadFishingCatalog).toHaveBeenCalledOnce();
});
