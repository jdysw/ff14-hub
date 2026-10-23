import {predatorPairs} from './fish-requirements.mjs';
const ordered=value=>[...(value??[])].sort((a,b)=>a-b);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const conditions=fish=>({startHour:fish.startHour,endHour:fish.endHour,currentWeather:ordered(fish.weatherSet),previousWeather:ordered(fish.previousWeatherSet)});
const observed=fish=>({startHour:fish.startHour,endHour:fish.endHour,currentWeather:ordered(fish.currentWeather),previousWeather:ordered(fish.previousWeather)});
export function auditIntuition(tracker,snapshot){
  const records=[];
  for(const item of snapshot.fish){
    const reference=tracker.FISH[item.id],differences=[],missingFields=[];
    const spot=item.spots.find(s=>s.spotId===reference?.location);
    if(!reference||!spot){records.push({id:item.id,status:'missing',differences:['target fishing spot missing']});continue;}
    const expected=predatorPairs(reference.predators).sort((a,b)=>a[0]-b[0]),actual=spot.predators.map(p=>[p.id,p.count]).sort((a,b)=>a[0]-b[0]);
    if(!same(expected,actual))differences.push('predator IDs or counts');
    if(reference.intuitionLength==null||spot.intuitionLength==null)missingFields.push('intuition duration');
    else if(reference.intuitionLength!==spot.intuitionLength)differences.push('intuition duration');
    if(!same(conditions(reference),observed(spot)))differences.push('target time/weather');
    const predecessors=[];
    for(const [id] of expected){const source=tracker.FISH[id],fact=spot.preconditions.find(p=>p.id===id)?.spots;
      const matched=!!source&&!!fact?.some(f=>same(conditions(source),observed(f)));
      predecessors.push({id,status:matched?'matched':!source||!fact?.length?'missing':'conflict'});
      if(!matched)differences.push('predecessor time/weather '+id);
    }
    records.push({id:item.id,status:differences.length?'conflict':missingFields.length?'partial':'matched',spotId:spot.spotId,predators:actual,intuitionSeconds:spot.intuitionLength,trackerIntuitionSeconds:reference.intuitionLength??null,predecessors,differences,missingFields});
  }
  return {total:records.length,matched:records.filter(r=>r.status==='matched').length,partial:records.filter(r=>r.status==='partial').length,conflicts:records.filter(r=>r.status==='conflict').length,missing:records.filter(r=>r.status==='missing').length,records};
}
