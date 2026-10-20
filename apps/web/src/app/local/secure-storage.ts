/** Device-only encrypted settings. Keys and ciphertext are never included in personal backups. */
let opening:Promise<IDBDatabase>|undefined;
function open(){return opening??=new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('ff14-hub-device-secrets',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('records');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('本机加密存储不可用'));
});}
export async function readDeviceRecord<T>(id:string):Promise<T|null>{
  const db=await open();
  const get=(key:string)=>new Promise<unknown>((resolve,reject)=>{const r=db.transaction('records').objectStore('records').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('读取本机配置失败'));});
  const record=await get(id) as {iv:Uint8Array;body:ArrayBuffer}|undefined;if(!record)return null;
  const key=await get('key') as CryptoKey|undefined;if(!key)throw new Error('本机密钥缺失，请重新配置');
  try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(record.iv),additionalData:new TextEncoder().encode(id)},key,record.body))) as T;}
  catch{throw new Error('本机配置解密失败，请重新配置');}
}
export async function writeDeviceRecord(id:string,value:unknown):Promise<void>{
  const db=await open();
  const candidate=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const key=await new Promise<CryptoKey>((resolve,reject)=>{
    const tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),r=store.get('key');let result:CryptoKey;
    r.onsuccess=()=>{result=(r.result as CryptoKey|undefined)??candidate;if(!r.result)store.put(result,'key');};
    tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(new Error('保存本机密钥失败'));
  });
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(id)},key,new TextEncoder().encode(JSON.stringify(value)));
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put({iv,body},id);tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(new Error('保存本机配置失败'));});
}
