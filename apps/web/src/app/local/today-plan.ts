import {fishWindows,type EventCalendarItem,type FishRegion} from '@ff14-hub/shared';
import type {CatalogFish} from '../fish/catalog';
import type {LocalData} from './store';
export const chinaDayEnd=(now:number)=>(Math.floor((now+8*3600000)/86400000)+1)*86400000-8*3600000;
export interface PlannedFish{fishId:number;region:FishRegion;name:string;location:string;startsAt:number;endsAt:number;candidate:boolean}
export function planFish(fish:readonly CatalogFish[],fields:LocalData['fish']['cn'],region:FishRegion,now:number){
  const caught=new Set(fields.filter(f=>f.field==='caught'&&f.value).map(f=>f.fishId));
  const watched=[...new Set(fields.filter(f=>(f.field==='alarm'||f.field==='pinned')&&f.value&&!caught.has(f.fishId)).map(f=>f.fishId))].sort((a,b)=>a-b);
  const wanted=new Set(watched.slice(0,50)),rows:PlannedFish[]=[];let unavailable=0,unrestricted=0;
  const byId=new Map(fish.map(f=>[f.id,f]));
  for(const id of wanted){const item=byId.get(id);
    if(!item?.rule||item.method!=='rod'){if(item?.always)unrestricted++;else unavailable++;continue;}
    try{for(const w of fishWindows({region,rules:[item.rule],from:now,to:chinaDayEnd(now)})){
      if(w.unrestricted){unrestricted++;continue;}
      rows.push({fishId:id,region,name:item.name,location:item.location,startsAt:w.startsAtUtcMs,endsAt:w.endsAtUtcMs,candidate:w.candidateOnly});
    }}catch{unavailable++;}
  }
  return {rows:rows.sort((a,b)=>Math.max(a.startsAt,now)-Math.max(b.startsAt,now)||a.endsAt-b.endsAt||a.fishId-b.fishId),watched:watched.length,limited:watched.length>50,unavailable,unrestricted};
}
export function planEvents(events:readonly EventCalendarItem[],now:number){
  const end=chinaDayEnd(now);
  const node=(e:EventCalendarItem)=>Math.min(e.startsAt!==null&&e.startsAt>=now?e.startsAt:Infinity,e.endsAt!==null&&e.endsAt>now?e.endsAt:Infinity);
  return events.filter(e=>e.startsAt!==null&&(e.endsAt===null||e.endsAt>e.startsAt)&&((e.startsAt>=now&&e.startsAt<end)||(e.endsAt!==null&&e.endsAt>now&&e.endsAt<=end))).sort((a,b)=>node(a)-node(b));
}
