import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const json=async path=>JSON.parse(await readFile(path,'utf8'));

test('all catalog identities have individual audit rows and source-limited evidence remains visible',async()=>{
  const [report,snapshot,versions]=await Promise.all([json('data/fishing-full-crosscheck.json'),readFile('data/fishing-fishcake-observations.json','utf8'),json('data/fishing-sources.json')]);
  assert.equal(report.sources.fishcakeSha256,createHash('sha256').update(snapshot).digest('hex'));assert.equal(report.sources.tracker,versions.tracker);
  for(const [region,total] of [['cn',2764],['global',1724]]){
    const catalog=await json(`apps/web/public/fishing/catalog-${region}.json`),audit=report.regions.find(r=>r.region===region);
    assert.equal(audit.total,total);assert.equal(audit.records.length,total);assert.equal(new Set(audit.records.map(r=>r.id)).size,total);
    assert.deepEqual(audit.records.map(r=>r.id).sort((a,b)=>a-b),catalog.fish.map(f=>f.id).sort((a,b)=>a-b));
    assert.equal(audit.checked+audit.special+audit.partial+audit.conflicts+audit.singleSource,total);assert.ok(audit.fieldsCompared>25000);
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
    assert.equal(catalog.fish.filter(f=>f.acquisitionContext).length,audit.special);
    assert.ok(catalog.fish.filter(f=>f.acquisitionContext).every(f=>f.acquisitionContext.inFishingLog===false&&(!f.rule||f.acquisitionContext.category==='collectable')&&!f.always));
    for(const id of [43903,43904,43905,43906]){const collectible=catalog.fish.find(f=>f.id===id);assert.equal(collectible.acquisitionContext.category,'collectable');assert.ok(collectible.rule);}
    if(region==='cn'){
      assert.ok(audit.specialSourceOnly>0);assert.equal(audit.special,958);assert.equal(audit.checked,1806);
      assert.equal(catalog.fish.find(f=>f.id===20144).location,'红玉炮台附近');assert.ok(catalog.fish.find(f=>f.id===43807).aliases.includes('泽拉多'));
      assert.equal(catalog.fish.find(f=>f.id===29994).spotId,10001);assert.equal(catalog.fish.find(f=>f.id===29994).location,'云冠洞穴');
      assert.equal(catalog.fish.find(f=>f.id===52224).acquisitionContext.category,'cosmic');
      assert.equal(catalog.fish.find(f=>f.id===6688).acquisitionContext.category,'associated-item');
      const old=catalog.fish.find(f=>f.id===13734).acquisitionContext;assert.equal(old.locations.length,0);assert.ok(old.unmatchedSpotIds.includes(10005));
    }
  }
});
