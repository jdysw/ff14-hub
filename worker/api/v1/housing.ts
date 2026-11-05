import {Hono} from 'hono';
import {HOUSING_SOURCE,housingPlotsSchema,housingWorlds} from '@ff14-hub/shared/housing';
import {boundedBody} from '../../modules/events/calendar-feed';
import type {AppBindings} from '../../types';

const supportedWorlds = new Set(Object.values(housingWorlds).flatMap(worlds => [...worlds].map(([id]) => String(id))));
export const housingRoutes = new Hono<AppBindings>();

housingRoutes.get('/', async c => {
  const world = c.req.query('world');
  if (!world || !supportedWorlds.has(world)) return c.json({message:'请选择有效的国服服务器。'}, 400);

  const key = new Request(new URL(`/api/v1/housing?world=${world}`, c.req.url));
  const cached = await caches.default.match(key).catch(() => undefined);
  if (cached) return cached;

  try {
    const response = await fetch(new URL(`api/sales?server=${world}`, HOUSING_SOURCE), {
      headers: {'Accept':'application/json','User-Agent':'FF14 Hub/1.0 (+https://github.com/jdysw/ff14-hub/issues)'},
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Housing source returned an error');
    const plots = housingPlotsSchema.parse(JSON.parse(await boundedBody(response)));
    if (plots.some(plot => String(plot.Server) !== world)) throw new Error('Housing source returned the wrong world');
    const result = c.json({plots, fetchedAt:Date.now()}, 200, {'Cache-Control':'public, max-age=300'});
    await caches.default.put(key, result.clone()).catch(() => undefined);
    return result;
  } catch {
    return c.json({message:'房源数据暂时无法获取，请稍后重试。'}, 503, {'Cache-Control':'no-store'});
  }
});
