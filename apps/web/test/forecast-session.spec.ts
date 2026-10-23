// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {nextFishingWindowRefresh,subscribeFishingForecast} from '../src/app/fish/forecast-session';
import type {FishingCatalog} from '../src/app/fish/catalog';
import type {FishForecast} from '../src/app/fish/forecast';

class FakeWorker{
  onmessage:((event:MessageEvent<{forecasts?:FishForecast[];error?:string}>)=>void)|null=null;
  onerror:(()=>void)|null=null;
  postMessage=vi.fn();
  terminate=vi.fn();
}
let workers:FakeWorker[]=[];
const WorkerFactory=class extends FakeWorker{constructor(){super();workers.push(this);}};
const catalog={
  generatedAt:'2026-10-24T00:00:00Z',
  versions:{cn:'v1',tracker:'v1',teamcraft:'v1'},
  fish:[{id:42}],
} as unknown as FishingCatalog;
beforeEach(()=>{workers=[];vi.stubGlobal('Worker',WorkerFactory);});
afterEach(()=>vi.unstubAllGlobals());

it('shares one worker and prediction stream between homepage and expanded view',()=>{
  const a=vi.fn(),b=vi.fn(),data:FishForecast[]=[{id:42,windows:[],failed:false}];
  const stopA=subscribeFishingForecast(catalog,'cn',168,a);
  const stopB=subscribeFishingForecast(catalog,'cn',168,b);
  expect(workers).toHaveLength(1);
  expect(workers[0]?.postMessage).toHaveBeenCalledOnce();
  workers[0]?.onmessage?.(new MessageEvent('message',{data:{forecasts:data}}));
  expect(a).toHaveBeenCalledWith({forecasts:data});
  expect(b).toHaveBeenCalledWith({forecasts:data});
  stopA();
  expect(workers[0]?.terminate).not.toHaveBeenCalled();
  stopB();
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  const stopC=subscribeFishingForecast(catalog,'cn',168,vi.fn());
  expect(workers).toHaveLength(2);
  stopC();
});

it('replays the current forecast to a late subscriber and separates different horizons',()=>{
  const first=vi.fn();
  const stopA=subscribeFishingForecast(catalog,'cn',168,first);
  workers[0]?.onmessage?.(new MessageEvent('message',{data:{forecasts:[]}}));
  const late=vi.fn();
  const stopB=subscribeFishingForecast(catalog,'cn',168,late);
  expect(late).toHaveBeenCalledWith({forecasts:[]});
  const stopShort=subscribeFishingForecast(catalog,'cn',24,vi.fn());
  expect(workers).toHaveLength(2);
  stopShort();stopB();stopA();
});

it('does not reuse a worker when rules differ despite matching catalogue metadata',()=>{
  const older={...catalog,fish:[{id:42,rule:{version:'old',startHour:4}}]} as unknown as FishingCatalog;
  const newer={...catalog,fish:[{id:42,rule:{version:'new',startHour:8}}]} as unknown as FishingCatalog;
  const stale=vi.fn(),fresh=vi.fn();
  const stopA=subscribeFishingForecast(older,'cn',168,stale);
  const stopB=subscribeFishingForecast(newer,'cn',168,fresh);
  expect(workers).toHaveLength(2);
  const stopC=subscribeFishingForecast({...newer,fish:[{...newer.fish[0]!}]} as FishingCatalog,'cn',168,vi.fn());
  expect(workers).toHaveLength(2);
  workers[0]?.onmessage?.(new MessageEvent('message',{data:{forecasts:[{id:42,failed:false,windows:[]}]}}));
  expect(stale).toHaveBeenCalledOnce();
  expect(fresh).not.toHaveBeenCalled();
  stopA();
  // base key 被释放后，仍应找到正在工作的 :1 任务。
  const stopD=subscribeFishingForecast({...newer},'cn',168,vi.fn());
  expect(workers).toHaveLength(2);
  stopD();stopC();stopB();
});

it('replays the latest worker error to a subsequent subscriber and cleans up on a failed post',()=>{
  const initial=vi.fn();
  const stop=subscribeFishingForecast(catalog,'cn',168,initial);
  workers[0]?.onerror?.();
  const late=vi.fn();
  const stopLate=subscribeFishingForecast(catalog,'cn',168,late);
  expect(late).toHaveBeenCalledWith({error:'鱼窗计算中断，请重试。'});
  stopLate();stop();
});
it('schedules recomputation at minute rollover or an earlier exact fish window boundary',()=>{
  const now=Date.parse('2026-10-24T01:02:15.000Z');
  const window=(startsAtUtcMs:number,endsAtUtcMs:number)=>({
    id:1,failed:false,windows:[{startsAtUtcMs,endsAtUtcMs}],
  }) as FishForecast;
  expect(nextFishingWindowRefresh(now,[])).toBe(Date.parse('2026-10-24T01:03:00.000Z'));
  expect(nextFishingWindowRefresh(now,[window(now+17_000,now+80_000)])).toBe(now+17_000);
  expect(nextFishingWindowRefresh(now,[window(now-17_000,now+25_000)])).toBe(now+25_000);
  expect(nextFishingWindowRefresh(now,[window(now-80_000,now-1)])).toBe(Date.parse('2026-10-24T01:03:00.000Z'));
});
