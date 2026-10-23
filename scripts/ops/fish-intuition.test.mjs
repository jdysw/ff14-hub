import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {auditIntuition} from '../lib/fish-intuition-audit.mjs';
test('classifies a missing duration separately from a real predecessor condition conflict',()=>{
  const one={startHour:0,endHour:24,weatherSet:[],previousWeatherSet:[]},tracker={FISH:{1:{...one,location:2,predators:[[3,2]],intuitionLength:100},3:one}};
  const facts={fish:[{id:1,spots:[{spotId:2,predators:[{id:3,count:2}],intuitionLength:100,startHour:0,endHour:24,currentWeather:[],previousWeather:[],preconditions:[{id:3,spots:[{startHour:0,endHour:24,currentWeather:[],previousWeather:[]}]}]}]}]};
  assert.equal(auditIntuition(tracker,facts).matched,1);tracker.FISH[1].intuitionLength=null;assert.equal(auditIntuition(tracker,facts).partial,1);
  facts.fish[0].spots[0].preconditions[0].spots[0].endHour=8;assert.equal(auditIntuition(tracker,facts).conflicts,1);
});
test('the committed 32-record report and public catalogs retain source differences rather than promoting all to matched',async()=>{
  const report=JSON.parse(await readFile('data/fishing-intuition-audit.json','utf8'));
  assert.equal(report.total,32);assert.equal(report.matched,23);assert.equal(report.partial,8);assert.equal(report.conflicts,1);
  const observations=await readFile('data/fishing-intuition-observations.json','utf8');
  assert.equal(report.sources.observationsSha256,createHash('sha256').update(observations).digest('hex'));
  assert.equal(report.sources.trackerSha256,JSON.parse(await readFile('data/fishing-accuracy-audit.json','utf8')).files['tracker.js']);
  for(const region of ['cn','global']){
  const catalog=JSON.parse(await readFile(`apps/web/public/fishing/catalog-${region}.json`,'utf8'));
  assert.equal(catalog.intuitionCrosscheck.matched,report.matched);assert.equal(catalog.fish.filter(f=>f.intuitionCrosscheck).length,32);
  assert.equal(catalog.fish.find(f=>f.id===24994).intuitionCrosscheck.status,'conflict');assert.equal(catalog.fish.find(f=>f.id===46195).intuitionCrosscheck.status,'partial');
  }
});
