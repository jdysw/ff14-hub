import {it,expect} from 'vitest';
import {createLocalStore,localDataSchema,localBackupSchema,type LocalData} from '../src/app/local/store';
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','notes'],visible:{events:true,fishing:true,notes:false},region:'cn'},links:[],notes:[]});
it('rejects identity credentials and unknown configuration keys in personal backups',()=>{
  expect(()=>localBackupSchema.parse({format:'ff14-hub-local',version:1,exportedAt:'now',data:{...empty(),deviceToken:'must-not-be-imported'}})).toThrow();
  expect(()=>localDataSchema.parse({...empty(),configuration:{...empty().configuration,workspaceId:'unused'}})).toThrow();
});
it('rejects cross-region and duplicate progress fields',()=>{
  const field={region:'cn',fishId:7678,field:'caught',value:true,revision:1,updatedAt:1};
  expect(()=>localDataSchema.parse({...empty(),fish:{cn:[field,field],global:[]}})).toThrow();
  expect(()=>localDataSchema.parse({...empty(),fish:{cn:[],global:[field]}})).toThrow();
});
it('rejects executable and credential-bearing navigation URLs before restore',()=>{
  for(const url of ['javascript:alert(1)','https://name:password@example.com']){
    expect(()=>localDataSchema.parse({...empty(),links:[{id:crypto.randomUUID(),title:'test',url,category:'test',favorite:false}]})).toThrow();
  }
});
it('reports unavailable storage instead of using a nonpersistent in-memory fallback',async()=>{
  const store=createLocalStore(()=>{throw new Error('disabled');});
  await expect(store.read()).rejects.toThrow('浏览器不支持本地存储');
});
