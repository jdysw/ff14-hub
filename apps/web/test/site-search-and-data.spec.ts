import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {searchSite} from '../src/app/local/site-search';
import {localDataSchema,type LocalData} from '../src/app/local/store';
import {mergePersonalData,remoteFailureMessage,RemoteSyncError} from '../src/app/local/remote-sync';
import {fishingCatalogSchema} from '../src/app/fish/catalog';
import type {BrowserLink} from '../src/app/local/directory-links';
const catalog=fishingCatalogSchema.parse(JSON.parse(readFileSync('public/fishing/catalog-cn.json','utf8')) as unknown),base=catalog.fish.find(f=>f.rule)!;
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]});
it('finds a fish by the alternate source spelling while keeping the official CN name',()=>{
  const result=searchSite('泽拉多',[],catalog.fish,[]);expect(result.fish[0]?.id).toBe(43807);expect(result.fish[0]?.name).toBe('泽拉朵');
});
it('searches aliases and bait locally, normalizes width/case, and ranks an exact fish before a partial name',()=>{
  const links=[{id:'1',title:'工具',url:'https://example.com',category:'导航',description:'',tags:['攻略'],aliases:['ＦＦ１４'],favorite:true,personal:true,region:'cn'}] as BrowserLink[];
  const fish=[{...base,name:'涅普特龙之谜',id:2,bait:['极地磷虾']},{...base,name:'涅普特龙',id:3,bait:['极地磷虾']}];
  expect(searchSite('ff14',links,[],[]).links).toHaveLength(1);expect(searchSite('涅普特龙',[],fish,[]).fish[0]?.id).toBe(3);
  expect(searchSite('极地 磷虾',[],fish,[]).fish).toHaveLength(2);expect(searchSite('备份',[],[],[]).features[0]?.id).toBe('backup');
});
it('old note backups remain valid and completed notes survive merge without resetting other personal data',()=>{
  const original={...empty(),notes:[{id:crypto.randomUUID(),title:'周常',text:'备忘'}]};expect(localDataSchema.parse(original).notes[0]?.completed).toBeUndefined();
  const remote={...original,notes:[{...original.notes[0]!,completed:true}]};expect(mergePersonalData(original,original,remote).data.notes[0]?.completed).toBe(true);
});
it('diagnostics distinguish actionable failures and never echo arbitrary exception text',()=>{
  expect(remoteFailureMessage(new RemoteSyncError('auth','账号权限检查失败'))).toBe('账号权限检查失败');
  expect(remoteFailureMessage(new Error('secret-token-must-not-show'))).not.toContain('secret-token');
});
