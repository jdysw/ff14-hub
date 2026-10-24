import {z} from 'zod';
import {fishProgressSchema,parseFishDocument,fieldsToDocument,validateNavUrl,type FishDocument,type FishProgress,type FishRegion,type FishProgressWrite} from '@ff14-hub/shared';
export const sectionSchema=z.enum(['events','fishing','pvp','notes']);
export type HomeSection=z.infer<typeof sectionSchema>;
export const localLinkSchema=z.object({
  id:z.uuid(),title:z.string().min(1).max(100),
  url:z.string().refine(url=>validateNavUrl(url).ok,'请使用有效的 HTTPS 地址'),
  category:z.string().max(60),favorite:z.boolean(),
  categoryCustomized:z.boolean().optional(),
  // optional 保留旧版浏览器数据和备份的兼容性；介绍由用户自行编辑或主动获取。
  description:z.string().max(240).optional(),
  faviconUrl:z.string().url().startsWith('https://').max(700).optional(),
}).strict().superRefine((link,ctx)=>{
  if(link.faviconUrl){
    try{
      if(new URL(link.faviconUrl).origin!==new URL(link.url).origin)
        ctx.addIssue({code:'custom',message:'图标必须来自网站自身域名',path:['faviconUrl']});
    }catch{ctx.addIssue({code:'custom',message:'图标地址无效',path:['faviconUrl']});}
  }
});
/**
 * 增加 PVP 首页模块时自动迁移旧版三模块数据和个人备份。
 * 保留旧的可见性及排序，不创建新账号、不清空 IndexedDB。
 * 已经拥有 PVP 配置时原样校验，避免覆盖用户的隐藏设置。
 */
const configurationSchema=z.preprocess(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const record=value as Record<string,unknown>;
  if(!Array.isArray(record['order'])||record['order'].length!==3)return value;
  const order:readonly unknown[]=record['order'];
  const old=new Set(order);
  if(old.size!==3||!['events','fishing','notes'].every(x=>old.has(x)))return value;
  const visible=record['visible'];
  if(!visible||typeof visible!=='object'||Array.isArray(visible))return value;
  return {...record,order:[...order,'pvp'],visible:{...visible,pvp:true}};
},z.object({
  order:z.array(sectionSchema).length(4).refine(v=>new Set(v).size===4),
  visible:z.object({events:z.boolean(),fishing:z.boolean(),pvp:z.boolean(),notes:z.boolean()}).strict(),
  region:z.enum(['cn','global']),
  orderCustomized:z.boolean().optional(),
}).strict());
export const localDataSchema=z.object({version:z.literal(1),revision:z.number().int().nonnegative(),fish:z.object({cn:z.array(fishProgressSchema).max(15000),global:z.array(fishProgressSchema).max(15000)}).strict(),configuration:configurationSchema,links:z.array(localLinkSchema).max(2000),notes:z.array(z.object({id:z.uuid(),title:z.string().trim().min(1).max(100),text:z.string().max(10000),completed:z.boolean().optional(),startsAt:z.number().int().nonnegative().optional(),endsAt:z.number().int().nonnegative().optional(),remindAt:z.number().int().nonnegative().optional()}).strict().refine(note=>note.startsAt===undefined||note.endsAt===undefined||note.endsAt>note.startsAt,'截止时间必须晚于开始时间')).max(100)}).strict()
  .refine(data=>['cn','global'].every(region=>{const fields=data.fish[region as FishRegion];return fields.every(f=>f.region===region)&&new Set(fields.map(f=>`${f.fishId}:${f.field}`)).size===fields.length;})&&new Set(data.links.map(link=>link.id)).size===data.links.length,'备份含重复或区服不一致的数据');
export type LocalData=z.infer<typeof localDataSchema>;
export const localBackupSchema=z.object({format:z.literal('ff14-hub-local'),version:z.literal(1),exportedAt:z.string(),data:localDataSchema}).strict();
const databaseSchema=z.object({data:localDataSchema,operations:z.array(z.object({id:z.string(),fingerprint:z.string(),result:fishProgressSchema})).max(200)});
type DatabaseDocument=z.infer<typeof databaseSchema>;
const initial=():DatabaseDocument=>({data:{version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]},operations:[]});

/** Each mutation is one IDB read/write transaction, serialized across tabs. */
export function createLocalStore(factory:()=>IDBFactory=()=>indexedDB,name='ff14-hub-personal-v1'){
  let database:Promise<IDBDatabase>|undefined;
  const listeners=new Set<()=>void>();
  let channel:BroadcastChannel|null=null;
  const notify=()=>{for(const listener of listeners)listener();};
  const open=()=>database??=new Promise<IDBDatabase>((resolve,reject)=>{
    try{
      const request=factory().open(name,1);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('documents'))request.result.createObjectStore('documents');};
      request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
      request.onerror=()=>reject(new Error('浏览器本地存储无法打开，请检查站点存储权限。'));
      request.onblocked=()=>reject(new Error('其他页面正在升级数据，请关闭其他标签页后重试。'));
    }catch{reject(new Error('浏览器不支持本地存储，请使用允许站点存储的浏览器。'));}
  });
  async function read():Promise<LocalData>{
    const db=await open();return new Promise((resolve,reject)=>{
      const request=db.transaction('documents','readonly').objectStore('documents').get('personal');
      request.onsuccess=()=>{try{resolve(databaseSchema.parse(request.result??initial()).data);}catch{reject(new Error('本机数据格式异常，请先导出备份，不要清理站点数据。'));}};
      request.onerror=()=>reject(new Error('读取本机数据失败，请重试。'));
    });
  }
  async function change<T>(mutate:(document:DatabaseDocument)=>T):Promise<T>{
    const db=await open();return new Promise<T>((resolve,reject)=>{
      const transaction=db.transaction('documents','readwrite');let result:T;let failure:unknown;
      const store=transaction.objectStore('documents'),request=store.get('personal');
      request.onsuccess=()=>{
        try{const document=databaseSchema.parse(request.result??initial());const revision=document.data.revision;
          result=mutate(document);document.data.revision=revision+1;databaseSchema.parse(document);store.put(document,'personal');
        }catch(error){failure=error;transaction.abort();}
      };
      transaction.oncomplete=()=>{notify();channel?.postMessage('changed');resolve(result);};
      transaction.onabort=transaction.onerror=()=>reject(failure instanceof Error?failure:new Error('本机保存失败，可能已达到存储上限；原有数据仍保留，请导出备份。'));
    });
  }
  async function mergeFish(text:string,region:FishRegion,includePreferences=false):Promise<number>{
    const imported=parseFishDocument(text.replace(/^\uFEFF/,''));
    return change(document=>{
      const fields=document.data.fish[region];let added=0;
      for(const [set,field] of [['completed','caught'],['pinned','pinned'],['alarmFish','alarm']] as const){
        if(set!=='completed'&&!includePreferences)continue;
        for(const fishId of new Set(imported[set])){const existing=fields.find(f=>f.fishId===fishId&&f.field===field);
          if(existing?.value)continue;
          if(existing){existing.value=true;existing.revision++;existing.updatedAt=Date.now();}
          else fields.push({region,fishId,field,value:true,revision:1,updatedAt:Date.now()});added++;
        }
      }return added;
    });
  }
  return {read,change,mergeFish,subscribe(listener:()=>void){
      listeners.add(listener);
      if(!channel&&typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel(name);channel.onmessage=notify;}
      return()=>{listeners.delete(listener);if(listeners.size===0){channel?.close();channel=null;}};
    },
    async exportFish(region:FishRegion):Promise<FishDocument>{return fieldsToDocument((await read()).fish[region]);},
    async exportBackup(){return localBackupSchema.parse({format:'ff14-hub-local',version:1,exportedAt:new Date().toISOString(),data:await read()});},
    async restoreBackup(raw:unknown){const backup=localBackupSchema.parse(raw);await change(document=>{
      for(const region of ['cn','global'] as const)for(const previous of document.data.fish[region]){
        const restored=backup.data.fish[region].find(field=>field.fishId===previous.fishId&&field.field===previous.field);
        if(restored){restored.revision=Math.max(restored.revision,previous.revision)+1;restored.updatedAt=Date.now();}
        else backup.data.fish[region].push({...previous,value:false,revision:previous.revision+1,updatedAt:Date.now()});
      }
      document.data=backup.data;document.operations=[];
    });},
    async saveProgress(input:FishProgressWrite):Promise<FishProgress>{return change(document=>{
      const fingerprint=JSON.stringify(input),old=document.operations.find(op=>op.id===input.operationId);
      if(old){if(old.fingerprint!==fingerprint)throw new Error('重复操作内容不一致');return old.result;}
      const fields=document.data.fish[input.region];let field=fields.find(f=>f.fishId===input.fishId&&f.field===input.field);
      if((field?.revision??0)!==input.expectedRevision)throw new Error('另一个标签页已更新此标记，请重新读取后再试。');
      if(field){field.value=input.value;field.revision++;field.updatedAt=Date.now();}
      else{field={region:input.region,fishId:input.fishId,field:input.field,value:input.value,revision:1,updatedAt:Date.now()};fields.push(field);}
      document.operations.push({id:input.operationId,fingerprint,result:{...field}});document.operations=document.operations.slice(-200);return {...field};
    });},
  };
}
export type LocalStore=ReturnType<typeof createLocalStore>;
