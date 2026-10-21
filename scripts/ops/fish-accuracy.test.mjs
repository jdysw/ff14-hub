import {test} from 'node:test';
import assert from 'node:assert/strict';
import {predatorPairs,baitPathLabels,trackerRequirements} from '../lib/fish-requirements.mjs';
import {gameWeatherTargets,trackerWeatherTargets,compareCnWeather} from '../lib/fish-accuracy.mjs';

test('predator tuples retain fish IDs and counts instead of array indexes',()=>{
  assert.deepEqual(predatorPairs([[4913,3],[5031,2]]),[[4913,3],[5031,2]]);
  assert.deepEqual(predatorPairs({'4913':3}),[[4913,3]]);
  assert.throws(()=>predatorPairs([[4913,0]]));
  assert.throws(()=>predatorPairs([[4913,3],[4913,2]]));
  const conditions=trackerRequirements({predators:[[4913,3]],intuitionLength:100},id=>id===4913?'测试前置鱼':undefined);
  assert.ok(conditions.some(c=>c.description.includes('测试前置鱼 × 3')));
  assert.ok(conditions.some(c=>c.description.includes('100 秒')));
});
test('bait alternatives are grouped without losing the mooch path',()=>{
  const names={1:'鱼饵甲',2:'鱼饵乙',3:'泳饵鱼'};
  assert.deepEqual(baitPathLabels([[1,2],3],id=>names[id]),['鱼饵甲 / 鱼饵乙','泳饵鱼']);
  assert.throws(()=>baitPathLabels([1,[2,3]],id=>names[id]));
});
test('unmodeled skill and missing conditions survive conversion',()=>{
  const conditions=trackerRequirements({snagging:true,lure:2,dataMissing:true},()=>undefined);
  assert.equal(conditions.filter(c=>c.kind==='unknown').length,3);
  assert.ok(conditions.some(c=>c.description.includes('钓组')));
});
test('weather comparison preserves ordered target ranges, including repeated weather IDs',()=>{
  const row={};for(let i=0;i<8;i++){row[`Weather[${i}]`]=0;row[`Rate[${i}]`]=0;}
  Object.assign(row,{'Weather[0]':7,'Rate[0]':20,'Weather[1]':2,'Rate[1]':30,'Weather[2]':7,'Rate[2]':50});
  assert.deepEqual(gameWeatherTargets(row),trackerWeatherTargets([[7,20],[2,50],[7,100]]));
  assert.notDeepEqual(gameWeatherTargets(row),trackerWeatherTargets([[7,70],[2,100]]));
  assert.throws(()=>gameWeatherTargets({...row,'Rate[2]':49}));
});
test('missing or conflicting CN weather can never become a matched fact',()=>{
  const tables={fish:{location:1},tracker:{FISHING_SPOTS:{1:{territory_id:10}},WEATHER_RATES:{10:{weather_rates:[[1,100]]}}},
    spots:new Map([[1,{TerritoryType:10}]]),territories:new Map([[10,{WeatherRate:2}]]),rates:new Map()};
  assert.equal(compareCnWeather(tables).status,'missing');
});
