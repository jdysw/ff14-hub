import {predatorPairs} from './fish-requirements.mjs';
const ordered=value=>[...(value??[])].sort((a,b)=>a-b);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const conditions=fish=>({startHour:fish.startHour,endHour:fish.endHour,currentWeather:ordered(fish.weatherSet),previousWeather:ordered(fish.previousWeatherSet)});
const observed=fish=>({startHour:fish.startHour,endHour:fish.endHour,currentWeather:ordered(fish.currentWeather),previousWeather:ordered(fish.previousWeather)});
// Fishcake stores mooch bait restrictions separately; Tracker flattens them.
const effectiveObserved=fish=>observed(fish.moochDependencies?.length&&fish.effectiveConditions?fish.effectiveConditions:fish);
export function auditIntuition(tracker,snapshot){
  const records=[];
  for(const item of snapshot.fish){
    const reference=tracker.FISH[item.id],differences=[],missingFields=[],supplementedFields=[];
    const spot=item.spots.find(s=>s.spotId===reference?.location);
    if(!reference||!spot){records.push({id:item.id,status:'missing',differences:['target fishing spot missing']});continue;}
    const expected=predatorPairs(reference.predators).sort((a,b)=>a[0]-b[0]),actual=spot.predators.map(p=>[p.id,p.count]).sort((a,b)=>a[0]-b[0]);
    if(!same(expected,actual))differences.push('predator IDs or counts');
    if(reference.intuitionLength==null&&Number.isSafeInteger(spot.intuitionLength)&&spot.intuitionLength>0&&spot.intuitionLength<=86400)supplementedFields.push('intuition duration');
    else if(reference.intuitionLength==null||spot.intuitionLength==null)missingFields.push('intuition duration');
    else if(reference.intuitionLength!==spot.intuitionLength)differences.push('intuition duration');
    if(!same(conditions(reference),effectiveObserved(spot)))differences.push('target time/weather');
    const predecessors=[];
    for(const [id] of expected){const source=tracker.FISH[id],fact=spot.preconditions.find(p=>p.id===id)?.spots;
      const matching=source&&fact?.find(f=>same(conditions(source),effectiveObserved(f))),matched=!!matching;
      predecessors.push({id,status:matched?'matched':!source||!fact?.length?'missing':'conflict',...(matching&&!same(observed(matching),effectiveObserved(matching))?{normalizedMooch:true,rawConditions:observed(matching),effectiveConditions:effectiveObserved(matching),moochDependencies:matching.moochDependencies}:{})});
      if(!matched)differences.push('predecessor time/weather '+id);
    }
    records.push({id:item.id,status:differences.length?'conflict':missingFields.length?'partial':supplementedFields.length?'supplemented':'matched',spotId:spot.spotId,predators:actual,intuitionSeconds:spot.intuitionLength,trackerIntuitionSeconds:reference.intuitionLength??null,predecessors,differences,missingFields,supplementedFields});
  }
  return {total:records.length,matched:records.filter(r=>r.status==='matched').length,supplemented:records.filter(r=>r.status==='supplemented').length,partial:records.filter(r=>r.status==='partial').length,conflicts:records.filter(r=>r.status==='conflict').length,missing:records.filter(r=>r.status==='missing').length,records};
}

export function supplementIntuition(fish,row,snapshot){
  if(row.status!=='supplemented')return fish;
  if(!fish.rule||!Number.isSafeInteger(row.intuitionSeconds)||row.intuitionSeconds<=0||row.intuitionSeconds>86400)throw new Error('Cannot supplement invalid intuition duration');
  const description=`鱼识持续 ${row.intuitionSeconds} 秒（鱼糕补充）；尚未计算前置鱼准备的可行性。`;
  const previous=fish.rule.conditions.filter(c=>c.kind==='intuition').map(c=>c.description);
  const conditions=fish.conditions.filter(text=>!previous.includes(text)&&!/^鱼识持续 /.test(text));
  const suffix='-fishcake-'+snapshot.version;
  const baseVersion=fish.rule.version.replace(/-fishcake-[^-]+$/,'');
  const version=baseVersion.slice(0,80-suffix.length)+suffix;
  return {...fish,conditions:[...conditions,description],intuitionDuration:{seconds:row.intuitionSeconds,source:'fishcake',sourceVersion:snapshot.version,checkedAt:snapshot.observedAt},rule:{...fish.rule,version,conditions:[...fish.rule.conditions.filter(c=>c.kind!=='intuition'),{kind:'intuition',description}]}};
}
