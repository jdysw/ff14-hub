import {it,expect} from 'vitest';
import {managedHomeSchema,withMarketModule,withHomeModules} from '@ff14-hub/shared';
it('adds market to display order without rewriting old data or overriding hidden settings',()=>{
  const legacy=empty();
  expect(localDataSchema.parse(legacy).configuration.order).toEqual(legacy.configuration.order);
  expect(withMarketModule(legacy.configuration.order)).toEqual(['events','fishing','pvp','notes','market']);
  const upgraded={...legacy,configuration:{...legacy.configuration,order:['market','notes','pvp','events','fishing'],visible:{...legacy.configuration.visible,market:false}}};
  expect(localDataSchema.parse(upgraded).configuration.visible.market).toBe(false);
  expect(withMarketModule(localDataSchema.parse(upgraded).configuration.order)[0]).toBe('market');
  const oldHome={enabled:{events:true,fishing:true,pvp:false,notes:true},layout:'auto',order:legacy.configuration.order};
  expect(managedHomeSchema.parse(oldHome).enabled.pvp).toBe(false);
  expect(()=>localDataSchema.parse({...upgraded,configuration:{...upgraded.configuration,order:['market','notes','pvp','events','events']}})).toThrow();
});
import {createLocalStore,localDataSchema,localBackupSchema,type LocalData} from '../src/app/local/store';
const empty=():LocalData=>({version:1,revision:0,fish:{cn:[],global:[]},configuration:{order:['events','fishing','pvp','notes'],visible:{events:true,fishing:true,pvp:true,notes:false},region:'cn'},links:[],notes:[]});
it('preserves old orders and explicit weather visibility while completing new home modules',()=>{
  const legacy=empty();
  expect(withHomeModules(legacy.configuration.order)).toEqual(['events','fishing','pvp','notes','market','weather']);
  const config={...legacy.configuration,order:['weather','events','fishing','pvp','notes','market'],visible:{...legacy.configuration.visible,weather:false,market:false}};
  const value=localDataSchema.parse({...legacy,configuration:config});
  expect(withHomeModules(value.configuration.order)[0]).toBe('weather');
  expect(value.configuration.visible.weather).toBe(false);
  expect(managedHomeSchema.parse({enabled:config.visible,order:config.order,layout:'auto'}).enabled.weather).toBe(false);
});
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

it('keeps old personal link backups valid and accepts safe editable descriptions',()=>{
  const id=crypto.randomUUID();
  const legacy={id,title:'原有网站',url:'https://example.org/',category:'常用',favorite:false};
  expect(localDataSchema.parse({...empty(),links:[legacy]}).links[0]?.description).toBeUndefined();
  const enriched={...legacy,description:'网页公开简介',faviconUrl:'https://example.org/favicon.svg'};
  expect(localBackupSchema.parse({format:'ff14-hub-local',version:1,exportedAt:'now',
    data:{...empty(),links:[enriched]}}).data.links[0]?.description).toBe('网页公开简介');
  expect(()=>localDataSchema.parse({...empty(),links:[{...enriched,faviconUrl:'https://other.org/icon.png'}]})).toThrow();
});

it('upgrades existing three-module browser documents and backups without losing order, visibility or fish progress',()=>{
  const legacy=empty();
  const incoming={...legacy,configuration:{...legacy.configuration,order:['notes','fishing','events'],visible:{events:true,fishing:false,notes:true}}};
  const result=localDataSchema.parse(incoming);
  expect(result.configuration.order).toEqual(['notes','fishing','events','pvp']);
  expect(result.configuration.visible).toEqual({events:true,fishing:false,notes:true,pvp:true});
  const restored=localBackupSchema.parse({format:'ff14-hub-local',version:1,exportedAt:'2026-10-21',data:incoming});
  expect(restored.data.configuration.order).toEqual(result.configuration.order);
  expect(restored.data.links).toEqual([]);
  const changed={...result,configuration:{...result.configuration,visible:{...result.configuration.visible,pvp:false}}};
  expect(localDataSchema.parse(changed).configuration.visible.pvp).toBe(false);
  expect(()=>localDataSchema.parse({...legacy,configuration:{...legacy.configuration,unknown:'unsafe'}})).toThrow();
});
