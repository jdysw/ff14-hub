import { ApiError, directoryMutationSchema, directoryToggleSchema } from '@ff14-hub/shared';
import type { Hono } from 'hono';
import type { AppBindings, AppMiddleware } from '../../types';
import { noStoreJson } from '../../lib/response';
import { parsedJsonBody, validateJsonBody } from '../../middleware/validation';
import { applyCatalogSeed, readBaseCatalog } from '../../modules/nav/catalog';
import { readDirectoryRecords, saveDirectoryRecord } from '../../modules/nav/directory-editor';

export function registerAdminNavigation(routes: Hono<AppBindings>, auth: AppMiddleware): void {
  routes.use('/navigation/*', auth);
  routes.get('/navigation/items', async c => {
    await applyCatalogSeed({db:c.env.DB,now:Date.now()});
    return noStoreJson(c,{records:await readDirectoryRecords(c.env.DB,await readBaseCatalog(c.env.DB))});
  });
  routes.post('/navigation/items',validateJsonBody(directoryMutationSchema),async c => {
    const body=parsedJsonBody(c,directoryMutationSchema);
    if(body.expectedRevision!==0) throw new ApiError('validation_failed','新建网站版本必须为 0');
    await applyCatalogSeed({db:c.env.DB,now:Date.now()});
    const records=await readDirectoryRecords(c.env.DB,await readBaseCatalog(c.env.DB));
    return noStoreJson(c,await saveDirectoryRecord(c.env.DB,records,{
      id:'catalog.manual.'+crypto.randomUUID(),expectedRevision:0,item:body.item,hidden:false,
    }),201);
  });
  routes.put('/navigation/items/:id',validateJsonBody(directoryMutationSchema),async c => {
    const body=parsedJsonBody(c,directoryMutationSchema);
    const records=await readDirectoryRecords(c.env.DB,await readBaseCatalog(c.env.DB));
    const old=records.find(record=>record.entry.id===c.req.param('id'));
    if(!old) throw new ApiError('not_found','网站不存在');
    return noStoreJson(c,await saveDirectoryRecord(c.env.DB,records,{
      id:old.entry.id,expectedRevision:body.expectedRevision,item:body.item,hidden:old.hidden,
    }));
  });
  for(const action of ['hide','restore'] as const) {
    routes.post('/navigation/items/:id/'+action,validateJsonBody(directoryToggleSchema),async c=>{
      const body=parsedJsonBody(c,directoryToggleSchema);
      const records=await readDirectoryRecords(c.env.DB,await readBaseCatalog(c.env.DB));
      const old=records.find(record=>record.entry.id===c.req.param('id'));
      if(!old) throw new ApiError('not_found','网站不存在');
      return noStoreJson(c,await saveDirectoryRecord(c.env.DB,records,{
        id:old.entry.id,expectedRevision:body.expectedRevision,item:old.entry,hidden:action==='hide',
      }));
    });
  }
}
