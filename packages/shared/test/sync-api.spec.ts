/**
 * 跨设备同步契约测试（HUB-051 / ADR-0004 D7）。
 *
 * 重点在三个最容易写错、且错了会**静默丢变更**的地方：
 * - 游标编解码：v2 = **数据库单调变更序号**，不是时间戳；v1（毫秒）必须被**明确拒绝**
 *   （当成 seq 解释会静默漏变更或重放）；非法输入绝不猜成 0。
 * - 分页推进：seq 严格递增 ⇒ 每页取下一条之后的 `limit` 条即可，**不存在**
 *   「停在同一个时间戳反复扫」这种技巧，也不存在「同一毫秒被切成两页」。
 * - 变更元数据：`seq` 与响应 `meta` 都是必填——客户端据此排序/去重/推进全局 CAS。
 *
 * 相对导入 `../src/sync-api`：本文件要能独立验证新契约，不依赖 barrel 是否接线。
 */
import { describe, expect, it } from 'vitest';
import {
  LEGACY_SYNC_CURSOR_PREFIX,
  SYNC_CHANGE_OPS,
  SYNC_CONFLICT_REASONS,
  SYNC_CONFLICT_RESOLUTIONS,
  SYNC_CURSOR_PREFIX,
  SYNC_DEFAULT_LIMIT,
  SYNC_ENTITY_TYPES,
  SYNC_MAX_LIMIT,
  SYNC_MESSAGES,
  compareSyncChanges,
  decodeSyncCursor,
  encodeSyncCursor,
  nextSyncCursor,
  syncChangeSchema,
  syncChangesResponseSchema,
  syncConflictSchema,
  syncMetaSchema,
  type SyncChange,
} from '../src/sync-api';

const T0 = 1_700_000_000_000;

function change(overrides: Partial<SyncChange> & { readonly entityId: string }): SyncChange {
  return {
    seq: 1,
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
 * 模拟服务端扫描（与实现一致）：`seq > since`、按 **seq** 稳定排序、`limit` 截断，
 * 然后用共享 `nextSyncCursor` 推游标。
 */
function scanPage(
  all: readonly SyncChange[],
  sinceSeq: number,
  limit: number,
): { readonly changes: SyncChange[]; readonly nextCursor: string; readonly hasMore: boolean } {
  const window = [...all]
    .sort(compareSyncChanges)
    .filter((item) => item.seq > sinceSeq)
    .slice(0, limit);
  const advanced = nextSyncCursor({
    returned: window.length,
    limit,
    lastSeq: window.at(-1)?.seq ?? null,
    requestSeq: sinceSeq,
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

  it('游标前缀是 v2（单调序号）且旧版 v1 前缀只用于识别拒绝', () => {
    expect(SYNC_CURSOR_PREFIX).toBe('v2:');
    expect(LEGACY_SYNC_CURSOR_PREFIX).toBe('v1:');
    // 两个前缀必须不同：否则「拒绝旧游标」与「解析新游标」会互相吞掉。
    expect(SYNC_CURSOR_PREFIX.startsWith(LEGACY_SYNC_CURSOR_PREFIX)).toBe(false);
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
  it('编码为 v2:<非负整数>（序号，而不是毫秒）', () => {
    expect(encodeSyncCursor(0)).toBe('v2:0');
    expect(encodeSyncCursor(1)).toBe('v2:1');
    expect(encodeSyncCursor(T0)).toBe(`v2:${String(T0)}`);
  });

  it('往返一致（含 0 与最大安全整数）', () => {
    for (const value of [0, 1, 42, T0, Number.MAX_SAFE_INTEGER]) {
      const encoded = encodeSyncCursor(value);
      expect(decodeSyncCursor(encoded)).toEqual({ ok: true, seq: value });
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
      'v2',
      'v2:',
      'v2:-1',
      'v2:1.5',
      'v2:abc',
      'v2:007',
      'v2:1x',
      'v2 1',
      'V2:1',
      'v2:+1',
      'v2:99999999999999999999999',
      'v1',
      'v1abc',
    ];
    for (const raw of malformed) {
      expect(decodeSyncCursor(raw), `since=${raw}`).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('旧版时间戳游标（v1）单独报告 unsupported_version —— 绝不当成 seq 解释', () => {
    // 这是复核发现的真实缺陷：`v1:1760000000000` 若被当成 seq，会静默跳过大半条变更流。
    for (const raw of ['v1:0', 'v1:1', 'v1:123', 'v1:abc', 'v1:007', 'v1:1760000000000']) {
      expect(decodeSyncCursor(raw), `since=${raw}`).toEqual({
        ok: false,
        reason: 'unsupported_version',
      });
    }
  });

  it('未来版本与损坏输入分开报告（unsupported_version ≠ malformed）', () => {
    expect(decodeSyncCursor('v3:0')).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(decodeSyncCursor('v10:0')).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(decodeSyncCursor('abc')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('非字符串输入（null / 数字 / 对象）也是 malformed', () => {
    for (const raw of [null, undefined, 0, 1, {}, [], true]) {
      expect(decodeSyncCursor(raw)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('decode 的失败结果**不含** seq 字段：调用方无法误用 0 当水位', () => {
    const result = decodeSyncCursor('abc');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
    expect(Object.hasOwn(result, 'seq')).toBe(false);
    // 旧版契约的时间戳字段必须彻底消失：它的存在会让调用方继续走时间比较。
    expect(Object.hasOwn(result, 'updatedAtMs')).toBe(false);
  });
});

describe('compareSyncChanges：只按 seq 排序', () => {
  it('按 seq 升序，与 updatedAt / entityType / entityId 无关', () => {
    const sorted = [
      change({ entityId: 'b', entityType: 'page', seq: 5, updatedAt: T0 + 1 }),
      change({ entityId: 'a', entityType: 'page', seq: 2, updatedAt: T0 + 999 }),
      change({ entityId: 'z', entityType: 'widget', seq: 3, updatedAt: T0 }),
    ]
      .sort(compareSyncChanges)
      .map((item) => item.seq);

    expect(sorted).toEqual([2, 3, 5]);
  });

  it('时钟回退（updatedAt 变小）不改变顺序：seq 才是全序', () => {
    const sorted = [
      change({ entityId: 'later', seq: 9, updatedAt: T0 - 10_000 }),
      change({ entityId: 'earlier', seq: 8, updatedAt: T0 + 10_000 }),
    ]
      .sort(compareSyncChanges)
      .map((item) => item.entityId);
    expect(sorted).toEqual(['earlier', 'later']);
  });

  it('同一毫秒内的相对顺序与输入顺序无关（确定性）', () => {
    const forward = [
      change({ entityId: 'a', seq: 1 }),
      change({ entityId: 'b', seq: 2 }),
      change({ entityId: 'c', seq: 3 }),
    ];
    const backward = [...forward].reverse();
    expect([...forward].sort(compareSyncChanges).map((item) => item.entityId)).toEqual(['a', 'b', 'c']);
    expect([...backward].sort(compareSyncChanges).map((item) => item.entityId)).toEqual(['a', 'b', 'c']);
  });

  it('seq 相同即返回 0（其余字段不参与比较）', () => {
    expect(compareSyncChanges(change({ entityId: 'a', seq: 4 }), change({ entityId: 'a', seq: 4 }))).toBe(0);
    expect(
      compareSyncChanges(change({ entityId: 'a', entityType: 'page', seq: 4 }), change({ entityId: 'b', entityType: 'widget', seq: 4 })),
    ).toBe(0);
  });

  it('不修改入参', () => {
    const original = [change({ entityId: 'b', seq: 2 }), change({ entityId: 'a', seq: 1 })];
    const snapshot = original.map((item) => item.entityId);
    [...original].sort(compareSyncChanges);
    expect(original.map((item) => item.entityId)).toEqual(snapshot);
  });
});

describe('nextSyncCursor：三种分页情形', () => {
  it('returned == 0：hasMore=false，游标**停在请求游标**（不 +1，也不清空）', () => {
    expect(nextSyncCursor({ returned: 0, limit: 5, lastSeq: null, requestSeq: 7 })).toEqual({
      nextCursor: 'v2:7',
      hasMore: false,
    });
    // 首次全量（没有请求游标）时停在 0：与「从头开始」等价。
    expect(nextSyncCursor({ returned: 0, limit: 5, lastSeq: null, requestSeq: null })).toEqual({
      nextCursor: 'v2:0',
      hasMore: false,
    });
  });

  it('0 < returned < limit：hasMore=false，游标 = 最后一条的 seq', () => {
    expect(nextSyncCursor({ returned: 2, limit: 5, lastSeq: 11, requestSeq: 0 })).toEqual({
      nextCursor: 'v2:11',
      hasMore: false,
    });
  });

  it('returned == limit：hasMore=true，游标 = 最后一条的 seq（下一轮从它之后继续）', () => {
    expect(nextSyncCursor({ returned: 5, limit: 5, lastSeq: 12, requestSeq: 3 })).toEqual({
      nextCursor: 'v2:12',
      hasMore: true,
    });
  });

  it('limit == 1 的边界也遵守同一规则', () => {
    expect(nextSyncCursor({ returned: 1, limit: 1, lastSeq: 4, requestSeq: 3 })).toEqual({
      nextCursor: 'v2:4',
      hasMore: true,
    });
    expect(nextSyncCursor({ returned: 0, limit: 1, lastSeq: null, requestSeq: 3 }).nextCursor).toBe('v2:3');
  });

  it('游标**只前进或停驻**，绝不回退到请求游标之前', () => {
    const advanced = nextSyncCursor({ returned: 3, limit: 3, lastSeq: 9, requestSeq: 6 });
    const decoded = decodeSyncCursor(advanced.nextCursor);
    expect(decoded.ok && decoded.seq >= 6).toBe(true);
  });

  it('非法输入抛错（不静默修正，否则会把丢行掩盖过去）', () => {
    expect(() => nextSyncCursor({ returned: 6, limit: 5, lastSeq: 9, requestSeq: 0 })).toThrow(RangeError);
    expect(() => nextSyncCursor({ returned: 1, limit: 0, lastSeq: 9, requestSeq: 0 })).toThrow(RangeError);
    expect(() => nextSyncCursor({ returned: -1, limit: 5, lastSeq: 9, requestSeq: 0 })).toThrow(RangeError);
    expect(() => nextSyncCursor({ returned: 1.5, limit: 5, lastSeq: 9, requestSeq: 0 })).toThrow(RangeError);
    expect(() => nextSyncCursor({ returned: 1, limit: 1.5, lastSeq: 9, requestSeq: 0 })).toThrow(RangeError);
    // 有变更却缺 lastSeq：宁可抛错，也不能猜一个水位出来。
    expect(() => nextSyncCursor({ returned: 1, limit: 5, lastSeq: null, requestSeq: 0 })).toThrow(RangeError);
  });
});

describe('分页场景：seq 严格递增，既不漏也不重', () => {
  it('跨页：每页恰好消费 limit 条，下一页从最后一条 seq 之后继续', () => {
    const store: readonly SyncChange[] = [
      change({ entityId: 'p1', seq: 1 }),
      change({ entityId: 'p2', seq: 2 }),
      change({ entityId: 'p3', seq: 3 }),
      change({ entityId: 'p4', seq: 4 }),
    ];

    const round1 = scanPage(store, 0, 3);
    expect(round1.changes.map((item) => item.entityId)).toEqual(['p1', 'p2', 'p3']);
    expect(round1.hasMore).toBe(true);
    expect(round1.nextCursor).toBe('v2:3');

    const round2 = scanPage(store, 3, 3);
    expect(round2.changes.map((item) => item.entityId)).toEqual(['p4']);
    expect(round2.hasMore).toBe(false);
    expect(round2.nextCursor).toBe('v2:4');

    const merged = new Map<string, SyncChange>();
    mergeById(merged, round1.changes);
    mergeById(merged, round2.changes);
    expect([...merged.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'page:p1',
      'page:p2',
      'page:p3',
      'page:p4',
    ]);
  });

  it('恰好填满一页：hasMore 保守为 true，下一轮返回空且游标停驻（不丢、不重）', () => {
    const store: readonly SyncChange[] = [change({ entityId: 'p1', seq: 1 }), change({ entityId: 'p2', seq: 2 })];
    const limit = 2;

    const round1 = scanPage(store, 0, limit);
    expect(round1.changes.map((item) => item.entityId)).toEqual(['p1', 'p2']);
    expect(round1.hasMore).toBe(true);
    expect(round1.nextCursor).toBe('v2:2');

    // 关键：游标停在 2（而不是 3，也不是 0），因此既不会跳过 seq>2 的变更，也不会重放。
    const round2 = scanPage(store, 2, limit);
    expect(round2.changes).toEqual([]);
    expect(round2.hasMore).toBe(false);
    expect(round2.nextCursor).toBe('v2:2');

    // 新写入（seq=3）在下一轮立刻可见——这正是 v1 时间戳游标会丢掉的场景。
    const appended = [...store, change({ entityId: 'p3', seq: 3 })];
    expect(scanPage(appended, 2, limit).changes.map((item) => item.entityId)).toEqual(['p3']);
  });

  it('空窗口：returned == 0 → hasMore=false 且游标停驻，不会原地打转也不会倒退', () => {
    const store: readonly SyncChange[] = [change({ entityId: 'p1', seq: 1 })];
    const empty = scanPage(store, 9, 2);
    expect(empty.changes).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.nextCursor).toBe('v2:9');
  });

  it('所有页的 seq 并集 = 库内全部变更，且按页拼接后严格递增', () => {
    const store: readonly SyncChange[] = Array.from({ length: 7 }, (_unused, index) =>
      change({ entityId: `p${String(index + 1)}`, seq: index + 1 }),
    );
    const collected: number[] = [];
    let cursor = 0;
    for (let round = 0; round < 10; round += 1) {
      const page = scanPage(store, cursor, 3);
      collected.push(...page.changes.map((item) => item.seq));
      const decoded = decodeSyncCursor(page.nextCursor);
      if (!decoded.ok) {
        throw new Error(`服务端给出的游标不可解析：${page.nextCursor}`);
      }
      cursor = decoded.seq;
      if (!page.hasMore) {
        break;
      }
    }
    expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let index = 1; index < collected.length; index += 1) {
      expect(collected[index]).toBeGreaterThan(collected[index - 1] ?? 0);
    }
  });
});

describe('syncChangeSchema：seq 必填，且对 entityType / op 严格拒绝', () => {
  it('合法的 upsert 与 delete 都通过（delete 的 payload 为 null）', () => {
    expect(
      syncChangeSchema.safeParse({
        seq: 12,
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
        seq: 13,
        entityType: 'module',
        entityId: 'ff14.events',
        op: 'delete',
        revision: 3,
        updatedAt: T0,
        payload: null,
      }).success,
    ).toBe(true);
  });

  it('seq 必填且必须是正整数（缺省 / 0 / 负数 / 小数一律拒绝）', () => {
    const base = {
      entityType: 'page',
      entityId: 'p1',
      op: 'upsert',
      revision: 1,
      updatedAt: T0,
      payload: null,
    };
    expect(syncChangeSchema.safeParse({ ...base, seq: 1 }).success).toBe(true);
    expect(syncChangeSchema.safeParse(base).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, seq: 0 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, seq: null }).success).toBe(false);
  });

  it('未知 entityType / op 一律拒绝（默认拒绝，不静默丢弃）', () => {
    const base = { seq: 1, entityType: 'page', entityId: 'p1', op: 'upsert', revision: 1, updatedAt: T0, payload: null };
    expect(syncChangeSchema.safeParse({ ...base, entityType: 'event' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, entityType: 'user' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, entityType: 'nav-link' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: 'update' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: 'remove' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: 'UPSERT' }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, op: null }).success).toBe(false);
  });

  it('严格拒绝未知字段、负 revision、非整数时间戳与空 entityId', () => {
    const base = { seq: 1, entityType: 'page', entityId: 'p1', op: 'upsert', revision: 1, updatedAt: T0, payload: null };
    expect(syncChangeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, revision: -1 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, updatedAt: T0 + 0.5 }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...base, entityId: '' }).success).toBe(false);
  });
});

describe('syncMetaSchema：与变更流同一快照的全局修订号', () => {
  it('合法 meta：三个字段都必填且非负', () => {
    expect(syncMetaSchema.safeParse({ navRevision: 0, workbenchRevision: 3, watermark: 9 }).success).toBe(true);
    expect(syncMetaSchema.safeParse({ navRevision: 0, workbenchRevision: 0, watermark: 0 }).success).toBe(true);
  });

  it('缺字段 / 负数 / 未知字段一律拒绝（不允许「猜一个默认 0」）', () => {
    expect(syncMetaSchema.safeParse({ navRevision: 1, workbenchRevision: 1 }).success).toBe(false);
    expect(syncMetaSchema.safeParse({ navRevision: 1, watermark: 1 }).success).toBe(false);
    expect(syncMetaSchema.safeParse({ workbenchRevision: 1, watermark: 1 }).success).toBe(false);
    expect(syncMetaSchema.safeParse({ navRevision: -1, workbenchRevision: 0, watermark: 0 }).success).toBe(false);
    expect(syncMetaSchema.safeParse({ navRevision: 0, workbenchRevision: 0, watermark: -1 }).success).toBe(false);
    expect(
      syncMetaSchema.safeParse({ navRevision: 0, workbenchRevision: 0, watermark: 0, extra: 1 }).success,
    ).toBe(false);
    expect(syncMetaSchema.safeParse({}).success).toBe(false);
  });
});

describe('syncChangesResponseSchema / syncConflictSchema', () => {
  const validChange = {
    seq: 1,
    entityType: 'page',
    entityId: 'p1',
    op: 'upsert',
    revision: 1,
    updatedAt: T0,
    payload: null,
  };
  const validMeta = { navRevision: 2, workbenchRevision: 0, watermark: 1 };

  it('响应必须显式携带 entityTypes（客户端不能靠「没收到」推断「没有变更」）', () => {
    const ok = {
      changes: [validChange],
      nextCursor: 'v2:1',
      hasMore: true,
      serverTimeMs: T0,
      entityTypes: [...SYNC_ENTITY_TYPES],
      meta: validMeta,
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
      meta: validMeta,
    };
    expect(syncChangesResponseSchema.safeParse(withoutEntityTypes).success).toBe(false);
    expect(syncChangesResponseSchema.safeParse({ ...ok, nextCursor: null, hasMore: false }).success).toBe(true);
    expect(syncChangesResponseSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('meta 必填：缺 meta 的响应一律拒绝（全局 CAS 基数不能靠行修订推导）', () => {
    const withoutMeta = {
      changes: [validChange],
      nextCursor: 'v2:1',
      hasMore: false,
      serverTimeMs: T0,
      entityTypes: [...SYNC_ENTITY_TYPES],
    };
    expect(syncChangesResponseSchema.safeParse(withoutMeta).success).toBe(false);
    expect(syncChangesResponseSchema.safeParse({ ...withoutMeta, meta: {} }).success).toBe(false);
    expect(
      syncChangesResponseSchema.safeParse({ ...withoutMeta, meta: { navRevision: 0, workbenchRevision: 0 } })
        .success,
    ).toBe(false);
  });

  it('变更缺 seq 的响应一律拒绝（不能发出无法排序/去重的变更流）', () => {
    const withoutSeq = {
      changes: [{ entityType: 'page', entityId: 'p1', op: 'upsert', revision: 1, updatedAt: T0, payload: null }],
      nextCursor: 'v2:1',
      hasMore: false,
      serverTimeMs: T0,
      entityTypes: [...SYNC_ENTITY_TYPES],
      meta: validMeta,
    };
    expect(syncChangesResponseSchema.safeParse(withoutSeq).success).toBe(false);
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
