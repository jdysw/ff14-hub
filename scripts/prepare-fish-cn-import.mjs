import {csvRows} from './lib/fish-csv.mjs';
/**
 * 国服鱼类候选目录适配器：国际服社区规则 + 国服游戏表的 ID 交集。
 * 本脚本不执行下载的 JS，不声称两服最新规则相同；输出始终为候选规则。
 * 输入为上游转换的国际服 JSON 和来自国服 datamining 的 CSV。
 */
import { readFile,writeFile } from 'node:fs/promises';
import {trackerRequirements} from './lib/fish-requirements.mjs';

const [globalBundlePath,trackerPath,itemsPath,parametersPath,weatherPath,spotsPath,placesPath,cnSha,outputPath]=process.argv.slice(2);
if(![globalBundlePath,trackerPath,itemsPath,parametersPath,weatherPath,spotsPath,placesPath,cnSha,outputPath].every(Boolean)
    || !/^[a-f0-9]{40}$/i.test(cnSha)){
  throw new Error('用法: node scripts/prepare-fish-cn-import.mjs <global.json> <data.js> <Item.csv> <FishParameter.csv> <Weather.csv> <FishingSpot.csv> <PlaceName.csv> <国服commit40位SHA> <out.json>');
}

/** 按 RFC4180 读取含 BOM、逗号、双引号、换行和 CRLF 的 CSV。 */
function parseCsv(text){
  let rows;
  try{rows=csvRows(text);}catch{throw new Error('不完整的 CSV 引号');}
  if(rows[0]?.[0]?.codePointAt(0)===0xfeff){rows[0][0]=rows[0][0].slice(1);}
  return rows;
}
function indexOfHeader(table,header,name){
  const index=table.headers.indexOf(header);
  if(index<0)throw new Error(name+' 缺少列 '+header);
  return index;
}
function byId(table,valueIndex){
  const items=new Map();
  for(const fields of table.rows){
    if(!/^\d+$/.test(fields[0]??''))continue;
    const id=Number(fields[0]);if(id>0&&fields[valueIndex])items.set(id,fields[valueIndex]);
  }
  return items;
}
const bundle=JSON.parse(await readFile(globalBundlePath,'utf8'));
if(bundle.region!=='global'||!Array.isArray(bundle.records))throw new Error('必须使用前置国际服适配器输出');
const trackerText=await readFile(trackerPath,'utf8');
if(!trackerText.startsWith('const DATA = {')||!trackerText.trimEnd().endsWith('}'))throw new Error('上游 data.js 格式异常');
const tracker=JSON.parse(trackerText.replace(/^const DATA = /,'').replace(/^ {2}([A-Z_]+):/gm,'  "$1":'));
const [items,parameters,weathers,spots,places]=await Promise.all([
 itemsPath,parametersPath,weatherPath,spotsPath,placesPath].map(async (p)=>readFile(p,'utf8').then(parseCsv).then(rows=>{
   if(rows.length<4||rows[0][0]!=='key'||rows[1][0]!=='#'||rows[2][0]!=='int32')throw new Error('国服 CSV 表头非法: '+p);
   return {headers:rows[1],rows:rows.slice(3)};
 })));
const nameIndex=indexOfHeader(items,'Name','Item.csv');
const fishIdIndex=indexOfHeader(parameters,'Item','FishParameter.csv');
const weatherIndex=indexOfHeader(weathers,'Name','Weather.csv');
const spotPlaceIndex=indexOfHeader(spots,'PlaceName','FishingSpot.csv');
const placeNameIndex=indexOfHeader(places,'Name','PlaceName.csv');
const names=byId(items,nameIndex);
const weatherNames=byId(weathers,weatherIndex);
const placeNames=byId(places,placeNameIndex);
const fishIds=new Set(parameters.rows.map(r=>Number(r[fishIdIndex])).filter(n=>Number.isSafeInteger(n)&&n>0));
const spotNames=new Map();
for(const row of spots.rows){
  const id=Number(row[0]), placeId=Number(row[spotPlaceIndex]);
  if(Number.isSafeInteger(id)&&id>0&&placeNames.has(placeId))spotNames.set(id,placeNames.get(placeId));
}
const enToCnWeather=new Map();
for(const [key,weather] of Object.entries(tracker.WEATHER_TYPES??{})){
  const translation=weatherNames.get(Number(key));
  if(translation&&typeof weather.name_en==='string')enToCnWeather.set(weather.name_en,translation);
}
if(fishIds.size<100||names.size<100||enToCnWeather.size<5)throw new Error('国服数据不完整，拒绝生成候选目录');
const records=[];const skipped={missingCnFish:0,missingCnName:0,missingWeather:0};
const sourceUrl='https://github.com/thewakingsands/ffxiv-datamining-cn/blob/'+cnSha+'/FishParameter.csv';
const version='cn-'+cnSha.slice(0,12)+'-rule-'+String(bundle.records[0]?.rule?.version??'unknown').slice(0,40)+'-conditions2';
for(const original of bundle.records){
  if(!fishIds.has(original.id)){skipped.missingCnFish++;continue;}
  const localizedName=names.get(original.id);
  if(!localizedName){skipped.missingCnName++;continue;}
  const translate=(value)=>enToCnWeather.get(value);
  const rates=original.rule.weatherRates.map(entry=>({weather:translate(entry.weather),chance:entry.chance}));
  const current=original.rule.currentWeather.map(translate);
  const previous=original.rule.previousWeather.map(translate);
  if(rates.some(w=>!w.weather)||current.some(w=>!w)||previous.some(w=>!w)){
    skipped.missingWeather++;continue;
  }
  const originalFish=tracker.FISH?.[String(original.id)];
  const cnSpot=spotNames.get(Number(originalFish?.location))??original.rule.zoneId;
  const rule={
    ...original.rule,region:'cn',version,fishId:original.id,zoneId:String(cnSpot).slice(0,80),
    weatherRates:rates,currentWeather:current,previousWeather:previous,
    validationStatus:original.rule.validationStatus==='incomplete'?'incomplete':'unverified',
    // Localize actual requirements. Regional uncertainty is the source status,
    // not a replacement for dataMissing/snagging or other unknown mechanisms.
    conditions:originalFish?trackerRequirements(originalFish,id=>names.get(id)??'物品 '+id):original.rule.conditions
  };
  records.push({
    ...original,region:'cn',name:String(localizedName).slice(0,100),demo:false,
    source:{url:sourceUrl,version,fetchedAt:Date.now(),authorizationStatus:'unverified',verificationStatus:'unverified'},
    rule
  });
}
if(records.length<100)throw new Error('国服交叉校验结果不足100条，拒绝部署不完整数据');
records.sort((a,b)=>a.id-b.id);
await writeFile(outputPath,JSON.stringify({schemaVersion:1,region:'cn',records},null,2)+'\n');
console.log(JSON.stringify({converted:records.length,big:records.filter(f=>f.fishType==='big').length,skipped,cnSha,globalRevision:bundle.records[0]?.rule.version}));
console.log('注意：这批国服记录属于未验证候选规则，不可当成已核对的真实出鱼条件。');
