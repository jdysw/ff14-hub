// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {navCatalogEntrySchema} from '@ff14-hub/shared';
import {LocalApp} from '../src/app/local/LocalApp';

const {read,change}=vi.hoisted(()=>({read:vi.fn(),change:vi.fn()}));
vi.mock('../src/app/local/store',()=>({createLocalStore:()=>({read,change,subscribe:()=>()=>{}})}));
vi.mock('../src/app/local/fish-port',()=>({localFishingData:()=>({loadCatalog:vi.fn()})}));
vi.mock('../src/app/fish/FishingBoard',()=>({FishingBoard:()=>null}));
vi.mock('../src/app/shell/HomeOfficialEvents',()=>({HomeOfficialEvents:()=>null}));
vi.mock('../src/app/fish/catalog',()=>({loadFishingCatalog:()=>Promise.resolve({fish:[]})}));
vi.mock('../src/app/local/public-resources',()=>({loadPublicCalendar:()=>Promise.resolve({events:[]})}));
vi.mock('../src/app/admin/site-settings',()=>({useSiteSettings:()=>({siteName:'FF14 Hub',announcementEnabled:false,announcement:'',homeCalendarEnabled:true})}));
vi.mock('../src/app/events/calendar-admin-session',()=>({useCalendarAdminSession:()=>({authenticated:false})}));
vi.mock('../src/app/pwa/PwaStatusBar',()=>({PwaStatusBar:()=>null}));
const entries=[['market','市场工具','市场与经济'],['fish','钓鱼工具','生产采集与钓鱼']].map(([id,title,category])=>navCatalogEntrySchema.parse({
  id,title,category,url:`https://${id}.example.org/`,description:'真实工具用途',tags:[],aliases:[],icon:'',openMode:'new_tab',region:'both',
  sourceVersion:3,sortOrder:1,sourceUrl:'https://example.org/',sourceName:'测试',verifiedAt:1,verificationStatus:'verified',updatedAt:1,
}));
beforeEach(()=>{
  vi.stubGlobal('scrollTo',vi.fn());
  read.mockResolvedValue({version:1,revision:0,fish:{cn:[],global:[]},links:[],notes:[],configuration:{order:['events','fishing','notes'],visible:{events:false,fishing:false,notes:false},region:'cn'}});
  vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({entries,sourceVersion:3,updatedAt:1}),{status:200}))));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
const directory=()=>within(screen.getByRole('region',{name:'导航站'}));

it('defaults to the first populated category without an all-categories button',async()=>{
 const official={...entries[0]!,id:'official',title:'国服官网',url:'https://official.example.org/',category:'官方与账号 / 官网与公告'};
 vi.mocked(fetch).mockImplementation(()=>Promise.resolve(Response.json({entries:[...entries,official],sourceVersion:3,updatedAt:1})));
 render(<LocalApp/>);
 await screen.findByText('国服官网');
 const tabs=within(directory().getByRole('navigation',{name:'网站分类'}));
 expect(tabs.queryByRole('button',{name:'全部'})).toBeNull();
 expect(tabs.getByRole('button',{name:'官方与账号'}).getAttribute('aria-pressed')).toBe('true');
 expect(directory().queryByText('市场工具')).toBeNull();
 fireEvent.click(tabs.getByRole('button',{name:'生产与采集'}));
 expect(directory().getByText('市场工具')).toBeDefined();
 expect(directory().queryByText('国服官网')).toBeNull();
});

it('renders more than 36 directory entries without a show-more gate',async()=>{
 const many=Array.from({length:45},(_,index)=>({...entries[0]!,id:'entry-'+index,title:'工具 '+index,url:'https://entry'+index+'.example.org/'}));
 vi.mocked(fetch).mockImplementation(()=>Promise.resolve(Response.json({entries:many,sourceVersion:3,updatedAt:1})));
 render(<LocalApp/>);
 await screen.findByText('工具 44');
 expect(directory().getAllByRole('listitem')).toHaveLength(45);
 expect(directory().queryByRole('button',{name:/显示更多/})).toBeNull();
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

it('opens inline search without unmounting an unfinished settings form',async()=>{
  render(<LocalApp/>);await screen.findByText('市场工具');fireEvent.click(screen.getByRole('button',{name:'设置'}));
  fireEvent.click(screen.getByRole('button',{name:'待办'}));
  fireEvent.change(screen.getByRole('textbox',{name:'待办标题'}),{target:{value:'尚未保存的备忘'}});
  fireEvent.focus(screen.getByRole('searchbox',{name:'全站搜索关键词'}));
  await screen.findByRole('region',{name:'全站搜索结果'});
  expect(screen.getByRole<HTMLInputElement>('textbox',{name:'待办标题'}).value).toBe('尚未保存的备忘');expect(change).not.toHaveBeenCalled();
});
