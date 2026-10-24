import {SELF,env} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {navCatalogEntrySchema} from '@ff14-hub/shared';
import {NAV_CATALOG_SEED,applyCatalogSeed} from '../modules/nav/catalog';
const BASE='https://hub.test/api/v1/navigation/catalog';

beforeEach(async()=>{await applyCatalogSeed({db:env.DB,now:Date.now()});});

describe('public navigation directory without legacy workspaces',()=>{
  it('returns only public catalogue entries, with a stable source revision',async()=>{
    const response=await SELF.fetch(BASE);
    expect(response.status).toBe(200);
    const body=await response.json<{entries:unknown[];sourceVersion:number;updatedAt:number}>();
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.length).toBeLessThanOrEqual(NAV_CATALOG_SEED.length);
    for(const entry of body.entries)navCatalogEntrySchema.parse(entry);
    expect(body.sourceVersion).toBeGreaterThan(0);
  });
  it('rejects invalid region and accepts anonymous scoped reads',async()=>{
    expect((await SELF.fetch(BASE+'?region=invalid')).status).toBe(422);
    const response=await SELF.fetch(BASE+'?region=cn');
    expect(response.status).toBe(200);
    const rows=(await response.json<{entries:{region:string}[]}>()).entries;
    expect(rows.every(entry=>entry.region==='cn'||entry.region==='both')).toBe(true);
  });
  it('never exposes a per-workspace navigation route',async()=>{
    expect((await SELF.fetch('https://hub.test/api/v1/me/navigation')).status).toBe(404);
  });
});
