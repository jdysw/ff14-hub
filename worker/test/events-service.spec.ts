/**
 * 个人活动服务（HUB-011）——**真实 workerd + D1** 的服务层验收。
 *
 * 为什么与服务端 HTTP 规范分开：HTTP 层验证「路由/中间件/错误码」，这里验证
 * 「服务层是权威校验点」——直连服务的调用（测试、将来的内部调用）同样必须
 * 拿到结构化判定（`invalid_input` / `revision_conflict` / `event_limit_reached`），
 * 而不是把非法值写进数据库、让 CHECK 约束把整个 batch 变成 500。
 *
 * 覆盖范围：拒绝原因集合与错误码映射、阶段/区服/关键字筛选与共享纯函数一致、
 * 结构化 revision 冲突、墓碑语义、幂等指纹（同 ID 换正文/换目标）、上限边界、
 * `verification_status` 恒为 unverified、以及「公共表与个人表互不串数据」。
 */
import {
  API_ERROR_CODES,
  eventListResponseSchema,
  filterEvents,
  publicEventListResponseSchema,
  sortEvents,
  type EventSortOrder,
} from '@ff14-hub/shared';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEventService,
  MAX_PERSONAL_EVENTS_PER_WORKSPACE,
  type CreatePersonalEventInput,
  type EventService,
} from '../modules/events/service';
import {
  ERROR_CODE_BY_EVENT_REJECTION,
  EVENT_OP_KINDS,
  EVENT_REJECTIONS,
  isEventRejection,
  type EventFailure,
  type EventResult,
} from '../modules/events/tx';
import { opId, resetIdentityState, seedAuth } from './helpers';

const DAY_MS = 86_400_000;

/** 固定时钟：服务层的时间戳与阶段判定因此完全确定，不依赖真实流逝的时间。 */
const FIXED_NOW = 1_700_000_000_000;

function serviceWithFixedClock(): EventService {
  return createEventService({ db: env.DB, now: () => FIXED_NOW });
}

/** 断言服务调用成功并取出值（失败时把原因带进断言消息，便于定位）。 */
function expectOk<T>(result: EventResult<T>): T {
  expect(result.ok, result.ok ? '' : `期望成功，实际失败：${result.reason}（${result.detail}）`).toBe(true);
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.reason}`);
  }
  return result.value;
}

/** 断言服务调用失败并取出失败原因。 */
function expectFailure<T>(result: EventResult<T>): EventFailure {
  expect(result.ok, '期望失败，实际成功').toBe(false);
  if (result.ok) {
    throw new Error('期望失败，实际成功');
  }
  return result;
}

function baseCreateInput(overrides: Partial<CreatePersonalEventInput> = {}): CreatePersonalEventInput {
  return {
    title: '服务层活动',
    description: '',
    region: 'cn',
    startsAt: FIXED_NOW + DAY_MS,
    endsAt: FIXED_NOW + 2 * DAY_MS,
    ...overrides,
  };
}

/** 插入一条公共来源活动夹具（真实走 CHECK 约束）。 */
async function insertPublicEvent(input: {
  readonly id: string;
  readonly region: 'cn' | 'global';
  readonly title: string;
  readonly description?: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly sourceName?: string;
  readonly verificationStatus?: 'verified' | 'unverified';
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (id, region, title, description, starts_at, ends_at, source_url, source_name,
                         verification_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.region,
      input.title,
      input.description ?? '',
      input.startsAt,
      input.endsAt,
      `https://example.com/${input.id}`,
      input.sourceName ?? '官方公告',
      input.verificationStatus ?? 'verified',
      FIXED_NOW,
      FIXED_NOW,
    )
    .run();
}

/** 直接种若干活跃/墓碑个人活动行（用于上限边界，避免上千次服务调用）。 */
async function seedPersonalEvents(
  workspaceId: string,
  count: number,
  options: { readonly tombstoneLast?: boolean } = {},
): Promise<void> {
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
      FIXED_NOW + DAY_MS,
      FIXED_NOW + 2 * DAY_MS,
      options.tombstoneLast === true && index === count - 1 ? FIXED_NOW : null,
      FIXED_NOW,
      FIXED_NOW,
    ),
  );
  await env.DB.batch(statements);
}

async function countActiveEvents(workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM workspace_events WHERE workspace_id = ? AND deleted_at IS NULL',
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

beforeEach(async () => {
  await resetIdentityState();
  await env.DB.prepare('DELETE FROM events').run();
});

describe('tx 常量与拒绝原因映射', () => {
  it('kind 常量固定为 event.create / event.update / event.delete', () => {
    expect(EVENT_OP_KINDS).toEqual({
      create: 'event.create',
      update: 'event.update',
      delete: 'event.delete',
    });
  });

  it('每个拒绝原因都映射到契约内的错误码（未知字符串不会被当成合法原因）', () => {
    for (const reason of EVENT_REJECTIONS) {
      expect(API_ERROR_CODES, `reason=${reason}`).toContain(ERROR_CODE_BY_EVENT_REJECTION[reason]);
    }
    // 关键映射：not_found→404、冲突→409、校验→422、内部→500。
    expect(ERROR_CODE_BY_EVENT_REJECTION.event_not_found).toBe('not_found');
    expect(ERROR_CODE_BY_EVENT_REJECTION.revision_conflict).toBe('conflict');
    expect(ERROR_CODE_BY_EVENT_REJECTION.event_limit_reached).toBe('conflict');
    expect(ERROR_CODE_BY_EVENT_REJECTION.operation_id_reused).toBe('conflict');
    expect(ERROR_CODE_BY_EVENT_REJECTION.operation_payload_mismatch).toBe('conflict');
    expect(ERROR_CODE_BY_EVENT_REJECTION.invalid_input).toBe('validation_failed');
    expect(ERROR_CODE_BY_EVENT_REJECTION.persist_failed).toBe('internal_error');

    expect(isEventRejection('revision_conflict')).toBe(true);
    expect(isEventRejection('page_not_found')).toBe(false);
    expect(isEventRejection('')).toBe(false);
  });
});

describe('listPublic：只读公共表，筛选/排序复用共享纯函数', () => {
  it('空表返回空数组与 serverTimeMs，且严格符合公共响应契约', async () => {
    const service = serviceWithFixedClock();
    const body = await service.listPublic({ nowMs: FIXED_NOW });
    expect(body.events).toEqual([]);
    expect(body.serverTimeMs).toBe(FIXED_NOW);
    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(['events', 'serverTimeMs']);
    expect(publicEventListResponseSchema.safeParse(body).success).toBe(true);
  });

  it('区服 / 阶段 / 关键字筛选与排序与共享纯函数完全一致', async () => {
    await insertPublicEvent({
      id: 'pub-cn-ended',
      region: 'cn',
      title: '国服已结束活动',
      description: '蛮神祭',
      startsAt: FIXED_NOW - 3 * DAY_MS,
      endsAt: FIXED_NOW - DAY_MS,
    });
    await insertPublicEvent({
      id: 'pub-cn-upcoming',
      region: 'cn',
      title: '国服未开始活动',
      description: '零式开放',
      startsAt: FIXED_NOW + DAY_MS,
      endsAt: FIXED_NOW + 2 * DAY_MS,
    });
    await insertPublicEvent({
      id: 'pub-global-active',
      region: 'global',
      title: '国际服进行中活动',
      description: 'Moonfire Faire',
      startsAt: FIXED_NOW - 60_000,
      endsAt: FIXED_NOW + 60_000,
    });

    const service = serviceWithFixedClock();

    for (const query of [
      { region: 'cn' as const },
      { region: 'global' as const },
      { phase: 'ended' as const },
      { phase: 'active' as const },
      { phase: 'upcoming' as const },
      { region: 'cn' as const, phase: 'upcoming' as const },
      { text: '蛮神' },
      { text: 'moonfire' },
    ]) {
      const body = await service.listPublic({ ...query, nowMs: FIXED_NOW });
      const expected = sortEvents(
        filterEvents(
          [
            {
              id: 'pub-cn-ended',
              region: 'cn',
              title: '国服已结束活动',
              description: '蛮神祭',
              startsAt: FIXED_NOW - 3 * DAY_MS,
              endsAt: FIXED_NOW - DAY_MS,
            },
            {
              id: 'pub-cn-upcoming',
              region: 'cn',
              title: '国服未开始活动',
              description: '零式开放',
              startsAt: FIXED_NOW + DAY_MS,
              endsAt: FIXED_NOW + 2 * DAY_MS,
            },
            {
              id: 'pub-global-active',
              region: 'global',
              title: '国际服进行中活动',
              description: 'Moonfire Faire',
              startsAt: FIXED_NOW - 60_000,
              endsAt: FIXED_NOW + 60_000,
            },
          ],
          { ...query, nowMs: FIXED_NOW },
        ),
        'startsAt',
      );
      expect(body.events.map((event) => event.id), JSON.stringify(query)).toEqual(
        expected.map((event) => event.id),
      );
    }

    // 排序参数：降序就是「最新在前」，且并列项以 id 升序兜底（与共享实现一致）。
    const ascending = await service.listPublic({ nowMs: FIXED_NOW, sort: 'startsAt' });
    const descending = await service.listPublic({ nowMs: FIXED_NOW, sort: 'startsAtDesc' });
    expect(ascending.events.map((event) => event.id)).toEqual([
      'pub-cn-ended',
      'pub-global-active',
      'pub-cn-upcoming',
    ]);
    expect(descending.events.map((event) => event.id)).toEqual([
      'pub-cn-upcoming',
      'pub-global-active',
      'pub-cn-ended',
    ]);
    const sortOrder: EventSortOrder = 'startsAtDesc';
    expect(descending.events.map((event) => event.id)).toEqual(
      sortEvents(ascending.events, sortOrder).map((event) => event.id),
    );
  });
});

describe('createPersonal：服务层是权威校验点', () => {
  it('成功创建：revision 0、未删除、verificationStatus 恒为 unverified', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ sourceUrl: 'https://example.com/event' }),
        operationId: opId('svc-create'),
      }),
    );

    expect(created.event.revision).toBe(0);
    expect(created.event.deletedAt).toBeNull();
    expect(created.event.verificationStatus).toBe('unverified');
    expect(created.event.sourceUrl).toBe('https://example.com/event');
    expect(created.event.createdAt).toBe(FIXED_NOW);
    expect(created.event.updatedAt).toBe(FIXED_NOW);

    const read = await service.readPersonal(auth.workspaceId, created.event.id);
    expect(read).toEqual(created.event);
  });

  it('区服 both / 区间倒置 / 非法来源 / 空标题 → invalid_input，且零写入', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const cases: readonly { readonly input: CreatePersonalEventInput; readonly label: string }[] = [
      { input: baseCreateInput({ region: 'both' }), label: 'both' },
      { input: baseCreateInput({ startsAt: FIXED_NOW + 2 * DAY_MS, endsAt: FIXED_NOW + DAY_MS }), label: '区间倒置' },
      { input: baseCreateInput({ startsAt: 1.5 }), label: '非整数时间' },
      { input: baseCreateInput({ sourceUrl: 'http://example.com/x' }), label: 'http' },
      { input: baseCreateInput({ sourceUrl: 'javascript:alert(1)' }), label: 'javascript' },
      { input: baseCreateInput({ title: '' }), label: '空标题' },
      { input: baseCreateInput({ title: 'x'.repeat(121) }), label: '超长标题' },
      { input: baseCreateInput({ description: 'x'.repeat(1001) }), label: '超长描述' },
    ];

    for (const testCase of cases) {
      const failure = expectFailure(
        await service.createPersonal({
          workspaceId: auth.workspaceId,
          deviceId: auth.deviceId,
          input: testCase.input,
          operationId: opId(`svc-invalid-${testCase.label}`),
        }),
      );
      expect(failure.reason, testCase.label).toBe('invalid_input');
      expect(ERROR_CODE_BY_EVENT_REJECTION[failure.reason]).toBe('validation_failed');
    }

    expect(await countActiveEvents(auth.workspaceId)).toBe(0);
  });

  it('零长度区间合法；空串来源链接归一化为 NULL', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ startsAt: FIXED_NOW, endsAt: FIXED_NOW, sourceUrl: '' }),
        operationId: opId('svc-zero'),
      }),
    );
    expect(created.event.startsAt).toBe(FIXED_NOW);
    expect(created.event.endsAt).toBe(FIXED_NOW);
    expect(created.event.sourceUrl).toBeNull();

    const row = await env.DB.prepare('SELECT source_url FROM workspace_events WHERE id = ?')
      .bind(created.event.id)
      .first<{ source_url: string | null }>();
    expect(row?.source_url).toBeNull();
  });

  it('客户端声明 verified 也不生效（用户自述来源永不自动变成 verified）', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ verificationStatus: 'verified' }),
        operationId: opId('svc-verified-claim'),
      }),
    );
    expect(created.event.verificationStatus).toBe('unverified');
    const row = await env.DB.prepare('SELECT verification_status FROM workspace_events WHERE id = ?')
      .bind(created.event.id)
      .first<{ verification_status: string }>();
    expect(row?.verification_status).toBe('unverified');
  });

  it('列表只返回本工作空间、未删除的行，筛选与共享纯函数一致', async () => {
    const alice = await seedAuth();
    const bob = await seedAuth();
    const service = serviceWithFixedClock();
    const ended = expectOk(
      await service.createPersonal({
        workspaceId: alice.workspaceId,
        deviceId: alice.deviceId,
        input: baseCreateInput({
          title: '国服已结束',
          region: 'cn',
          startsAt: FIXED_NOW - 2 * DAY_MS,
          endsAt: FIXED_NOW - DAY_MS,
        }),
        operationId: opId('svc-list-ended'),
      }),
    );
    const active = expectOk(
      await service.createPersonal({
        workspaceId: alice.workspaceId,
        deviceId: alice.deviceId,
        input: baseCreateInput({
          title: '国际服进行中',
          region: 'global',
          startsAt: FIXED_NOW - 1_000,
          endsAt: FIXED_NOW + 1_000,
        }),
        operationId: opId('svc-list-active'),
      }),
    );
    expectOk(
      await service.createPersonal({
        workspaceId: bob.workspaceId,
        deviceId: bob.deviceId,
        input: baseCreateInput({ title: 'B 的活动' }),
        operationId: opId('svc-list-bob'),
      }),
    );

    const all = await service.listPersonal(alice.workspaceId, { nowMs: FIXED_NOW });
    expect(eventListResponseSchema.safeParse(all).success).toBe(true);
    expect(all.events.map((event) => event.id)).toEqual([ended.event.id, active.event.id]);
    expect(all.serverTimeMs).toBe(FIXED_NOW);

    const expectedNames = [
      { region: 'cn' as const },
      { region: 'global' as const },
      { phase: 'active' as const },
      { text: '国际' },
    ];
    for (const query of expectedNames) {
      const body = await service.listPersonal(alice.workspaceId, { ...query, nowMs: FIXED_NOW });
      const expected = filterEvents(all.events, { ...query, nowMs: FIXED_NOW });
      expect(body.events.map((event) => event.id), JSON.stringify(query)).toEqual(
        expected.map((event) => event.id),
      );
    }
  });
});

describe('updatePersonal：CAS 与结构化冲突', () => {
  it('成功更新：revision +1、updated_at 更新、其余字段来自补丁', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ sourceUrl: null }),
        operationId: opId('svc-upd-create'),
      }),
    );

    const updated = expectOk(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        patch: { title: '新标题', sourceUrl: 'https://example.com/new' },
        operationId: opId('svc-upd'),
      }),
    );
    expect(updated.event.title).toBe('新标题');
    expect(updated.event.sourceUrl).toBe('https://example.com/new');
    expect(updated.event.revision).toBe(1);
    expect(updated.event.createdAt).toBe(FIXED_NOW);
    expect(updated.event.updatedAt).toBe(FIXED_NOW);
  });

  it('过期 expectedRevision → revision_conflict + 结构化 details，且行未被修改', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput(),
        operationId: opId('svc-conflict-create'),
      }),
    );
    expectOk(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        patch: { title: '第一次修改' },
        operationId: opId('svc-conflict-1'),
      }),
    );
    const rowBefore = JSON.stringify(
      await env.DB.prepare('SELECT title, revision, updated_at FROM workspace_events WHERE id = ?')
        .bind(created.event.id)
        .first<Record<string, unknown>>(),
    );

    const failure = expectFailure(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        patch: { title: '基于过期基数' },
        operationId: opId('svc-conflict-2'),
      }),
    );
    expect(failure.reason).toBe('revision_conflict');
    expect(failure.details).toEqual({
      reason: 'revision_conflict',
      entityType: 'workspace_event',
      entityId: created.event.id,
      field: null,
      baseRevision: 0,
      currentRevision: 1,
      resolutionOptions: ['local', 'server'],
    });
    const rowAfter = JSON.stringify(
      await env.DB.prepare('SELECT title, revision, updated_at FROM workspace_events WHERE id = ?')
        .bind(created.event.id)
        .first<Record<string, unknown>>(),
    );
    expect(rowAfter).toBe(rowBefore);
  });

  it('合并后的区间非法（只改一端）→ invalid_input，且零写入', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput(),
        operationId: opId('svc-merge-create'),
      }),
    );
    const failure = expectFailure(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        patch: { startsAt: FIXED_NOW + 10 * DAY_MS },
        operationId: opId('svc-merge-bad'),
      }),
    );
    expect(failure.reason).toBe('invalid_input');
    const read = await service.readPersonal(auth.workspaceId, created.event.id);
    expect(read?.revision).toBe(0);
    expect(read?.startsAt).toBe(FIXED_NOW + DAY_MS);
  });

  it('空补丁 / 非法 operationId / 负数 expectedRevision → invalid_input', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput(),
        operationId: opId('svc-badupd-create'),
      }),
    );
    const emptyPatch = expectFailure(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        patch: {},
        operationId: opId('svc-badupd-1'),
      }),
    );
    expect(emptyPatch.reason).toBe('invalid_input');
    const badOperationId = expectFailure(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        patch: { title: 'x' },
        operationId: 'short',
      }),
    );
    expect(badOperationId.reason).toBe('invalid_input');
    const badRevision = expectFailure(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: -1,
        patch: { title: 'x' },
        operationId: opId('svc-badupd-2'),
      }),
    );
    expect(badRevision.reason).toBe('invalid_input');
  });
});

describe('deletePersonal：墓碑而非硬删', () => {
  it('墓碑化后行仍在、readPersonal 为 null、列表不再返回、再删返回 event_not_found', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput(),
        operationId: opId('svc-del-create'),
      }),
    );

    const deleted = expectOk(
      await service.deletePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        operationId: opId('svc-del'),
      }),
    );
    expect(deleted.event.deletedAt).toBe(FIXED_NOW);
    expect(deleted.event.revision).toBe(1);
    expect(await service.readPersonal(auth.workspaceId, created.event.id)).toBeNull();
    const list = await service.listPersonal(auth.workspaceId, { nowMs: FIXED_NOW });
    expect(list.events).toEqual([]);

    // 行仍在（墓碑），revision 与 deleted_at 已落库。
    const row = await env.DB.prepare('SELECT deleted_at, revision FROM workspace_events WHERE id = ?')
      .bind(created.event.id)
      .first<{ deleted_at: number | null; revision: number }>();
    expect(row?.deleted_at).toBe(FIXED_NOW);
    expect(row?.revision).toBe(1);

    // 用**新的** operationId 再删：墓碑已不可见 → not_found（不泄露「它曾经存在」）。
    const secondDelete = expectFailure(
      await service.deletePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 1,
        operationId: opId('svc-del-again'),
      }),
    );
    expect(secondDelete.reason).toBe('event_not_found');

    // 墓碑后更新同样 not_found。
    const updateAfterDelete = expectFailure(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 1,
        patch: { title: '复活尝试' },
        operationId: opId('svc-upd-deleted'),
      }),
    );
    expect(updateAfterDelete.reason).toBe('event_not_found');
  });

  it('删除时的过期 expectedRevision → revision_conflict，且墓碑未落下', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput(),
        operationId: opId('svc-delc-create'),
      }),
    );
    expectOk(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        patch: { title: '先改一次' },
        operationId: opId('svc-delc-upd'),
      }),
    );

    const failure = expectFailure(
      await service.deletePersonal({
        workspaceId: auth.workspaceId,
        eventId: created.event.id,
        expectedRevision: 0,
        operationId: opId('svc-delc-stale'),
      }),
    );
    expect(failure.reason).toBe('revision_conflict');
    expect(failure.details).toMatchObject({ currentRevision: 1, baseRevision: 0 });
    const row = await env.DB.prepare('SELECT deleted_at FROM workspace_events WHERE id = ?')
      .bind(created.event.id)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeNull();
  });
});

describe('幂等：指纹绑定请求意图', () => {
  it('同一 operationId 重放 → replayed=true 且只写一条', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const input = baseCreateInput({ title: '幂等活动' });
    const operationId = opId('svc-replay');
    const first = expectOk(
      await service.createPersonal({ workspaceId: auth.workspaceId, deviceId: auth.deviceId, input, operationId }),
    );
    const replay = expectOk(
      await service.createPersonal({ workspaceId: auth.workspaceId, deviceId: auth.deviceId, input, operationId }),
    );
    expect(replay).toEqual(first);
    expect(await countActiveEvents(auth.workspaceId)).toBe(1);
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM event_operations WHERE workspace_id = ?) AS operations,
              (SELECT COUNT(*) FROM event_operation_intents WHERE workspace_id = ?) AS intents`,
    )
      .bind(auth.workspaceId, auth.workspaceId)
      .first<{ operations: number; intents: number }>();
    expect(counts).toEqual({ operations: 1, intents: 1 });
  });

  it('同一 operationId 换正文 → operation_payload_mismatch 且零写入', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const operationId = opId('svc-mismatch');
    const first = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '第一次正文' }),
        operationId,
      }),
    );
    const failure = expectFailure(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '换了正文' }),
        operationId,
      }),
    );
    expect(failure.reason).toBe('operation_payload_mismatch');
    expect(ERROR_CODE_BY_EVENT_REJECTION[failure.reason]).toBe('conflict');
    expect(await countActiveEvents(auth.workspaceId)).toBe(1);
    expect(await service.readPersonal(auth.workspaceId, first.event.id)).toEqual(first.event);
  });

  it('同一 operationId 换目标（改另一条）→ operation_payload_mismatch', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const first = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '活动甲' }),
        operationId: opId('svc-target-a'),
      }),
    );
    const second = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '活动乙' }),
        operationId: opId('svc-target-b'),
      }),
    );
    const shared = opId('svc-target-shared');
    expectOk(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: first.event.id,
        expectedRevision: 0,
        patch: { title: '甲已改名' },
        operationId: shared,
      }),
    );

    const failure = expectFailure(
      await service.updatePersonal({
        workspaceId: auth.workspaceId,
        eventId: second.event.id,
        expectedRevision: 0,
        patch: { title: '乙被偷改' },
        operationId: shared,
      }),
    );
    expect(failure.reason).toBe('operation_payload_mismatch');
    const untouched = await service.readPersonal(auth.workspaceId, second.event.id);
    expect(untouched?.title).toBe('活动乙');
    expect(untouched?.revision).toBe(0);
  });

  it('更新重放：同样的过期 expectedRevision 原样重试 → 返回首次结果，而不是 revision_conflict', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '重放前标题' }),
        operationId: opId('svc-replay-upd-create'),
      }),
    );
    const operationId = opId('svc-replay-upd');
    const input = {
      workspaceId: auth.workspaceId,
      eventId: created.event.id,
      expectedRevision: 0,
      patch: { title: '重放后标题' },
      operationId,
    };
    const first = expectOk(await service.updatePersonal(input));
    expect(first.event.revision).toBe(1);

    // 首次成功后 revision 已是 1；若先做 CAS 判断，这次原样重试会被早退成 409，
    // 而幂等恰恰要在「响应丢失后的重试」这一刻生效。
    const replay = expectOk(await service.updatePersonal(input));
    expect(replay).toEqual(first);
    const counts = await env.DB.prepare('SELECT COUNT(*) AS count FROM event_operations WHERE workspace_id = ?')
      .bind(auth.workspaceId)
      .first<{ count: number }>();
    expect(counts?.count).toBe(2);
  });

  it('删除重放：同一 operationId 重试墓碑化 → 返回同一墓碑（而不是 not_found）', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput(),
        operationId: opId('svc-replay-del-create'),
      }),
    );
    const input = {
      workspaceId: auth.workspaceId,
      eventId: created.event.id,
      expectedRevision: 0,
      operationId: opId('svc-replay-del'),
    };
    const first = expectOk(await service.deletePersonal(input));
    const replay = expectOk(await service.deletePersonal(input));
    expect(replay).toEqual(first);
    expect(replay.event.deletedAt).toBe(FIXED_NOW);
    expect(await countActiveEvents(auth.workspaceId)).toBe(0);
  });
});

describe('上限与公共/个人隔离', () => {
  it(`活跃行达到 ${MAX_PERSONAL_EVENTS_PER_WORKSPACE} 条 → event_limit_reached（冲突，不是丢弃）`, async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    await seedPersonalEvents(auth.workspaceId, MAX_PERSONAL_EVENTS_PER_WORKSPACE);
    expect(await countActiveEvents(auth.workspaceId)).toBe(MAX_PERSONAL_EVENTS_PER_WORKSPACE);

    const failure = expectFailure(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '超限活动' }),
        operationId: opId('svc-limit'),
      }),
    );
    expect(failure.reason).toBe('event_limit_reached');
    expect(ERROR_CODE_BY_EVENT_REJECTION[failure.reason]).toBe('conflict');
    expect(await countActiveEvents(auth.workspaceId)).toBe(MAX_PERSONAL_EVENTS_PER_WORKSPACE);
    const operations = await env.DB.prepare('SELECT COUNT(*) AS count FROM event_operations WHERE workspace_id = ?')
      .bind(auth.workspaceId)
      .first<{ count: number }>();
    expect(operations?.count).toBe(0);
  });

  it('墓碑不占额度：上限 - 1 条活跃时可创建到上限', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    await seedPersonalEvents(auth.workspaceId, MAX_PERSONAL_EVENTS_PER_WORKSPACE, { tombstoneLast: true });
    expect(await countActiveEvents(auth.workspaceId)).toBe(MAX_PERSONAL_EVENTS_PER_WORKSPACE - 1);

    const created = expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '最后一个名额' }),
        operationId: opId('svc-limit-ok'),
      }),
    );
    expect(created.event.revision).toBe(0);
    expect(await countActiveEvents(auth.workspaceId)).toBe(MAX_PERSONAL_EVENTS_PER_WORKSPACE);
  });

  it('个人活动绝不会出现在公共列表里', async () => {
    const auth = await seedAuth();
    const service = serviceWithFixedClock();
    expectOk(
      await service.createPersonal({
        workspaceId: auth.workspaceId,
        deviceId: auth.deviceId,
        input: baseCreateInput({ title: '私有活动' }),
        operationId: opId('svc-privacy'),
      }),
    );
    const publicList = await service.listPublic({ nowMs: FIXED_NOW });
    expect(publicList.events).toEqual([]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});
