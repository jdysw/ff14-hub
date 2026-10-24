import {SELF,env} from 'cloudflare:test';
import {afterEach,it,expect,vi} from 'vitest';
import {Hono} from 'hono';
import {ApiError,DEFAULT_ERROR_MESSAGE} from '@ff14-hub/shared';
import type {AppBindings} from '../types';
import {registerErrorHandlers} from '../middleware/error-handler';
import {createApp} from '../app';
import {partialEnv} from './helpers';
afterEach(()=>vi.restoreAllMocks());
const secret='plain private personal phrase without any credential marker';
it('does not log unexpected exception names/messages or expose arbitrary 5xx ApiError details',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  for(const kind of ['unexpected','api'] as const){
    const app=new Hono<AppBindings>();
    app.get('/',()=>{
      if(kind==='api')throw new ApiError('internal_error',secret,secret,{privateBody:secret});
      const error=new Error(secret);error.name=secret;throw error;
    });registerErrorHandlers(app);
    const response=await app.request('/');expect(response.status).toBe(500);
    const text=await response.text();expect(text).not.toContain(secret);
    expect(JSON.parse(text) as unknown).toEqual({code:'internal_error',message:DEFAULT_ERROR_MESSAGE.internal_error,requestId:'req-unknown'});
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);expect(log).toHaveBeenCalledTimes(2);
});
it('keeps unexpected database error bodies and arbitrary private paths out of logs',async()=>{
  const errorLog=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  const warnLog=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  const db=new Proxy(env.DB,{get(target,key,receiver):unknown{if(key==='prepare')return ()=>{throw new Error(secret);};return Reflect.get(target,key,receiver);}});
  const response=await createApp().request('/api/v1/health',{},partialEnv({DB:db,ENVIRONMENT:'test'}));
  expect(await response.text()).not.toContain(secret);expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
  expect((await SELF.fetch(`https://hub.test/api/v1/me/${encodeURIComponent(secret)}`)).status).toBe(404);
  expect(JSON.stringify(warnLog.mock.calls)).not.toContain(encodeURIComponent(secret));
  expect(JSON.stringify(warnLog.mock.calls)).not.toContain(secret);
});
