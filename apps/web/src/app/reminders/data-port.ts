import { z } from 'zod';
import { reminderSnapshotSchema,reminderRuleInputSchema,reminderDeleteSchema,pushSubscriptionInputSchema } from '@ff14-hub/shared';
import { buildApiUrl } from '../../lib/api-client';
import type { ModulePortFactory } from '../widgets/module-data-ports';
export const reminderPortFactory:ModulePortFactory=(context)=>{
  const request=async(method:string,path:string,body?:unknown):Promise<unknown>=>{
    const response=await fetch(buildApiUrl(`/api/v1/me/reminders${path}`,context.apiBaseUrl),{method,
      headers:{Authorization:`Bearer ${context.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',redirect:'error',credentials:'omit'});
    if(response.status===401)context.onUnauthorized?.();
    if(response.status===429)throw new Error('操作过于频繁，请稍后再试；当前输入已保留');
    if(!response.ok)throw new Error(response.status===409?'规则已变化，请刷新后重试；当前输入已保留':`提醒请求失败（${String(response.status)}）`);
    return response.json();
  };
  return {
    'reminders.snapshot':async()=>reminderSnapshotSchema.parse(await request('GET','')),
    'reminders.save':async(input)=>request('PUT','/rules',reminderRuleInputSchema.parse(input)),
    'reminders.delete':async(input)=>{const q=reminderDeleteSchema.extend({id:z.uuid()}).parse(input);
      return request('DELETE',`/rules/${q.id}`,{operationId:q.operationId,expectedRevision:q.expectedRevision});},
    'reminders.reconcile':async()=>request('POST','/reconcile',{}),
    'reminders.subscribe':async(input)=>request('PUT','/push',pushSubscriptionInputSchema.parse(input)),
    'reminders.unsubscribe':async()=>request('DELETE','/push',{}),
  };
};
