const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const pairs=value=>(value??[]).map(p=>[p.id,p.count??p.amount]).sort((a,b)=>a[0]-b[0]);
const tcTug={0:'medium',1:'heavy',2:'light'},tcHook={1:'Powerful',2:'Precision'};
const correctedVersion=version=>{const suffix='-crosscheck-v1';return version.replace(/-crosscheck-v1$/,'').slice(0,80-suffix.length)+suffix;};
import {effectivePeriods,periods,teamcraftPeriods,normalizedOceanTimes} from './fishing-crosscheck.mjs';
export function correctCatalog({catalog,fishcake,teamcraft,items,spotNames,snapshot,tracker,conventions}){
  const changes=[];
  const label=id=>catalog.region==='cn'?items.get(id)??tracker.ITEMS[id]?.name_en:tracker.ITEMS[id]?.name_en??items.get(id);
  for(const fish of catalog.fish){
    const s=fishcake.get(fish.id)?.spots.find(s=>s.spotId===fish.spotId),tc=teamcraft.get(fish.id)?.find(n=>n.id===fish.spotId&&!n.identityOnly),changed=[];
    const assign=(key,value,source)=>{if(value!==undefined&&value!==null&&!same(fish[key],value)){changes.push({id:fish.id,field:key,before:fish[key],after:value,source});fish[key]=value;changed.push(key);}};
    if(catalog.region==='cn'&&spotNames.get(fish.spotId))assign('location',spotNames.get(fish.spotId),'cn-game-table');
    if(s){
      if(tracker.FISH[fish.id]?.bestCatchPath)fish.catchPathIds=tracker.FISH[fish.id].bestCatchPath;
      else if(s.bestCatchPathIds?.length){fish.catchPathIds=s.bestCatchPathIds;const labels=s.bestCatchPathIds.map(id=>label(id));if(labels.every(Boolean))assign('bait',labels,'fishcake recommended path at primary spot');}
      if(!fish.patch||Math.floor(Number(fish.patch)*10)===Math.floor(s.patch*10)&&Number(fish.patch)!==Math.round(s.patch*100)/100)assign('patch',String(Math.round(s.patch*100)/100),'fishcake');
      if(!fish.tug&&s.tug&&tcTug[tc?.tug]===s.tug)assign('tug',s.tug,'fishcake+teamcraft');
      if(!fish.hookset&&s.hookset&&tcHook[tc?.hookset]?.toLowerCase()===s.hookset)assign('hookset',tcHook[tc.hookset],'fishcake+teamcraft');
      if(fish.method==='ocean'&&s.ocean?.ikdTimes){
        const times=normalizedOceanTimes(s.ocean.ikdTimes.map(t=>t.id),conventions.fishcakeOceanTimes),labels={day:'白天',sunset:'黄昏',night:'夜晚'};
        fish.conditions=fish.conditions.filter(c=>!c.startsWith('海钓环境：'));
        fish.conditions.push(`海钓环境：${s.ocean.stage==='spectral'?'幻海流':'普通海域'}；${times.length?'时段：'+times.map(t=>labels[t]).join(' / '):'海钓时段不限'}（鱼糕资料）。`);
      }
      const own=s.predators??[],shadow=s.shadowPredators??[];
      if(fish.method==='spear'&&(own.length||shadow.length)){
        fish.conditions=fish.conditions.filter(c=>!/^鱼识前置：|^鱼影触发[：（]|^鱼识持续 /.test(c));
        if(shadow.length)fish.conditions.push('鱼影触发（鱼糕资料）：'+shadow.map(p=>`${label(p.id)||p.id} × ${p.count}`).join('、'));
        if(own.length)fish.conditions.push('鱼识前置：'+own.map(p=>`${label(p.id)||p.id} × ${p.count}`).join('、'));
        if(own.length&&fish.intuitionDuration)fish.conditions.push(`鱼识持续 ${fish.intuitionDuration.seconds} 秒（鱼糕资料）。`);
        changed.push('separate-shadow-and-intuition');
      }
      if(own.length&&s.intuitionSeconds>0&&Number.isSafeInteger(s.intuitionSeconds)){
        const sourcePairs=pairs(tc?.predators??tc?.alarm?.predators).filter(([id])=>!shadow.some(p=>p.id===id));
        const corroborated=same(sourcePairs,pairs(own));
        if(!fish.conditions.some(c=>c.startsWith('鱼识前置：')))fish.conditions.push('鱼识前置：'+own.map(p=>`${label(p.id)||p.id} × ${p.count}`).join('、'));
        if(!fish.intuitionDuration){
          const description=`鱼识持续 ${s.intuitionSeconds} 秒（鱼糕资料）。`;
          fish.intuitionDuration={seconds:s.intuitionSeconds,source:'fishcake',sourceVersion:snapshot.version,checkedAt:snapshot.observedAt};
          fish.conditions=fish.conditions.filter(c=>!c.startsWith('鱼识持续 '));fish.conditions.push(description);
          changes.push({id:fish.id,field:'intuitionDuration',after:fish.intuitionDuration,source:corroborated?'fishcake; predator counts corroborated by teamcraft':'fishcake'});changed.push('intuitionDuration');
        }
        if(fish.rule){
          const missingPredators=!fish.rule.conditions.some(c=>c.kind==='predators'),missingIntuition=!fish.rule.conditions.some(c=>c.kind==='intuition');
          if(missingPredators||missingIntuition){
            if(missingPredators)fish.rule.conditions.push({kind:'predators',description:fish.conditions.find(c=>c.startsWith('鱼识前置：'))});
            if(missingIntuition)fish.rule.conditions.push({kind:'intuition',description:`鱼识持续 ${s.intuitionSeconds} 秒（鱼糕资料）。`});
            fish.rule.version=correctedVersion(fish.rule.version);changed.push('intuition-rule');
            changes.push({id:fish.id,field:'rule.intuition',after:{predators:own,seconds:s.intuitionSeconds},source:'fishcake; separate predator count comparison retained in report'});
          }
        }
      }
      // This time correction has matching bait, weather, and two corroborating sources.
      if(fish.id===14218&&fish.rule){
        if(s.startHour!==18||s.endHour!==24||tc?.spawns?.[0]!==18||tc?.duration!==360)throw Error('Oliphant time correction no longer matches source evidence');
        if(fish.rule.endHour!==24){changes.push({id:fish.id,field:'rule.endHour',before:fish.rule.endHour,after:24,source:'fishcake+teamcraft'});fish.rule={...fish.rule,endHour:24};changed.push('time');}
        fish.rule.version=correctedVersion(fish.rule.version);
      }
      if(fish.id===4906&&fish.rule){
        const time=tc?effectivePeriods(teamcraftPeriods(tc),tc.baits?.map(b=>b.id),id=>{const n=teamcraft.get(id)?.find(n=>n.id===fish.spotId&&!n.identityOnly);return n?{periods:teamcraftPeriods(n),path:n.baits?.map(b=>b.id)}:null;}):null;
        if(s.effectiveConditions?.startHour!==18||s.effectiveConditions?.endHour!==6||!same(time,periods(18,6)))throw Error('Nautilus mooch time no longer matches sources');
        if(fish.rule.startHour!==18||fish.rule.endHour!==6){changes.push({id:fish.id,field:'rule.time',before:[fish.rule.startHour,fish.rule.endHour],after:[18,6],source:'tracker dependencies+fishcake+teamcraft dependencies'});fish.rule={...fish.rule,startHour:18,endHour:6};fish.always=false;changed.push('mooch-time');}
        fish.rule.version=correctedVersion(fish.rule.version);
      }
    }
    if(changed.length)fish.crossSourceCorrections={fields:[...new Set([...(fish.crossSourceCorrections?.fields??[]),...changed])],checkedAt:snapshot.observedAt,sourceVersion:snapshot.version};
  }
  return changes;
}
