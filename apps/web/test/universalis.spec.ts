import {afterEach,beforeEach,expect,it,vi} from 'vitest';
beforeEach(()=>vi.resetModules());
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const signal=()=>new AbortController().signal;
it('accepts bounded item IDs and only Universalis market links',async()=>{
  const {parseMarketItemId}=await import('../src/app/market/universalis');
  expect(parseMarketItemId(' 2 ')).toBe(2);
  expect(parseMarketItemId('https://universalis.app/market/2?world=1167')).toBe(2);
  for(const value of ['0','-1','1000000','https://evil.org/market/2','https://user:pass@universalis.app/market/2','火之碎晶']){
    expect(parseMarketItemId(value)).toBeNull();
  }
});
it('escapes search syntax, requests Chinese names and omits credentials',async()=>{
  const fetcher=vi.fn().mockResolvedValue(reply({results:[{row_id:2,fields:{Name:'火之碎晶',Icon:{path:'ui/icon/020000/020001.tex'}}}]}));
  vi.stubGlobal('fetch',fetcher);
  const {searchMarketItems}=await import('../src/app/market/universalis');
  const items=await searchMarketItems('水"晶',signal());
  expect(items[0]?.id).toBe(2);expect(items[0]?.icon).toContain('https://v2.xivapi.com/api/asset/ui/icon/');
  const url=new URL(fetcher.mock.calls[0]![0] as string);
  expect(url.hostname).toBe('xivapi-v2.xivcdn.com');
  expect(url.searchParams.get('query')).toBe('+Name~'+JSON.stringify('水"晶')+' +ItemSearchCategory>=1');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({credentials:'omit',referrerPolicy:'no-referrer'});
});
it('joins live world IDs to data centers and excludes unknown worlds',async()=>{
  vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(url.endsWith('/worlds')?reply([{id:1167,name:'红玉海'}]):reply([{name:'陆行鸟',region:'中国',worlds:[1167,9999]}]))));
  const {loadMarketCenters}=await import('../src/app/market/universalis');
  expect(await loadMarketCenters(signal())).toEqual([{name:'陆行鸟',region:'中国',worlds:[{id:1167,name:'红玉海'}]}]);
});
it('caches price queries briefly and applies upstream HQ filters with bounded record counts',async()=>{
  const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(reply({itemID:2,lastUploadTime:1,listings:[],recentHistory:[]})));
  vi.stubGlobal('fetch',fetcher);
  const {loadMarketData}=await import('../src/app/market/universalis');
  await loadMarketData('陆行鸟',2,'hq',signal());await loadMarketData('陆行鸟',2,'hq',signal());
  expect(fetcher).toHaveBeenCalledTimes(1);
  const url=new URL(fetcher.mock.calls[0]![0] as string);
  expect(decodeURIComponent(url.pathname)).toBe('/api/v2/陆行鸟/2');
  expect(url.searchParams.get('hq')).toBe('true');expect(url.searchParams.get('listings')).toBe('40');
  expect(url.searchParams.get('entries')).toBe('30');
  await loadMarketData('陆行鸟',2,'hq',signal(),true);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('keeps numeric ID queries usable when the name service is down and rejects invalid URLs without requests',async()=>{
  const fetcher=vi.fn().mockRejectedValue(new TypeError('offline'));vi.stubGlobal('fetch',fetcher);
  const {searchMarketItems}=await import('../src/app/market/universalis');
  expect(await searchMarketItems('2',signal())).toEqual([{id:2,name:'物品 #2'}]);
  await expect(searchMarketItems('https://evil.org/market/2',signal())).rejects.toThrow('有效物品 ID');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('distinguishes service throttling and malformed price payloads from missing prices',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(reply({},429)).mockResolvedValueOnce(reply({itemID:2,lastUploadTime:1,listings:[{pricePerUnit:-1,quantity:1,hq:false}]}));
  vi.stubGlobal('fetch',fetcher);const {loadMarketData}=await import('../src/app/market/universalis');
  await expect(loadMarketData('1167',2,'all',signal())).rejects.toThrow('查询过于频繁');
  await expect(loadMarketData('1167',2,'all',signal())).rejects.toThrow('数据格式');
});
it('keeps record keys stable across insertion and price sorting while distinguishing duplicate records',async()=>{
  const {keyedMarketRows}=await import('../src/app/market/universalis');
  const first={listingID:'listing-1',pricePerUnit:80,quantity:2,hq:false};
  const second={pricePerUnit:40,quantity:3,hq:false,worldName:'红玉海',lastReviewTime:100};
  const before=keyedMarketRows([first,second,second]);
  const after=keyedMarketRows([{...first,pricePerUnit:90},second,second]);
  expect(after.map(item=>item.key)).toEqual(before.map(item=>item.key));
  expect(new Set(before.map(item=>item.key)).size).toBe(3);
  expect(keyedMarketRows([{...second,pricePerUnit:20},second,second]).slice(1).map(item=>item.key)).toEqual(before.slice(1).map(item=>item.key));
});
it('shows absence as unavailable and calculates the median from the returned sales only',async()=>{
  const {marketSummary}=await import('../src/app/market/universalis');
  expect(marketSummary({itemID:2,lastUploadTime:0,listings:[],recentHistory:[]})).toEqual({minimum:null,median:null});
  expect(marketSummary({itemID:2,lastUploadTime:1,listings:[{pricePerUnit:100,quantity:2,hq:false}],recentHistory:[10,80,20,30].map(pricePerUnit=>({pricePerUnit,quantity:1,hq:false,timestamp:1}))})).toEqual({minimum:100,median:25});
});
