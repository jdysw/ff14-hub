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

test('rejects stale frontend even when health succeeds',async()=>{
  await assert.rejects(verifyLive('production',fixture({asset:'older-build'})),/differs/);
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
