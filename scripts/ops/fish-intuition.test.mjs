import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {auditIntuition,supplementIntuition} from '../lib/fish-intuition-audit.mjs';
test('classifies a missing duration separately from a real predecessor condition conflict',()=>{
  const one={startHour:0,endHour:24,weatherSet:[],previousWeatherSet:[]},tracker={FISH:{1:{...one,location:2,predators:[[3,2]],intuitionLength:100},3:one}};
  const facts={fish:[{id:1,spots:[{spotId:2,predators:[{id:3,count:2}],intuitionLength:100,startHour:0,endHour:24,currentWeather:[],previousWeather:[],preconditions:[{id:3,spots:[{startHour:0,endHour:24,currentWeather:[],previousWeather:[]}]}]}]}]};
  assert.equal(auditIntuition(tracker,facts).matched,1);tracker.FISH[1].intuitionLength=null;assert.equal(auditIntuition(tracker,facts).supplemented,1);
  facts.fish[0].spots[0].preconditions[0].spots[0].endHour=8;assert.equal(auditIntuition(tracker,facts).conflicts,1);
});
test('the committed 32-record report and public catalogs retain source differences rather than promoting all to matched',async()=>{
  const report=JSON.parse(await readFile('data/fishing-intuition-audit.json','utf8'));
  assert.equal(report.total,32);assert.equal(report.matched,24);assert.equal(report.supplemented,8);assert.equal(report.partial,0);assert.equal(report.conflicts,0);
  const observations=await readFile('data/fishing-intuition-observations.json','utf8');
  assert.equal(report.sources.observationsSha256,createHash('sha256').update(observations).digest('hex'));
  assert.equal(report.sources.trackerSha256,JSON.parse(await readFile('data/fishing-accuracy-audit.json','utf8')).files['tracker.js']);
  for(const region of ['cn','global']){
  const catalog=JSON.parse(await readFile(`apps/web/public/fishing/catalog-${region}.json`,'utf8'));
  assert.equal(catalog.intuitionCrosscheck.matched,report.matched);assert.equal(catalog.fish.filter(f=>f.intuitionCrosscheck).length,32);
  assert.equal(catalog.fish.find(f=>f.id===24994).intuitionCrosscheck.status,'matched');assert.equal(catalog.fish.find(f=>f.id===46195).intuitionCrosscheck.supplemented,true);
  for(const [id,seconds] of [[46195,350],[49797,300],[49801,300],[52005,300],[52008,360],[52009,900],[52297,90],[52011,600]]){
    const fish=catalog.fish.find(f=>f.id===id);assert.equal(fish.intuitionDuration.seconds,seconds);assert.equal(fish.intuitionDuration.source,'fishcake');
    assert.equal(fish.intuitionCrosscheck.status,'partial');assert.equal(fish.intuitionCrosscheck.supplemented,true);
    assert.ok(fish.conditions.some(c=>c.includes(`${seconds} 秒（鱼糕补充）`)));assert.equal(fish.rule.conditions.filter(c=>c.kind==='intuition').length,1);assert.equal(fish.rule.validationStatus,'unverified');
  }
  }
});

test('normalizes mooch dependencies but never accepts an unsupported effective override',()=>{
  const one={startHour:0,endHour:24,weatherSet:[],previousWeatherSet:[]};
  const tracker={FISH:{1:{...one,location:2,predators:[[3,2]],intuitionLength:100},3:{...one,startHour:4,endHour:8}}};
  const fact={startHour:0,endHour:24,currentWeather:[],previousWeather:[],effectiveConditions:{startHour:4,endHour:8,currentWeather:[],previousWeather:[]}};
  const snapshot={fish:[{id:1,spots:[{spotId:2,predators:[{id:3,count:2}],intuitionLength:100,startHour:0,endHour:24,currentWeather:[],previousWeather:[],preconditions:[{id:3,spots:[fact]}]}]}]};
  assert.equal(auditIntuition(tracker,snapshot).conflicts,1);
  fact.moochDependencies=[{id:4,startHour:4,endHour:8,currentWeather:[],previousWeather:[]}];
  assert.equal(auditIntuition(tracker,snapshot).matched,1);
  assert.equal(auditIntuition(tracker,snapshot).records[0].predecessors[0].normalizedMooch,true);
});

test('duration fill is idempotent and never overwrites a conflicting known duration',()=>{
  const fish={conditions:['鱼识前置：测试 × 3'],rule:{version:'v1',conditions:[{kind:'predators',description:'前置'}],validationStatus:'unverified'}};
  const row={status:'supplemented',intuitionSeconds:350},snapshot={version:'abc',observedAt:'2026-10-23T00:00:00Z'};
  const once=supplementIntuition(fish,row,snapshot);assert.deepEqual(supplementIntuition(once,row,snapshot),once);assert.equal(fish.rule.conditions.length,1);
  const long=supplementIntuition({...fish,rule:{...fish.rule,version:'a'.repeat(80)}},row,snapshot);assert.equal(long.rule.version.length,80);assert.deepEqual(supplementIntuition(long,row,snapshot),long);
  assert.equal(supplementIntuition(fish,{...row,status:'conflict'},snapshot),fish);
  for(const seconds of [0,-1,Infinity,NaN,1.5])assert.throws(()=>supplementIntuition(fish,{...row,intuitionSeconds:seconds},snapshot));
});
