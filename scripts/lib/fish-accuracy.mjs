import {predatorPairs} from './fish-requirements.mjs';

/** Compare all 100 forecast targets, preserving repeated weather slots and order. */
export function gameWeatherTargets(row){
  if(!row)throw new Error('Missing game weather table');
  const values=[];
  for(let i=0;i<8;i++){
    const weather=Number(row[`Weather[${i}]`]),chance=Number(row[`Rate[${i}]`]);
    if(!Number.isInteger(chance)||chance<0||chance>100||!Number.isInteger(weather)||(chance>0&&weather<=0))throw new Error('Invalid game weather probability');
    for(let n=0;n<chance;n++)values.push(weather);
  }
  if(values.length!==100)throw new Error('Game weather probabilities do not total 100');
  return values;
}

export function trackerWeatherTargets(entries){
  if(!Array.isArray(entries))throw new Error('Missing community weather table');
  const values=[];
  for(const pair of entries){
    if(!Array.isArray(pair)||pair.length!==2)throw new Error('Invalid community weather slot');
    const [weather,end]=pair;
    if(!Number.isSafeInteger(weather)||weather<=0||!Number.isInteger(end)||end<=values.length||end>100)throw new Error('Invalid community threshold');
    while(values.length<end)values.push(weather);
  }
  if(values.length!==100)throw new Error('Community weather thresholds do not total 100');
  return values;
}

export function compareCnWeather({fish,tracker,spots,territories,rates}){
  const spot=spots.get(Number(fish.location));
  const territory=territories.get(Number(spot?.TerritoryType));
  const globalSpot=tracker.FISHING_SPOTS[fish.location];
  if(!spot||!territory||!globalSpot)return {status:'missing',territoryId:Number(spot?.TerritoryType??0)};
  try{
    const game=gameWeatherTargets(rates.get(Number(territory.WeatherRate)));
    const community=trackerWeatherTargets(tracker.WEATHER_RATES[globalSpot.territory_id]?.weather_rates);
    return {status:game.every((weather,i)=>weather===community[i])?'matched':'mismatch',territoryId:Number(spot.TerritoryType),weatherRateId:Number(territory.WeatherRate)};
  }catch{return {status:'missing',territoryId:Number(spot.TerritoryType)};}
}

export function dependencyFacts(fish,fishIds,itemNames){
  const pairs=predatorPairs(fish.predators);
  return {predators:pairs.map(([id,count])=>({id,count,name:itemNames.get(id)??null,presentInRegion:fishIds.has(id)})),
    intuitionSeconds:fish.intuitionLength??null,feasibilityVerified:false};
}
