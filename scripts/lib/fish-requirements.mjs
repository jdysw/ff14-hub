/** Read declarative tracker facts; array indices must never become fish IDs. */
export function predatorPairs(value){
  if(value!==undefined&&value!==null&&typeof value!=='object')throw new Error('Invalid predator list');
  let raw=[];
  if(Array.isArray(value)){raw=value;}
  else if(value&&typeof value==='object'){raw=Object.entries(value);}
  const pairs=[];
  for(const entry of raw){
    const id=Number(entry?.[0]),count=Number(entry?.[1]);
    if(!Array.isArray(entry)||entry.length!==2||!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(count)||count<=0)
      throw new Error('Invalid predator identity/count');
    pairs.push([id,count]);
  }
  if(new Set(pairs.map(([id])=>id)).size!==pairs.length)throw new Error('Duplicate predator');
  return pairs;
}

export function baitPathLabels(path,label){
  if(path===undefined||path===null)return [];
  if(!Array.isArray(path))throw new Error('Invalid bait path');
  const item=id=>{
    if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid bait ID');
    return label(id)||`物品 ${id}`;
  };
  return path.map((step,index)=>{
    if(Array.isArray(step)){
      if(index!==0||!step.length)throw new Error('Alternative bait must be the first path step');
      return step.map(item).join(' / ');
    }
    return item(step);
  });
}

export function trackerRequirements(fish,label){
  const result=[];
  const add=(kind,description)=>result.push({kind,description:String(description).slice(0,300)});
  const bait=baitPathLabels(fish.bestCatchPath,label);
  if(bait.length)add('bait','推荐鱼饵/泳饵路径：'+bait.join(' → '));
  const predators=predatorPairs(fish.predators);
  if(predators.length)add('predators','鱼识前置：'+predators.map(([id,count])=>`${label(id)||'鱼 '+id} × ${count}`).join('、'));
  if(fish.intuitionLength){
    if(!Number.isFinite(fish.intuitionLength)||fish.intuitionLength<=0)throw new Error('Invalid intuition duration');
    add('intuition',`鱼识持续 ${fish.intuitionLength} 秒；尚未计算前置鱼准备的可行性。`);
  }
  if(fish.folklore)add('folklore','需要对应地区传承录');
  if(fish.fishEyes)add('fishEyes','支持鱼眼；这里按未使用鱼眼的原始时间窗计算');
  if(fish.snagging)add('unknown','需要开启钓组（Snagging）；尚未模拟技能状态');
  if(fish.lure)add('unknown',`上游标注诱鱼技能 ${String(fish.lure)}；技能名称及状态待核对`);
  if(fish.dataMissing)add('unknown','上游标记有缺失的钓鱼条件');
  if(fish.gig)add('unknown','刺鱼机制，不适用普通钓鱼窗口');
  return result;
}
