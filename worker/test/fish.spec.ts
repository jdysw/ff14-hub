import {SELF,env} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {fishListResponseSchema,fishWindowsResponseSchema} from '@ff14-hub/shared';
import {importFishBundle,demoFish} from './fixtures/fish';

const BASE='https://hub.test/api/v1';
beforeEach(async()=>{
  for(const region of ['cn','global'] as const)
    await importFishBundle(env.DB,{schemaVersion:1,region,records:demoFish(region)});
});
describe('current public fishing API',()=>{
  it('requires region and bounds window computation; examples remain explicitly unverified',async()=>{
    expect((await SELF.fetch(`${BASE}/fish`)).status).toBe(422);
    const response=await SELF.fetch(`${BASE}/fish?region=cn`);
    expect(response.status).toBe(200);
    const body=fishListResponseSchema.parse(await response.json());
    expect(body.fish[0]?.demo).toBe(true);
    expect(body.fish[0]?.rule.validationStatus).toBe('unverified');
    const windows=await SELF.fetch(`${BASE}/fish/windows?region=cn&from=4200000&hours=1`);
    expect(windows.status).toBe(200);
    fishWindowsResponseSchema.parse(await windows.json());
    expect((await SELF.fetch(`${BASE}/fish/windows?region=cn&hours=169`)).status).toBe(422);
  });
  it('does not accept records with the wrong region and updates public rules atomically',async()=>{
    await expect(importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:demoFish('global')})).rejects.toThrow();
    await importFishBundle(env.DB,{schemaVersion:1,region:'cn',records:demoFish('cn').map(f=>({...f,rule:{...f.rule,version:'synthetic-v2'}}))});
    const response=await SELF.fetch(`${BASE}/fish?region=cn`);
    expect(response.status).toBe(200);
    const body=fishListResponseSchema.parse(await response.json());
    expect(body.fish[0]?.rule.version).toBe('synthetic-v2');
  });
  it('does not expose the retired workspace fish-progress endpoint',async()=>{
    const response=await SELF.fetch(`${BASE}/me/fish-progress?region=cn`);
    expect(response.status).toBe(404);
  });
});
