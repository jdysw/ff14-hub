import './setup-d1';
import {SELF,env} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {navCatalogEntrySchema} from '@ff14-hub/shared';
import {NAV_CATALOG_SEED,applyCatalogSeed,readCatalog,RETIRED_NAVIGATION_IDS} from '../modules/nav/catalog';
const BASE='https://hub.test/api/v1/navigation/catalog';

beforeEach(async()=>{await applyCatalogSeed({db:env.DB,now:Date.now()});});

describe('public navigation directory without legacy workspaces',()=>{
  it('applies reviewed descriptions and regions without losing the stable legacy ID',()=>{
    const market=NAV_CATALOG_SEED.find(entry=>entry.id==='catalog.universalis');
    expect(market?.region).toBe('both');expect(market?.description).toContain('跨服务器');
    expect(NAV_CATALOG_SEED.some(entry=>RETIRED_NAVIGATION_IDS.has(entry.id))).toBe(false);
    expect(NAV_CATALOG_SEED.every(entry=>!entry.category.startsWith('插件与开发'))).toBe(true);
  });
  it('retires rows left by older seeds while preserving an explicit owner restoration',async()=>{
    const old=NAV_CATALOG_SEED[0]!,id=[...RETIRED_NAVIGATION_IDS][0]!;
    try{
    await env.DB.prepare('UPDATE nav_catalog_links SET id=? WHERE id=?').bind(id,old.id).run();
    expect((await readCatalog({db:env.DB})).some(entry=>entry.id===id)).toBe(false);
    const restored={...old,id};
    await env.DB.prepare('INSERT INTO nav_catalog_edits(id,payload,canonical_url,hidden,revision,updated_at) VALUES(?,?,?,0,1,?)')
      .bind(id,JSON.stringify(restored),old.url,Date.now()).run();
    expect((await readCatalog({db:env.DB})).some(entry=>entry.id===id)).toBe(true);
    }finally{
      await env.DB.prepare('DELETE FROM nav_catalog_edits WHERE id=?').bind(id).run();
      await env.DB.prepare('DELETE FROM nav_catalog_links WHERE id=?').bind(id).run();
      await applyCatalogSeed({db:env.DB,now:Date.now()});
    }
  });
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
