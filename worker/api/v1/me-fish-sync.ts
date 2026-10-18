import { z } from 'zod';
import { ApiError,fishRegionSchema,fishSyncPreviewInputSchema,fishSyncApplySchema } from '@ff14-hub/shared';
import type { Hono } from 'hono';
import type { AppBindings } from '../../types';
import { noStoreJson } from '../../lib/response';
import { validateQuery,parsedJsonBody,validateJsonBody } from '../../middleware/validation';
import { syncSnapshot,previewSync,applySync,rollbackPreview } from '../../modules/fish-sync/service';
const query=z.object({region:fishRegionSchema});
const rollback=z.object({auditId:z.uuid()}).strict();
export function registerFishSyncRoutes(me:Hono<AppBindings>):void{
  me.get('/fish-sync',validateQuery(query),async(c)=>{
    const q=query.parse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
    return noStoreJson(c,await syncSnapshot(c.env.DB,c.get('workspaceId'),q.region));
  });
  me.post('/fish-sync/preview',validateJsonBody(fishSyncPreviewInputSchema),async(c)=>
    noStoreJson(c,await previewSync(c.env.DB,c.get('workspaceId'),parsedJsonBody(c,fishSyncPreviewInputSchema))));
  me.post('/fish-sync/rollback-preview',validateJsonBody(rollback),async(c)=>
    noStoreJson(c,await rollbackPreview(c.env.DB,c.get('workspaceId'),parsedJsonBody(c,rollback).auditId)));
  me.post('/fish-sync/apply',validateJsonBody(fishSyncApplySchema),async(c)=>{
    const result=await applySync(c.env.DB,c.get('workspaceId'),c.get('deviceId'),parsedJsonBody(c,fishSyncApplySchema));
    if(!result.ok)throw new ApiError(result.reason==='persist_failed'?'internal_error':'conflict',result.detail,result.reason);
    return noStoreJson(c,{...result.value,replayed:result.replayed});
  });
}
