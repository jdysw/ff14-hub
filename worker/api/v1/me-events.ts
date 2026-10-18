/**
 * `/api/v1/me/events*` —— 个人活动（阶段 04：HUB-011）。
 *
 * 安全前提：
 * - 挂载在 `meRoutes` 之下，先经 `deviceAuth()`；未授权一律 401。
 * - 作用域**只**取 `c.get('workspaceId')`（认证结果），路径参数只用于过滤；
 *   服务层每条语句都带 `workspace_id`，因此拿 A 的凭证访问 B 的活动只会得到 404。
 * - 个人活动**永不**出现在公开 `/api/v1/events` 响应里（两棵子树读写不同的表）。
 * - 写请求先经 `validateJsonBody`（严格 Schema，多余字段直接拒绝），
 *   再带 `operationId` 进入原子幂等事务（ADR-0004 D11）。
 * - 本阶段**不实现**提醒 / 调度 / Cron / 抓取（ADR-0004 D12 的显式边界）。
 */
import {
  ApiError,
  DEFAULT_ERROR_MESSAGE,
  createWorkspaceEventRequestSchema,
  deleteWorkspaceEventRequestSchema,
  eventPhaseSchema,
  eventRegionSchema,
  updateWorkspaceEventRequestSchema,
  type EventPhase,
  type EventRegion,
} from '@ff14-hub/shared';
// 只把 Hono 当作类型使用（路由注册进传入的实例）。
import type { Hono } from 'hono';
import { z } from 'zod';
import { noStoreJson } from '../../lib/response';
import { nowUtcMs } from '../../lib/util';
import { parsedJsonBody, validateJsonBody, validateQuery } from '../../middleware/validation';
import { createEventService } from '../../modules/events/service';
import { ERROR_CODE_BY_EVENT_REJECTION, type EventFailure } from '../../modules/events/tx';
import type { AppBindings } from '../../types';

/** 把服务层的拒绝原因映射成统一错误契约（not_found→404、冲突→409、校验→422）。 */
function eventError(failure: EventFailure): ApiError {
  const code = ERROR_CODE_BY_EVENT_REJECTION[failure.reason];
  // 结构化冲突的对外形状与导航**完全一致**：`details.conflict`。
  // 为什么统一包一层 `conflict` 而不是把冲突对象直接当 details：
  //   ① 客户端只需要一套解析逻辑（导航/活动/同步共用 `syncConflictSchema`）；
  //   ② `details` 将来还能承载别的、与冲突无关的可回显细节，不会被冲突字段占满。
  // `failure.details` 只含可安全回显的内容（实体 ID / revision / 可选处理方式）；
  // 为 undefined 时响应体**不会出现** details 键（阶段 01–03 的响应形状保持不变）。
  const details = failure.details === undefined ? undefined : { conflict: failure.details };
  return new ApiError(code, `${DEFAULT_ERROR_MESSAGE[code]}（${failure.detail}）`, failure.reason, details);
}

/** 个人活动列表的筛选查询参数（不含排序：维护视图固定按开始时间升序）。 */
const personalEventQuerySchema = z.object({
  region: eventRegionSchema.optional(),
  phase: eventPhaseSchema.optional(),
  text: z.string().optional(),
});

/**
 * 取出原始查询参数。
 *
 * 与 `validateQuery` 的取值方式**逐字一致**（同一份 `URLSearchParams`），
 * 因此中间件校验过的值与处理器使用的值必然相同（重复参数也遵循同一规则）。
 */
function rawQuery(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/** 在 /me 子树里注册个人活动路由。 */
export function registerMeEventRoutes(me: Hono<AppBindings>): void {
  /** GET /me/events —— 本工作空间的个人活动（只含未删除行）。 */
  me.get('/events', validateQuery(personalEventQuerySchema), async (c) => {
    // 中间件已用同一份输入校验过；失败即说明中间件链被改动，让它 500 响亮失败。
    const query = personalEventQuerySchema.parse(rawQuery(c.req.url));
    const region: EventRegion | null = query.region ?? null;
    const phase: EventPhase | null = query.phase ?? null;
    const service = createEventService({ db: c.env.DB });
    return noStoreJson(
      c,
      await service.listPersonal(c.get('workspaceId'), {
        region,
        phase,
        text: query.text ?? null,
        nowMs: nowUtcMs(),
      }),
    );
  });

  /**
   * POST /me/events —— 新建个人活动。
   * `verification_status` 由服务端固定为 `unverified`：用户自述来源不构成证据。
   */
  me.post('/events', validateJsonBody(createWorkspaceEventRequestSchema), async (c) => {
    const body = parsedJsonBody(c, createWorkspaceEventRequestSchema);
    const service = createEventService({ db: c.env.DB });
    const outcome = await service.createPersonal({
      workspaceId: c.get('workspaceId'),
      deviceId: c.get('deviceId'),
      input: {
        title: body.title,
        ...(body.description === undefined ? {} : { description: body.description }),
        region: body.region,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        ...(body.sourceUrl === undefined ? {} : { sourceUrl: body.sourceUrl }),
        ...(body.verificationStatus === undefined ? {} : { verificationStatus: body.verificationStatus }),
      },
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw eventError(outcome);
    }
    return noStoreJson(c, { event: outcome.value.event, replayed: outcome.replayed }, 201);
  });

  /** PATCH /me/events/:id —— 编辑（必须带 expectedRevision；冲突返回结构化 409）。 */
  me.patch('/events/:id', validateJsonBody(updateWorkspaceEventRequestSchema), async (c) => {
    const body = parsedJsonBody(c, updateWorkspaceEventRequestSchema);
    const service = createEventService({ db: c.env.DB });
    const outcome = await service.updatePersonal({
      workspaceId: c.get('workspaceId'),
      eventId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
      patch: {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.region === undefined ? {} : { region: body.region }),
        ...(body.startsAt === undefined ? {} : { startsAt: body.startsAt }),
        ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt }),
        ...(body.sourceUrl === undefined ? {} : { sourceUrl: body.sourceUrl }),
        ...(body.verificationStatus === undefined ? {} : { verificationStatus: body.verificationStatus }),
      },
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw eventError(outcome);
    }
    return noStoreJson(c, { event: outcome.value.event, replayed: outcome.replayed });
  });

  /**
   * DELETE /me/events/:id —— 墓碑化（**不硬删**：删除要跨设备同步，见 ADR-0004 D7）。
   * 同样是 CAS + 幂等，因此重复删除（同 operationId 重放）能拿到首次结果。
   */
  me.delete('/events/:id', validateJsonBody(deleteWorkspaceEventRequestSchema), async (c) => {
    const body = parsedJsonBody(c, deleteWorkspaceEventRequestSchema);
    const service = createEventService({ db: c.env.DB });
    const outcome = await service.deletePersonal({
      workspaceId: c.get('workspaceId'),
      eventId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw eventError(outcome);
    }
    return noStoreJson(c, { event: outcome.value.event, replayed: outcome.replayed });
  });
}
