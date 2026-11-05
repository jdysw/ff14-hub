// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {HousingBoard} from '../src/app/housing/HousingBoard';

afterEach(() => {cleanup();vi.unstubAllGlobals();});

it('displays one-based ward numbers and separates unknown participation from reported zero', async () => {
  const plot = {Server:1167,Area:0,Slot:0,ID:34,Price:20_000_000,Size:1,LastSeen:1793880705,
    State:0,Participate:0,Winner:0,EndTime:0,UpdateTime:0,PurchaseType:2,RegionType:2};
  const reported = {...plot,ID:35,State:1,UpdateTime:1793880705,EndTime:4_000_000_000};
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({plots:[plot,reported],fetchedAt:1793880705000}))));
  render(<HousingBoard/>);
  const unknown = await screen.findByRole('row',{name:/海雾村 1 区 34 号/});
  expect(within(unknown).getAllByRole('cell')[4]?.textContent).toBe('—');
  const open = screen.getByRole('row',{name:/海雾村 1 区 35 号/});
  expect(within(open).getAllByRole('cell')[4]?.textContent).toBe('0');
  fireEvent.change(screen.getByRole('combobox',{name:'抽签状态'}),{target:{value:'1'}});
  expect(screen.queryByRole('row',{name:/34 号/})).toBeNull();
  expect(screen.getByRole('row',{name:/35 号/})).toBeDefined();
});
