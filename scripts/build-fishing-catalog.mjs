/** Build public factual snapshots without executing any upstream JavaScript. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {csvTable} from './lib/fish-csv.mjs';
import {fishDataBundleSchema} from '../packages/fish-engine/src/index.ts';
import {trackerRequirements} from './lib/fish-requirements.mjs';
import {compareCnWeather,dependencyFacts} from './lib/fish-accuracy.mjs';
import {createHash} from 'node:crypto';

const [directory,trackerSha,cnSha,teamcraftSha]=process.argv.slice(2);
if(!directory||![trackerSha,cnSha,teamcraftSha].every(s=>/^[a-f0-9]{40}$/.test(s??'')))throw new Error('Usage: source-directory tracker-sha cn-sha teamcraft-sha');
const read=(name)=>readFile(path.join(directory,name),'utf8');
const tracker=JSON.parse((await read('tracker.js')).replace(/^const DATA = /,'').replace(/^ {2}([A-Z_]+):/gm,'  "$1":'));
const guide=JSON.parse((await read('guide.js')).replace(/^const FISH_INFO = /,'').trim().replace(/;$/,''));
const [items,parameters,spots,places]=await Promise.all(['Item','FishParameter','FishingSpot','PlaceName'].map(async n=>csvTable(await read(n+'.csv'))));
const names=new Map(items.map(i=>[Number(i.id),i.Name]));
for(const item of csvTable(await read('EventItem.csv')))names.set(Number(item.id),item.Name||item.Singular);
const placeNames=new Map(places.map(i=>[Number(i.id),i.Name]));
const cnSpots=new Map(spots.map(i=>[Number(i.id),i]));
const territories=new Map(csvTable(await read('TerritoryType.csv')).map(i=>[Number(i.id),i]));
const weatherRates=new Map(csvTable(await read('WeatherRate.csv')).map(i=>[Number(i.id),i]));
// IsHidden marks hidden/rare fish in the fishing log, not unreleased content.
const cnFish=new Map(parameters.filter(p=>Number(p.Item)>0).map(p=>[Number(p.Item),p]));
const spearIds=new Set();
for(const item of csvTable(await read('SpearfishingItem.csv'))){
  const id=Number(item.Item);
  if(id>0){spearIds.add(id);if(!cnFish.has(id))cnFish.set(id,{...item,IsInLog:'True',IsHidden:'False'});}
}
const cnFishIds=new Set(cnFish.keys());
const byGuide=new Map(guide.map(g=>[g.id,g]));
const legendary=new Set(Object.keys(JSON.parse(await read('legendary.json'))).map(Number));
const teamcraft=JSON.parse(await read('teamcraft.json'));
const extras=new Map();
for(const category of teamcraft)for(const tab of category.tabs??[])for(const spot of tab.spots??[])for(const fish of spot.fishes??[]){
  if(!extras.has(fish.itemId))extras.set(fish.itemId,{fish,spot,category});
}
const generatedAt=new Date().toISOString();
const audit={schemaVersion:1,generatedAt,versions:{tracker:trackerSha,cn:cnSha,teamcraft:teamcraftSha},
  meaning:'Game-table checks are not in-game catch or history verification. No gameplay rules are promoted to verified.',
  files:{},summary:{identities:0,forecastRules:0,weatherMatched:0,weatherMismatch:0,weatherMissing:0,
    unrestrictedRules:0,weatherOnlyRules:0,overnightRules:0,fishWithPredators:0,missingPredatorReferences:0},fish:[]};
for(const filename of ['tracker.js','Item.csv','EventItem.csv','FishParameter.csv','Weather.csv','WeatherRate.csv','FishingSpot.csv','PlaceName.csv','TerritoryType.csv','teamcraft.json','legendary.json'])
  audit.files[filename]=createHash('sha256').update(await read(filename)).digest('hex');
await mkdir('apps/web/public/fishing',{recursive:true});
for(const region of ['cn','global']){
  const normalized=fishDataBundleSchema.parse(JSON.parse(await read(region+'.json')));
  const rules=new Map(normalized.records.map(record=>[record.id,record]));
  const ids=region==='cn'?[...cnFish.keys()]:[...new Set([...byGuide.keys(),...Object.keys(tracker.FISH).map(Number)])];
  const records=[];
  for(const id of ids){
    const g=byGuide.get(id),t=tracker.FISH[id],extra=extras.get(id);
    const param=cnFish.get(id),spotId=Number(t?.location??param?.FishingSpot??extra?.spot.id??0);
    const spot=tracker.FISHING_SPOTS[spotId]??tracker.SPEARFISHING_SPOTS?.[spotId];
    const localizedSpot=cnSpots.get(spotId);
    const name=region==='cn'?names.get(id):g?.name_en??tracker.ITEMS[id]?.name_en;
    if(!name)throw new Error('Missing name for fish '+id);
    const label=(itemId)=>region==='cn'?names.get(Number(itemId))??tracker.ITEMS[itemId]?.name_en:tracker.ITEMS[itemId]?.name_en;
    const baitIds=t?.bestCatchPath??extra?.fish.data?.[0]?.gatheringNode?.baits?.map(b=>b.id)??[];
    const baitLabel=value=>typeof value==='number'?label(value):Array.isArray(value)?value.map(baitLabel).filter(Boolean).join(' / '):null;
    const bait=baitIds.map(baitLabel).filter(Boolean);
    const sourceRecord=rules.get(id);
    const method=t?.gig||region==='cn'&&spearIds.has(id)?'spear':Number(param?.OceanStars)>0?'ocean':'rod';
    let rule=method==='rod'?(sourceRecord?.rule??null):null;
    if(region==='cn'){
      audit.summary.identities++;
      if(rule&&t){
        audit.summary.forecastRules++;
        const weather=compareCnWeather({fish:t,tracker,spots:cnSpots,territories,rates:weatherRates});
        if(weather.status==='matched')audit.summary.weatherMatched++;
        else if(weather.status==='mismatch')audit.summary.weatherMismatch++;
        else audit.summary.weatherMissing++;
        const dependencies=dependencyFacts(t,cnFishIds,names);
        if(dependencies.predators.length)audit.summary.fishWithPredators++;
        audit.summary.missingPredatorReferences+=dependencies.predators.filter(p=>!p.presentInRegion||!p.name).length;
        const unrestricted=rule.startHour===0&&rule.endHour===24&&!rule.currentWeather.length&&!rule.previousWeather.length;
        if(unrestricted)audit.summary.unrestrictedRules++;
        else if(rule.startHour===0&&rule.endHour===24)audit.summary.weatherOnlyRules++;
        if(rule.endHour<rule.startHour)audit.summary.overnightRules++;
        audit.fish.push({id,name,identity:'cn-game-table',weather,timeRule:'community-unverified',dependencies,
          requiredMechanisms:rule.conditions.map(c=>c.kind),gameplayVerified:false});
        // Keep the identity and guide, but do not forecast mismatched/missing CN weather.
        if(weather.status!=='matched')rule=null;
      }
    }
    // Absence of a forecast must never be interpreted as an unrestricted fish.
    const always=Boolean(method==='rod'&&g&&g.time_restricted===0&&g.weather_restricted===0&&g.special_conditions===0&&!t?.dataMissing&&
      (!t||(t.startHour===0&&t.endHour===24&&!t.weatherSet.length&&!t.previousWeatherSet.length)));
    const location=region==='cn'?(placeNames.get(Number(localizedSpot?.PlaceName))??spot?.name_en??'钓场待补'):spot?.name_en??g?.zone_en??'Location not recorded';
    const territory=territories.get(Number(localizedSpot?.TerritoryType??spot?.territory_id??param?.TerritoryType));
    const zone=region==='cn'?(placeNames.get(Number(territory?.PlaceName))||location):g?.zone_en??location;
    const conditions=t?trackerRequirements(t,label).filter(c=>c.kind!=='bait').map(c=>c.description):[];
    records.push({id,name,englishName:g?.name_en??tracker.ITEMS[id]?.name_en??'',
      kind:legendary.has(id)?'legendary':t?.bigFish||param?.IsHidden==='True'&&param.IsInLog==='True'&&Number(param.OceanStars)===0?'big':'normal',method,
      level:g?.level?.[0]??extra?.fish.level??0,patch:String(t?.patch??''),zone,location,spotId,bait,
      tug:t?.tug??'',hookset:t?.hookset??'',conditions,always,rule});
  }
  records.sort((a,b)=>a.id-b.id);
  const catalog={schemaVersion:1,region,generatedAt,versions:{tracker:trackerSha,cn:cnSha,teamcraft:teamcraftSha},
    ...(region==='cn'?{accuracy:{weatherMatched:audit.summary.weatherMatched,weatherMismatch:audit.summary.weatherMismatch,
      weatherMissing:audit.summary.weatherMissing,fishWithPredators:audit.summary.fishWithPredators,gameplayVerified:0}}:{}),
    coverage:{total:records.length,forecast:records.filter(r=>r.rule!==null).length,always:records.filter(r=>!r.rule&&r.always).length,unknown:records.filter(r=>!r.rule&&!r.always).length},fish:records};
  await writeFile('apps/web/public/fishing/catalog-'+region+'.json',JSON.stringify(catalog)+'\n');
  console.log(JSON.stringify({region,...catalog.coverage,bytes:JSON.stringify(catalog).length}));
}
await mkdir('data',{recursive:true});
await writeFile('data/fishing-accuracy-audit.json',JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify({accuracyAudit:audit.summary}));
