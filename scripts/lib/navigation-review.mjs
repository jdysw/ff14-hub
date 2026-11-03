/** Replay explicit review decisions when rebuilding the source snapshot. */
export function applyNavigationReview(entries,review){
 const result=new Map(entries.map(entry=>[entry.id,structuredClone(entry)]));
 for(const decision of review.entries){
  const entry=result.get(decision.id);if(!entry)continue;
  if(decision.decision==='merge'){
   const target=result.get(decision.mergedInto);
   if(!target)throw new Error('Reviewed merge target is missing: '+decision.id);
   target.aliases=[...new Set([...target.aliases,entry.title,...entry.aliases])].slice(0,10);
   target.sources.push(...entry.sources.filter(source=>!target.sources.some(old=>old.url===source.url&&old.title===source.title)));
  }
  if(decision.decision==='remove'||decision.decision==='merge'){result.delete(entry.id);continue;}
  if(decision.patch){
   if(decision.patch.title&&decision.patch.title!==entry.title)entry.aliases=[...new Set([...entry.aliases,entry.title])].slice(0,10);
   Object.assign(entry,decision.patch);
  }
 }
 return [...result.values()];
}
