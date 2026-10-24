// Original interoperability adapter. Audited Fishcake releases: 803987e and 9e1f21f.
export function fishcakeDocument(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('进度格式不正确');
  const output={};
  for(const key of ['completed','pinned','alarmFish']){
    const list=raw[key];
    if(!Array.isArray(list)||list.length>5000||list.some(n=>!Number.isSafeInteger(n)||n<=0))throw new Error('进度 ID 格式不正确');
    output[key]=[...new Set(list)].sort((a,b)=>a-b);
  }
  return output;
}
export function fishcakeFingerprint(raw){return JSON.stringify(fishcakeDocument(raw));}
export function createFishcakeAdapter(store,model,storage){
  const idsToSpots=ids=>ids.flatMap(id=>{
    const spots=model.getSpotFishesByFishId(id).filter(f=>!f.isEmpty&&f.itemId===id);
    if(!spots.length)throw new Error(`鱼糕尚不支持提醒鱼类 ${id}，未写入`);
    return spots.map(f=>f.id);
  });
  const spotsToIds=spots=>spots.map(spot=>{
    const fish=model.getSpotFish(spot);
    if(!fish||fish.isEmpty||!Number.isSafeInteger(fish.itemId)||fish.itemId<=0)throw new Error('鱼糕提醒 ID 无法转换，已停止同步');
    return fish.itemId;
  });
  const read=()=>{
    const state=store.getState().fishing;
    if(!state||!Array.isArray(state.alarmFish))throw new Error('鱼糕状态结构已改变');
    const text=storage.getItem('userData');const legacy=text?JSON.parse(text):null;
    const old=key=>legacy&&!legacy.syncedKey?.includes(key);
    return fishcakeDocument({completed:old('completed')?legacy.completed??[]:state.completedFish,
      pinned:old('pinned')?legacy.pinned??[]:state.pinnedFish,
      alarmFish:old('toBeNotified')?legacy.toBeNotified??[]:spotsToIds(state.alarmFish)});
  };
  return {read,subscribe:listener=>store.subscribe(listener),apply(expected,next){
    if(fishcakeFingerprint(read())!==fishcakeFingerprint(expected))throw new Error('鱼糕进度已变化，请重新预览');
    const target=fishcakeDocument(next),current=store.getState().fishing;
    // Keep a user's chosen spot when an existing alarm remains enabled.
    const kept=current.alarmFish.filter(spot=>target.alarmFish.includes(spotsToIds([spot])[0]));
    const keptIds=new Set(spotsToIds(kept));
    const alarms=[...kept,...idsToSpots(target.alarmFish.filter(id=>!keptIds.has(id)))];
    store.dispatch({type:'fishing/importSettings',payload:{completedFish:target.completed,pinnedFish:target.pinned,alarmFish:alarms}});
    if(fishcakeFingerprint(read())!==fishcakeFingerprint(target))throw new Error('鱼糕未确认写入，请重新读取');
    return read();
  }};
}
export function findFishcakeStore(root){
  const key=Object.keys(root??{}).find(k=>k.startsWith('__reactContainer$'));
  const stack=[root?.[key]],seen=new Set();
  while(stack.length&&seen.size<15000){
    const node=stack.pop();if(!node||seen.has(node)){continue;}seen.add(node);
    const store=node.memoizedProps?.store??node.memoizedProps?.value?.store;
    if(typeof store?.getState==='function'&&typeof store.dispatch==='function'&&typeof store.subscribe==='function'&&store.getState().fishing){return store;}
    stack.push(node.child,node.sibling,node.alternate);
  }
  throw new Error('鱼糕尚未加载或状态接口已改变');
}
export async function loadFishcakeAdapter(doc,storage){
  const version=doc.querySelector('meta[name=version]')?.content;
  if(!['803987e','9e1f21f'].includes(version))throw new Error('鱼糕版本已更新，请更新互通脚本后重试');
  const script=[...doc.scripts].find(s=>s.type==='module'&&new URL(s.src).origin===location.origin&&/\/assets\/index-[\w-]+\.js$/.test(new URL(s.src).pathname));
  if(!script)throw new Error('鱼糕应用尚未加载');
  const exports=await import(script.src);
  const model=Object.values(exports).find(m=>m&&typeof m.getSpotFishesByFishId==='function'&&typeof m.getSpotFish==='function');
  if(!model)throw new Error('鱼糕鱼类 ID 转换接口已改变');
  const adapter=createFishcakeAdapter(findFishcakeStore(doc.getElementById('root')),model,storage);
  // Fishcake's Redux persist store does not rehydrate other open tabs.
  // Never overwrite a selection made in another native Fishcake tab.
  let externalChange=false;
  window.addEventListener('storage',event=>{if(event.storageArea===storage&&['persist:fishing','userData'].includes(event.key))externalChange=true;});
  const assertCurrent=()=>{if(externalChange)throw new Error('另一个鱼糕标签页更新了进度，请只保留一个鱼糕页面并刷新后重试');};
  return {...adapter,read(){assertCurrent();return adapter.read();},apply(expected,next){assertCurrent();return adapter.apply(expected,next);}};
}
