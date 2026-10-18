/**
 * 跨设备同步契约测试（HUB-051 / ADR-0004 D7）。
 *
 * 重点在两个最容易写错、且错了会**静默丢变更**的地方：
 * - 游标编解码：非法输入必须明确拒绝（绝不猜成 0，否则等于悄悄触发全量重扫）；
 * - 分页推进：`returned == limit` 时游标**停在同一毫秒**（宁可下一轮重复，也不漏行）。
 *
 * 相对导入 `../src/sync-api`：本文件要能独立验证新契约，不依赖 barrel 是否接线。
 */
import { describe, expect, it } from 'vitest';
import {
  SYNC_CHANGE_OPS,
  SYNC_CONFLICT_REASONS,
  SYNC_CONFLICT_RESOLUTIONS,
  SYNC_CURSOR_PREFIX,
  SYNC_DEFAULT_LIMIT,
  SYNC_ENTITY_TYPES,
  SYNC_MAX_LIMIT,
  SYNC_MESSAGES,
  advanceCursor,
  compareSyncChanges,
  decodeSyncCursor,
  encodeSyncCursor,
  syncChangeSchema,
  syncChangesResponseSchema,
  syncConflictSchema,
  type SyncChange,
} from '../src/sync-api';

const T0 = 1_700_000_000_000;

function change(overrides: Partial<SyncChange> & { readonly entityId: string }): SyncChange {
  return {
    entityType: 'page',
    revision: 1,
    op: 'upsert',
    updatedAt: T0,
    payload: null,
    ...overrides,
    entityId: overrides.entityId,
  };
}

/** 客户端本地视图：按 (entityType, entityId) 幂等去重 —— 「后到的覆盖先到的」。 */
function mergeById(store: Map<string, SyncChange>, changes: readonly SyncChange[]): void {
  for (const item of changes) {
    store.set(`${item.entityType}:${item.entityId}`, item);
  }
}

/**
 * 模拟服务端扫描（与 ADR-0004 D7 一致）：`updated_at >= since`、按
 * `(updatedAt, entityType, entityId)` 稳定排序、`limit` 截断，然后用 `advanceCursor` 推游标。
 */
function scanPage(
  all: readonly SyncChange[],
  sinceMs: number,
  limit: number,
): { readonly changes: SyncChange[]; readonly nextCursor: string; readonly hasMore: boolean } {
  const window = [...all]
    .sort(compareSyncChanges)
    .filter((item) => item.updatedAt >= sinceMs)
    .slice(0, limit);
  const last = window.at(-1);
  const advanced = advanceCursor({
    returned: window.length,
    limit,
    // 空窗口时「最后时间戳」没有意义：沿用本轮起点，游标因此前移到 since + 1。
    lastUpdatedAtMs: last?.updatedAt ?? sinceMs,
  });
  return { changes: window, nextCursor: advanced.nextCursor, hasMore: advanced.hasMore };
}

// ---------------------------------------------------------------------------

describe('常量与 ADR-0004 D7 的实体清单一致', () => {
  it('实体类型清单与顺序固定（顺序也是契约：响应 entityTypes 按它输出）', () => {
    expect(SYNC_ENTITY_TYPES).toEqual([
      'page',
      'widget',
      'layout',
      'nav_link',
      'nav_group',
      'nav_membership',
      'module',
      // 阶段 04 追加：个人活动（HUB-011）也进入同一条水位扫描，因此追加在末尾。
      'workspace_event',
    ]);
  });

  it('游标前缀与页大小限制', () => {
    expect(SYNC_CURSOR_PREFIX).toBe('v1:');
    expect(SYNC_DEFAULT_LIMIT).toBe(200);
    expect(SYNC_MAX_LIMIT).toBe(500);
    expect(SYNC_MAX_LIMIT).toBeGreaterThanOrEqual(SYNC_DEFAULT_LIMIT);
  });

  it('变更操作、冲突原因与处理方式都是白名单', () => {
    expect(SYNC_CHANGE_OPS).toEqual(['upsert', 'delete']);
    expect(SYNC_CONFLICT_REASONS).toEqual([
      'revision_conflict',
      'operation_payload_mismatch',
      'entity_not_found',
    ]);
    expect(SYNC_CONFLICT_RESOLUTIONS).toEqual(['local', 'server']);
  });

  it('提示文案明确「不自称已完成」', () => {
    expect(SYNC_MESSAGES.has_more.length).toBeGreaterThan(0);
    expect(SYNC_MESSAGES.cursor_malformed.length).toBeGreaterThan(0);
    expect(SYNC_MESSAGES.cursor_unsupported_version).toContain('版本');
  });
});

describe('encodeSyncCursor / decodeSyncCursor', () => {
  it('编码为 v1:<非负整数>', () => {
    expect(encodeSyncCursor(0)).toBe('v1:0');
    expect(encodeSyncCursor(T0)).toBe(`v1:${String(T0)}`);
  });

  it('往返一致（含 0 与最大安全整数）', () => {
    for (const value of [0, 1, T0, Number.MAX_SAFE_INTEGER]) {
      const encoded = encodeSyncCursor(value);
      expect(decodeSyncCursor(encoded)).toEqual({ ok: true, updatedAtMs: value });
    }
  });

  it('非法入参编码时抛错（不夹取成 0）', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeSyncCursor(bad)).toThrow(RangeError);
    }
  });

  it('非法游标一律明确拒绝，绝不猜成 0', () => {
    const malformed = [
      '',
      'abc',
      'v1',
      'v1:',
      'v1:-1',
      'v1:1.5',
      'v1:abc',
      'v1:007',
      'v1:1x',
      'v1 1',
      'V1:1',
      'v1:+1',
      'v1:99999999999999999999999',
    ];
    for (const raw of malformed) {
      expect(decodeSyncCursor(raw)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('未来版本与损坏输入分开报告（unsupported_version ≠ malformed）', () => {
    expect(decodeSyncCursor('v2:1')).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(decodeSyncCursor('v10:0')).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(decodeSyncCursor('abc')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('非字符串输入（null / 数字 / 对象）也是 malformed', () => {
    for (const raw of [null, undefined, 0, 1, {}, [], true]) {
      expect(decodeSyncCursor(raw)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('decode 的失败结果**不含** updatedAtMs 字段：调用方无法误用 0 当水位', () => {
    const result = decodeSyncCursor('abc');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
    expect(Object.hasOwn(result, 'updatedAtMs')).toBe(false);
  });
});

describe('compareSyncChanges：(updatedAt, entityType, entityId) 稳定排序', () => {
  it('先按时间，再按实体类型，最后按实体 ID', () => {
    const sorted = [
      change({ entityId: 'b', entityType: 'page', updatedAt: T0 + 1 }),
      change({ entityId: 'a', entityType: 'page', updatedAt: T0 }),
      change({ entityId: 'z', entityType: 'widget', updatedAt: T0 }),
      change({ entityId: 'a', entityType: 'widget', updatedAt: T0 }),
      change({ entityId: 'c', entityType: 'page', updatedAt: T0 }),
    ]
      .sort(compareSyncChanges)
      .map((item) => `${item.updatedAt}:${item.entityType}:${item.entityId}`);

    expect(sorted).toEqual([
      `${T0}:page:a`,
      `${T0}:page:c`,
      `${T0}:widget:a`,
      `${T0}:widget:z`,
      `${T0 + 1}:page:b`,
    ]);
  });

  it('同一毫秒内的相对顺序与输入顺序无关（确定性）', () => {
    const forward = [change({ entityId: 'a' }), change({ entityId: 'b' }), change({ entityId: 'c' })];
    const backward = [...forward].reverse();
    expect([...forward].sort(compareSyncChanges).map((item) => item.entityId)).toEqual(['a', 'b', 'c']);
    expect([...backward].sort(compareSyncChanges).map((item) => item.entityId)).toEqual(['a', 'b', 'c']);
  });

  it('完全相同的键返回 0', () => {
    expect(compareSyncChanges(change({ entityId: 'a' }), change({ entityId: 'a' }))).toBe(0);
  });

  it('不修改入参', () => {
    const original = [change({ entityId: 'b' }), change({ entityId: 'a' })];
    const snapshot = original.map((item) => item.entityId);
    [...original].sort(compareSyncChanges);
    expect(original.map((item) => item.entityId)).toEqual(snapshot);
  });
});

describe('advanceCursor：三种分页情形', () => {
  it('returned == 0：hasMore=false，游标前移到 lastUpdatedAtMs + 1', () => {
    expect(advanceCursor({ returned: 0, limit: 5, lastUpdatedAtMs: T0 })).toEqual({
      nextCursor: `v1:${String(T0 + 1)}`,
      hasMore: false,
    });
  });

  it('0 < returned < limit：hasMore=false，游标前移到 lastUpdatedAtMs + 1', () => {
    expect(advanceCursor({ returned: 2, limit: 5, lastUpdatedAtMs: T0 })).toEqual({
      nextCursor: `v1:${String(T0 + 1)}`,
      hasMore: false,
    });
  });

  it('returned == limit：hasMore=true，游标**停在**最后一个时间戳（不 +1）', () => {
    expect(advanceCursor({ returned: 5, limit: 5, lastUpdatedAtMs: T0 })).toEqual({
      nextCursor: `v1:${String(T0)}`,
      hasMore: true,
    });
  });

  it('limit == 1 的边界也遵守同一规则', () => {
    expect(advanceCursor({ returned: 1, limit: 1, lastUpdatedAtMs: T0 })).toEqual({
      nextCursor: `v1:${String(T0)}`,
      hasMore: true,
    });
    expect(advanceCursor({ returned: 0, limit: 1, lastUpdatedAtMs: T0 }).nextCursor).toBe(`v1:${String(T0 + 1)}`);
  });

  it('非法输入抛错（不静默修正，否则会把丢行掩盖过去）', () => {
    expect(() => advanceCursor({ returned: 6, limit: 5, lastUpdatedAtMs: T0 })).toThrow(RangeError);
    expect(() => advanceCursor({ returned: 1, limit: 0, lastUpdatedAtMs: T0 })).toThrow(RangeError);
    expect(() => advanceCursor({ returned: -1, limit: 5, lastUpdatedAtMs: T0 })).toThrow(RangeError);
    expect(() => advanceCursor({ returned: 1, limit: 5, lastUpdatedAtMs: -1 })).toThrow(RangeError);
    expect(() => advanceCursor({ returned: 1, limit: 1.5, lastUpdatedAtMs: T0 })).toThrow(RangeError);
  });
});

describe('分页场景：跨毫秒推进与「同一毫秒刚好等于 limit」', () => {
  it('跨毫秒：停驻会重复边界毫秒的行，客户端去重后不漏任何行', () => {
    const store: readonly SyncChange[] = [
      change({ entityId: 'p1', entityType: 'page', updatedAt: T0 }),
      change({ entityId: 'p2', entityType: 'page', updatedAt: T0 }),
      change({ entityId: 'p3', entityType: 'page', updatedAt: T0 + 1 }),
      change({ entityId: 'p4', entityType: 'page', updatedAt: T0 + 1 }),
    ];

    const round1 = scanPage(store, T0, 3);
    expect(round1.changes.map((item) => item.entityId)).toEqual(['p1', 'p2', 'p3']);
    expect(round1.hasMore).toBe(true);
    // 最后一行在 T0+1，所以游标停在 T0+1（下一轮会重复 p3）。
    expect(round1.nextCursor).toBe(`v1:${String(T0 + 1)}`);

    const decoded = decodeSyncCursor(round1.nextCursor);
    expect(decoded.ok).toBe(true);

    const round2 = scanPage(store, T0 + 1, 3);
    expect(round2.changes.map((item) => item.entityId)).toEqual(['p3', 'p4']);
    expect(round2.hasMore).toBe(false);
    expect(round2.nextCursor).toBe(`v1:${String(T0 + 2)}`);

    const merged = new Map<string, SyncChange>();
    mergeById(merged, round1.changes);
    mergeById(merged, round2.changes);
    expect([...merged.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['page:p1', 'page:p2', 'page:p3', 'page:p4']);
  });

  it('同一毫秒多行且刚好等于 limit：游标停在同一毫秒，下一轮仍返回这些行（宁可重复，绝不跳过）', () => {
    const store: readonly SyncChange[] = [
      change({ entityId: 'p1', updatedAt: T0 }),
      change({ entityId: 'p2', updatedAt: T0 }),
    ];
    const limit = 2;

    const round1 = scanPage(store, T0, limit);
    expect(round1.changes.map((item) => item.entityId)).toEqual(['p1', 'p2']);
    expect(round1.hasMore).toBe(true);
    // 关键断言：停在 T0，而不是 T0+1。
    expect(round1.nextCursor).toBe(`v1:${String(T0)}`);

    // 如果这里前移到 T0+1，就再也不会返回这些行 —— 那才是丢变更。
    const round2 = scanPage(store, T0, limit);
    expect(round2.changes.map((item) => item.entityId)).toEqual(['p1', 'p2']);
    expect(round2.nextCursor).toBe(`v1:${String(T0)}`);
    expect(round2.hasMore).toBe(true);

    // 客户端按实体 ID 幂等去重：重复不会产生第二条实体，也不会产生「已同步完成」的错觉。
    const merged = new Map<string, SyncChange>();
    mergeById(merged, round1.changes);
    mergeById(merged, round2.changes);
    expect(merged.size).toBe(2);
  });

  it('空窗口：returned == 0 → hasMore=false 且游标前移，不会原地打转', () => {
    const store: readonly SyncChange[] = [change({ entityId: 'p1', updatedAt: T0 })];
    const empty = scanPage(store, T0 + 5, 2);
    expect(empty.changes).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.nextCursor).toBe(`v1:${String(T0 + 6)}`);
  });
});

describe('syncChangeSchema：对 entityType / op 严格拒绝', () => {
  it('合法的 upsert 与 delete 都通过（delete 的 payload 为 null）', () => {
    expect(
      syncChangeSchema.safeParse({
        entityType: 'nav_link',
        entityId: 'link-1',
        op: 'upsert',
        revision: 7,
        updatedAt: T0,
        payload: { title: '官网', url: 'https://example.com' },
      }).success,
    ).toBe(true);
    expect(
      syncChangeSchema.safeParse({
        entityType: 'module',
        entityId: 'ff14.events',
        op: 'delete',
        revision: 3,
        updatedAt: T0,
        payload: null,
      }).success,
    ).toBe(true);
  });

  it('未知 entityType / op 一律拒绝（默认拒绝，不静默丢弃）', () => {
    const base = { entityType: 'page', entityId: 'p1', op: 'upsert', revision: 1, updatedAt: T0, payload: null };
    expect(syncChangeSchema.safeParse({ ...base, entityType: 'event' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, entityType: 'user' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, entityType: 'nav-link' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: 'update' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: 'remove' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: 'UPSERT' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: null }).success).toBe(false);
  });

  it('严格拒绝未知字段、负 revision、非整数时间戳与空 entityId', () => {
    const base = { entityType: 'page', entityId: 'p1', op: 'upsert', revision: 1, updatedAt: T0, payload: null };
    expect(syncChangeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, revision: -1 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, updatedAt: T0 + 0.5 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, entityId: '' }).success).toBe(false);
  });
});

describe('syncChangesResponseSchema / syncConflictSchema', () => {
  const validChange = {
    entityType: 'page',
    entityId: 'p1',
    op: 'upsert',
    revision: 1,
    updatedAt: T0,
    payload: null,
  };

  it('响应必须显式携带 entityTypes（客户端不能靠「没收到」推断「没有变更」）', () => {
    const ok = {
      changes: [validChange],
      nextCursor: `v1:${String(T0)}`,
      hasMore: true,
      serverTimeMs: T0,
      entityTypes: [...SYNC_ENTITY_TYPES],
    };
    expect(syncChangesResponseSchema.safeParse(ok).success).toBe(true);
    expect(syncChangesResponseSchema.safeParse({ ...ok, entityTypes: ['page', 'unknown_entity'] }).success).toBe(
      false,
    );
    // 缺 entityTypes：客户端将无法分辨「服务端已确认无变更」与「服务端根本没扫这个类型」。
    const withoutEntityTypes = {
      changes: ok.changes,
      nextCursor: ok.nextCursor,
      hasMore: ok.hasMore,
      serverTimeMs: ok.serverTimeMs,
    };
    expect(syncChangesResponseSchema.safeParse(withoutEntityTypes).success).toBe(false);
    expect(syncChangesResponseSchema.safeParse({ ...ok, nextCursor: null, hasMore: false }).success).toBe(true);
    expect(syncChangesResponseSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('冲突结构：可空字段用 null 表达「不存在」，而不是伪造 0', () => {
    const notFound = {
      reason: 'entity_not_found',
      entityType: 'nav_group',
      entityId: 'g1',
      field: null,
      baseRevision: null,
      currentRevision: null,
      resolutionOptions: ['server'],
    };
    expect(syncConflictSchema.safeParse(notFound).success).toBe(true);

    const revisionConflict = {
      reason: 'revision_conflict',
      entityType: 'layout',
      entityId: 'page-1:desktop',
      field: 'rects',
      baseRevision: 4,
      currentRevision: 6,
      resolutionOptions: ['local', 'server'],
    };
    expect(syncConflictSchema.safeParse(revisionConflict).success).toBe(true);
  });

  it('冲突原因/处理方式未知、或处理方式为空时拒绝', () => {
    const base = {
      reason: 'revision_conflict',
      entityType: 'page',
      entityId: 'p1',
      field: null,
      baseRevision: 0,
      currentRevision: 1,
      resolutionOptions: ['local', 'server'],
    };
    expect(syncConflictSchema.safeParse({ ...base, reason: 'conflict' }).success).toBe(false);
    expect(syncConflictSchema.safeParse({ ...base, resolutionOptions: [] }).success).toBe(false);
    expect(syncConflictSchema.safeParse({ ...base, resolutionOptions: ['both'] }).success).toBe(false);
    expect(syncConflictSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(syncConflictSchema.safeParse({ ...base, entityType: 'event' }).success).toBe(false);
  });
});
