import './setup-d1';
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



});
