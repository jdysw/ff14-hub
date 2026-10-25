
function auditAlternativeBaitRoutes({bait,fishcake,spotId,s}){
if(bait.status!=='conflict'){return;}

          const valid=(steps,target,seen=new Set())=>{if(!target||!steps?.length){return false;}const last=steps.at(-1);if(steps.length===1){return last.some(id=>target.baitIds?.includes(id));}return last.some(id=>target.moochIds?.includes(id)&&!seen.has(id)&&valid(steps.slice(0,-1),fishcake.get(id)?.spots.find(p=>p.spotId===spotId),new Set([...seen,id])));};
          bait.status=s&&Object.values(bait.values).every(p=>valid(p,s))?'compatible-alternatives':'recommendation-difference';

}

function auditRodWeather({add,t,effective,node}){
add('weather',{tracker:t?sorted(t.weatherSet):null,fishcake:effective?sorted(effective.currentWeather):null,teamcraft:teamcraftWeather(node)});
        add('previousWeather',{tracker:t?sorted(t.previousWeatherSet):null,fishcake:effective?sorted(effective.previousWeather):null,teamcraft:teamcraftWeather(node,true)});
}

function auditPatchPrecision({patch}){
if(!(patch.status==='conflict'&&Object.values(patch.values).every(v=>Math.floor(v*10)===Math.floor(Object.values(patch.values)[0]*10)))){return;}
patch.status='precision-difference';
}

function auditLocalizedName({catalog,nameValues,items,item,cake,tracker}){
if(catalog.region==='cn'){nameValues.game=items.get(item.id);if(cake.length){nameValues.fishcake=cake[0].name;}}
    else {nameValues.tracker=tracker.ITEMS[item.id]?.name_en;}
}

function resolveCorroboratedField({field}){

      const sourceValues=Object.entries(field.values).filter(([k])=>k!=='catalog'&&k!=='game');
      const selected=sourceValues.find(([,value])=>sourceValues.filter(([,v])=>same(v,value)).length>=2);
      if(selected&&(!Object.hasOwn(field.values,'catalog')||same(field.values.catalog,selected[1]))){field.status='resolved';field.resolution={sources:sourceValues.filter(([,v])=>same(v,selected[1])).map(([k])=>k),value:selected[1]};}

}

function auditFishIdentity({item,catalog,items,cake,tracker,fields,param,reference,tc}){
const nameValues={catalog:item.name};
    auditLocalizedName({catalog,nameValues,items,item,cake,tracker});
    const nameCheck=checkField('name',nameValues);
    // IDs agree; a translated spelling differs, rather than fish identity.
    if(nameCheck.status==='conflict'&&nameValues.game===item.name){nameCheck.status='localization-difference';}
    fields.push(
nameCheck,
checkField('identity',{game:param?item.id:null,tracker:reference?item.id:null,fishcake:cake.length?item.id:null,teamcraft:tc.length?item.id:null})
);
    const technique=item.method==='spear'?'spear':'rod';
    fields.push(checkField('technique',{catalog:technique,game:gameTechnique(param),fishcake:cake[0]?.catchType,teamcraft:teamcraftTechnique(tc)}));
    if(cake.length&&param?.method!=='spear'){fields.push(checkField('oceanClassification',{catalog:item.method==='ocean',game:Number(param?.OceanStars)>0,fishcake:cake[0].fishType==='ikd'}));}
    const patch=checkField('patch',{catalog:item.patch?rounded(Number(item.patch)):null,tracker:rounded(reference?.patch),fishcake:rounded(cake[0]?.patch)});
    auditPatchPrecision({patch});
    fields.push(patch);
    if(param?.IsInLog&&cake[0]?.fishParameter){fields.push(checkField('inFishingLog',{game:booleans(param.IsInLog),fishcake:cake[0].fishParameter.isInLog}));}
    if(item.method==='rod'&&cake.length){const tier=cake[0].tier;const kind=rarityKind(tier);fields.push(checkField('rarity',{catalog:item.kind,fishcake:kind}));}
}

function auditPredatorDuration({predators,add,t,s,item,spotId}){
if(!(Object.values(predators).some(p=>p?.length))){return;}

        add('predators',predators);
        add('intuitionDuration',{tracker:t?.intuitionLength>0?t.intuitionLength:null,fishcake:s?.intuitionSeconds>0?s.intuitionSeconds:null,catalog:item.spotId===spotId?item.intuitionDuration?.seconds:null});

}

function auditShadowSpawn({item,shadowIds,shadowEvidence,spotId,add,rawTracker,s,rawTc}){
if(!(item.method==='spear'&&shadowIds.size)){return;}
const fromNode=shadowEvidence.get(spotId)?.map(p=>p.filter(([id])=>shadowIds.has(id))).find(p=>p.length===shadowIds.size);add('shadowSpawn',{tracker:rawTracker?.filter(([id])=>shadowIds.has(id)),fishcake:pairs(s.shadowPredators),teamcraft:fromNode??rawTc?.filter(([id])=>shadowIds.has(id))});
}

function compareBaitPathSources({item,spotId,t,s,path}){
const bait=checkField('baitPath',{catalog:item.spotId===spotId?pathSteps(item.catchPathIds):null,tracker:pathSteps(t?.bestCatchPath),fishcake:pathSteps(s?.bestCatchPathIds),teamcraft:pathSteps(path)},compatiblePaths);
return bait;
}

function compareRodTimeSources({item,spotId,trackerTime,effective,tcTime}){
const time=checkField('time',{catalog:item.spotId===spotId&&item.rule?periods(item.rule.startHour,item.rule.endHour):null,tracker:trackerTime,fishcake:effective?periods(effective.startHour,effective.endHour):null,teamcraft:tcTime});
return time;
}

function teamcraftEffectiveTime({node,path,teamcraft,spotId}){
const tcTime=node?effectivePeriods(teamcraftPeriods(node),path,id=>{const n=teamcraft.get(id)?.find(n=>n.id===spotId&&!n.identityOnly);return n?{periods:teamcraftPeriods(n),path:n.baits?.map(b=>b.id)}:null;}):null;
return tcTime;
}

function trackerEffectiveTime({t,tracker}){
const trackerTime=t?effectivePeriods(periods(t.startHour,t.endHour),t.bestCatchPath,id=>{const f=tracker.FISH[id];return f?{periods:periods(f.startHour,f.endHour),path:f.bestCatchPath}:null;}):null;
return trackerTime;
}

function auditOceanConditions({item,s,conventions,additionalEvidence,spotId,node,fields,add,oceanStages,param}){
if(item.method!=='ocean'){return;}

        const times=s?.ocean?.ikdTimes?normalizedOceanTimes(s.ocean.ikdTimes.map(t=>t.id),conventions.fishcakeOceanTimes):null;
        const extra=Object.fromEntries(additionalEvidence.filter(e=>e.fishId===item.id&&e.spotId===spotId&&e.field==='oceanTime').map(e=>[e.source,e.value]));
        const oceanTime=checkField('oceanTime',{fishcake:times,teamcraft:teamcraftOceanTime(node,conventions.teamcraftOceanTimes),...extra});
        if(oceanTime.status==='conflict'&&times?.length>1&&oceanTime.values.teamcraft?.length&&oceanTime.values.teamcraft.every(t=>times.includes(t))){oceanTime.status='representation-limit';}
        fields.push({...oceanTime,spotId});
        add('oceanStage',{fishcake:s?.ocean?.stage,game:oceanStages.get(spotId)});
        add('oceanPoints',{fishcake:s?.ocean?.points});
        add('oceanStars',{fishcake:s?.fishParameter?.oceanStars,game:param?.OceanStars!==undefined?Number(param.OceanStars):null});

}

function auditRodConditions({item,s,t,tracker,node,path,teamcraft,spotId,fields,add}){
if(item.method!=='rod'){return;}

        const effective=s?.effectiveConditions??s;
        const trackerTime=trackerEffectiveTime({t,tracker});
        const tcTime=teamcraftEffectiveTime({node,path,teamcraft,spotId});
        const time=compareRodTimeSources({item,spotId,trackerTime,effective,tcTime});
        if(time.status==='conflict'&&['compatible-alternatives','recommendation-difference'].includes(fields.find(f=>f.field==='baitPath'&&f.spotId===spotId)?.status)){
          // Effective time can differ legitimately when recommended mooch routes differ.
          const paths=[pathSteps(t?.bestCatchPath),pathSteps(s?.bestCatchPathIds),pathSteps(path)].filter(Boolean);
          if(paths.length>1&&!compatiblePaths(paths)){time.status='route-dependent';}
        }
        fields.push({...time,spotId});
        auditRodWeather({add,t,effective,node});
        if(t&&s&&same(periods(t.startHour,t.endHour),periods(s.startHour,s.endHour))&&!same(periods(s.startHour,s.endHour),[[0,24]])){add('fishEyes',{tracker:t.fishEyes,fishcake:s.fishEyesSupported});}

}

function auditRodTackle({item,spotId,t,s,path,fishcake,fields,add,node}){
if(item.method==='spear'){return;}

        const bait=compareBaitPathSources({item,spotId,t,s,path});
        auditAlternativeBaitRoutes({bait,fishcake,spotId,s});
        fields.push({...bait,spotId});
        add('tug',{tracker:t?.tug,fishcake:s?.tug,teamcraft:tcTug[node?.tug]});
        add('hookset',{tracker:t?.hookset?.toLowerCase(),fishcake:s?.hookset,teamcraft:tcHook[node?.hookset]});
        add('snagging',{tracker:t?Boolean(t.snagging):null,fishcake:s?.requiresSnagging,teamcraft:node?.snagging});
        add('folklore',{tracker:t?Boolean(t.folklore):null,fishcake:s?Boolean(s.folkloreId):null,teamcraft:node?.folklore!==undefined?Boolean(node.folklore):null});
        add('lure',{tracker:t?normalizedLure(t.lure):null,fishcake:normalizedLure(s?.lureSkillType),teamcraft:teamcraftLure(node)});
        if(s?.lureSkillType==='ambitious'||s?.lureSkillType==='modest'){add('lureStacks',{fishcake:s.lureSkillStack,teamcraft:s.lureSkillType==='ambitious'?node?.aLure:node?.mLure});}

}

function auditFishingSpot({cake,spotId,tc,reference,fields,fishcake,catalog,item,spotNames,tracker,teamcraft,conventions,additionalEvidence,oceanStages,param,shadowEvidence}){

      const s=cake.find(s=>s.spotId===spotId),node_=tc.find(n=>n.id===spotId),node=node_,t=reference?.location===spotId?reference:null;
      const add=(name,values,equal)=>fields.push({...checkField(name,values,equal),spotId});
      const path=completeMoochPath(node?.baits?.map(b=>b.id),spotId,fishcake);
      if(catalog.region==='cn'){add('spotName',{catalog:item.spotId===spotId?item.location:null,game:spotNames.get(spotId),fishcake:s?.spotName});}
      auditRodTackle({item,spotId,t,s,path,fishcake,fields,add,node});
      auditRodConditions({item,s,t,tracker,node,path,teamcraft,spotId,fields,add});
      auditOceanConditions({item,s,conventions,additionalEvidence,spotId,node,fields,add,oceanStages,param});
      if(item.method==='spear'){add('shadowSize',{fishcake:({small:'small',average:'medium',big:'large'})[s?.size?.toLowerCase()],teamcraft:{0:'small',1:'medium',2:'large'}[node?.shadowSize]});}
      const rawTracker=t?pairs(t.predators):null,rawTc=pairs(node?.predators??node?.alarm?.predators);
      const shadowIds=new Set((s?.shadowPredators??[]).map(p=>p.id));
      auditShadowSpawn({item,shadowIds,shadowEvidence,spotId,add,rawTracker,s,rawTc});
      const predators={tracker:rawTracker?.filter(([id])=>!shadowIds.has(id)),fishcake:s?pairs(s.predators):null,teamcraft:rawTc?.filter(([id])=>!shadowIds.has(id))};
      auditPredatorDuration({predators,add,t,s,item,spotId});

}

function auditCatalogItem({tracker,item,fishcake,teamcraft,game,catalog,items,spotNames,conventions,additionalEvidence,oceanStages,shadowEvidence,weatherAudit,records}){

    const reference=tracker.FISH[item.id],cake=fishcake.get(item.id)?.spots??[],tc=teamcraft.get(item.id)??[],param=game.get(item.id),fields=[];
    auditFishIdentity({item,catalog,items,cake,tracker,fields,param,reference,tc});
    const spotIds=sorted([...cake.map(s=>s.spotId),...tc.map(s=>s.id),...(reference?.location?[reference.location]:[])]).filter(id=>Number.isSafeInteger(id)&&id>0);
    if(item.spotId>0){fields.push(checkField('primarySpot',{catalog:item.spotId,fishcake:primarySpotEvidence(cake,item.spotId,s=>s.spotId),teamcraft:primarySpotEvidence(tc,item.spotId,s=>s.id,true)}));}
    else if(spotIds.length){fields.push({field:'primarySpot',status:'missing',values:{catalog:0,available:spotIds}});}
    for(const spotId of spotIds){auditFishingSpot({cake,spotId,tc,reference,fields,fishcake,catalog,item,spotNames,tracker,teamcraft,conventions,additionalEvidence,oceanStages,param,shadowEvidence});}
    const weather=weatherAudit.get(item.id);if(weather){fields.push({field:'weatherProbability',status:weatherAuditStatus(weather),values:weather});}
    // Preserve disagreeing raw facts while explicitly recording the adopted corroborated value.
    for(const field of fields.filter(f=>f.status==='conflict')){resolveCorroboratedField({field});}
    const conflicts=fields.filter(f=>f.status==='conflict'),missing=fields.filter(f=>f.status==='missing');
    const sources=['game',...(reference?['tracker']:[]),...(cake.length?['fishcake']:[]),...(tc.length?['teamcraft']:[]),...new Set(additionalEvidence.filter(e=>e.fishId===item.id).map(e=>e.source))];
    const special=item.acquisitionContext;
    records.push({id:item.id,name:item.name,method:item.method,region:catalog.region,sources,scope:special?'special-content':'fishing-log',...(special?{acquisitionContext:special}:{}),status:catalogAuditStatus(conflicts,special,sources,missing,cake),compared:fields.filter(f=>['matched','compatible-alternatives','resolved'].includes(f.status)).length,conflicts:conflicts.map(f=>({field:f.field,spotId:f.spotId,values:f.values})),missing:missing.map(f=>f.field),fields});

}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const sorted=value=>[...new Set(value??[])].sort((a,b)=>a-b);
export function periods(start,end){
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>24||end<0||end>24){return null;}
  start=Math.round(start*60)/60;end=Math.round(end*60)/60;
  if(start===end||start===0&&end===24){return [[0,24]];}
  return start<end?[[start,end]]:[[0,end],[start,24]].filter(([a,b])=>a!==b);
}
export function teamcraftPeriods(node){
  if(!Array.isArray(node.spawns)||!Number.isFinite(node.duration)){return null;}
  if(!node.spawns.length){return [[0,24]];}
  if(node.duration<=0||node.duration>=1440){return [[0,24]];}
  const windows=node.spawns.flatMap(start=>periods(start,(start+node.duration/60)%24)??[]).sort((a,b)=>a[0]-b[0]);
  const merged=[];for(const [a,b] of windows){const last=merged.at(-1);if(last&&a<=last[1]){last[1]=Math.max(last[1],b);}else {merged.push([a,b]);}}return merged;
}
export function pathSteps(path){
  if(!Array.isArray(path)||!path.length){return null;}
  const steps=path.map(step=>sorted(Array.isArray(step)?step:[step]));
  return steps.every(step=>step.length&&step.every(id=>Number.isSafeInteger(id)&&id>0))?steps:null;
}
export function compatiblePaths(values){
  if(!values.length||values.some(v=>v.length!==values[0].length)){return false;}
  return values[0].every((step,index)=>step.some(id=>values.every(path=>path[index].includes(id))));
}
export function completeMoochPath(path,spotId,fishcake){
  if(!Array.isArray(path)||!path.length||Array.isArray(path[0])){return path;}
  const seen=new Set();let result=[...path];
  while(!seen.has(result[0])){seen.add(result[0]);const fish=fishcake.get(result[0])?.spots.find(s=>s.spotId===spotId),prefix=fish?.bestCatchPathIds;if(!prefix?.length){break;}result=[...prefix,...result];if(result.length>12){break;}}
  return result;
}
export function checkField(field,values,equal=values=>values.every(v=>same(v,values[0]))){
  const present=Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined&&v!==null));
  const list=Object.values(present);
  const external=Object.keys(present).filter(key=>key!=='catalog').length;
  let status='matched';
  if(list.length>1&&!equal(list)){status='conflict';}
  else if(external<2){status='single-source';}
  return {field,status,values:present};
}
const pairs=value=>{
  if(!Array.isArray(value)){return null;}
  return value.map(p=>Array.isArray(p)?p:[p.id,p.amount??p.count]).sort((a,b)=>a[0]-b[0]);
};
const rounded=value=>Number.isFinite(value)?Math.round(value*100)/100:null;
const tcTug={0:'medium',1:'heavy',2:'light'},tcHook={1:'powerful',2:'precision'};
const normalizedLure=value=>{
  if(typeof value==='string'){return value.toLowerCase();}
  return value===null?'none':null;
};
const booleans=value=>{
  if(value==='True'){return true;}
  if(value==='False'){return false;}
  return null;
};
const teamcraftWeather=(node,previous=false)=>{
  if(previous){
    if(node?.weathersFrom!==undefined){return sorted(node.weathersFrom);}
    if(node?.alarm?.weathersFrom!==undefined){return sorted(node.alarm.weathersFrom);}
  }else if(node?.weathers!==undefined){return sorted(node.weathers);}
  if(node?.limited===false){return [];}
  return null;
};
const teamcraftOceanTime=(node,conventions)=>{
  if(node?.oceanFishingTime===0){return [];}
  if(node?.oceanFishingTime>0){return normalizedOceanTimes([node.oceanFishingTime],conventions);}
  return null;
};
const weatherAuditStatus=weather=>{
  if(weather.status==='matched'){return 'matched';}
  if(weather.status==='mismatch'){return 'conflict';}
  return 'missing';
};
/** 缺失游戏证据与竿钓、刺鱼类型分别记录，不推断未出现的来源。 */
const teamcraftTechnique=rows=>{
  if(!rows.length){return null;}
  return rows[0].type===4?'spear':'rod';
};
const gameTechnique=param=>{
  if(!param){return null;}
  return param.method==='spear'?'spear':'rod';
};
const rarityKind=tier=>({livingLegend:'legendary',bigFish:'big',normal:'normal'})[tier]??null;
const primarySpotEvidence=(values,expected,idOf,sortFallback=false)=>{
  if(!values.length){return null;}
  if(values.some(value=>idOf(value)===expected)){return expected;}
  const ids=values.map(idOf);
  return sortFallback?sorted(ids):ids;
};
const teamcraftLure=node=>{
  if(node?.aLure>0){return 'ambitious';}
  if(node?.mLure>0){return 'modest';}
  if(node?.aLure===0&&node?.mLure===0){return 'none';}
  return null;
};
const catalogAuditStatus=(conflicts,special,sources,missing,fishcake)=>{
  if(conflicts.length){return 'conflict';}
  if(special){return 'special-content';}
  if(sources.length===1){return 'single-source';}
  if(missing.length||!fishcake.length){return 'partial';}
  return 'checked';
};
const intersectPeriods=(a,b)=>a.flatMap(([x,y])=>b.map(([u,v])=>[Math.max(x,u),Math.min(y,v)]).filter(([u,v])=>u<v));
export function effectivePeriods(initial,path,lookup,seen=new Set()){
  let result=initial;
  if(!result){return null;}
  for(const step of path?.slice(1)??[]){
    if(Array.isArray(step)){continue;}
    if(seen.has(step)){continue;}
    const dependency=lookup(step);if(!dependency){continue;}
    const next=effectivePeriods(dependency.periods,dependency.path,lookup,new Set([...seen,step]));
    if(next){result=intersectPeriods(result,next);}
  }
  return result;
}

/** Compare every catalog item and every known spot; absent evidence is never agreement. */
export function normalizedOceanTimes(ids,mapping){
  if(!Array.isArray(ids)){return null;}
  const values=[...new Set(ids.map(id=>mapping[id]))];
  if(values.some(v=>!v)){throw new Error('Unknown ocean time enum');}
  return values.includes('any')||values.length===3?[]:values.sort((a,b)=>a.localeCompare(b));
}
export function auditCatalog({catalog,tracker,fishcake,teamcraft,game,items,spotNames,weatherAudit,shadowEvidence=new Map(),oceanStages=new Map(),conventions,additionalEvidence=[]}){
  const records=[];
  for(const item of catalog.fish){auditCatalogItem({tracker,item,fishcake,teamcraft,game,catalog,items,spotNames,conventions,additionalEvidence,oceanStages,shadowEvidence,weatherAudit,records});}
  const count=status=>records.filter(r=>r.status===status).length;
  return {region:catalog.region,total:records.length,checked:count('checked'),special:count('special-content'),partial:count('partial'),conflicts:count('conflict'),singleSource:count('single-source'),specialWithLocations:records.filter(r=>r.acquisitionContext?.locations.length).length,specialWithBaits:records.filter(r=>r.acquisitionContext?.baitIds.length).length,specialSourceOnly:records.filter(r=>r.acquisitionContext&&r.sources.length===1).length,fieldsCompared:records.reduce((n,r)=>n+r.compared,0),resolvedDifferences:records.filter(r=>r.fields.some(f=>f.status==='resolved')).length,alternativeRoutes:records.filter(r=>r.fields.some(f=>f.status==='route-dependent'||f.status==='compatible-alternatives')).length,records};
}
