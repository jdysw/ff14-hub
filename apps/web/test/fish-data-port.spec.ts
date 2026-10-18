import { afterEach,it,expect,vi } from 'vitest';
import { FISH_MODULE_ID } from '@ff14-hub/shared';
import { createModuleDataPort } from '../src/app/widgets/module-data-ports';
afterEach(()=>vi.unstubAllGlobals());
it('uses fixed paths with bearer credentials, validates responses and keeps private requests uncached',async()=>{
  const urls:string[]=[];
  vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit)=>{
    urls.push(url);expect(options.cache).toBe('no-store');expect(options.headers).toHaveProperty('Authorization','Bearer test-token');
    return Promise.resolve(Response.json(url.includes('/me/')?{fields:[],watermark:0}:{fish:[],total:0,offset:0}));
  }));
  const data=createModuleDataPort({moduleId:FISH_MODULE_ID,context:{token:'test-token',apiBaseUrl:'https://hub.test',moduleAccess:()=>({status:'enabled',grantedCapabilities:['storage:own']})}});
  await data.call('fish.snapshot',{region:'cn',hours:1});
  expect(urls).toContain('https://hub.test/api/v1/me/fish-progress?region=cn');
  expect(urls.every((url)=>!url.includes('test-token'))).toBe(true);
  await expect(data.call('not.registered')).rejects.toThrow();
});
it('blocks disabled modules before any network request',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const data=createModuleDataPort({moduleId:FISH_MODULE_ID,context:{token:'test-token',apiBaseUrl:'',moduleAccess:()=>({status:'disabled',grantedCapabilities:['storage:own']})}});
  await expect(data.call('fish.snapshot',{region:'cn'})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
