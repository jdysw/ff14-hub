import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const converter=fileURLToPath(new URL('../prepare-fish-tracker-import.mjs',import.meta.url));
const upstream={
  FISH:{'100':{_id:100,startHour:22,endHour:4,location:3,bigFish:true,weatherSet:[2],
    previousWeatherSet:[1],bestCatchPath:[200],predators:[],fishEyes:false,dataMissing:null}},
  FISHING_SPOTS:{'3':{name_en:'Test Cove',territory_id:128}},
  SPEARFISHING_SPOTS:{},ITEMS:{'100':{name_en:'Test Fish'},'200':{name_en:'Test Bait'}},
  WEATHER_RATES:{'128':{weather_rates:[[1,70],[2,100]]}},
  WEATHER_TYPES:{'1':{name_en:'Clear Skies'},'2':{name_en:'Rain'}}
};
const source=(value)=>'const DATA = {\n'+Object.entries(value).map(([name,records])=>'  '+name+': '+JSON.stringify(records)).join(',\n')+'\n}\n';

test('adapts versioned upstream fish records without executing source code',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hub-fishing-'));
  try{
    const input=join(dir,'data.js');const output=join(dir,'fish.json');
    await writeFile(input,source(upstream));
    execFileSync(process.execPath,[converter,input,'global','abcdef1234567890',output]);
    const data=JSON.parse(await readFile(output,'utf8'));
    assert.equal(data.region,'global');
    assert.equal(data.records.length,1);
    const fish=data.records[0];
    assert.equal(fish.id,100);
    assert.equal(fish.fishType,'big');
    assert.equal(fish.demo,false);
    assert.equal(fish.rule.zoneId,'Test Cove');
    assert.equal(fish.rule.weatherRates.reduce((n,r)=>n+r.chance,0),100);
    assert.deepEqual(fish.rule.currentWeather,['Rain']);
    assert.deepEqual(fish.rule.previousWeather,['Clear Skies']);
    assert.equal(fish.source.authorizationStatus,'unverified');
    assert.equal(fish.rule.validationStatus,'unverified');
    assert.ok(fish.rule.conditions.some(c=>c.kind==='bait'));
    assert.throws(()=>execFileSync(process.execPath,[converter,input,'cn','abcdef1234567890',output],{stdio:'pipe'}));
    await writeFile(input,source(upstream)+'process.exit(100);\n');
    assert.throws(()=>execFileSync(process.execPath,[converter,input,'global','abcdef1234567890',output],{stdio:'pipe'}));
  }finally{await rm(dir,{recursive:true,force:true});}
});
