// Run with Node >=22: node --experimental-strip-types scripts/generate-android-pvp-rules.mjs
// Android's first-launch/offline rules are generated from the same source as the Worker.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {
  FRONTLINE_ANCHOR_UTC,FRONTLINE_MAPS,PVP_DAY_MS,frontlineAt,
  CRYSTAL_ANCHOR_UTC,CRYSTAL_MAPS,CRYSTAL_PERIOD_MS,crystallineAt,
} from '../packages/shared/src/pvp-rotation.ts';

const generatedAtMs=Math.max(FRONTLINE_ANCHOR_UTC,CRYSTAL_ANCHOR_UTC);
function rule(at,anchor,anchorIndex,periodMs,cycle){
  const state=at(generatedAtMs);
  return {current:state.current,next:state.next,startsAtMs:state.startsAt,changesAtMs:state.changesAt,
    anchorUtcMs:anchor,anchorIndex,periodMs,cycle,ruleVersion:'2026-10-21-cn-v1'};
}
const snapshot={schemaVersion:1,generatedAtMs,refreshAfterMs:generatedAtMs+900_000,
  staleAfterMs:generatedAtMs+7_200_000,timezone:'Asia/Shanghai',region:'cn',pvp:{
    frontline:rule(frontlineAt,FRONTLINE_ANCHOR_UTC,4,PVP_DAY_MS,FRONTLINE_MAPS),
    crystalline:rule(crystallineAt,CRYSTAL_ANCHOR_UTC,6,CRYSTAL_PERIOD_MS,CRYSTAL_MAPS),
  },fish:{status:'selection_required',items:[]},
  events:{status:'unavailable',sourceCheckedAtMs:null,items:[]}};
const target=new URL('../apps/android/app/src/main/assets/pvp-rules-v1.json',import.meta.url);
const content=JSON.stringify(snapshot,null,2)+'\n';
if(process.argv.includes('--check')){
  if(await readFile(target,'utf8')!==content)throw new Error('Android PVP asset differs from shared rules; regenerate it.');
}else{
  await mkdir(new URL('.',target),{recursive:true});
  await writeFile(target,content);
}
