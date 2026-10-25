import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkedWranglerArguments,releaseGuard,releaseWorker} from './release-worker.mjs';
test('a feature branch or missing CI context cannot publish production',()=>{
  assert.throws(()=>releaseGuard('production',{}));assert.throws(()=>releaseGuard('production',{WORKERS_CI:'1',WORKERS_CI_BRANCH:'feature'}));
  assert.doesNotThrow(()=>releaseGuard('production',{WORKERS_CI:'1',WORKERS_CI_BRANCH:'main'}));assert.throws(()=>releaseGuard('unknown',{}));
});
test('confirmed upload precedes promotion and propagation retries never redeploy',async()=>{
  const calls=[],id='01234567-89ab-cdef-0123-456789abcdef';let checks=0;
  const result=await releaseWorker('production',{variables:{WORKERS_CI:'1',WORKERS_CI_BRANCH:'main'},run:async args=>{calls.push(args);return args[1]==='upload'?'Worker Version ID: '+id:'';},verify:async()=>{if(checks++===0)throw new Error('propagating');return {environment:'production'};},sleep:async()=>{}});
  assert.equal(result.version,id);assert.equal(calls.length,2);assert.ok(calls[0].includes('--keep-vars'));assert.ok(calls[1].includes(id+'@100'));assert.equal(checks,2);
});
test('an incomplete upload can never alter traffic',async()=>{
  let calls=0;await assert.rejects(releaseWorker('preview',{run:async()=>{calls++;return 'no confirmed version';}}));assert.equal(calls,1);
});

test('manual production release needs explicit approval AND a clean main checkout',()=>{
  const manual={FF14_MANUAL_RELEASE_APPROVAL:'ff14-hub-production'};
  assert.throws(()=>releaseGuard('production',manual));
  assert.throws(()=>releaseGuard('production',manual,{branch:'feature',clean:true}));
  assert.throws(()=>releaseGuard('production',manual,{branch:'main',clean:false}));
  assert.doesNotThrow(()=>releaseGuard('production',manual,{branch:'main',clean:true}));
  assert.throws(()=>releaseGuard('production',{FF14_MANUAL_RELEASE_APPROVAL:'yes'},{branch:'main',clean:true}));
});

test('Wrangler launch arguments are rebuilt from approved release command shapes',()=>{
  const upload=['versions','upload','--env','preview','--keep-vars','--tag','automated-preview','--message','Verified CI release verified-build'];
  const deploy=['versions','deploy','01234567-89ab-cdef-0123-456789abcdef@100','--env','production','--yes','--message','Verified main release verified-build'];
  assert.deepEqual(checkedWranglerArguments(upload),upload);assert.deepEqual(checkedWranglerArguments(deploy),deploy);
});
test('Wrangler launch rejects injected flags, unsupported commands and unconfirmed versions',()=>{
  assert.throws(()=>checkedWranglerArguments(['versions','delete','--all']));
  assert.throws(()=>checkedWranglerArguments(['versions','upload','--env','preview --remote','--keep-vars','--tag','automated-preview','--message','Verified CI release verified-build']));
  assert.throws(()=>checkedWranglerArguments(['versions','deploy','--help','--env','production','--yes','--message','Verified main release verified-build']));
});
