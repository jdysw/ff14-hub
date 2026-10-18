import { z } from 'zod';
import { fishListQuerySchema,fishListResponseSchema,fishWindowsResponseSchema,fishProgressWriteSchema,
  fishProgressResponseSchema,fishProgressSchema,fishSnapshotQuerySchema } from '@ff14-hub/shared';
import type { ModulePortFactory } from '../widgets/module-data-ports';
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
      const fish=fishListResponseSchema.parse(await request(`/fish?region=${region}&limit=${String(fishListQuerySchema.parse({region:q.region}).limit)}&offset=${String(q.offset)}&text=${encodeURIComponent(q.text)}`));
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
