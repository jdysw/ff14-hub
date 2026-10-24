// ==UserScript==
// @name         FF14 Hub · 鱼糕实时互通
// @namespace    https://ff14.zhixia.uk/
// @version      1.0.1
// @description  在当前浏览器中双向同步钓获、收藏和提醒；首次预览后启用。
// @match        https://fish.ffmomola.com/*
// @match        https://ff14.zhixia.uk/*
// @match        https://ff14-preview.zhixia.uk/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// @updateURL    https://ff14.zhixia.uk/fishcake-sync.user.js
// @downloadURL  https://ff14.zhixia.uk/fishcake-sync.user.js
// ==/UserScript==

(()=>{'use strict';
// Original interoperability adapter. Audited Fishcake releases: 803987e and 9e1f21f.
function fishcakeDocument(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('进度格式不正确');
  const output={};
  for(const key of ['completed','pinned','alarmFish']){
    const list=raw[key];
    if(!Array.isArray(list)||list.length>5000||list.some(n=>!Number.isSafeInteger(n)||n<=0))throw new Error('进度 ID 格式不正确');
    output[key]=[...new Set(list)].sort((a,b)=>a-b);
  }
  return output;
}
function fishcakeFingerprint(raw){return JSON.stringify(fishcakeDocument(raw));}
function createFishcakeAdapter(store,model,storage){
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
function findFishcakeStore(root){
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
async function loadFishcakeAdapter(doc,storage){
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

const PAGE_ADAPTER_SOURCE="// Original interoperability adapter. Audited Fishcake releases: 803987e and 9e1f21f.\nfunction fishcakeDocument(raw){\n  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('进度格式不正确');\n  const output={};\n  for(const key of ['completed','pinned','alarmFish']){\n    const list=raw[key];\n    if(!Array.isArray(list)||list.length>5000||list.some(n=>!Number.isSafeInteger(n)||n<=0))throw new Error('进度 ID 格式不正确');\n    output[key]=[...new Set(list)].sort((a,b)=>a-b);\n  }\n  return output;\n}\nfunction fishcakeFingerprint(raw){return JSON.stringify(fishcakeDocument(raw));}\nfunction createFishcakeAdapter(store,model,storage){\n  const idsToSpots=ids=>ids.flatMap(id=>{\n    const spots=model.getSpotFishesByFishId(id).filter(f=>!f.isEmpty&&f.itemId===id);\n    if(!spots.length)throw new Error(`鱼糕尚不支持提醒鱼类 ${id}，未写入`);\n    return spots.map(f=>f.id);\n  });\n  const spotsToIds=spots=>spots.map(spot=>{\n    const fish=model.getSpotFish(spot);\n    if(!fish||fish.isEmpty||!Number.isSafeInteger(fish.itemId)||fish.itemId<=0)throw new Error('鱼糕提醒 ID 无法转换，已停止同步');\n    return fish.itemId;\n  });\n  const read=()=>{\n    const state=store.getState().fishing;\n    if(!state||!Array.isArray(state.alarmFish))throw new Error('鱼糕状态结构已改变');\n    const text=storage.getItem('userData');const legacy=text?JSON.parse(text):null;\n    const old=key=>legacy&&!legacy.syncedKey?.includes(key);\n    return fishcakeDocument({completed:old('completed')?legacy.completed??[]:state.completedFish,\n      pinned:old('pinned')?legacy.pinned??[]:state.pinnedFish,\n      alarmFish:old('toBeNotified')?legacy.toBeNotified??[]:spotsToIds(state.alarmFish)});\n  };\n  return {read,subscribe:listener=>store.subscribe(listener),apply(expected,next){\n    if(fishcakeFingerprint(read())!==fishcakeFingerprint(expected))throw new Error('鱼糕进度已变化，请重新预览');\n    const target=fishcakeDocument(next),current=store.getState().fishing;\n    // Keep a user's chosen spot when an existing alarm remains enabled.\n    const kept=current.alarmFish.filter(spot=>target.alarmFish.includes(spotsToIds([spot])[0]));\n    const keptIds=new Set(spotsToIds(kept));\n    const alarms=[...kept,...idsToSpots(target.alarmFish.filter(id=>!keptIds.has(id)))];\n    store.dispatch({type:'fishing/importSettings',payload:{completedFish:target.completed,pinnedFish:target.pinned,alarmFish:alarms}});\n    if(fishcakeFingerprint(read())!==fishcakeFingerprint(target))throw new Error('鱼糕未确认写入，请重新读取');\n    return read();\n  }};\n}\nfunction findFishcakeStore(root){\n  const key=Object.keys(root??{}).find(k=>k.startsWith('__reactContainer$'));\n  const stack=[root?.[key]],seen=new Set();\n  while(stack.length&&seen.size<15000){\n    const node=stack.pop();if(!node||seen.has(node)){continue;}seen.add(node);\n    const store=node.memoizedProps?.store??node.memoizedProps?.value?.store;\n    if(typeof store?.getState==='function'&&typeof store.dispatch==='function'&&typeof store.subscribe==='function'&&store.getState().fishing){return store;}\n    stack.push(node.child,node.sibling,node.alternate);\n  }\n  throw new Error('鱼糕尚未加载或状态接口已改变');\n}\nasync function loadFishcakeAdapter(doc,storage){\n  const version=doc.querySelector('meta[name=version]')?.content;\n  if(!['803987e','9e1f21f'].includes(version))throw new Error('鱼糕版本已更新，请更新互通脚本后重试');\n  const script=[...doc.scripts].find(s=>s.type==='module'&&new URL(s.src).origin===location.origin&&/\\/assets\\/index-[\\w-]+\\.js$/.test(new URL(s.src).pathname));\n  if(!script)throw new Error('鱼糕应用尚未加载');\n  const exports=await import(script.src);\n  const model=Object.values(exports).find(m=>m&&typeof m.getSpotFishesByFishId==='function'&&typeof m.getSpotFish==='function');\n  if(!model)throw new Error('鱼糕鱼类 ID 转换接口已改变');\n  const adapter=createFishcakeAdapter(findFishcakeStore(doc.getElementById('root')),model,storage);\n  // Fishcake's Redux persist store does not rehydrate other open tabs.\n  // Never overwrite a selection made in another native Fishcake tab.\n  let externalChange=false;\n  window.addEventListener('storage',event=>{if(event.storageArea===storage&&['persist:fishing','userData'].includes(event.key))externalChange=true;});\n  const assertCurrent=()=>{if(externalChange)throw new Error('另一个鱼糕标签页更新了进度，请只保留一个鱼糕页面并刷新后重试');};\n  return {...adapter,read(){assertCurrent();return adapter.read();},apply(expected,next){assertCurrent();return adapter.apply(expected,next);}};\n}\n\nasync function startPageAdapter(nonce){\n  let adapter;\n  let lastFingerprint;\n  const publish=(id,error,force=false)=>{\n    try{\n      const current=error?null:adapter.read(),fingerprint=JSON.stringify({current,error});\n      // Native countdown/filter actions are unrelated to personal progress.\n      if(!force&&!id&&lastFingerprint===fingerprint)return;\n      lastFingerprint=fingerprint;\n      window.postMessage({channel:'ff14hub-fishcake-page',nonce,action:'state',id,document:current,error},location.origin);\n    }\n    catch(cause){window.postMessage({channel:'ff14hub-fishcake-page',nonce,action:'state',id,error:cause.message},location.origin);}\n  };\n  let loading;\n  const ensure=async()=>{\n    if(!adapter){loading??=loadFishcakeAdapter(document,localStorage).catch(cause=>{loading=null;throw cause;});adapter=await loading;if(!adapter._hubSubscribed){adapter._hubSubscribed=true;adapter.subscribe(()=>publish());}}\n  };\n  window.addEventListener('message',event=>{\n    const m=event.data;\n    if(event.source!==window||event.origin!==location.origin||m?.channel!=='ff14hub-fishcake-page'||m.nonce!==nonce||!['read','apply'].includes(m.action))return;\n    void (async()=>{\n      try{await ensure();if(m.action==='apply'){if(!Number.isFinite(m.expires)||m.expires<Date.now())throw new Error('同步请求已过期，请重新读取');adapter.apply(m.expected,m.document);}publish(m.id,undefined,true);}\n      catch(cause){publish(m.id,cause.message||'鱼糕适配失败');}\n    })();\n  });\n}\n";
/* Runs in the userscript manager, with a separate page-realm adapter. */
const allowedHub=['https://ff14.zhixia.uk','https://ff14-preview.zhixia.uk'];
const isFish=location.origin==='https://fish.ffmomola.com';
const prefix='ff14hub-fishcake-v1:';
const get=key=>GM_getValue(prefix+key,null);
const set=(key,value)=>GM_setValue(prefix+key,value);
const watch=(key,callback)=>GM_addValueChangeListener(prefix+key,(_name,_before,next)=>callback(next));
const uuid=()=>crypto.randomUUID();
const validBinding=b=>b&&['cn','global'].includes(b.region)&&allowedHub.includes(b.origin);
const pageNonce=uuid();
const emit=(id,value,error)=>window.postMessage({channel:'ff14hub-fishcake',direction:'response',id,value,error},location.origin);
if(!isFish){
  window.addEventListener('message',async event=>{
    if(event.source!==window||event.origin!==location.origin||!allowedHub.includes(event.origin))return;
    const message=event.data;
    if(message?.channel!=='ff14hub-fishcake'||message.direction!=='request'||typeof message.id!=='string'||message.id.length>100)return;
    try{
      const binding=get('binding');
      if(message.action==='hello'){emit(message.id,{installed:true,version:1});return;}
      if(message.action==='connect'){
        if(!['cn','global'].includes(message.region))throw new Error('请选择区服');
        if(validBinding(binding)&&binding.origin!==location.origin)throw new Error('已连接另一站点，请先在原站点断开');
        if(!binding||binding.region!==message.region){set('snapshot',null);set('command',null);}
        set('binding',{origin:location.origin,region:message.region});emit(message.id,{connected:true});return;
      }
      if(!validBinding(binding)||binding.origin!==location.origin||binding.region!==message.region)throw new Error('请先连接所选区服');
      if(message.action==='disconnect'){set('binding',null);set('snapshot',null);set('command',null);emit(message.id,{disconnected:true});return;}
      if(message.action==='read'){emit(message.id,get('snapshot'));return;}
      if(message.action==='apply'){
        const snapshot=get('snapshot');
        if(!snapshot||Date.now()-snapshot.at>20000||snapshot.region!==binding.region)throw new Error('鱼糕页面未在线，请打开鱼糕');
        fishcakeDocument(message.document);fishcakeDocument(message.expected);
        if(JSON.stringify(message).length>1048576)throw new Error('进度过大');
        const timer=setTimeout(()=>{GM_removeValueChangeListener(listener);emit(message.id,null,'鱼糕未确认写入，请重新读取');},15000);
        const listener=watch('reply',reply=>{if(reply?.id!==message.id)return;clearTimeout(timer);GM_removeValueChangeListener(listener);emit(message.id,reply.document,reply.error);});
        set('command',{id:message.id,session:snapshot.session,region:binding.region,expires:Date.now()+12000,expected:message.expected,document:message.document});return;
      }
      throw new Error('不支持的互通操作');
    }catch(error){emit(message.id,null,error.message||'互通失败');}
  });
}else{
  // A single fish page owns the adapter; other fish tabs remain passive.
  navigator.locks.request('ff14hub-fishcake-adapter',async lock=>{
    if(!lock)return;
    let ready=false,error=null;
    const binding=()=>get('binding');
    const send=(action,value)=>window.postMessage({channel:'ff14hub-fishcake-page',nonce:pageNonce,action,...value},location.origin);
    const start=()=>{
      if(ready||!validBinding(binding()))return;
      send('read',{});
    };
    window.addEventListener('message',event=>{
      const m=event.data;if(event.source!==window||event.origin!==location.origin||m?.channel!=='ff14hub-fishcake-page'||m.nonce!==pageNonce||m.action!=='state')return;
      const b=binding();if(!validBinding(b))return;
      ready=true;error=m.error??null;
      set('snapshot',{session:pageNonce,region:b.region,at:Date.now(),document:m.document??null,error});
      if(m.id)set('reply',{id:m.id,document:m.document,error});
    });
    watch('binding',()=>{ready=false;start();});
    watch('command',command=>{
      const b=binding();
      if(!validBinding(b)||!command||command.region!==b.region||command.session!==pageNonce||command.expires<Date.now())return;
      // Before-images remain in userscript storage, separate from exports or the Hub server.
      set('backup',{at:Date.now(),region:b.region,document:get('snapshot')?.document});
      send('apply',{id:command.id,expires:command.expires,expected:command.expected,document:command.document});
    });
    const injected=document.createElement('script');injected.type='module';
    injected.textContent=`${PAGE_ADAPTER_SOURCE}\nstartPageAdapter(${JSON.stringify(pageNonce)});`;
    (document.head||document.documentElement).append(injected);injected.remove();
    setInterval(()=>{
      const b=binding();if(!validBinding(b))return;
      if(!ready||error){start();return;}
      send('read',{});
    },5000);
    start();
    await new Promise(()=>{});
  }).catch(()=>{});
}

})();
