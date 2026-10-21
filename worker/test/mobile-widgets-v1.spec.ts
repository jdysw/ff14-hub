import {SELF} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';
import {mobileWidgetResponseV1Schema,FRONTLINE_MAPS,CRYSTAL_MAPS} from '@ff14-hub/shared';
import {TEST_BASE_URL} from './helpers';

const url=`${TEST_BASE_URL}/api/v1/widgets/v1/summary`;
describe('platform-neutral mobile widget API v1',()=>{
  it('returns public UTC snapshot with version, finite expiry and complete PvP cycles',async()=>{
    const response=await SELF.fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const raw:unknown=await response.json();
    const payload=mobileWidgetResponseV1Schema.parse(raw);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.timezone).toBe('Asia/Shanghai');
    expect(payload.region).toBe('cn');
    expect(payload.generatedAtMs).toBeLessThan(payload.refreshAfterMs);
    expect(payload.refreshAfterMs).toBeLessThan(payload.staleAfterMs);
    expect(payload.pvp.frontline.cycle).toEqual(FRONTLINE_MAPS);
    expect(payload.pvp.frontline.ruleVersion).toBe('2026-10-21-cn-v2');
    expect(new Date(payload.pvp.frontline.changesAtMs + 8 * 3_600_000).getUTCHours()).toBe(23);
    expect(payload.pvp.crystalline.cycle).toEqual(CRYSTAL_MAPS);
    expect(payload.fish).toEqual({status:'selection_required',items:[]});
    expect(['ready','stale','unavailable']).toContain(payload.events.status);
    expect(JSON.stringify(raw)).not.toContain('workspaceId');
    expect(JSON.stringify(raw)).not.toContain('password');
  });
  it('does not expose CN official calendar for international region',async()=>{
    const response=await SELF.fetch(`${url}?region=global`);
    expect(response.status).toBe(200);
    const data=mobileWidgetResponseV1Schema.parse(await response.json());
    expect(data.region).toBe('global');
    expect(data.events).toEqual({status:'unavailable',sourceCheckedAtMs:null,items:[]});
  });
  it('enforces a bounded unique positive fish watchlist and rejects unknown keys',async()=>{
    for(const query of ['fishIds=1,1','fishIds=0','fishIds=-1','fishIds=1,2,3,4,5,6,7,8,9,10,11','region=both','secret=1']){
      const response=await SELF.fetch(`${url}?${query}`);
      expect(response.status,query).toBe(422);
    }
  });
  it('rejects mutating methods on the read-only endpoint',async()=>{
    const response=await SELF.fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(response.status).toBe(405);
  });
});
