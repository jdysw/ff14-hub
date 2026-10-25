
function annotateIntuitionRecord({catalog,row}){
const index=catalog.fish.findIndex(f=>f.id===row.id);if(index<0){return;}const fish=supplementIntuition(catalog.fish[index],row,snapshot);catalog.fish[index]=fish;
    const descriptions=[];
    if(row.status==='supplemented'){descriptions.push(`已按鱼糕补全鱼识持续时间：${row.intuitionSeconds} 秒；Tracker 原记录未提供时长，来源条件与补充字段分别保留。`);}
    if(row.status==='partial'){descriptions.push('来源时长资料仍不完整，未擅自填写。');}
    for(const predecessor of row.predecessors??[]){if(predecessor.normalizedMooch){descriptions.push(`${names.get(predecessor.id)??predecessor.id}：合并泳饵依赖后 ET ${predecessor.effectiveConditions.startHour}–${predecessor.effectiveConditions.endHour}，与 Tracker 一致。`);}if(predecessor.status==='matched'){continue;}
      const fact=snapshot.fish.find(f=>f.id===row.id).spots.find(s=>s.spotId===row.spotId).preconditions.find(p=>p.id===predecessor.id)?.spots?.[0],reference=tracker.FISH[predecessor.id];
      descriptions.push(`${names.get(predecessor.id)??predecessor.id}：Tracker ET ${reference?.startHour}–${reference?.endHour}；鱼糕 ET ${fact?.startHour}–${fact?.endHour}，准备时间条件存在差异。`);
    }
    // Retain the previous public enum so an already-open PWA can still parse catalogs.
    fish.intuitionCrosscheck={status:row.status==='supplemented'?'partial':row.status,...(row.status==='supplemented'?{supplemented:true}:{}),description:descriptions.join(' '),checkedAt:snapshot.observedAt,fishcakeVersion:snapshot.version};

}
import {forEachSequential} from "../packages/shared/src/sequential-tasks.mjs";
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {auditIntuition,supplementIntuition} from './lib/fish-intuition-audit.mjs';
const [trackerPath,snapshotPath]=process.argv.slice(2);
if(!trackerPath||!snapshotPath){throw new Error('Usage: tracker-data.js fishcake-observations.json');}
const raw=await readFile(trackerPath,'utf8'),snapshotText=await readFile(snapshotPath,'utf8');
if(!raw.startsWith('const DATA = {')||!raw.trimEnd().endsWith('}'))throw new Error('Unexpected tracker format');
const tracker=JSON.parse(raw.replace(/^const DATA = /,'').replace(/^ {2}([A-Z_]+):/gm,'  "$1":'));
const snapshot=JSON.parse(snapshotText),versions=JSON.parse(await readFile('data/fishing-sources.json','utf8'));
if(snapshot.source!=='https://fish.ffmomola.com'||!snapshot.version||snapshot.fish.length!==32)throw new Error('Expected complete, versioned fishcake facts');
const accuracy=JSON.parse(await readFile('data/fishing-accuracy-audit.json','utf8'));
const ids=accuracy.fish.filter(f=>f.dependencies.predators.length).map(f=>f.id).sort((a,b)=>a-b);
if(JSON.stringify(ids)!==JSON.stringify(snapshot.fish.map(f=>f.id).sort((a,b)=>a-b)))throw new Error('Intuition target IDs do not match regional audit');
const digest=value=>createHash('sha256').update(value).digest('hex');
if(digest(raw)!==accuracy.files['tracker.js'])throw new Error('Tracker input does not match pinned regional audit');
const result=auditIntuition(tracker,snapshot);
const report={schemaVersion:1,generatedAt:new Date().toISOString(),sources:{trackerRevision:versions.tracker,trackerSha256:digest(raw),fishcakeVersion:snapshot.version,fishcakeUrl:snapshot.source,observedAt:snapshot.observedAt,observationsSha256:digest(snapshotText)},meaning:'Field agreement is not a simulation of player preparation time. Conflicting or missing facts remain explicit.',...result};
await writeFile('data/fishing-intuition-observations.json',snapshotText);
await writeFile('data/fishing-intuition-audit.json',JSON.stringify(report,null,2)+'\n');
const cn=JSON.parse(await readFile('apps/web/public/fishing/catalog-cn.json','utf8')),names=new Map(cn.fish.map(f=>[f.id,f.name]));
await forEachSequential(['cn','global'],async (region)=>{
  const path=`apps/web/public/fishing/catalog-${region}.json`,catalog=JSON.parse(await readFile(path,'utf8'));
  catalog.intuitionCrosscheck={total:result.total,matched:result.matched,supplemented:result.supplemented,partial:result.partial,conflicts:result.conflicts,missing:result.missing,checkedAt:snapshot.observedAt,fishcakeVersion:snapshot.version};
  for(const row of result.records){annotateIntuitionRecord({catalog,row});}
  await writeFile(path,JSON.stringify(catalog)+'\n');
});
console.log(JSON.stringify({total:result.total,matched:result.matched,supplemented:result.supplemented,partial:result.partial,conflicts:result.conflicts,missing:result.missing}));
