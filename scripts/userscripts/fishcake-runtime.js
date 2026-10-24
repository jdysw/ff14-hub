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
    if(event.source!==window||event.origin!==location.origin||!allowedHub.includes(event.origin)){return;}
    const message=event.data;
    if(message?.channel!=='ff14hub-fishcake'||message.direction!=='request'||typeof message.id!=='string'||message.id.length>100){return;}
    try{
      const binding=get('binding');
      if(message.action==='hello'){emit(message.id,{installed:true,version:1});return;}
      if(message.action==='connect'){
        if(!['cn','global'].includes(message.region)){throw new Error('请选择区服');}
        if(validBinding(binding)&&binding.origin!==location.origin){throw new Error('已连接另一站点，请先在原站点断开');}
        if(!binding||binding.region!==message.region){set('snapshot',null);set('command',null);}
        set('binding',{origin:location.origin,region:message.region});emit(message.id,{connected:true});return;
      }
      if(!validBinding(binding)||binding.origin!==location.origin||binding.region!==message.region){throw new Error('请先连接所选区服');}
      if(message.action==='disconnect'){set('binding',null);set('snapshot',null);set('command',null);emit(message.id,{disconnected:true});return;}
      if(message.action==='read'){emit(message.id,get('snapshot'));return;}
      if(message.action==='apply'){
        const snapshot=get('snapshot');
        if(!snapshot||Date.now()-snapshot.at>20000||snapshot.region!==binding.region){throw new Error('鱼糕页面未在线，请打开鱼糕');}
        fishcakeDocument(message.document);fishcakeDocument(message.expected);
        if(JSON.stringify(message).length>1048576){throw new Error('进度过大');}
        const timer=setTimeout(()=>{GM_removeValueChangeListener(listener);emit(message.id,null,'鱼糕未确认写入，请重新读取');},15000);
        const listener=watch('reply',reply=>{if(reply?.id!==message.id){return;}clearTimeout(timer);GM_removeValueChangeListener(listener);emit(message.id,reply.document,reply.error);});
        set('command',{id:message.id,session:snapshot.session,region:binding.region,expires:Date.now()+12000,expected:message.expected,document:message.document});return;
      }
      throw new Error('不支持的互通操作');
    }catch(error){emit(message.id,null,error.message||'互通失败');}
  });
}else{
  // A single fish page owns the adapter; other fish tabs remain passive.
  navigator.locks.request('ff14hub-fishcake-adapter',async lock=>{
    if(!lock){return;}
    let ready=false,error=null;
    const binding=()=>get('binding');
    const send=(action,value)=>window.postMessage({channel:'ff14hub-fishcake-page',nonce:pageNonce,action,...value},location.origin);
    const start=()=>{
      if(ready||!validBinding(binding())){return;}
      send('read',{});
    };
    window.addEventListener('message',event=>{
      const m=event.data;if(event.source!==window||event.origin!==location.origin||m?.channel!=='ff14hub-fishcake-page'||m.nonce!==pageNonce||m.action!=='state'){return;}
      const b=binding();if(!validBinding(b)){return;}
      ready=true;error=m.error??null;
      set('snapshot',{session:pageNonce,region:b.region,at:Date.now(),document:m.document??null,error});
      if(m.id){set('reply',{id:m.id,document:m.document,error});}
    });
    watch('binding',()=>{ready=false;start();});
    watch('command',command=>{
      const b=binding();
      if(!validBinding(b)||!command||command.region!==b.region||command.session!==pageNonce||command.expires<Date.now()){return;}
      // Before-images remain in userscript storage, separate from exports or the Hub server.
      set('backup',{at:Date.now(),region:b.region,document:get('snapshot')?.document});
      send('apply',{id:command.id,expires:command.expires,expected:command.expected,document:command.document});
    });
    const injected=document.createElement('script');injected.type='module';
    injected.textContent=`${PAGE_ADAPTER_SOURCE}\nstartPageAdapter(${JSON.stringify(pageNonce)});`;
    (document.head||document.documentElement).append(injected);injected.remove();
    setInterval(()=>{
      const b=binding();if(!validBinding(b)){return;}
      if(!ready||error){start();return;}
      send('read',{});
    },5000);
    start();
    await new Promise(()=>{});
  }).catch(()=>{});
}
