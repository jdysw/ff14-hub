import {SELF} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';
import {publicEventListResponseSchema} from '@ff14-hub/shared';

const BASE='https://hub.test/api/v1/events';
describe('current public event API',()=>{
  it('responds anonymously with public entries only',async()=>{
    const response=await SELF.fetch(BASE);
    expect(response.status).toBe(200);
    const payload=publicEventListResponseSchema.parse(await response.json());
    expect(payload.events).toBeDefined();
    expect(payload.serverTimeMs).toBeGreaterThan(0);
  });
  it('rejects invalid regions and disallows public writes',async()=>{
    expect((await SELF.fetch(BASE+'?region=both')).status).toBe(422);
    const response=await SELF.fetch(BASE,{method:'DELETE',headers:{Origin:'https://hub.test'}});
    expect([403,405]).toContain(response.status);
  });
  it('does not route private workspace events',async()=>{
    expect((await SELF.fetch('https://hub.test/api/v1/me/events')).status).toBe(404);
  });
});
