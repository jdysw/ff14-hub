import { z } from 'zod';
import { fishListQuerySchema,fishListResponseSchema,fishWindowsResponseSchema,fishProgressWriteSchema,
  fishProgressResponseSchema,fishProgressSchema,fishSnapshotQuerySchema,FISH_MODULE_ID } from '@ff14-hub/shared';
import type { ModulePortFactory } from '../widgets/module-data-ports';
import type { ModuleDataPort } from '../widgets/types';
import { buildApiUrl } from '../../lib/api-client';

export const fishingSnapshotSchema = z.object({fish:fishListResponseSchema,windows:fishWindowsResponseSchema,progress:fishProgressResponseSchema});
export type FishingSnapshot = z.infer<typeof fishingSnapshotSchema>;
export const fishModulePortFactory: ModulePortFactory = (context) => {
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(buildApiUrl(`/api/v1${path}`,context.apiBaseUrl),{
      method:body === undefined?'GET':'PUT',headers:{Authorization:`Bearer ${context.token}`,
        ...(body === undefined?{}:{'Content-Type':'application/json'})},
      ...(body === undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',redirect:'error',credentials:'omit',
    });
    if (response.status === 401) context.onUnauthorized?.();
    if (!response.ok) throw new Error(response.status === 409?'进度已被其他设备修改，请刷新后重试':`钓鱼数据请求失败（${String(response.status)}）`);
    return response.json();
  };
  return {
    'fish.snapshot':async (input) => {
      const q = fishSnapshotQuerySchema.parse(input);
      const region = encodeURIComponent(q.region);
      const fish=fishListResponseSchema.parse(await request('/fish?region='+region+'&category='+q.category+'&limit='+String(fishListQuerySchema.parse({region:q.region}).limit)+'&offset='+String(q.offset)+'&text='+encodeURIComponent(q.text)));
      const now=Date.now();
      const [windows,progress] = await Promise.all([
        fish.fish.length===0?Promise.resolve({windows:[],from:now,to:now+q.hours*3600000}):request(`/fish/windows?region=${region}&hours=${String(q.hours)}&fishIds=${fish.fish.map((f)=>String(f.id)).join(',')}`),
        request(`/me/fish-progress?region=${region}`),
      ]);
      return fishingSnapshotSchema.parse({fish,windows,progress});
    },
    'fish.progress':async (input) => {
      const q = fishProgressWriteSchema.parse(input);
      return z.object({field:fishProgressSchema,replayed:z.boolean()}).parse(await request('/me/fish-progress',q));
    },
  };
};

/**
 * 公开只读端口：不依赖设备 Token 和个人工作空间，绝不开放私有进度写入。
 * 独立页面可以直接看鱼窗；Widget 仍通过原有模块门禁端口访问。
 */
export const publicFishPort: ModuleDataPort = {
  moduleId:FISH_MODULE_ID,
  operations:['fish.snapshot'],
  async call<T = unknown>(operation:string,input?:unknown):Promise<T>{
    if(operation!=='fish.snapshot')throw new Error('公开钓鱼目录不支持修改个人进度');
    const q=fishSnapshotQuerySchema.parse(input);
    const region=encodeURIComponent(q.region);
    const request=async(path:string):Promise<unknown>=>{
      const response=await fetch(buildApiUrl('/api/v1'+path),{cache:'no-store',credentials:'omit',redirect:'error'});
      if(!response.ok)throw new Error('公开鱼类数据暂时无法加载（'+String(response.status)+'）');
      return response.json();
    };
    const fish=fishListResponseSchema.parse(await request('/fish?region='+region+'&category='+q.category+
      '&limit=30&offset='+String(q.offset)+'&text='+encodeURIComponent(q.text)));
    const now=Date.now();
    const windows=fish.fish.length===0?{windows:[],from:now,to:now+q.hours*3600000}:
      await request('/fish/windows?region='+region+'&hours='+String(q.hours)+'&fishIds='+fish.fish.map(f=>String(f.id)).join(','));
    return fishingSnapshotSchema.parse({fish,windows,progress:{fields:[],watermark:0}}) as T;
  },
};
