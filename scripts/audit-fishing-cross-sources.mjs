import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {csvTable,csvRows} from './lib/fish-csv.mjs';
import {auditCatalog} from './lib/fishing-crosscheck.mjs';
import {correctCatalog} from './lib/fishing-corrections.mjs';
import {annotateCatalog} from './lib/fishing-audit-summary.mjs';
import {buildSpecialContexts} from './lib/fishing-special-content.mjs';
const [directory='.wrangler/fishing-sources',snapshotPath='.wrangler/full-fishcake-observations.json']=process.argv.slice(2);
const read=name=>readFile(directory+'/'+name,'utf8'),digest=s=>createHash('sha256').update(s).digest('hex');
const raw=await read('tracker.js'),tracker=JSON.parse(raw.replace(/^const DATA = /,'').replace(/^ {2}([A-Z_]+):/gm,'  "$1":'));
const versions=JSON.parse(await readFile('data/fishing-sources.json','utf8')),accuracy=JSON.parse(await readFile('data/fishing-accuracy-audit.json','utf8'));
if(digest(raw)!==accuracy.files['tracker.js'])throw Error('Pinned tracker hash mismatch');
const snapshotText=await readFile(snapshotPath,'utf8'),snapshot=JSON.parse(snapshotText);
const conventions=JSON.parse(await readFile('data/fishing-source-conventions.json','utf8'));
const evidenceText=await readFile('data/fishing-additional-evidence.json','utf8'),additionalEvidence=JSON.parse(evidenceText).records;
if(conventions.teamcraftRevision!==versions.teamcraft||conventions.fishcakeVersion!==snapshot.version)throw Error('Source conventions need checking for these source versions');
if(snapshot.source!=='https://fish.ffmomola.com'||!snapshot.version||new Set(snapshot.fish.map(f=>f.id)).size!==snapshot.fish.length)throw Error('Invalid public snapshot');
const inputs={};for(const filename of ['Item.csv','ItemUICategory.csv','EventItem.csv','FishParameter.csv','SpearfishingItem.csv','SpearfishingNotebook.csv','IKDSpot.csv','WKSItemInfo.csv','TerritoryType.csv','FishingSpot.csv','PlaceName.csv','teamcraft.json','tc-fishing-sources.json','tc-fishing-log.json','tc-fishing-spots.json'])inputs[filename]=await read(filename);
for(const [name,bytes] of Object.entries(inputs))if(accuracy.files[name]&&digest(bytes)!==accuracy.files[name])throw Error('Pinned source mismatch '+name);
const items=new Map([...csvTable(inputs['Item.csv']),...csvTable(inputs['EventItem.csv'])].map(row=>[Number(row.id),row.Name||row.Singular]));
const itemRows=new Map([...csvTable(inputs['Item.csv']),...csvTable(inputs['EventItem.csv'])].map(row=>[Number(row.id),row]));
const itemCategories=new Map(csvTable(inputs['ItemUICategory.csv']).map(row=>[row.id,row.Name]));
const game=new Map(csvTable(inputs['FishParameter.csv']).filter(r=>Number(r.Item)>0).map(r=>[Number(r.Item),{...r,method:'rod'}]));
for(const row of csvTable(inputs['SpearfishingItem.csv']))if(Number(row.Item)>0)game.set(Number(row.Item),{...row,method:'spear'});
const places=new Map(csvTable(inputs['PlaceName.csv']).map(r=>[Number(r.id),r.Name]));
const spotNames=new Map(csvTable(inputs['FishingSpot.csv']).map(r=>[Number(r.id),places.get(Number(r.PlaceName))]));
for(const row of csvTable(inputs['SpearfishingNotebook.csv']))spotNames.set(Number(row.GatheringPointBase),places.get(Number(row.PlaceName)));
const gameSpots=new Map(csvTable(inputs['FishingSpot.csv']).map(row=>[Number(row.id),row])),territories=new Map(csvTable(inputs['TerritoryType.csv']).map(row=>[Number(row.id),row]));
const rawSources=JSON.parse(inputs['tc-fishing-sources.json']),tcLog=JSON.parse(inputs['tc-fishing-log.json']);
const wksItems=new Set(csvRows(inputs['WKSItemInfo.csv']).slice(3).map(row=>Number(row[1])));
const specialContexts=buildSpecialContexts({game,itemRows,itemCategories,wksItems,gameSpots,places,tcLog,rawSources,territories});
const teamcraft=new Map();for(const category of JSON.parse(inputs['teamcraft.json']))for(const tab of category.tabs??[])for(const spot of tab.spots??[])for(const fish of spot.fishes??[]){const rows=teamcraft.get(fish.itemId)??[];if(!fish.data?.length)rows.push({id:spot.id,identityOnly:true});for(const data of fish.data??[]){const node=data.gatheringNode;if(node)rows.push({...node,alarm:data.alarms?.find(a=>a.nodeId===node.id)});}teamcraft.set(fish.itemId,rows);}
for(const [id,context] of specialContexts){const rows=teamcraft.get(id)??[];for(const source of rawSources[id]??[]){if(!context.locations.some(l=>l.spotId===source.spot))continue;rows.unshift({id:source.spot,type:game.get(id)?.method==='spear'?4:-5,hookset:source.hookset,tug:source.tug,baits:source.bait?[{id:source.bait}]:undefined,snagging:source.snagging,folklore:source.folklore,sourceKind:'raw-special-acquisition'});}if(!rows.length&&context.rawSourcePresent)rows.push({id:0,identityOnly:true,sourceKind:'unmatched-raw-acquisition'});if(rows.length)teamcraft.set(id,rows);}
const fishcake=new Map(snapshot.fish.map(f=>[f.id,f])),weatherAudit=new Map(accuracy.fish.map(f=>[f.id,f.weather]));
const shadowEvidence=new Map();for(const rows of teamcraft.values())for(const node of rows){const p=node.predators??node.alarm?.predators;if(p?.length){const all=shadowEvidence.get(node.id)??[];all.push(p.map(p=>[p.id,p.amount]).sort((a,b)=>a[0]-b[0]));shadowEvidence.set(node.id,all);}}
const oceanStages=new Map();for(const row of csvTable(inputs['IKDSpot.csv'])){if(Number(row.SpotMain)>0)oceanStages.set(Number(row.SpotMain),'normal');if(Number(row.SpotSub)>0)oceanStages.set(Number(row.SpotSub),'spectral');}
const previous=await readFile('data/fishing-full-crosscheck.json','utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const results=[];for(const region of ['cn','global']){const path=`apps/web/public/fishing/catalog-${region}.json`,catalog=JSON.parse(await readFile(path,'utf8'));if(catalog.fish.some(f=>!fishcake.has(f.id)))throw Error('Snapshot does not cover every catalog identity');const context={catalog,tracker,fishcake,teamcraft,game,items,spotNames,snapshot,shadowEvidence,oceanStages,conventions,additionalEvidence,specialContexts,weatherAudit:region==='cn'?weatherAudit:new Map()};const changes=correctCatalog(context);const result=auditCatalog(context);const previousChanges=previous?.sources.fishcake===snapshot.version&&previous?.sources.tracker===versions.tracker?previous.regions.find(r=>r.region===region)?.changes??[]:[];result.changes=[...new Map([...previousChanges,...changes].map(c=>[c.id+':'+c.field,c])).values()];results.push(result);annotateCatalog(catalog,result,snapshot,versions);await writeFile(path,JSON.stringify(catalog)+'\n');}
const report={schemaVersion:1,generatedAt:new Date().toISOString(),meaning:'Every catalog identity and available source spot is checked. Checked means comparable facts have agreement or an explicit corroborated resolution; it does not mean every field has multiple independent sources. Source gaps, representation limits, alternate recommended routes, and raw disagreements are retained.',sources:{...versions,fishcake:snapshot.version,observedAt:snapshot.observedAt,fishcakeSha256:digest(snapshotText),additionalEvidenceSha256:digest(evidenceText),files:Object.fromEntries(Object.entries(inputs).map(([name,bytes])=>[name,digest(bytes)])),trackerSha256:digest(raw)},regions:results};
await writeFile('data/fishing-full-crosscheck.json',JSON.stringify(report)+'\n');
await writeFile('data/fishing-fishcake-observations.json',snapshotText);
console.log(JSON.stringify(results.map(({records,changes,...summary})=>({...summary,changedFields:changes.length,conflictFields:records.flatMap(r=>r.conflicts).reduce((a,c)=>(a[c.field]=(a[c.field]??0)+1,a),{})})),null,2));
