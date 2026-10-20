import {localNotificationChannelSchema,type LocalNotificationChannel} from '@ff14-hub/shared';
import type {Env} from '../../env';
import {createPushTransport} from './push';
const enc=new TextEncoder();
async function key(secret:string){if(secret.length<32)throw new Error('notification_encryption_unavailable');return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode('ff14.notification-channel.v1:'+secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
const b64=(value:Uint8Array)=>btoa(Array.from(value,b=>String.fromCharCode(b)).join(''));
export async function encryptChannel(channel:LocalNotificationChannel,secret:string,id:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(id)},await key(secret),enc.encode(JSON.stringify(channel)));
  return b64(iv)+'.'+b64(new Uint8Array(encrypted));
}
export async function decryptChannel(ciphertext:string,secret:string,id:string){
  const [iv,body]=ciphertext.split('.');if(!iv||!body)throw new Error('notification_channel_unavailable');
  const bytes=(raw:string)=>Uint8Array.from(atob(raw),char=>char.charCodeAt(0));
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:enc.encode(id)},await key(secret),bytes(body));
  return localNotificationChannelSchema.parse(JSON.parse(new TextDecoder().decode(plain)) as unknown);
}
export async function sendChannel(env:Env,channel:LocalNotificationChannel,tag:string,content:{title:string;body:string}):Promise<number>{
  if(channel.kind==='webpush')return (await createPushTransport(env).send(channel.subscription,tag,{title:content.title,body:content.body.slice(0,200)})).status;
  const title=content.title.replace(/[\r\n]/g,' ').slice(0,80);
  const response=channel.kind==='serverchan'?
    await fetch('https://sctapi.ftqq.com/'+channel.sendKey+'.send',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({title,desp:content.body}),redirect:'manual',signal:AbortSignal.timeout(8000)}):
    await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+channel.apiKey,'Content-Type':'application/json','Idempotency-Key':tag},body:JSON.stringify({from:channel.from,to:[channel.to],subject:title,text:content.body}),redirect:'manual',signal:AbortSignal.timeout(8000)});
  if(!response.ok){await response.body?.cancel();return response.status>=300&&response.status<400?400:response.status;}
  const reader=response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>|undefined;let text='',size=0;const decoder=new TextDecoder();
  if(reader){while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8192){await reader.cancel();return 400;}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
  try{const value=JSON.parse(text) as {code?:number;id?:string};return channel.kind==='serverchan'?(value.code===0?200:400):(typeof value.id==='string'?200:400);}catch{return 400;}
}
