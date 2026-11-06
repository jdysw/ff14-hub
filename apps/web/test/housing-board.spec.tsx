// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useState} from 'react';
import {HousingBoard} from '../src/app/housing/HousingBoard';
import {HousingHome} from '../src/app/housing/HousingHome';
import {HousingContext,useHousingState} from '../src/app/housing/housing-state';

afterEach(() => {cleanup();localStorage.clear();vi.unstubAllGlobals();});

function HousingView() {
  const [detailOpen,setDetailOpen] = useState(false);
  const state = useHousingState(true,detailOpen);
  return <HousingContext.Provider value={state}>
    <HousingHome onOpen={()=>setDetailOpen(true)}/>
    {detailOpen && <><HousingBoard/><button type="button" onClick={()=>setDetailOpen(false)}>关闭详情</button></>}
  </HousingContext.Provider>;
}

it('displays one-based ward numbers and separates unknown participation from reported zero', async () => {
  const plot = {Server:1167,Area:0,Slot:0,ID:34,Price:20_000_000,Size:1,LastSeen:1793880705,
    State:0,Participate:0,Winner:0,EndTime:0,UpdateTime:0,PurchaseType:2,RegionType:2};
  const reported = {...plot,ID:35,State:1,UpdateTime:1793880705,EndTime:4_000_000_000};
  const fetcher = vi.fn(() => Promise.resolve(Response.json({plots:[plot,reported],fetchedAt:1793880705000})));
  vi.stubGlobal('fetch',fetcher);
  const view = render(<HousingView/>);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:/查询房源/}));
  const unknown = await screen.findByRole('row',{name:/海雾村 1 区 34 号/});
  expect(within(unknown).getAllByRole('cell')[4]?.textContent).toBe('—');
  const open = screen.getByRole('row',{name:/海雾村 1 区 35 号/});
  expect(within(open).getAllByRole('cell')[4]?.textContent).toBe('0');
  fireEvent.change(screen.getByRole('combobox',{name:'抽签状态'}),{target:{value:'1'}});
  expect(screen.queryByRole('row',{name:/34 号/})).toBeNull();
  expect(screen.getByRole('row',{name:/35 号/})).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:'关闭详情'}));
  const home = within(screen.getByRole('region',{name:'房屋抽取'}));
  expect(home.getByText('匹配 1 条房源')).toBeDefined();
  expect(home.getByText('海雾村 1 区 35 号')).toBeDefined();
  expect(home.queryByText('海雾村 1 区 34 号')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  view.unmount();
  render(<HousingView/>);
  expect(await screen.findByText('匹配 1 条房源')).toBeDefined();
  fireEvent.click(screen.getByRole('button',{name:/筛选与详情/}));
  expect(screen.getByRole<HTMLSelectElement>('combobox',{name:'抽签状态'}).value).toBe('1');
});
