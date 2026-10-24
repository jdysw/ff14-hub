/** Identify non-log entries before interpreting absent normal-world fishing rules. */
function specialCategory(id,description,uiCategory,item,wksItems){
  // 分类优先级沿用已有规则，避免“任务/重建/收藏品”互相覆盖。
  if(wksItems.has(id))return 'cosmic';
  if(description.includes('伊修加德重建'))return 'reconstruction';
  if(uiCategory&&uiCategory!=='水产品')return 'associated-item';
  if(description.includes('任务专用')||id>=2000000)return 'quest';
  if(item?.IsCollectable==='True')return 'collectable';
  return 'non-log';
}
export function firstPositiveId(...values){return values.map(Number).find(id=>Number.isSafeInteger(id)&&id>0)??0;}
export function buildSpecialContexts({game,itemRows,itemCategories,wksItems,gameSpots,places,tcLog,rawSources,territories}){
  const byFish=new Map();
  for(const spot of gameSpots.values())for(const [key,value] of Object.entries(spot))if(key.startsWith('Item[')&&Number(value)>0){const rows=byFish.get(Number(value))??[];rows.push(spot);byFish.set(Number(value),rows);}
  const tcByFish=new Map();for(const row of tcLog){const rows=tcByFish.get(row.itemId)??[];rows.push(row);tcByFish.set(row.itemId,rows);}
  const result=new Map();
  for(const [id,param] of game){
    const nonLog=param.method==='spear'?param.IsVisible==='False':param.IsInLog==='False';if(!nonLog){continue;}
    const item=itemRows.get(id),description=item?.Description??'',uiCategory=itemCategories.get(item?.ItemUICategory),entries=rawSources[id]??[],locations=[];
    const category=specialCategory(id,description,uiCategory,item,wksItems);
    const labels={cosmic:'宇宙探索任务资源',reconstruction:'伊修加德重建资源','associated-item':'钓鱼关联物品',quest:'任务用获取条目',collectable:'捕鱼收藏品','non-log':'图鉴外特殊条目'};
    const logs=tcByFish.get(id)??[];
    for(const spot of byFish.get(id)??[]){const spotId=Number(spot.id),name=places.get(Number(spot.PlaceName));if(!name){continue;}const community=logs.some(l=>l.spot.id===spotId);locations.push({spotId,name,sources:community?['game','teamcraft']:['game'],evidence:community?'corroborated':'game-table',territoryId:Number(spot.TerritoryType)});}
    const unmatched=[];
    for(const entry of entries){const spotId=Number(entry.spot);if(!spotId||locations.some(s=>s.spotId===spotId)){continue;}const spot=gameSpots.get(spotId);
      // IDs >= 10000 are reused virtual/content spots. Never attach old fish to a new spot by ID alone.
      if(spotId>=10000){unmatched.push(spotId);continue;}
      const name=places.get(Number(spot?.PlaceName));if(name)locations.push({spotId,name,sources:['teamcraft'],evidence:'community-record',territoryId:Number(spot.TerritoryType)});
    }
    const baitIds=[...new Set(entries.filter(e=>locations.some(l=>l.spotId===e.spot)).map(e=>e.bait).filter(id=>Number.isSafeInteger(id)&&id>0))],notes=[];
    if(category==='cosmic')notes.push('此条属于宇宙探索任务资源，获取条件由对应任务决定。');
    else if(category==='reconstruction')notes.push('此条属于伊修加德重建资源，未列入普通鱼类图鉴。来源记录可能对应历史阶段，请按物品标注的重建阶段核对获取方式；列出地点不代表当前仍可获取。');
    else if(category==='quest')notes.push('此条是任务用物品，需结合任务进度与指定获取方式。');
    else if(category==='associated-item')notes.push('此条是捕鱼关联物品，单独列示获取资料。');
    else if(category==='collectable')notes.push('此条为可收集的捕鱼收藏品，未列入普通鱼类图鉴；已有世界钓场规则时仍可查看对应鱼窗。');
    else notes.push('游戏表将此条标为图鉴外记录，需结合对应专项内容查看。');
    if(unmatched.length)notes.push('旧来源中的虚拟钓场编号与现行物品列表未能对应，已保留原记录供核查。');
    if(!baitIds.length&&category!=='associated-item')notes.push('公开来源尚未提供可确认的鱼饵或任务触发条件。');
    const first=locations[0],territory=first?.territoryId?territories.get(first.territoryId):null;
    result.set(id,{category,label:labels[category],inFishingLog:false,locations,baitIds,notes,unmatchedSpotIds:[...new Set(unmatched)],zone:places.get(Number(territory?.PlaceName))??labels[category],classificationSources:['game',...(wksItems.has(id)?['WKSItemInfo']:[])],rawSourcePresent:entries.length>0});
  }
  return result;
}
