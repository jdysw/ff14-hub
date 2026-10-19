import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLive} from './verify-live.mjs';

function fixture({environment='production',database='ok',asset='build-content',healthStatus=200}={}){
  const requests=[];
  return {requests,readAsset:async()=>Buffer.from('build-content'),fetcher:async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/api/v1/health'))return Response.json({status:'ok',environment,database},{status:healthStatus,headers:{'Cache-Control':'no-store'}});
    if(url.endsWith('/'))return new Response('<script src="/assets/app-123.js"></script><link href="/assets/app-123.css">',{headers:{'Content-Security-Policy':"script-src 'self'"}});
    return new Response(asset);
  }};
}

test('verifies build content and health without sending credentials or following redirects',async()=>{
  const data=fixture();
  assert.equal((await verifyLive('production',data)).assetsVerified,2);
  assert.equal(data.requests.length,4);
  for(const {url,options} of data.requests){
    assert.ok(url.startsWith('https://ff14.zhixia.uk/'));
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    assert.equal(options.headers,undefined);
  }
});
test('rejects preview health returned from production domain',async()=>{
  await assert.rejects(verifyLive('production',fixture({environment:'preview'})),/mismatch/);
});
test('rejects unhealthy database',async()=>{
  await assert.rejects(verifyLive('production',fixture({database:'error'})),/mismatch/);
});
test('rejects stale frontend even when health succeeds',async()=>{
  await assert.rejects(verifyLive('production',fixture({asset:'older-build'})),/differs/);
});
test('rejects non-200 health',async()=>{
  await assert.rejects(verifyLive('production',fixture({healthStatus:503})),/HTTP 503/);
});
test('rejects arbitrary environment before issuing any request',async()=>{
  const data=fixture();await assert.rejects(verifyLive('https://other.invalid',data),/environment/);
  assert.equal(data.requests.length,0);
});
test('missing local build asset becomes a handled verification failure',async()=>{
  const data=fixture();
  data.readAsset=async()=>{throw new Error('missing build asset');};
  await assert.rejects(verifyLive('production',data),/missing build asset/);
});
test('explicit browser challenge uses only the fixed same-Worker endpoint and reports limitation',async()=>{
  const data=fixture();const original=data.fetcher;const hosts=[];
  data.fetcher=async(url,options)=>{
    hosts.push(new URL(url).hostname);
    if(url.startsWith('https://ff14.zhixia.uk'))return new Response('challenge',{status:403,headers:{'cf-mitigated':'challenge'}});
    return original(url,options);
  };
  const report=await verifyLive('production',data);
  assert.equal(report.customDomainVerified,false);
  assert.equal(report.baseUrl,'https://ff14-hub.3347759490.workers.dev');
  assert.equal(report.assetsVerified,2);
  assert.deepEqual([...new Set(hosts)],['ff14.zhixia.uk','ff14-hub.3347759490.workers.dev']);
});
test('ordinary 403 is a failure rather than a reason to use another endpoint',async()=>{
  const data=fixture({healthStatus:403});
  await assert.rejects(verifyLive('production',data),/HTTP 403/);
  assert.equal(data.requests.length,1);
});
test('fallback endpoint must also pass build-integrity checks',async()=>{
  const data=fixture({asset:'incorrect-build'});const original=data.fetcher;
  data.fetcher=async(url,options)=>url.startsWith('https://ff14.zhixia.uk')
    ?new Response('challenge',{status:403,headers:{'cf-mitigated':'challenge'}}):original(url,options);
  await assert.rejects(verifyLive('production',data),/differs/);
});
