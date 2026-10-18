import { z } from 'zod';
import { fishRegionSchema,fishSyncSnapshotSchema,fishSyncPreviewInputSchema,fishSyncPreviewSchema,fishSyncApplySchema,fishSyncResultSchema } from '@ff14-hub/shared';
import { buildApiUrl } from '../../lib/api-client';
import type { ModulePortFactory } from '../widgets/module-data-ports';
export const fishSyncPortFactory:ModulePortFactory=(context)=>{
  const request=async(path:string,body?:unknown):Promise<unknown>=>{
    const response=await fetch(buildApiUrl(`/api/v1/me/fish-sync${path}`,context.apiBaseUrl),{method:body===undefined?'GET':'POST',
      headers:{Authorization:`Bearer ${context.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store'});
    if(response.status===401)context.onUnauthorized?.();
    if(!response.ok)throw new Error(response.status===409?'数据已变化或预览已过期，请重新预览；文件内容仍保留':`同步请求失败（${String(response.status)}）`);
    return response.json();
  };
  return {
    'sync.snapshot':async(input)=>{const q=z.object({region:fishRegionSchema}).strict().parse(input);return fishSyncSnapshotSchema.parse(await request(`?region=${q.region}`));},
    'sync.preview':async(input)=>fishSyncPreviewSchema.parse(await request('/preview',fishSyncPreviewInputSchema.parse(input))),
    'sync.apply':async(input)=>fishSyncResultSchema.parse(await request('/apply',fishSyncApplySchema.parse(input))),
    'sync.rollback':async(input)=>fishSyncPreviewSchema.parse(await request('/rollback-preview',z.object({auditId:z.uuid()}).strict().parse(input))),
  };
};
