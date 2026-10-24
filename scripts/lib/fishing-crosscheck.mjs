const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const sorted=value=>[...new Set(value??[])].sort((a,b)=>a-b);
export function periods(start,end){
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>24||end<0||end>24)return null;
  start=Math.round(start*60)/60;end=Math.round(end*60)/60;
  if(start===end||start===0&&end===24)return [[0,24]];
  return start<end?[[start,end]]:[[0,end],[start,24]].filter(([a,b])=>a!==b);
}
export function teamcraftPeriods(node){
  if(!Array.isArray(node.spawns)||!Number.isFinite(node.duration))return null;
  if(!node.spawns.length)return [[0,24]];
  if(node.duration<=0||node.duration>=1440)return [[0,24]];
  const windows=node.spawns.flatMap(start=>periods(start,(start+node.duration/60)%24)??[]).sort((a,b)=>a[0]-b[0]);
  const merged=[];for(const [a,b] of windows){const last=merged.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else merged.push([a,b]);}return merged;
}
export function pathSteps(path){
  if(!Array.isArray(path)||!path.length)return null;
  const steps=path.map(step=>sorted(Array.isArray(step)?step:[step]));
  return steps.every(step=>step.length&&step.every(id=>Number.isSafeInteger(id)&&id>0))?steps:null;
}
export function compatiblePaths(values){
  if(!values.length||values.some(v=>v.length!==values[0].length))return false;
  return values[0].every((step,index)=>step.some(id=>values.every(path=>path[index].includes(id))));
}
export function completeMoochPath(path,spotId,fishcake){
  if(!Array.isArray(path)||!path.length||Array.isArray(path[0]))return path;
  const seen=new Set();let result=[...path];
  while(!seen.has(result[0])){seen.add(result[0]);const fish=fishcake.get(result[0])?.spots.find(s=>s.spotId===spotId),prefix=fish?.bestCatchPathIds;if(!prefix?.length){break;}result=[...prefix,...result];if(result.length>12){break;}}
  return result;
}
export function checkField(field,values,equal=values=>values.every(v=>same(v,values[0]))){
  const present=Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined&&v!==null));
  const list=Object.values(present);
  const external=Object.keys(present).filter(key=>key!=='catalog').length;
  return {field,status:list.length>1&&!equal(list)?'conflict':external<2?'single-source':'matched',values:present};
}
const pairs=value=>{
  if(!Array.isArray(value))return null;
  return value.map(p=>Array.isArray(p)?p:[p.id,p.amount??p.count]).sort((a,b)=>a[0]-b[0]);
};
const rounded=value=>Number.isFinite(value)?Math.round(value*100)/100:null;
const tcTug={0:'medium',1:'heavy',2:'light'},tcHook={1:'powerful',2:'precision'};
const normalizedLure=value=>{
  if(typeof value==='string')return value.toLowerCase();
  return value===null?'none':null;
};
const booleans=value=>value==='True'?true:value==='False'?false:null;
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
  if(!Array.isArray(ids))return null;
  const values=[...new Set(ids.map(id=>mapping[id]))];
  if(values.some(v=>!v))throw Error('Unknown ocean time enum');
  return values.includes('any')||values.length===3?[]:values.sort((a,b)=>a.localeCompare(b));
}
export function auditCatalog({catalog,tracker,fishcake,teamcraft,game,items,spotNames,weatherAudit,shadowEvidence=new Map(),oceanStages=new Map(),conventions,additionalEvidence=[]}){
  const records=[];
  for(const item of catalog.fish){
    const reference=tracker.FISH[item.id],cake=fishcake.get(item.id)?.spots??[],tc=teamcraft.get(item.id)??[],param=game.get(item.id),fields=[];
    const nameValues={catalog:item.name};
    if(catalog.region==='cn'){nameValues.game=items.get(item.id);if(cake.length)nameValues.fishcake=cake[0].name;}
    else nameValues.tracker=tracker.ITEMS[item.id]?.name_en;
    const nameCheck=checkField('name',nameValues);
    // IDs agree; a translated spelling differs, rather than fish identity.
    if(nameCheck.status==='conflict'&&nameValues.game===item.name){nameCheck.status='localization-difference';}
    fields.push(nameCheck);
    fields.push(checkField('identity',{game:param?item.id:null,tracker:reference?item.id:null,fishcake:cake.length?item.id:null,teamcraft:tc.length?item.id:null}));
    const technique=item.method==='spear'?'spear':'rod';
    fields.push(checkField('technique',{catalog:technique,game:param?.method==='spear'?'spear':param?'rod':null,fishcake:cake[0]?.catchType,teamcraft:tc.length?(tc[0].type===4?'spear':'rod'):null}));
    if(cake.length&&param?.method!=='spear'){fields.push(checkField('oceanClassification',{catalog:item.method==='ocean',game:Number(param?.OceanStars)>0,fishcake:cake[0].fishType==='ikd'}));}
    const patch=checkField('patch',{catalog:item.patch?rounded(Number(item.patch)):null,tracker:rounded(reference?.patch),fishcake:rounded(cake[0]?.patch)});
    if(patch.status==='conflict'&&Object.values(patch.values).every(v=>Math.floor(v*10)===Math.floor(Object.values(patch.values)[0]*10))){patch.status='precision-difference';}
    fields.push(patch);
    if(param?.IsInLog&&cake[0]?.fishParameter){fields.push(checkField('inFishingLog',{game:booleans(param.IsInLog),fishcake:cake[0].fishParameter.isInLog}));}
    if(item.method==='rod'&&cake.length){const tier=cake[0].tier;const kind=tier==='livingLegend'?'legendary':tier==='bigFish'?'big':tier==='normal'?'normal':null;fields.push(checkField('rarity',{catalog:item.kind,fishcake:kind}));}
    const spotIds=sorted([...cake.map(s=>s.spotId),...tc.map(s=>s.id),...(reference?.location?[reference.location]:[])]).filter(id=>Number.isSafeInteger(id)&&id>0);
    if(item.spotId>0)fields.push(checkField('primarySpot',{catalog:item.spotId,fishcake:cake.length?(cake.some(s=>s.spotId===item.spotId)?item.spotId:cake.map(s=>s.spotId)):null,teamcraft:tc.length?(tc.some(s=>s.id===item.spotId)?item.spotId:sorted(tc.map(s=>s.id))):null}));
    else if(spotIds.length){fields.push({field:'primarySpot',status:'missing',values:{catalog:0,available:spotIds}});}
    for(const spotId of spotIds){
      const s=cake.find(s=>s.spotId===spotId),nodes=tc.filter(n=>n.id===spotId),node=nodes[0],t=reference?.location===spotId?reference:null;
      const add=(name,values,equal)=>fields.push({...checkField(name,values,equal),spotId});
      const path=completeMoochPath(node?.baits?.map(b=>b.id),spotId,fishcake);
      if(catalog.region==='cn')add('spotName',{catalog:item.spotId===spotId?item.location:null,game:spotNames.get(spotId),fishcake:s?.spotName});
      if(item.method!=='spear'){
        const bait=checkField('baitPath',{catalog:item.spotId===spotId?pathSteps(item.catchPathIds):null,tracker:pathSteps(t?.bestCatchPath),fishcake:pathSteps(s?.bestCatchPathIds),teamcraft:pathSteps(path)},compatiblePaths);
        if(bait.status==='conflict'){
          const valid=(steps,target,seen=new Set())=>{if(!target||!steps?.length)return false;const last=steps.at(-1);if(steps.length===1)return last.some(id=>target.baitIds?.includes(id));return last.some(id=>target.moochIds?.includes(id)&&!seen.has(id)&&valid(steps.slice(0,-1),fishcake.get(id)?.spots.find(p=>p.spotId===spotId),new Set([...seen,id])));};
          bait.status=s&&Object.values(bait.values).every(p=>valid(p,s))?'compatible-alternatives':'recommendation-difference';
        }
        fields.push({...bait,spotId});
        add('tug',{tracker:t?.tug,fishcake:s?.tug,teamcraft:tcTug[node?.tug]});
        add('hookset',{tracker:t?.hookset?.toLowerCase(),fishcake:s?.hookset,teamcraft:tcHook[node?.hookset]});
        add('snagging',{tracker:t?Boolean(t.snagging):null,fishcake:s?.requiresSnagging,teamcraft:node?.snagging});
        add('folklore',{tracker:t?Boolean(t.folklore):null,fishcake:s?Boolean(s.folkloreId):null,teamcraft:node?.folklore!==undefined?Boolean(node.folklore):null});
        add('lure',{tracker:t?normalizedLure(t.lure):null,fishcake:normalizedLure(s?.lureSkillType),teamcraft:node?.aLure>0?'ambitious':node?.mLure>0?'modest':node?.aLure===0&&node?.mLure===0?'none':null});
        if(s?.lureSkillType==='ambitious'||s?.lureSkillType==='modest')add('lureStacks',{fishcake:s.lureSkillStack,teamcraft:s.lureSkillType==='ambitious'?node?.aLure:node?.mLure});
      }
      if(item.method==='rod'){
        const effective=s?.effectiveConditions??s;
        const trackerTime=t?effectivePeriods(periods(t.startHour,t.endHour),t.bestCatchPath,id=>{const f=tracker.FISH[id];return f?{periods:periods(f.startHour,f.endHour),path:f.bestCatchPath}:null;}):null;
        const tcTime=node?effectivePeriods(teamcraftPeriods(node),path,id=>{const n=teamcraft.get(id)?.find(n=>n.id===spotId&&!n.identityOnly);return n?{periods:teamcraftPeriods(n),path:n.baits?.map(b=>b.id)}:null;}):null;
        const time=checkField('time',{catalog:item.spotId===spotId&&item.rule?periods(item.rule.startHour,item.rule.endHour):null,tracker:trackerTime,fishcake:effective?periods(effective.startHour,effective.endHour):null,teamcraft:tcTime});
        if(time.status==='conflict'&&['compatible-alternatives','recommendation-difference'].includes(fields.find(f=>f.field==='baitPath'&&f.spotId===spotId)?.status)){
          // Effective time can differ legitimately when recommended mooch routes differ.
          const paths=[pathSteps(t?.bestCatchPath),pathSteps(s?.bestCatchPathIds),pathSteps(path)].filter(Boolean);
          if(paths.length>1&&!compatiblePaths(paths))time.status='route-dependent';
        }
        fields.push({...time,spotId});
        add('weather',{tracker:t?sorted(t.weatherSet):null,fishcake:effective?sorted(effective.currentWeather):null,teamcraft:node?.weathers!==undefined?sorted(node.weathers):node?.limited===false?[]:null});
        add('previousWeather',{tracker:t?sorted(t.previousWeatherSet):null,fishcake:effective?sorted(effective.previousWeather):null,teamcraft:node?.weathersFrom!==undefined?sorted(node.weathersFrom):node?.alarm?.weathersFrom!==undefined?sorted(node.alarm.weathersFrom):node?.limited===false?[]:null});
        if(t&&s&&same(periods(t.startHour,t.endHour),periods(s.startHour,s.endHour))&&!same(periods(s.startHour,s.endHour),[[0,24]]))add('fishEyes',{tracker:t.fishEyes,fishcake:s.fishEyesSupported});
      }
      if(item.method==='ocean'){
        const times=s?.ocean?.ikdTimes?normalizedOceanTimes(s.ocean.ikdTimes.map(t=>t.id),conventions.fishcakeOceanTimes):null;
        const extra=Object.fromEntries(additionalEvidence.filter(e=>e.fishId===item.id&&e.spotId===spotId&&e.field==='oceanTime').map(e=>[e.source,e.value]));
        const oceanTime=checkField('oceanTime',{fishcake:times,teamcraft:node?.oceanFishingTime===0?[]:node?.oceanFishingTime>0?normalizedOceanTimes([node.oceanFishingTime],conventions.teamcraftOceanTimes):null,...extra});
        if(oceanTime.status==='conflict'&&times?.length>1&&oceanTime.values.teamcraft?.length&&oceanTime.values.teamcraft.every(t=>times.includes(t)))oceanTime.status='representation-limit';
        fields.push({...oceanTime,spotId});
        add('oceanStage',{fishcake:s?.ocean?.stage,game:oceanStages.get(spotId)});
        add('oceanPoints',{fishcake:s?.ocean?.points});
        add('oceanStars',{fishcake:s?.fishParameter?.oceanStars,game:param?.OceanStars!==undefined?Number(param.OceanStars):null});
      }
      if(item.method==='spear')add('shadowSize',{fishcake:({small:'small',average:'medium',big:'large'})[s?.size?.toLowerCase()],teamcraft:{0:'small',1:'medium',2:'large'}[node?.shadowSize]});
      const rawTracker=t?pairs(t.predators):null,rawTc=pairs(node?.predators??node?.alarm?.predators);
      const shadowIds=new Set((s?.shadowPredators??[]).map(p=>p.id));
      if(item.method==='spear'&&shadowIds.size){const fromNode=shadowEvidence.get(spotId)?.map(p=>p.filter(([id])=>shadowIds.has(id))).find(p=>p.length===shadowIds.size);add('shadowSpawn',{tracker:rawTracker?.filter(([id])=>shadowIds.has(id)),fishcake:pairs(s.shadowPredators),teamcraft:fromNode??rawTc?.filter(([id])=>shadowIds.has(id))});}
      const predators={tracker:rawTracker?.filter(([id])=>!shadowIds.has(id)),fishcake:s?pairs(s.predators):null,teamcraft:rawTc?.filter(([id])=>!shadowIds.has(id))};
      if(Object.values(predators).some(p=>p?.length)){
        add('predators',predators);
        add('intuitionDuration',{tracker:t?.intuitionLength>0?t.intuitionLength:null,fishcake:s?.intuitionSeconds>0?s.intuitionSeconds:null,catalog:item.spotId===spotId?item.intuitionDuration?.seconds:null});
      }
    }
    const weather=weatherAudit.get(item.id);if(weather)fields.push({field:'weatherProbability',status:weather.status==='matched'?'matched':weather.status==='mismatch'?'conflict':'missing',values:weather});
    // Preserve disagreeing raw facts while explicitly recording the adopted corroborated value.
    for(const field of fields.filter(f=>f.status==='conflict')){
      const sourceValues=Object.entries(field.values).filter(([k])=>k!=='catalog'&&k!=='game');
      const selected=sourceValues.find(([,value])=>sourceValues.filter(([,v])=>same(v,value)).length>=2);
      if(selected&&(!Object.hasOwn(field.values,'catalog')||same(field.values.catalog,selected[1]))){field.status='resolved';field.resolution={sources:sourceValues.filter(([,v])=>same(v,selected[1])).map(([k])=>k),value:selected[1]};}
    }
    const conflicts=fields.filter(f=>f.status==='conflict'),missing=fields.filter(f=>f.status==='missing');
    const sources=['game',...(reference?['tracker']:[]),...(cake.length?['fishcake']:[]),...(tc.length?['teamcraft']:[]),...new Set(additionalEvidence.filter(e=>e.fishId===item.id).map(e=>e.source))];
    const special=item.acquisitionContext;
    records.push({id:item.id,name:item.name,method:item.method,region:catalog.region,sources,scope:special?'special-content':'fishing-log',...(special?{acquisitionContext:special}:{}),status:conflicts.length?'conflict':special?'special-content':sources.length===1?'single-source':missing.length||!cake.length?'partial':'checked',compared:fields.filter(f=>['matched','compatible-alternatives','resolved'].includes(f.status)).length,conflicts:conflicts.map(f=>({field:f.field,spotId:f.spotId,values:f.values})),missing:missing.map(f=>f.field),fields});
  }
  const count=status=>records.filter(r=>r.status===status).length;
  return {region:catalog.region,total:records.length,checked:count('checked'),special:count('special-content'),partial:count('partial'),conflicts:count('conflict'),singleSource:count('single-source'),specialWithLocations:records.filter(r=>r.acquisitionContext?.locations.length).length,specialWithBaits:records.filter(r=>r.acquisitionContext?.baitIds.length).length,specialSourceOnly:records.filter(r=>r.acquisitionContext&&r.sources.length===1).length,fieldsCompared:records.reduce((n,r)=>n+r.compared,0),resolvedDifferences:records.filter(r=>r.fields.some(f=>f.status==='resolved')).length,alternativeRoutes:records.filter(r=>r.fields.some(f=>f.status==='route-dependent'||f.status==='compatible-alternatives')).length,records};
}
