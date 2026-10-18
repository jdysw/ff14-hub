/**
 * `/api/v1/events` —— 公开活动列表（阶段 04：HUB-011）。
 *
 * 安全前提：
 * - **只读**、匿名可读，且只返回公共来源表 `events` 的行。
 *   个人活动在 `workspace_events`，永远不进入本响应（有测试覆盖）。
 * - 响应形状由共享的 `publicEventListResponseSchema` 约束（**严格**：只有
 *   `events` / `serverTimeMs` 两个键），因此不可能顺手把个人活动字段或内部元数据
 *   塞进公共响应。
 * - 本阶段公共表为空表（不捆绑未经核实的活动数据），因此正常返回空列表；
 *   界面据此诚实显示 `EVENTS_MESSAGES.publicEmpty`，而不是编造数据。
 * - 阶段 04 不做抓取器 / 提醒调度，也不注册 Cron（ADR-0004 D9 / D12）。
 */
import {
  EVENT_SORT_ORDERS,
  eventPhaseSchema,
  eventRegionSchema,
  type EventPhase,
  type EventRegion,
  type EventSortOrder,
} from '@ff14-hub/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { noStoreJson } from '../../lib/response';
import { nowUtcMs } from '../../lib/util';
import { methodNotAllowed } from '../../middleware/error-handler';
import { validateQuery } from '../../middleware/validation';
import { createEventService } from '../../modules/events/service';
import type { AppBindings } from '../../types';

export const publicEventRoutes = new Hono<AppBindings>();

/**
 * 公开列表的查询参数。
 *
 * 刻意**不**用 `.strict()`：查询串里出现无关参数（例如缓存击穿用的 `_=123`）不应让
 * 一个只读列表返回 422；真正需要拒绝的是「已知参数取了非法值」——
 * `region=both` / `phase=bogus` / `sort=bogus` 都会在这里被拒（422）。
 * 区服沿用共享枚举（**没有** `both`：活动是分区服的事实，INV-08）。
 */
const publicEventQuerySchema = z.object({
  region: eventRegionSchema.optional(),
  phase: eventPhaseSchema.optional(),
  text: z.string().optional(),
  sort: z.enum(EVENT_SORT_ORDERS).optional(),
});

/**
 * 取出原始查询参数。
 *
 * 与 `validateQuery` 的取值方式**逐字一致**（同一份 `URLSearchParams`），
 * 因此「中间件校验过的值」与「处理器使用的值」必然是同一批；重复参数也遵循同一规则
 * （`Object.fromEntries` 取最后一次出现的值，`URLSearchParams.get` 取第一次——正因如此
 * 这里不直接调 `c.req.query()`，避免两条路径对重复参数给出不同结果）。
 */
function rawQuery(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/** GET /api/v1/events —— 公共来源活动（匿名可读）。 */
publicEventRoutes.get('/', validateQuery(publicEventQuerySchema), async (c) => {
  // 中间件已经用**同一份输入**校验过，这里的 parse 不会失败；
  // 万一失败（说明中间件链被改动），让它以 500 响亮失败，而不是返回形状不完整的数据。
  const query = publicEventQuerySchema.parse(rawQuery(c.req.url));
  const service = createEventService({ db: c.env.DB });
  const region: EventRegion | null = query.region ?? null;
  const phase: EventPhase | null = query.phase ?? null;
  const sort: EventSortOrder = query.sort ?? 'startsAt';
  return noStoreJson(
    c,
    await service.listPublic({
      region,
      phase,
      text: query.text ?? null,
      // 阶段判定与响应里的 serverTimeMs 用同一个「现在」：客户端据 serverTimeMs 复算阶段时，
      // 必须与服务端筛选时的基准一致，否则设备时钟偏差会改变筛选结果。
      nowMs: nowUtcMs(),
      sort,
    }),
  );
});

// 只支持 GET：其他方法给结构化 405（不落入 404，便于区分「路径写错」与「方法写错」）。
publicEventRoutes.all('*', methodNotAllowed(['GET']));
