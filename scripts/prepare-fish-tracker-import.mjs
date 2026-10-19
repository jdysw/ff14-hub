/**
 * FFX|V Fish Tracker（MIT）离线数据适配器。
 * 只解析源码中已生成的 JSON 对象字面量，不执行下载的 JavaScript。
 * 游戏数据的授权不能由代码 MIT 许可证自动推定，因此始终标记为 unverified。
 */
import { readFile,stat,writeFile } from 'node:fs/promises';

const [sourcePath,region,revision,outputPath]=process.argv.slice(2);
if(!sourcePath||region!=='global'||!revision||!outputPath||!/^[0-9a-f]{7,40}$/i.test(revision)){
  throw new Error('用法：node scripts/prepare-fish-tracker-import.mjs <data.js> global <上游commit SHA> <输出.json>。国服需单独校验，不能混用国际服数据。');
}
const info=await stat(sourcePath);
if(info.size>16*1024*1024)throw new Error('数据文件超过16 MiB上限');
const raw=await readFile(sourcePath,'utf8');
if(!raw.startsWith('const DATA = {')||!raw.trimEnd().endsWith('}'))throw new Error('不支持的数据文件格式');
const jsonText=raw.replace(/^const DATA = /,'').replace(/^ {2}([A-Z_]+):/gm,'  "$1":');
const data=JSON.parse(jsonText);
if(!data||typeof data!=='object'||!data.FISH||!data.ITEMS||!data.FISHING_SPOTS||
  !data.WEATHER_RATES||!data.WEATHER_TYPES)throw new Error('上游数据结构发生变化，已停止导入');
const fetchedAt=Date.now();
const sourceUrl='https://github.com/icykoneko/ff14-fish-tracker-app/blob/'+revision+'/js/app/data.js';
const label=(item)=>typeof item?.name_en==='string'?item.name_en:'';
const short=(value,max=300)=>String(value).slice(0,max);
const fishRecords=[];
const skipped=[];
for(const [key,fish] of Object.entries(data.FISH)){
  const id=Number(key);
  if(!Number.isSafeInteger(id)||id<=0||fish?._id!==id){
    skipped.push(key+':invalid-id');continue;
  }
  const spot=data.FISHING_SPOTS[String(fish.location)]??data.SPEARFISHING_SPOTS?.[String(fish.location)];
  const territory=spot?.territory_id;
  const weather=data.WEATHER_RATES[String(territory)]?.weather_rates;
  const item=data.ITEMS[key];
  if(!spot||!Array.isArray(weather)||!item||!label(item)){
    skipped.push(key+':missing-location-or-name-or-weather');continue;
  }
  let threshold=0;
  const weatherRates=[];
  let valid=true;
  for(const [weatherId,end] of weather){
    const name=label(data.WEATHER_TYPES[String(weatherId)]);
    if(!name||!Number.isInteger(end)||end<=threshold||end>100){valid=false;break;}
    weatherRates.push({weather:name,chance:end-threshold});
    threshold=end;
  }
  if(!valid||threshold!==100||weatherRates.length>20){
    skipped.push(key+':invalid-weather-table');continue;
  }
  const weatherNames=(ids)=>{
    if(!Array.isArray(ids))return null;
    const names=ids.map(i=>label(data.WEATHER_TYPES[String(i)]));
    return names.every(Boolean)?names:null;
  };
  const currentWeather=weatherNames(fish.weatherSet);
  const previousWeather=weatherNames(fish.previousWeatherSet);
  const startHour=fish.startHour;
  const endHour=fish.endHour;
  if(currentWeather&&previousWeather&&![...currentWeather,...previousWeather].every(w=>weatherRates.some(rate=>rate.weather===w))){
    skipped.push(key+':weather-condition-not-in-zone');continue;
  }
  if(!currentWeather||!previousWeather||!Number.isFinite(startHour)||!Number.isFinite(endHour)||
    startHour<0||startHour>24||endHour<0||endHour>24||startHour===endHour){
    skipped.push(key+':invalid-window');continue;
  }
  const conditions=[];
  const add=(kind,description)=>{
    if(description&&conditions.length<20)conditions.push({kind,description:short(description)});
  };
  if(Array.isArray(fish.bestCatchPath)&&fish.bestCatchPath.length>0){
    const baitNames=fish.bestCatchPath.map(i=>label(data.ITEMS[String(i)])||('物品 '+String(i)));
    add('bait','推荐鱼饵/泳饵路径：'+baitNames.join(' → '));
  }
  if(Array.isArray(fish.predators)&&fish.predators.length>0)
    add('predators','需要的前置鱼：'+fish.predators.map(i=>JSON.stringify(i)).join('、'));
  if(fish.predators&&!Array.isArray(fish.predators)&&Object.keys(fish.predators).length>0)
    add('predators','前置鱼数量条件：'+JSON.stringify(fish.predators));
  if(fish.intuitionLength)add('intuition','鱼识持续时间：'+String(fish.intuitionLength));
  if(fish.folklore)add('folklore','需要传承录：'+String(fish.folklore));
  if(fish.fishEyes)add('fishEyes','可受鱼眼技能影响；当前计算未模拟鱼眼');
  if(fish.dataMissing)add('unknown','上游标记有缺失的钓鱼条件');
  if(fish.gig)add('unknown','刺鱼方式：'+String(fish.gig));
  const incomplete=Boolean(fish.dataMissing);
  fishRecords.push({
    id,region:'global',name:short(label(item),100),fishType:fish.bigFish?'big':'normal',demo:false,
    source:{url:sourceUrl,version:revision,fetchedAt,authorizationStatus:'unverified',
      verificationStatus:incomplete?'incomplete':'unverified'},
    rule:{schemaVersion:1,region:'global',fishId:id,version:revision,zoneId:short(label(spot)||String(territory),80),
      startHour,endHour,weatherRates,currentWeather,previousWeather,conditions,
      validationStatus:incomplete?'incomplete':'unverified'}
  });
}
if(fishRecords.length===0)throw new Error('没有可转换的有效鱼类数据，拒绝输出空目录');
fishRecords.sort((a,b)=>a.id-b.id);
await writeFile(outputPath,JSON.stringify({schemaVersion:1,region:'global',records:fishRecords},null,2)+'\n','utf8');
console.log('已转换：'+String(fishRecords.length)+' 条（鱼王 '+String(fishRecords.filter(f=>f.fishType==='big').length)+' 条）。');
console.log('由于缺少可靠钓点/天气/名称而跳过：'+String(skipped.length)+' 条；检查记录：'+skipped.slice(0,30).join(', '));
console.log('警告：这是国际服未经逐条验证的数据。不得直接标记 verified，也不得作为国服数据导入。');
