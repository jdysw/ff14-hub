import {z} from 'zod';
import type {Hono} from 'hono';
import {fishRegionSchema} from '@ff14-hub/shared';
import type {AppBindings} from '../../types';
import {noStoreJson} from '../../lib/response';
import {validateQuery} from '../../middleware/validation';
import {operationsSnapshot} from '../../modules/operations/snapshot';
const query=z.object({region:fishRegionSchema}).strict();
export function registerOperationsRoutes(me:Hono<AppBindings>):void{
  me.get('/operations',validateQuery(query),async(c)=>{
    const input=query.parse(Object.fromEntries(new URL(c.req.url).searchParams.entries()));
    return noStoreJson(c,await operationsSnapshot(c.env,c.get('workspaceId'),input.region));
  });
}
