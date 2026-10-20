/** Device-only encrypted settings. Personal backups never include keys or credentials. */
interface CipherRecord{iv:Uint8Array;body:ArrayBuffer;revision?:number}
let opening:Promise<IDBDatabase>|undefined;
function open(){return opening??=new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('ff14-hub-device-secrets',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('records');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>{opening=undefined;reject(new Error('本机加密存储不可用'));};
});}
async function readRaw<T>(id:string):Promise<T|undefined>{
  const db=await open();return new Promise((resolve,reject)=>{const r=db.transaction('records').objectStore('records').get(id);r.onsuccess=()=>resolve(r.result as T|undefined);r.onerror=()=>reject(new Error('读取本机配置失败'));});
}
async function storageKey():Promise<CryptoKey>{
  const stored=await readRaw<CryptoKey>('key');if(stored)return stored;
  const candidate=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const db=await open();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),r=store.get('key');let key:CryptoKey;
    r.onsuccess=()=>{key=(r.result as CryptoKey|undefined)??candidate;if(!r.result)store.put(key,'key');};
    tx.oncomplete=()=>resolve(key);tx.onabort=tx.onerror=()=>reject(new Error('保存本机密钥失败'));
  });
}
async function decrypt<T>(id:string,record:CipherRecord):Promise<T>{
  const key=await readRaw<CryptoKey>('key');if(!key)throw new Error('本机密钥缺失，请重新配置');
  try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(record.iv),additionalData:new TextEncoder().encode(id)},key,record.body))) as T;}
  catch{throw new Error('本机配置解密失败，请重新配置');}
}
export async function readDeviceRecord<T>(id:string):Promise<T|null>{
  const record=await readRaw<CipherRecord>(id);return record?decrypt<T>(id,record):null;
}
/**
 * Encrypt outside IDB transactions, then compare the revision and commit in one write transaction.
 * The pure updater may run again after a conflict; it must not perform network calls or side effects.
 * Version-less encrypted records from previous releases are read as revision zero.
 */
export async function updateDeviceRecord<T>(id:string,update:(previous:T|null)=>T|undefined):Promise<T|null>{
  if(id==='key')throw new Error('保留的本机记录名称');
  const db=await open();
  for(let attempt=0;attempt<12;attempt++){
    const previous=await readRaw<CipherRecord>(id),revision=previous?.revision??0;
    const current=previous?await decrypt<T>(id,previous):null,next=update(current);
    if(next===undefined)return current;
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(id)},await storageKey(),new TextEncoder().encode(JSON.stringify(next)));
    const saved=await new Promise<boolean>((resolve,reject)=>{
      const tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),r=store.get(id);let changed=false;
      r.onsuccess=()=>{const live=r.result as CipherRecord|undefined;if((live?.revision??0)!==revision)return;store.put({iv,body,revision:revision+1},id);changed=true;};
      tx.oncomplete=()=>resolve(changed);tx.onabort=tx.onerror=()=>reject(new Error('保存本机配置失败'));
    });
    if(saved)return next;
  }
  throw new Error('其他页面正在更新本机配置，请重试');
}
export async function writeDeviceRecord(id:string,value:unknown):Promise<void>{
  await updateDeviceRecord(id,()=>value);
}
