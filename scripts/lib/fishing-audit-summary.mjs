const names={tracker:'Tracker',fishcake:'鱼糕',teamcraft:'Teamcraft',game:'国服游戏表',cnWiki:'国服中文维基'};
const fieldNames={time:'时间',weather:'天气',previousWeather:'前置天气',shadowSpawn:'鱼影触发数量',predators:'鱼识前置',intuitionDuration:'鱼识持续时间',fishEyes:'鱼眼条件',lureStacks:'诱鱼层数',oceanTime:'海钓时段'};
export function annotateCatalog(catalog,result,snapshot,versions){
  catalog.crossSourceAudit={total:result.total,checked:result.checked,partial:result.partial,conflicts:result.conflicts,singleSource:result.singleSource,fieldsCompared:result.fieldsCompared,resolvedDifferences:result.resolvedDifferences,intuitionRecords:catalog.fish.filter(f=>f.intuitionDuration).length,checkedAt:snapshot.observedAt,sourceVersions:{...versions,fishcake:snapshot.version}};
  for(const record of result.records){
    const fish=catalog.fish.find(f=>f.id===record.id),notes=[];
    if(record.status==='single-source')notes.push('目前仅国服游戏表提供此条身份，社区来源缺少可比较的条件记录。');
    else if(!record.sources.includes('fishcake'))notes.push('鱼糕未收录此条钓场资料，已核对其他来源中可用的身份记录；具体条件仍待补。');
    if(record.fields.some(f=>f.status==='route-dependent'))notes.push('不同泳饵路线对应的准备时间不同，鱼窗按本站列出的推荐路线展示。');
    if(record.fields.some(f=>f.status==='representation-limit'))notes.push('鱼糕记录了多个海钓时段，Teamcraft 的单值字段仅列出其中一个；各来源记录已分别保留。');
    const resolved=record.fields.filter(f=>f.status==='resolved');
    for(const field of resolved.slice(0,2))notes.push(`${fieldNames[field.field]??field.field}采用${field.resolution.sources.map(s=>names[s]??s).join('与')}的共同记录；其他来源的差异保留在核对报告中。`);
    if(record.conflicts.length)notes.push('仍有来源差异：'+record.conflicts.map(f=>fieldNames[f.field]??f.field).join('、')+'；具体条件按来源分别列出。');
    const alias=record.fields.find(f=>f.status==='localization-difference');if(alias){notes.push('国服名称采用游戏表；鱼糕使用另一译名：'+alias.values.fishcake+'。');fish.aliases=[...new Set([...(fish.aliases??[]),alias.values.fishcake])];}
    if(fish.crossSourceCorrections?.fields.includes('time'))notes.push('已按鱼糕与 Teamcraft 修正结束时间至 ET 24:00。');
    if(fish.crossSourceCorrections?.fields.includes('mooch-time'))notes.push('已计入满月沙丁鱼泳饵依赖，推荐路线时间为 ET 18:00–06:00。');
    fish.crossSourceAudit={status:record.status,compared:record.compared,sources:record.sources,notes,sourceLimitedFields:record.fields.filter(f=>f.status==='single-source').length};
  }
}
