/** Build public factual snapshots without executing any upstream JavaScript. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {csvTable} from './lib/fish-csv.mjs';
import {fishDataBundleSchema} from '../packages/fish-engine/src/index.ts';

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
// IsHidden marks hidden/rare fish in the fishing log, not unreleased content.
const cnFish=new Map(parameters.filter(p=>Number(p.Item)>0).map(p=>[Number(p.Item),p]));
const spearIds=new Set();
for(const item of csvTable(await read('SpearfishingItem.csv'))){
  const id=Number(item.Item);
  if(id>0){spearIds.add(id);if(!cnFish.has(id))cnFish.set(id,{...item,IsInLog:'True',IsHidden:'False'});}
}
const byGuide=new Map(guide.map(g=>[g.id,g]));
const legendary=new Set(Object.keys(JSON.parse(await read('legendary.json'))).map(Number));
const teamcraft=JSON.parse(await read('teamcraft.json'));
const extras=new Map();
for(const category of teamcraft)for(const tab of category.tabs??[])for(const spot of tab.spots??[])for(const fish of spot.fishes??[]){
  if(!extras.has(fish.itemId))extras.set(fish.itemId,{fish,spot,category});
}
const generatedAt=new Date().toISOString();
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
    const rule=method==='rod'?(sourceRecord?.rule??null):null;
    // Absence of a forecast must never be interpreted as an unrestricted fish.
    const always=Boolean(method==='rod'&&g&&g.time_restricted===0&&g.weather_restricted===0&&g.special_conditions===0&&!t?.dataMissing);
    const location=region==='cn'?(placeNames.get(Number(localizedSpot?.PlaceName))??spot?.name_en??'钓场待补'):spot?.name_en??g?.zone_en??'Location not recorded';
    const territory=territories.get(Number(localizedSpot?.TerritoryType??spot?.territory_id??param?.TerritoryType));
    const zone=region==='cn'?(placeNames.get(Number(territory?.PlaceName))||location):g?.zone_en??location;
    const conditions=[];
    if(t?.predators&&Object.keys(t.predators).length)conditions.push('鱼识前置：'+Object.entries(t.predators).map(([key,value])=>String(label(key)??key)+' × '+String(value)).join('、'));
    if(t?.intuitionLength)conditions.push('鱼识持续 '+String(t.intuitionLength)+' 秒');
    if(t?.folklore)conditions.push('需要对应地区传承录');
    if(t?.fishEyes)conditions.push('支持鱼眼；此处按未使用鱼眼的原始窗口计算');
    if(t?.snagging)conditions.push('需要开启钓组');
    if(t?.lure)conditions.push('诱饵技能：'+String(t.lure));
    records.push({id,name,englishName:g?.name_en??tracker.ITEMS[id]?.name_en??'',
      kind:legendary.has(id)?'legendary':t?.bigFish||param?.IsHidden==='True'&&param.IsInLog==='True'&&Number(param.OceanStars)===0?'big':'normal',method,
      level:g?.level?.[0]??extra?.fish.level??0,patch:String(t?.patch??''),zone,location,spotId,bait,
      tug:t?.tug??'',hookset:t?.hookset??'',conditions,always,rule});
  }
  records.sort((a,b)=>a.id-b.id);
  const catalog={schemaVersion:1,region,generatedAt,versions:{tracker:trackerSha,cn:cnSha,teamcraft:teamcraftSha},
    coverage:{total:records.length,forecast:records.filter(r=>r.rule!==null).length,always:records.filter(r=>!r.rule&&r.always).length,unknown:records.filter(r=>!r.rule&&!r.always).length},fish:records};
  await writeFile('apps/web/public/fishing/catalog-'+region+'.json',JSON.stringify(catalog)+'\n');
  console.log(JSON.stringify({region,...catalog.coverage,bytes:JSON.stringify(catalog).length}));
}
