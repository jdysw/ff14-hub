async function startPageAdapter(nonce){
  let adapter;
  const publish=(id,error)=>{
    try{window.postMessage({channel:'ff14hub-fishcake-page',nonce,action:'state',id,document:error?null:adapter.read(),error},location.origin);}
    catch(cause){window.postMessage({channel:'ff14hub-fishcake-page',nonce,action:'state',id,error:cause.message},location.origin);}
  };
  let loading;
  const ensure=async()=>{
    if(!adapter){loading??=loadFishcakeAdapter(document,localStorage).catch(cause=>{loading=null;throw cause;});adapter=await loading;if(!adapter._hubSubscribed){adapter._hubSubscribed=true;adapter.subscribe(()=>publish());}}
  };
  window.addEventListener('message',event=>{
    const m=event.data;
    if(event.source!==window||event.origin!==location.origin||m?.channel!=='ff14hub-fishcake-page'||m.nonce!==nonce||!['read','apply'].includes(m.action))return;
    void (async()=>{
      try{await ensure();if(m.action==='apply'){if(!Number.isFinite(m.expires)||m.expires<Date.now())throw new Error('同步请求已过期，请重新读取');adapter.apply(m.expected,m.document);}publish(m.id);}
      catch(cause){publish(m.id,cause.message||'鱼糕适配失败');}
    })();
  });
}
