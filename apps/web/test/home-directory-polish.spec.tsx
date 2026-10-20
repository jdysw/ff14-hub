// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {navCatalogEntrySchema} from '@ff14-hub/shared';
import {LocalApp} from '../src/app/local/LocalApp';

const {read,change}=vi.hoisted(()=>({read:vi.fn(),change:vi.fn()}));
vi.mock('../src/app/local/store',()=>({createLocalStore:()=>({read,change,subscribe:()=>()=>{}})}));
vi.mock('../src/app/local/fish-port',()=>({localFishPort:()=>({operations:[],call:vi.fn()})}));
vi.mock('../src/app/fish/FishingBoard',()=>({FishingBoard:()=>null}));
vi.mock('../src/app/shell/HomeOfficialEvents',()=>({HomeOfficialEvents:()=>null}));
vi.mock('../src/app/admin/site-settings',()=>({useSiteSettings:()=>({siteName:'FF14 Hub',announcementEnabled:false,announcement:'',homeCalendarEnabled:true})}));
vi.mock('../src/app/events/calendar-admin-session',()=>({useCalendarAdminSession:()=>({authenticated:false})}));
vi.mock('../src/app/pwa/PwaStatusBar',()=>({PwaStatusBar:()=>null}));
const entries=[['market','市场工具','市场与经济'],['fish','钓鱼工具','生产采集与钓鱼']].map(([id,title,category])=>navCatalogEntrySchema.parse({
  id,title,category,url:`https://${id}.example.org/`,description:'真实工具用途',tags:[],aliases:[],icon:'',openMode:'new_tab',region:'both',
  sourceVersion:3,sortOrder:1,sourceUrl:'https://example.org/',sourceName:'测试',verifiedAt:1,verificationStatus:'verified',updatedAt:1,
}));
beforeEach(()=>{
  read.mockResolvedValue({version:1,revision:0,fish:{cn:[],global:[]},links:[],notes:[],configuration:{order:['events','fishing','notes'],visible:{events:false,fishing:false,notes:false},region:'cn'}});
  vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({entries,sourceVersion:3,updatedAt:1}),{status:200}))));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
const directory=()=>within(screen.getByRole('region',{name:'导航站'}));

it('does not show an empty result while the first public catalog is still loading',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));
  render(<LocalApp/>);
  expect(await screen.findByText('正在更新网站目录…')).toBeDefined();
  expect(screen.queryByText('还没有网站')).toBeNull();
  expect(screen.queryByText('没有找到匹配的网站')).toBeNull();
});

it('exposes category and search filters, announces result counts, and resets all filters',async()=>{
  render(<LocalApp/>);
  await screen.findByText('市场工具');
  fireEvent.click(within(directory().getByRole('navigation',{name:'网站分类'})).getByRole('button',{name:'市场与经济'}));
  expect(screen.queryByRole('combobox',{name:'更多分类'})).toBeNull();
  expect(directory().queryByText('钓鱼工具')).toBeNull();
  expect(directory().getByText('1 / 2 个网站')).toBeDefined();
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索网站'}),{target:{value:'不存在'}});
  expect(directory().getByText('没有找到匹配的网站')).toBeDefined();
  fireEvent.click(directory().getByRole('button',{name:'清除筛选'}));
  expect(directory().getByText('2 个网站')).toBeDefined();
  expect(directory().getByText('钓鱼工具')).toBeDefined();
});

it('retains already loaded links when refresh fails and makes retry available',async()=>{
  const fetchMock=vi.mocked(fetch);
  render(<LocalApp/>);
  await screen.findByText('市场工具');
  fetchMock.mockResolvedValueOnce(new Response('',{status:503}));
  fireEvent(window,new Event('ff14hub:directory-changed'));
  await screen.findByText(/公共目录暂时无法更新/);
  expect(directory().getByText('市场工具')).toBeDefined();
  expect(directory().getByRole('button',{name:'重试'})).toBeDefined();
  expect(screen.queryByText('正在更新网站目录…')).toBeNull();
});

it('does not steal focus out of an open modal with the slash shortcut',async()=>{
  render(<LocalApp/>);
  await screen.findByText('市场工具');
  const dialog=document.createElement('dialog');dialog.setAttribute('open','');
  const button=document.createElement('button');dialog.append(button);document.body.append(dialog);button.focus();
  fireEvent.keyDown(window,{key:'/'});
  expect(document.activeElement).toBe(button);
  dialog.remove();
  fireEvent.change(screen.getByRole('searchbox',{name:'搜索网站'}),{target:{value:'市场'}});
  fireEvent.keyDown(screen.getByRole('searchbox',{name:'搜索网站'}),{key:'Escape'});
  await waitFor(()=>expect(directory().getByText('2 个网站')).toBeDefined());
});
