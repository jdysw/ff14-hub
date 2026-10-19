import { test } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const converter=fileURLToPath(new URL('../prepare-fish-cn-import.mjs',import.meta.url));
const validator=fileURLToPath(new URL('../prepare-fish-import.mjs',import.meta.url));
const cnSha='a'.repeat(40);
const tracker={WEATHER_TYPES:{},FISH:{}};
const data={schemaVersion:1,region:'global',records:[]};
for(let id=1;id<=120;id++){
  tracker.FISH[String(id)]={location:1};
  data.records.push({
    id,region:'global',name:'Fish '+id,fishType:id===1?'big':'normal',demo:false,
    source:{url:'https://github.com/example/test',version:'b'.repeat(40),fetchedAt:Date.now(),authorizationStatus:'unverified',verificationStatus:'unverified'},
    rule:{schemaVersion:1,region:'global',fishId:id,version:'b'.repeat(40),zoneId:'Test spot',startHour:9,endHour:11,
      weatherRates:[{weather:'Clear Skies',chance:100}],currentWeather:[],previousWeather:[],conditions:[],validationStatus:'unverified'}
  });
}
for(let i=1;i<=5;i++)tracker.WEATHER_TYPES[String(i)]={name_en:i===1?'Clear Skies':'Weather '+i};
const csv=(heading,rows)=>'key,0\n#,'+heading+'\nint32,str\n'+rows.map(([id,value])=>String(id)+','+JSON.stringify(value)).join('\n')+'\n';
test('CN import intersects CN game IDs, translates names and weather, and passes shared Schema',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ff14-cn-import-'));
  const put=async(name,value)=>{const path=join(dir,name);await writeFile(path,value);return path;};
  try{
    const global=await put('global.json',JSON.stringify(data));
    const raw=await put('data.js','const DATA = {\n  WEATHER_TYPES: '+JSON.stringify(tracker.WEATHER_TYPES)+',\n  FISH: '+JSON.stringify(tracker.FISH)+'\n}\n');
    const cnNames=Array.from({length:120},(_,i)=>[i+1,i===0?'测试,鱼王':'国服鱼'+String(i+1)]);
    const items=await put('Item.csv',csv('Name',cnNames));
    const parameters=await put('FishParameter.csv',csv('Item',cnNames.map(([id])=>[id,String(id)])));
    const weather=await put('Weather.csv',csv('Name',Array.from({length:5},(_,i)=>[i+1,'国服天气'+String(i+1)])));
    const spots=await put('FishingSpot.csv',csv('PlaceName',[[1,'101']]));
    const places=await put('PlaceName.csv',csv('Name',[[101,'国服钓场']]));
    const output=join(dir,'cn.json');
    execFileSync(process.execPath,[converter,global,raw,items,parameters,weather,spots,places,cnSha,output],{stdio:'pipe'});
    const result=JSON.parse(await readFile(output,'utf8'));
    assert.equal(result.region,'cn');
    assert.equal(result.records.length,120);
    assert.equal(result.records[0].name,'测试,鱼王');
    assert.equal(result.records[0].rule.zoneId,'国服钓场');
    assert.equal(result.records[0].rule.weatherRates[0].weather,'国服天气1');
    assert.equal(result.records[0].rule.validationStatus,'unverified');
    assert.equal(result.records[0].source.authorizationStatus,'unverified');
    const sql=join(dir,'cn.sql');
    execFileSync(process.execPath,['--experimental-strip-types',validator,output,sql],{stdio:'pipe'});
    assert.ok((await readFile(sql,'utf8')).includes('INSERT INTO fish_catalog'));
    // 不能在 CN 表和国际服目录无交集时默默输出无效数据。
    await writeFile(parameters,csv('Item',[[999999,'999999']]));
    assert.throws(()=>execFileSync(process.execPath,[converter,global,raw,items,parameters,weather,spots,places,cnSha,output],{stdio:'pipe'}));
  }finally{await rm(dir,{recursive:true,force:true});}
});
