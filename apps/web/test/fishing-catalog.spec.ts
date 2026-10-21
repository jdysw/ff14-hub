import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {fishingCatalogSchema} from '../src/app/fish/catalog';
import {forecastCatalog,windowState} from '../src/app/fish/forecast';
const catalog=fishingCatalogSchema.parse(JSON.parse(readFileSync(new URL('../public/fishing/catalog-cn.json',import.meta.url),'utf8')) as unknown);

describe('real fishing catalog',()=>{
  it('ships all named CN FishParameter identities, including hidden fish and quest fish',()=>{
    expect(catalog.coverage.total).toBe(2764);
    expect(catalog.coverage.forecast).toBe(874);
    const zalera=catalog.fish.find(f=>f.id===7678);
    expect(zalera?.name).toBe('扎尔艾拉');
    expect(zalera?.bait).toEqual(['沟鼠尾巴']);
    expect(catalog.fish.find(f=>f.id===8754)?.kind).toBe('legendary');
    expect(catalog.fish.find(f=>f.id===2001398)?.name).toBe('圣人鲤');
    expect(catalog.coverage.forecast+catalog.coverage.always+catalog.coverage.unknown).toBe(catalog.coverage.total);
  });
  it('does not turn missing rules into always-available windows',()=>{
    const fish=catalog.fish.find(f=>!f.rule&&!f.always);
    expect(fish).toBeDefined();
    const state=windowState(fish!,undefined,Date.now());
    expect(state).toMatchObject({unknown:true,always:false,open:null,next:null});
  });
  it('evaluates real Zalera time restrictions with canonical UTC/ET boundaries',()=>{
    const fish=catalog.fish.find(f=>f.id===7678)!;
    const result=forecastCatalog([fish],'cn',175000*9,1);
    expect(result[0]?.failed).toBe(false);
    expect(result[0]?.windows[0]).toMatchObject({startsAtUtcMs:175000*9,endsAtUtcMs:175000*14,candidateOnly:true});
  });
  it('computes the entire catalog without a 30-row page limit',()=>{
    const results=forecastCatalog(catalog.fish,'cn',Date.now(),168);
    expect(results).toHaveLength(874);
    expect(results.filter(r=>r.failed)).toHaveLength(0);
    expect(results.some(r=>r.id>40000&&r.windows.length>0)).toBe(true);
  });
  it('keeps actual predator identities/counts and alternative baits in CN guides',()=>{
    expect(catalog.fish.find(f=>f.id===8754)?.conditions).toContain('鱼识前置：小撒拉奥斯 × 3');
    expect(catalog.fish.find(f=>f.id===8752)?.conditions).toContain('鱼识前置：丛林鲶鱼 × 3');
    expect(catalog.fish.find(f=>f.id===36458)?.bait).toEqual(['蜉蝣 / 医蛭']);
  });
  it('does not show a made-up closing countdown for unrestricted time/weather',()=>{
    const fish=catalog.fish.find(f=>f.id===4904)!;
    const forecast=forecastCatalog([fish],'cn',Date.now(),24)[0]!;
    expect(forecast.windows).toHaveLength(1);
    expect(forecast.windows[0]?.unrestricted).toBe(true);
    expect(windowState(fish,forecast,Date.now())).toMatchObject({always:true,open:null,next:null,unknown:false});
  });
  it('publishes game weather matches without promoting community gameplay to verified',()=>{
    expect(catalog.accuracy).toMatchObject({weatherMatched:874,weatherMismatch:0,weatherMissing:0,gameplayVerified:0});
    expect(catalog.fish.filter(f=>f.rule).every(f=>f.rule?.validationStatus!=='verified')).toBe(true);
  });
});
