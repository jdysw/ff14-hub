/**
 * 活动端点（HUB-011）——**真实 workerd + D1** 的 HTTP 验收。
 *
 * 覆盖范围（全部用 `SELF.fetch` 走真实路由、真实中间件、真实数据库）：
 * - 未认证一律 401（四个方法各一条）；
 * - 创建 → 列表 → 更新 → 删除的完整生命周期，且删除是**墓碑**（行仍在，`deleted_at IS NOT NULL`）；
 * - 校验边界：区服 `both`、区间倒置、零长度区间、来源链接只允许 https；
 * - `eventPhase` 过期逻辑：真实创建「已结束 / 进行中 / 未开始」三条，断言筛选子集
 *   与共享纯函数 `filterEvents` 的结果一致（服务端与前端不会漂移）；
 * - 幂等：同 operationId 重放只写一条；同 operationId 换正文/换目标 → 409 且**零写入**；
 * - 并发冲突：过期的 `expectedRevision` → 409 + 结构化 `details`，且行未被修改；
 * - 越权：用 A 的凭证操作 B 的活动 → 404，且 B 的行逐字节未变；
 * - **公共接口不泄露私有数据**：个人活动创建后 `GET /api/v1/events` 仍为空数组，
 *   且公开响应恰好只有 `events` / `serverTimeMs` 两个键。
 *
 * 证据标准：每一条被拒绝的写入都同时断言「可解释错误码」与「数据库事实未变」。
 */
import {
  eventListResponseSchema,
  filterEvents,
  publicEventListResponseSchema,
  type EventListResponse,
  type EventPhase,
  type PublicEventListResponse,
  type WorkspaceEvent,
} from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  URLS,
  eventUrl,
  jsonDelete,
  jsonPatch,
  jsonPost,
  opId,
  resetIdentityState,
  seedAuth,
} from './helpers';

const DAY_MS = 86_400_000;

/** 创建一段固定在「过去 / 现在 / 将来」的时间窗，供阶段判定使用。 */
function windowAround(now: number, phase: EventPhase): { startsAt: number; endsAt: number } {
  switch (phase) {
    case 'ended':
      return { startsAt: now - 3 * DAY_MS, endsAt: now - DAY_MS };
    case 'active':
      return { startsAt: now - 60_000, endsAt: now + 60_000 };
    case 'upcoming':
      return { startsAt: now + DAY_MS, endsAt: now + 2 * DAY_MS };
  }
}

/** 带查询串的私有列表 URL。 */
function eventsUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query).toString();
  return params.length === 0 ? URLS.meEvents : `${URLS.meEvents}?${params}`;
}

/** 带查询串的公开列表 URL。 */
function publicEventsUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query).toString();
  return params.length === 0 ? URLS.publicEvents : `${URLS.publicEvents}?${params}`;
}

interface EventEnvelope {
  readonly event: WorkspaceEvent;
  readonly replayed: boolean;
}

interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  /**
   * 结构化冲突的对外形状：`details.conflict`。
   * 与导航端点**完全一致**（客户端因此只需要一套解析逻辑：`syncConflictSchema`）。
   */
  readonly details?: {
    readonly conflict?: {
      readonly reason?: string;
      readonly entityType?: string;
      readonly entityId?: string;
      readonly field?: unknown;
      readonly baseRevision?: number;
      readonly currentRevision?: number;
      readonly resolutionOptions?: readonly string[];
    };
  };
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** 直接读库：一条个人活动行的原始事实（**不**按墓碑过滤）。 */
async function readEventRow(
  workspaceId: string,
  eventId: string,
): Promise<{ revision: number; deleted_at: number | null; title: string; verification_status: string } | null> {
  return await env.DB.prepare(
    'SELECT revision, deleted_at, title, verification_status FROM workspace_events WHERE id = ? AND workspace_id = ?',
  )
    .bind(eventId, workspaceId)
    .first<{ revision: number; deleted_at: number | null; title: string; verification_status: string }>();
}

/** 统计本工作空间的活跃个人活动数。 */
async function countActiveEvents(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM workspace_events WHERE workspace_id = ? AND deleted_at IS NULL',
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

/** 统计幂等账本两张表的行数（用于证明「被拒绝的写入零留痕」）。 */
async function operationCounts(workspaceId: string): Promise<{ operations: number; intents: number }> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM event_operations WHERE workspace_id = ?) AS operations,
            (SELECT COUNT(*) FROM event_operation_intents WHERE workspace_id = ?) AS intents`,
  )
    .bind(workspaceId, workspaceId)
    .first<{ operations: number; intents: number }>();
  return { operations: row?.operations ?? -1, intents: row?.intents ?? -1 };
}

/** 创建一条个人活动（期望成功）。 */
async function createEventOk(
  authorization: string,
  input: {
    readonly title: string;
    readonly region: string;
    readonly startsAt: number;
    readonly endsAt: number;
    readonly description?: string;
    readonly sourceUrl?: string | null;
    readonly verificationStatus?: string;
    readonly operationId: string;
  },
): Promise<EventEnvelope> {
  const response = await SELF.fetch(
    URLS.meEvents,
    jsonPost(
      {
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        region: input.region,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.verificationStatus === undefined ? {} : { verificationStatus: input.verificationStatus }),
        operationId: input.operationId,
      },
      { Authorization: authorization },
    ),
  );
  expect(response.status, `创建活动未成功：${await response.clone().text()}`).toBe(201);
  return await response.json<EventEnvelope>();
}

/** 读取私有列表（返回原始 Response，便于断言状态码与形状）。 */
async function listEvents(authorization: string, query: Record<string, string> = {}): Promise<Response> {
  return await SELF.fetch(eventsUrl(query), { headers: { Authorization: authorization } });
}

beforeEach(async () => {
  await resetIdentityState();
  // 公共来源表在阶段 04 没有任何种子；这里显式清空，保证「公共接口为空数组」
  // 这条断言在每个用例里都是干净起点，而不是依赖别的用例没有插入夹具。
  await env.DB.prepare('DELETE FROM events').run();
});

describe('未认证：一律 401', () => {
  it('GET /me/events 未带凭证 → 401 unauthorized', async () => {
    const response = await SELF.fetch(URLS.meEvents);
    expect(response.status).toBe(401);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('unauthorized');
  });

  it('POST /me/events 未带凭证 → 401 unauthorized', async () => {
    const response = await SELF.fetch(URLS.meEvents, jsonPost({ title: 'x', region: 'cn', startsAt: 1, endsAt: 1, operationId: opId('unauth') }));
    expect(response.status).toBe(401);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('unauthorized');
  });

  it('PATCH /me/events/:id 未带凭证 → 401 unauthorized', async () => {
    const response = await SELF.fetch(
      eventUrl(crypto.randomUUID()),
      jsonPatch({ expectedRevision: 0, title: 'x', operationId: opId('unauth') }),
    );
    expect(response.status).toBe(401);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('unauthorized');
  });

  it('DELETE /me/events/:id 未带凭证 → 401 unauthorized', async () => {
    const response = await SELF.fetch(
      eventUrl(crypto.randomUUID()),
      jsonDelete({ expectedRevision: 0, operationId: opId('unauth') }),
    );
    expect(response.status).toBe(401);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('unauthorized');
  });
});

describe('生命周期：创建 → 列表 → 更新 → 墓碑化', () => {
  it('创建后可列出、可更新、墓碑化后行仍在但列表不再返回', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const created = await createEventOk(auth.authorization, {
      title: '国服蛮神祭',
      description: '每周三晚八点',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      sourceUrl: 'https://example.com/event/1',
      operationId: opId('lifecycle-create'),
    });

    // 创建响应就是契约里的个人活动形状（严格 Schema：多一个键都会失败）。
    expect(created.event.revision).toBe(0);
    expect(created.event.deletedAt).toBeNull();
    expect(created.event.sourceUrl).toBe('https://example.com/event/1');
    // 用户自述来源永远 unverified。
    expect(created.event.verificationStatus).toBe('unverified');
    expect(created.replayed).toBe(false);

    const listed = await listEvents(auth.authorization);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json<EventListResponse>();
    expect(eventListResponseSchema.safeParse(listedBody).success).toBe(true);
    expect(listedBody.events.map((event) => event.id)).toEqual([created.event.id]);

    const patched = await SELF.fetch(
      eventUrl(created.event.id),
      jsonPatch(
        { expectedRevision: 0, title: '国服蛮神祭（改期）', operationId: opId('lifecycle-update') },
        { Authorization: auth.authorization },
      ),
    );
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json<EventEnvelope>();
    expect(patchedBody.event.title).toBe('国服蛮神祭（改期）');
    expect(patchedBody.event.revision).toBe(1);

    const deleted = await SELF.fetch(
      eventUrl(created.event.id),
      jsonDelete({ expectedRevision: 1, operationId: opId('lifecycle-delete') }, { Authorization: auth.authorization }),
    );
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json<EventEnvelope>();
    expect(deletedBody.event.deletedAt).not.toBeNull();
    expect(deletedBody.event.revision).toBe(2);

    // 列表不再返回它。
    const afterDelete = await listEvents(auth.authorization);
    const afterDeleteBody = await afterDelete.json<EventListResponse>();
    expect(afterDeleteBody.events).toEqual([]);

    // 但行**仍在**（墓碑而不是硬删），revision 与墓碑时间都已落库。
    const row = await readEventRow(auth.workspaceId, created.event.id);
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.revision).toBe(2);
    expect(row?.title).toBe('国服蛮神祭（改期）');
  });
});

describe('输入校验：422（明确原因，不落库）', () => {
  it("region='both' 被 422 拒绝（活动是分区服的事实，没有通配）", async () => {
    const auth = await seedAuth();
    const response = await SELF.fetch(
      URLS.meEvents,
      jsonPost(
        { title: '含糊的通用活动', region: 'both', startsAt: 1, endsAt: 2, operationId: opId('both') },
        { Authorization: auth.authorization },
      ),
    );
    expect(response.status).toBe(422);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('validation_failed');
    expect(await countActiveEvents(auth.workspaceId)).toBe(0);
  });

  it("公开列表 region='both' 同样被 422 拒绝", async () => {
    const response = await SELF.fetch(publicEventsUrl({ region: 'both' }));
    expect(response.status).toBe(422);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('validation_failed');
  });

  it('endsAt < startsAt 被 422 拒绝', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const response = await SELF.fetch(
      URLS.meEvents,
      jsonPost(
        { title: '倒置区间', region: 'cn', startsAt: now, endsAt: now - 1, operationId: opId('bad-range') },
        { Authorization: auth.authorization },
      ),
    );
    expect(response.status).toBe(422);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('validation_failed');
    expect(await countActiveEvents(auth.workspaceId)).toBe(0);
  });

  it('endsAt === startsAt 合法（零长度活动是一瞬，不是错误）', async () => {
    const auth = await seedAuth();
    const instant = Date.now() + DAY_MS;
    const created = await createEventOk(auth.authorization, {
      title: '零长度活动',
      region: 'global',
      startsAt: instant,
      endsAt: instant,
      operationId: opId('zero-length'),
    });
    expect(created.event.startsAt).toBe(instant);
    expect(created.event.endsAt).toBe(instant);
  });

  it.each([
    ['http://example.com/event', 'http（本阶段不授予任何 http 例外）'],
    ['javascript:alert(1)', 'javascript: 伪协议'],
    ['https://user:pass@example.com/event', '带用户名/密码'],
  ])('sourceUrl=%s 被 422 拒绝（%s）', async (sourceUrl, _reason) => {
    const auth = await seedAuth();
    const now = Date.now();
    const response = await SELF.fetch(
      URLS.meEvents,
      jsonPost(
        {
          title: '带非法来源的活动',
          region: 'cn',
          startsAt: now,
          endsAt: now + DAY_MS,
          sourceUrl,
          operationId: opId('bad-url'),
        },
        { Authorization: auth.authorization },
      ),
    );
    expect(response.status).toBe(422);
    expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('validation_failed');
    expect(await countActiveEvents(auth.workspaceId)).toBe(0);
  });

  it('https 来源通过并原样回显', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const created = await createEventOk(auth.authorization, {
      title: '带 https 来源的活动',
      region: 'cn',
      startsAt: now,
      endsAt: now + DAY_MS,
      sourceUrl: 'https://ff14.example.com/events/2026',
      operationId: opId('https-url'),
    });
    expect(created.event.sourceUrl).toBe('https://ff14.example.com/events/2026');
  });

  it('列表的 phase / region 非法值被 422 拒绝', async () => {
    const auth = await seedAuth();
    for (const query of [{ phase: 'bogus' }, { region: 'both' }]) {
      const response = await listEvents(auth.authorization, query);
      expect(response.status, `query=${JSON.stringify(query)}`).toBe(422);
      expect(parseJson<ErrorEnvelope>(await response.text()).code).toBe('validation_failed');
    }
    // 公开列表额外支持 sort：非法排序值同样 422。
    const badSort = await SELF.fetch(publicEventsUrl({ sort: 'random' }));
    expect(badSort.status).toBe(422);
    expect(parseJson<ErrorEnvelope>(await badSort.text()).code).toBe('validation_failed');
  });
});

describe('区服过滤', () => {
  it('cn / global 精确匹配，互不混入', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const cn = await createEventOk(auth.authorization, {
      title: '国服活动',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('region-cn'),
    });
    const global = await createEventOk(auth.authorization, {
      title: '国际服活动',
      region: 'global',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('region-global'),
    });

    const cnList = await (await listEvents(auth.authorization, { region: 'cn' })).json<EventListResponse>();
    expect(cnList.events.map((event) => event.id)).toEqual([cn.event.id]);
    const globalList = await (await listEvents(auth.authorization, { region: 'global' })).json<EventListResponse>();
    expect(globalList.events.map((event) => event.id)).toEqual([global.event.id]);
  });
});

describe('eventPhase 过期逻辑（真实时间 + 共享纯函数复核）', () => {
  it('已结束 / 进行中 / 未开始三条按 phase 过滤返回正确子集', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const ended = await createEventOk(auth.authorization, {
      title: '已结束活动',
      region: 'cn',
      ...windowAround(now, 'ended'),
      operationId: opId('phase-ended'),
    });
    const active = await createEventOk(auth.authorization, {
      title: '进行中活动',
      region: 'cn',
      ...windowAround(now, 'active'),
      operationId: opId('phase-active'),
    });
    const upcoming = await createEventOk(auth.authorization, {
      title: '未开始活动',
      region: 'cn',
      ...windowAround(now, 'upcoming'),
      operationId: opId('phase-upcoming'),
    });
    const all = [ended.event, active.event, upcoming.event];
    const expectedIdByPhase: Readonly<Record<EventPhase, string>> = {
      ended: ended.event.id,
      active: active.event.id,
      upcoming: upcoming.event.id,
    };

    for (const phase of ['ended', 'active', 'upcoming'] as const) {
      const body = await (await listEvents(auth.authorization, { phase })).json<EventListResponse>();
      // 与共享纯函数的结果一致：客户端用响应里的 serverTimeMs 复算阶段时必然得到同一集合。
      const expected = filterEvents(all, { nowMs: body.serverTimeMs, phase });
      expect(body.events.map((event) => event.id)).toEqual(expected.map((event) => event.id));
      expect(body.events.map((event) => event.id)).toEqual([expectedIdByPhase[phase]]);
    }

    // 不带 phase 时三条都在（默认按 startsAt 升序）。
    const allBody = await (await listEvents(auth.authorization)).json<EventListResponse>();
    expect(allBody.events.map((event) => event.id)).toEqual([
      ended.event.id,
      active.event.id,
      upcoming.event.id,
    ]);
  });
});

describe('幂等：同一 operationId 只写一次', () => {
  it('重放返回首次结果，且只创建一条', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const operationId = opId('replay-create');
    const body = {
      title: '幂等活动',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId,
    };
    const first = await SELF.fetch(URLS.meEvents, jsonPost(body, { Authorization: auth.authorization }));
    expect(first.status).toBe(201);
    const firstBody = await first.json<EventEnvelope>();

    const replay = await SELF.fetch(URLS.meEvents, jsonPost(body, { Authorization: auth.authorization }));
    expect(replay.status).toBe(201);
    const replayBody = await replay.json<EventEnvelope>();

    // 业务字段逐字节一致（`replayed` 是本次请求的元信息，不属于业务结果）。
    expect(replayBody.event).toEqual(firstBody.event);
    expect(replayBody.replayed).toBe(true);
    expect(await countActiveEvents(auth.workspaceId)).toBe(1);
    expect(await operationCounts(auth.workspaceId)).toEqual({ operations: 1, intents: 1 });
  });

  it('同一 operationId 换正文 → 409 且零写入', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const operationId = opId('mismatch-create');
    const first = await SELF.fetch(
      URLS.meEvents,
      jsonPost(
        { title: '第一次正文', region: 'cn', startsAt: now, endsAt: now + DAY_MS, operationId },
        { Authorization: auth.authorization },
      ),
    );
    expect(first.status).toBe(201);

    const mismatch = await SELF.fetch(
      URLS.meEvents,
      jsonPost(
        { title: '换了正文', region: 'cn', startsAt: now, endsAt: now + DAY_MS, operationId },
        { Authorization: auth.authorization },
      ),
    );
    expect(mismatch.status).toBe(409);
    const error = parseJson<ErrorEnvelope>(await mismatch.text());
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('与首次不同');

    expect(await countActiveEvents(auth.workspaceId)).toBe(1);
    expect(await operationCounts(auth.workspaceId)).toEqual({ operations: 1, intents: 1 });
  });

  it('同一 operationId 换目标（改另一条活动）→ 409 且另一条逐字节未变', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const first = await createEventOk(auth.authorization, {
      title: '活动甲',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('target-a'),
    });
    const second = await createEventOk(auth.authorization, {
      title: '活动乙',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('target-b'),
    });
    const shared = opId('shared-update');

    const firstPatch = await SELF.fetch(
      eventUrl(first.event.id),
      jsonPatch({ expectedRevision: 0, title: '甲已改名', operationId: shared }, { Authorization: auth.authorization }),
    );
    expect(firstPatch.status).toBe(200);
    const beforeSecond = JSON.stringify(await readEventRow(auth.workspaceId, second.event.id));

    const reused = await SELF.fetch(
      eventUrl(second.event.id),
      jsonPatch({ expectedRevision: 0, title: '乙被偷改', operationId: shared }, { Authorization: auth.authorization }),
    );
    expect(reused.status).toBe(409);
    expect(parseJson<ErrorEnvelope>(await reused.text()).code).toBe('conflict');

    // 零写入：目标未变、首次结果仍在、账本没有因被拒绝的调用多出行
    //（三条成功写入：创建甲、创建乙、改甲；被拒绝的那次不留下任何痕迹）。
    expect(JSON.stringify(await readEventRow(auth.workspaceId, second.event.id))).toBe(beforeSecond);
    expect((await readEventRow(auth.workspaceId, first.event.id))?.title).toBe('甲已改名');
    expect(await operationCounts(auth.workspaceId)).toEqual({ operations: 3, intents: 3 });
  });

  it('换一个 operationId（内容相同）会再创建一条：去重是按 operationId，不是按内容', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    await createEventOk(auth.authorization, {
      title: '同样的活动',
      region: 'cn',
      startsAt: now,
      endsAt: now + DAY_MS,
      operationId: opId('distinct-1'),
    });
    await createEventOk(auth.authorization, {
      title: '同样的活动',
      region: 'cn',
      startsAt: now,
      endsAt: now + DAY_MS,
      operationId: opId('distinct-2'),
    });
    expect(await countActiveEvents(auth.workspaceId)).toBe(2);
  });

  it('更新重放：带着同样的过期 expectedRevision 原样重试 → 返回首次结果，而不是 409', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const created = await createEventOk(auth.authorization, {
      title: '重放前标题',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('replay-upd-create'),
    });
    const operationId = opId('replay-upd');
    const body = { expectedRevision: 0, title: '重放后标题', operationId };

    const first = await SELF.fetch(
      eventUrl(created.event.id),
      jsonPatch(body, { Authorization: auth.authorization }),
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json<EventEnvelope>();
    expect(firstBody.event.revision).toBe(1);

    // 首次成功之后行内 revision 已经变成 1，单纯走 CAS 会把这次重试早退成 409；
    // 幂等短路必须发生在新鲜度判断之前（否则「响应丢失后的重试」拿不到首次结果）。
    const replay = await SELF.fetch(
      eventUrl(created.event.id),
      jsonPatch(body, { Authorization: auth.authorization }),
    );
    expect(replay.status).toBe(200);
    const replayBody = await replay.json<EventEnvelope>();
    expect(replayBody.event).toEqual(firstBody.event);
    expect(replayBody.replayed).toBe(true);
    expect(await operationCounts(auth.workspaceId)).toEqual({ operations: 2, intents: 2 });
  });

  it('删除重放：同一 operationId 重试墓碑化 → 返回同一墓碑，且不产生第二行', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const created = await createEventOk(auth.authorization, {
      title: '待删除活动',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('replay-del-create'),
    });
    const operationId = opId('replay-del');
    const body = { expectedRevision: 0, operationId };

    const first = await SELF.fetch(
      eventUrl(created.event.id),
      jsonDelete(body, { Authorization: auth.authorization }),
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json<EventEnvelope>();

    const replay = await SELF.fetch(
      eventUrl(created.event.id),
      jsonDelete(body, { Authorization: auth.authorization }),
    );
    expect(replay.status).toBe(200);
    const replayBody = await replay.json<EventEnvelope>();
    expect(replayBody.event).toEqual(firstBody.event);
    expect(replayBody.replayed).toBe(true);
    expect(await operationCounts(auth.workspaceId)).toEqual({ operations: 2, intents: 2 });
  });
});

describe('并发冲突：过期的 expectedRevision', () => {
  it('用过期 revision 更新 → 409 + 结构化 details，且行未被修改', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const created = await createEventOk(auth.authorization, {
      title: '原始标题',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('cas-create'),
    });
    const firstUpdate = await SELF.fetch(
      eventUrl(created.event.id),
      jsonPatch(
        { expectedRevision: 0, title: '第一次修改', operationId: opId('cas-update-1') },
        { Authorization: auth.authorization },
      ),
    );
    expect(firstUpdate.status).toBe(200);
    const rowBefore = JSON.stringify(await readEventRow(auth.workspaceId, created.event.id));

    const stale = await SELF.fetch(
      eventUrl(created.event.id),
      jsonPatch(
        { expectedRevision: 0, title: '基于过期 revision 的修改', operationId: opId('cas-update-2') },
        { Authorization: auth.authorization },
      ),
    );
    expect(stale.status).toBe(409);
    const error = parseJson<ErrorEnvelope>(await stale.text());
    expect(error.code).toBe('conflict');
    const conflict = error.details?.conflict;
    expect(conflict?.reason).toBe('revision_conflict');
    expect(conflict?.entityType).toBe('workspace_event');
    expect(conflict?.entityId).toBe(created.event.id);
    expect(conflict?.field).toBeNull();
    expect(conflict?.baseRevision).toBe(0);
    expect(conflict?.currentRevision).toBe(1);
    expect(conflict?.resolutionOptions).toEqual(['local', 'server']);

    expect(JSON.stringify(await readEventRow(auth.workspaceId, created.event.id))).toBe(rowBefore);
  });
});

describe('越权：A 的凭证不能操作 B 的活动', () => {
  it('PATCH / DELETE B 的活动 → 404，且 B 的行逐字节未变', async () => {
    const alice = await seedAuth();
    const bob = await seedAuth();
    const now = Date.now();
    const bobEvent = await createEventOk(bob.authorization, {
      title: 'B 的活动',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('bob-create'),
    });
    const before = JSON.stringify(await readEventRow(bob.workspaceId, bobEvent.event.id));

    const patchByAlice = await SELF.fetch(
      eventUrl(bobEvent.event.id),
      jsonPatch(
        { expectedRevision: 0, title: 'A 试图改名', operationId: opId('alice-patch') },
        { Authorization: alice.authorization },
      ),
    );
    expect(patchByAlice.status).toBe(404);
    expect(parseJson<ErrorEnvelope>(await patchByAlice.text()).code).toBe('not_found');

    const deleteByAlice = await SELF.fetch(
      eventUrl(bobEvent.event.id),
      jsonDelete({ expectedRevision: 0, operationId: opId('alice-delete') }, { Authorization: alice.authorization }),
    );
    expect(deleteByAlice.status).toBe(404);
    expect(parseJson<ErrorEnvelope>(await deleteByAlice.text()).code).toBe('not_found');

    expect(JSON.stringify(await readEventRow(bob.workspaceId, bobEvent.event.id))).toBe(before);
    // A 自己的列表不受影响，B 的活动仍然在 B 的列表里。
    const bobList = await (await listEvents(bob.authorization)).json<EventListResponse>();
    expect(bobList.events.map((event) => event.id)).toEqual([bobEvent.event.id]);
  });
});

describe('公共接口不泄露任何个人数据', () => {
  it('创建个人活动后 GET /api/v1/events 仍为空数组，且响应只有两个键', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    await createEventOk(auth.authorization, {
      title: '绝不应出现在公开接口的私密活动',
      description: '私人备注：绝不应出现在公开接口',
      region: 'cn',
      startsAt: now + DAY_MS,
      endsAt: now + 2 * DAY_MS,
      operationId: opId('privacy'),
    });

    const response = await SELF.fetch(URLS.publicEvents);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = parseJson<PublicEventListResponse>(text);
    expect(publicEventListResponseSchema.safeParse(body).success).toBe(true);
    expect(body.events).toEqual([]);
    expect(Number.isInteger(body.serverTimeMs)).toBe(true);
    // 严格两个键：任何多出来的字段都会让共享的严格 Schema 失败。
    expect(Object.keys(body).sort()).toEqual(['events', 'serverTimeMs']);
    expect(text).not.toContain('私密活动');
    expect(text).not.toContain('私人备注');

    // 数据库事实：公共表在阶段 04 是空表，个人行在另一张表。
    const publicCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>();
    expect(publicCount?.count).toBe(0);
  });

  it('公共表有夹具行时按 region / phase 正确过滤（只作用于公共数据）', async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO events (id, region, title, description, starts_at, ends_at, source_url, source_name,
                           verification_status, created_at, updated_at)
       VALUES (?, 'cn', ?, '', ?, ?, ?, ?, 'verified', ?, ?)`,
    )
      .bind(
        'public-cn-upcoming',
        '公共来源活动（国服）',
        now + DAY_MS,
        now + 2 * DAY_MS,
        'https://example.com/public',
        '官方公告',
        now,
        now,
      )
      .run();

    const cnUpcoming = await SELF.fetch(publicEventsUrl({ region: 'cn', phase: 'upcoming' }));
    expect(cnUpcoming.status).toBe(200);
    const cnUpcomingBody = await cnUpcoming.json<PublicEventListResponse>();
    expect(publicEventListResponseSchema.safeParse(cnUpcomingBody).success).toBe(true);
    expect(cnUpcomingBody.events.map((event) => event.id)).toEqual(['public-cn-upcoming']);
    expect(cnUpcomingBody.events[0]?.sourceName).toBe('官方公告');

    const globalList = await (await SELF.fetch(publicEventsUrl({ region: 'global' }))).json<PublicEventListResponse>();
    expect(globalList.events).toEqual([]);

    const endedList = await (await SELF.fetch(publicEventsUrl({ phase: 'ended' }))).json<PublicEventListResponse>();
    expect(endedList.events).toEqual([]);

    const textList = await (await SELF.fetch(publicEventsUrl({ text: '国服' }))).json<PublicEventListResponse>();
    expect(textList.events.map((event) => event.id)).toEqual(['public-cn-upcoming']);
  });
});

describe('上限：每工作空间 200 条活跃个人活动', () => {
  /** 直接种活跃行（夹具），避免用 200 次 HTTP 往返测一个纯计数边界。 */
  async function seedActiveEvents(workspaceId: string, count: number, tombstoneLast: boolean): Promise<void> {
    const now = Date.now();
    const statements = Array.from({ length: count }, (_unused, index) =>
      env.DB.prepare(
        `INSERT INTO workspace_events (id, workspace_id, title, description, region, starts_at, ends_at,
                                       source_url, verification_status, revision, deleted_at, created_at,
                                       updated_at, created_by_device)
         VALUES (?, ?, ?, '', 'cn', ?, ?, NULL, 'unverified', 0, ?, ?, ?, NULL)`,
      ).bind(
        crypto.randomUUID(),
        workspaceId,
        `夹具活动 ${index}`,
        now,
        now + DAY_MS,
        tombstoneLast && index === count - 1 ? now : null,
        now,
        now,
      ),
    );
    await env.DB.batch(statements);
  }

  it('已满 200 条时创建 → 409（冲突而不是静默丢弃），且没有多出行', async () => {
    const auth = await seedAuth();
    await seedActiveEvents(auth.workspaceId, 200, false);
    const now = Date.now();

    const response = await SELF.fetch(
      URLS.meEvents,
      jsonPost(
        { title: '第 201 条', region: 'cn', startsAt: now, endsAt: now + DAY_MS, operationId: opId('limit') },
        { Authorization: auth.authorization },
      ),
    );
    expect(response.status).toBe(409);
    const error = parseJson<ErrorEnvelope>(await response.text());
    expect(error.code).toBe('conflict');
    expect(await countActiveEvents(auth.workspaceId)).toBe(200);
    expect(await operationCounts(auth.workspaceId)).toEqual({ operations: 0, intents: 0 });
  });

  it('墓碑行不占额度：199 条活跃 + 1 条墓碑时仍可创建', async () => {
    const auth = await seedAuth();
    await seedActiveEvents(auth.workspaceId, 200, true);
    expect(await countActiveEvents(auth.workspaceId)).toBe(199);
    const now = Date.now();

    const created = await createEventOk(auth.authorization, {
      title: '第 200 条（额度内）',
      region: 'cn',
      startsAt: now,
      endsAt: now + DAY_MS,
      operationId: opId('limit-ok'),
    });
    expect(created.event.revision).toBe(0);
    expect(await countActiveEvents(auth.workspaceId)).toBe(200);
  });
});

describe('verification_status 恒为 unverified', () => {
  it('省略该字段 → unverified（响应与数据库一致）', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const created = await createEventOk(auth.authorization, {
      title: '未声明验证状态',
      region: 'cn',
      startsAt: now,
      endsAt: now + DAY_MS,
      operationId: opId('vs-omit'),
    });
    expect(created.event.verificationStatus).toBe('unverified');
    expect((await readEventRow(auth.workspaceId, created.event.id))?.verification_status).toBe('unverified');
  });

  it('客户端声明 verified 也不生效：用户自述来源永不自动变成 verified', async () => {
    const auth = await seedAuth();
    const now = Date.now();
    const created = await createEventOk(auth.authorization, {
      title: '自称已核实',
      region: 'cn',
      startsAt: now,
      endsAt: now + DAY_MS,
      verificationStatus: 'verified',
      operationId: opId('vs-claim'),
    });
    expect(created.event.verificationStatus).toBe('unverified');
    expect((await readEventRow(auth.workspaceId, created.event.id))?.verification_status).toBe('unverified');

    // 更新路径同样不可能把它改成 verified。
    const patched = await SELF.fetch(
      eventUrl(created.event.id),
      jsonPatch(
        { expectedRevision: 0, title: '更新后仍为未验证', operationId: opId('vs-update') },
        { Authorization: auth.authorization },
      ),
    );
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json<EventEnvelope>();
    expect(patchedBody.event.verificationStatus).toBe('unverified');
    expect((await readEventRow(auth.workspaceId, created.event.id))?.verification_status).toBe('unverified');
  });
});
