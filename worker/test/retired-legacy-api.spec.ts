import {SELF} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';

const base='https://hub.test/api/v1';
describe('single-user local-first API surface',()=>{
  it.each(['/identity/bootstrap','/identity/pairing','/me/profile','/me/navigation','/me/reminders','/modules/catalog'])(
    'does not expose retired workspace route %s',async(route)=>{
      const response=await SELF.fetch(base+route);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect((await response.json<{code:string}>()).code).toBe('not_found');
    });
  it('continues to serve the current public and owner routes',async()=>{
    expect((await SELF.fetch(base+'/health')).status).toBe(200);
    expect((await SELF.fetch(base+'/navigation/catalog')).status).toBe(200);
    expect((await SELF.fetch(base+'/local-notifications/status')).status).toBe(401);
    expect((await SELF.fetch(base+'/widgets/v1/overview')).status).not.toBe(404);
  });
});
