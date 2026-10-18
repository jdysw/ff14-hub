import {afterEach,it,expect,vi} from 'vitest';
import {createModuleDataPort} from '../src/app/widgets/module-data-ports';
afterEach(()=>vi.unstubAllGlobals());
it.each([
  ['ff14.fishing','fish.snapshot',{region:'cn',hours:1}],
  ['ff14.sync','sync.snapshot',{region:'cn'}],
  ['ff14.reminders','reminders.reconcile',undefined],
  ['ff14.events','events.listPersonal',{region:'cn'}],
] as const)('fails a redirected %s request with credentials confined to the trusted header',async(moduleId,operation,input)=>{
  const network=vi.fn<typeof fetch>((address,init)=>{
    expect(address).not.toContain('ephemeral-device-token');
    expect(init).toMatchObject({redirect:'error',credentials:'omit',cache:'no-store'});
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ephemeral-device-token');
    return Promise.reject(new TypeError('redirect blocked'));
  });vi.stubGlobal('fetch',network);
  const data=createModuleDataPort({moduleId,context:{token:'ephemeral-device-token',apiBaseUrl:'https://hub.test',moduleAccess:()=>({status:'enabled',grantedCapabilities:['storage:own']})}});
  await expect(data.call(operation,input)).rejects.toThrow();expect(network).toHaveBeenCalledOnce();
  expect(JSON.stringify(data)).not.toContain('ephemeral-device-token');
});
it('reports reminder rate limits without echoing an arbitrary server body',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(Response.json({message:'private upstream body'},{status:429}))));
  const data=createModuleDataPort({moduleId:'ff14.reminders',context:{token:'ephemeral-device-token',apiBaseUrl:'',moduleAccess:()=>({status:'enabled',grantedCapabilities:['storage:own']})}});
  await expect(data.call('reminders.reconcile')).rejects.toThrow('操作过于频繁，请稍后再试；当前输入已保留');
});
