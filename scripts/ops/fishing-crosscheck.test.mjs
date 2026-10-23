import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {periods,teamcraftPeriods,effectivePeriods,pathSteps,compatiblePaths,checkField,normalizedOceanTimes,completeMoochPath} from '../lib/fishing-crosscheck.mjs';
import {correctCatalog} from '../lib/fishing-corrections.mjs';
const json=async path=>JSON.parse(await readFile(path,'utf8'));
test('normalizes minute precision, overnight spans and inherited mooch time',()=>{
  assert.deepEqual(periods(23.5,1.083333373),teamcraftPeriods({spawns:[23.5],duration:94.8}));
  assert.deepEqual(effectivePeriods(periods(0,24),[1,2],id=>id===2?{periods:periods(18,6),path:[1]}:null),periods(18,6));
  assert.equal(periods(NaN,24),null);
});
test('bait choices and abbreviated mooch paths do not become false condition conflicts',()=>{
  assert.equal(compatiblePaths([pathSteps([[1,2],3]),pathSteps([2,3])]),true);
  assert.equal(compatiblePaths([pathSteps([1,3]),pathSteps([2,3])]),false);
  assert.deepEqual(completeMoochPath([3],8,new Map([[3,{spots:[{spotId:8,bestCatchPathIds:[1]}]}]])),[1,3]);
  assert.equal(checkField('field',{one:undefined,two:1}).status,'single-source');
  assert.equal(checkField('field',{catalog:1,fishcake:1}).status,'single-source');
  assert.equal(checkField('field',{one:1,two:2}).status,'conflict');
});
test('ocean day and sunset enum numbers differ between sources and must be mapped semantically',async()=>{
  const conventions=await json('data/fishing-source-conventions.json');
  assert.deepEqual(normalizedOceanTimes([2],conventions.fishcakeOceanTimes),normalizedOceanTimes([1],conventions.teamcraftOceanTimes));
  assert.deepEqual(normalizedOceanTimes([1],conventions.fishcakeOceanTimes),['day']);
  assert.deepEqual(normalizedOceanTimes([1,2,3],conventions.fishcakeOceanTimes),[]);
  assert.throws(()=>normalizedOceanTimes([999],conventions.teamcraftOceanTimes));
});
test('spear node unlocking and fish intuition remain distinct and corrections are idempotent',()=>{
  const catalog={region:'cn',fish:[{id:1,method:'spear',spotId:8,name:'鱼',patch:'4',bait:[],conditions:['鱼识前置：旧混合条件','刺鱼机制'],rule:null}]};
  const source={spotId:8,patch:4,predators:[{id:3,count:2}],shadowPredators:[{id:2,count:7}],intuitionSeconds:20};
  const context={catalog,fishcake:new Map([[1,{spots:[source]}]]),teamcraft:new Map(),items:new Map([[2,'触发鱼'],[3,'前置鱼']]),spotNames:new Map(),snapshot:{version:'v',observedAt:'2026-10-23T00:00:00Z'},tracker:{FISH:{},ITEMS:{}}};
  correctCatalog(context);const once=structuredClone(catalog);correctCatalog(context);assert.deepEqual(catalog,once);
  assert.ok(catalog.fish[0].conditions.includes('鱼识前置：前置鱼 × 2'));
  assert.ok(catalog.fish[0].conditions.some(c=>c.startsWith('鱼影触发')&&c.includes('触发鱼 × 7')));
  assert.equal(catalog.fish[0].conditions.filter(c=>c.startsWith('鱼识持续 ')).length,1);
});
test('all catalog identities have individual audit rows and source-limited evidence remains visible',async()=>{
  const [report,snapshot,versions]=await Promise.all([json('data/fishing-full-crosscheck.json'),readFile('data/fishing-fishcake-observations.json','utf8'),json('data/fishing-sources.json')]);
  assert.equal(report.sources.fishcakeSha256,createHash('sha256').update(snapshot).digest('hex'));assert.equal(report.sources.tracker,versions.tracker);
  for(const [region,total] of [['cn',2764],['global',1724]]){
    const catalog=await json(`apps/web/public/fishing/catalog-${region}.json`),audit=report.regions.find(r=>r.region===region);
    assert.equal(audit.total,total);assert.equal(audit.records.length,total);assert.equal(new Set(audit.records.map(r=>r.id)).size,total);
    assert.deepEqual(audit.records.map(r=>r.id).sort((a,b)=>a-b),catalog.fish.map(f=>f.id).sort((a,b)=>a-b));
    assert.equal(audit.checked+audit.partial+audit.conflicts+audit.singleSource,total);assert.ok(audit.fieldsCompared>25000);
    assert.deepEqual(catalog.crossSourceAudit.total,audit.total);assert.equal(catalog.fish.filter(f=>f.crossSourceAudit).length,total);
    const elephant=catalog.fish.find(f=>f.id===14218),nautilus=catalog.fish.find(f=>f.id===4906);
    assert.equal(elephant.rule.endHour,24);assert.equal(nautilus.rule.startHour,18);assert.equal(nautilus.rule.endHour,6);assert.equal(nautilus.always,false);
    const raw=audit.records.find(r=>r.id===14218).fields.find(f=>f.field==='time');assert.equal(raw.status,'resolved');assert.deepEqual(raw.values.tracker,[[18,23]]);assert.deepEqual(raw.resolution.value,[[18,24]]);
    const turtle=audit.records.find(r=>r.id===51228).fields.find(f=>f.field==='oceanTime');assert.deepEqual(turtle.values.teamcraft,['night']);assert.deepEqual(turtle.values.fishcake,['sunset']);assert.equal(turtle.status,'resolved');
    assert.ok(catalog.fish.find(f=>f.id===51228).conditions.some(c=>c.includes('黄昏')));
    assert.ok(catalog.fish.find(f=>f.id===36535).conditions.some(c=>c.startsWith('鱼影触发')));
    assert.ok(catalog.fish.find(f=>f.id===36535).conditions.some(c=>c.startsWith('鱼识前置')&&!c.includes('乐园石斑鱼')));
    assert.ok(catalog.fish.every(f=>!f.rule||f.rule.validationStatus==='unverified'));
    assert.ok(catalog.fish.every(f=>!f.rule||f.rule.version.length<=80));
    if(region==='cn'){assert.ok(audit.singleSource>0);assert.ok(audit.partial>0);assert.equal(catalog.fish.find(f=>f.id===20144).location,'红玉炮台附近');assert.ok(catalog.fish.find(f=>f.id===43807).aliases.includes('泽拉多'));}
  }
});
