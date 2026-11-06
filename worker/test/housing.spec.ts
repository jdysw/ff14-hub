import {afterEach,expect,it,vi} from 'vitest';
import {housingRoutes} from '../api/v1/housing';

afterEach(() => vi.unstubAllGlobals());

const plot = {
  Server:1167,Area:0,Slot:0,ID:34,Price:20_000_000,Size:1,LastSeen:1793880705,
  State:0,Participate:0,Winner:0,EndTime:0,UpdateTime:0,PurchaseType:2,RegionType:2,
};

it('queries a supported world using the documented API and caches its validated snapshot', async () => {
  const fetcher = vi.fn((input: URL, init: RequestInit) => {
    const request = new Request(input,init);
    expect(request.url).toBe('https://house.ffxiv.cyou/api/sales?server=1167');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('User-Agent')).toContain('FF14 Hub');
    return Promise.resolve(Response.json([plot]));
  });
  vi.stubGlobal('fetch',fetcher);
  const url = 'https://housing.test/?world=1167';
  const response = await housingRoutes.request(url);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({plots:[plot]});
  const repeated = await housingRoutes.request(url);
  expect(repeated.status).toBe(200);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('rejects invalid worlds and never presents an upstream error as an empty list', async () => {
  const fetcher = vi.fn(() => Promise.resolve(Response.json([plot])));
  vi.stubGlobal('fetch',fetcher);
  expect((await housingRoutes.request('/?world=9999')).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  const mismatched = await housingRoutes.request('https://housing-error.test/?world=1081');
  expect(mismatched.status).toBe(503);
  expect(mismatched.headers.get('Cache-Control')).toBe('no-store');
});
