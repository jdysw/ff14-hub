import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

async function hubRuntime(){
  const listeners=new Map(),messages=[];
  const window={addEventListener:(kind,handler)=>listeners.set(kind,handler),postMessage:(payload,origin)=>messages.push({payload,origin})};
  const context={window,location:{origin:'https://ff14.zhixia.uk'},crypto:{randomUUID:()=> 'test-session'},
    GM_getValue:()=>null,GM_setValue:()=>{},GM_addValueChangeListener:()=>0,GM_removeValueChangeListener:()=>{}};
  vm.runInNewContext(await readFile('apps/web/public/fishcake-sync.user.js','utf8'),context);
  return {window,messages,receive:listeners.get('message')};
}
test('published Hub userscript still accepts an explicit same-window handshake',async()=>{
  const {window,messages,receive}=await hubRuntime();
  receive({source:window,origin:'https://ff14.zhixia.uk',data:{channel:'ff14hub-fishcake',direction:'request',id:'hello-1',action:'hello'}});
  assert.equal(messages.length,1);
  assert.equal(messages[0].origin,'https://ff14.zhixia.uk');
  assert.equal(messages[0].payload.value.installed,true);
  assert.equal(messages[0].payload.id,'hello-1');
});
test('published Hub userscript rejects other windows and foreign message origins',async()=>{
  const {window,messages,receive}=await hubRuntime();
  const data={channel:'ff14hub-fishcake',direction:'request',id:'foreign',action:'hello'};
  receive({source:{},origin:'https://ff14.zhixia.uk',data});
  receive({source:window,origin:'https://foreign.example',data});
  assert.equal(messages.length,0);
});
