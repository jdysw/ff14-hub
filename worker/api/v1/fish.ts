import { Hono } from 'hono';
import { ApiError, fishListQuerySchema, fishWindowQuerySchema, fishWindows } from '@ff14-hub/shared';
import { z } from 'zod';
import type { AppBindings } from '../../types';
import { noStoreJson } from '../../lib/response';
import {validateQuery} from '../../middleware/validation';
import {readFish} from '../../modules/fish/service';
import { methodNotAllowed } from '../../middleware/error-handler';

export const fishRoutes = new Hono<AppBindings>();
const queryOf = (url: string): Record<string,string> => Object.fromEntries(new URL(url).searchParams.entries());
fishRoutes.get('/',validateQuery(fishListQuerySchema),async (c) => {
  const q = fishListQuerySchema.parse(queryOf(c.req.url));
  const records = (await readFish(c.env.DB,q.region)).filter((f) =>
    f.name.toLocaleLowerCase().includes(q.text.toLocaleLowerCase()) &&
    (q.category==='all' || (q.category==='rare' ? f.fishType!=='normal' : f.fishType===q.category)));
  return noStoreJson(c,{fish:records.slice(q.offset,q.offset+q.limit),total:records.length,offset:q.offset});
});
fishRoutes.get('/windows',validateQuery(fishWindowQuerySchema),async (c) => {
  const q = fishWindowQuerySchema.parse(queryOf(c.req.url));
  const records = (await readFish(c.env.DB,q.region)).filter((f) => (q.fishId === undefined || f.id === q.fishId) && (q.fishIds === undefined || q.fishIds.includes(f.id)));
  if (q.fishId !== undefined && records.length === 0) throw new ApiError('not_found','该区服没有此鱼类');
  const from = q.from ?? Date.now();
  const to = from + q.hours*3_600_000;
  try {
    if(records.length>50)throw new RangeError('最多同时查询50种鱼');
    // 逐鱼计算再限流：常见全天鱼在 7 天内可能产生数百个天气段，
    // 直接计算30种会超过旧版5000个窗口上限，让整页失效。
    const windows:ReturnType<typeof fishWindows>=[];
    const truncatedFishIds:number[]=[];
    for(const fish of records){
      const all=fishWindows({region:q.region,rules:[fish.rule],from,to});
      if(all.length>90)truncatedFishIds.push(fish.id);
      windows.push(...all.slice(0,90));
    }
    windows.sort((a,b)=>a.startsAtUtcMs-b.startsAtUtcMs||a.fishId-b.fishId);
    return noStoreJson(c,{windows,from,to,truncatedFishIds});
  }
  catch (error) {
    if (error instanceof RangeError || error instanceof z.ZodError) throw new ApiError('validation_failed','窗口查询超出上限或规则不完整，请缩小范围');
    throw error;
  }
});
fishRoutes.all('*',methodNotAllowed(['GET']));

