import {SELF} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import {TEST_BASE_URL} from './helpers';

describe('POST /navigation/metadata integration',()=>{
  const endpoint=`${TEST_BASE_URL}/api/v1/navigation/metadata`;
  const post=(body:unknown)=>SELF.fetch(endpoint,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),
  });
  it('consumes the JSON already parsed by the writeGuard and rejects private URLs with 422',async()=>{
    const response=await post({url:'https://127.0.0.1/admin'});
    expect(response.status).toBe(422);
    const message=await response.text();
    expect(message).toContain('HTTPS');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects malformed shapes without starting an external request',async()=>{
    const response=await post({url:'https://example.org',extra:'ignore-me'});
    expect(response.status).toBe(422);
  });
  it('does not allow cross-origin browser POST requests',async()=>{
    const response=await SELF.fetch(endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json',Origin:'https://evil.example'},
      body:JSON.stringify({url:'https://example.org'}),
    });
    expect(response.status).toBe(403);
  });
});
