/**
 * 身份写入的原子性与故障回滚（HUB-006）。
 *
 * 这个文件存在的理由：并发与半初始化问题无法靠「多跑几次」证明，必须**确定性地**构造
 * 交错时刻与故障，并断言数据库里没有留下任何中间状态。全部在真实 workerd + Miniflare D1 中执行。
 *
 * 覆盖：
 * 1. D1 batch 中 `changes()` 的语义（撤销审计的判据依赖它）
 * 2. 配对领取的独占标记与「消费 / 新设备 / 审计」同事务
 * 3. 确定性交错：预读之后、提交之前发起设备被撤销 → 不得铸造设备
 * 4. 故障注入（可控触发器阻止设备/审计插入）→ 整批回滚 → 恢复后仍可领取
 * 5. 撤销审计以受影响行数为条件：同一时间戳 / 并发撤销只产生一条
 */
import { TOKEN_BODY_LENGTH } from '@ff14-hub/shared';
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPairing } from '../modules/identity/pairing';
import { hashCredential } from '../modules/identity/credentials';
import { revokeDevice } from '../modules/identity/devices';
import {
  URLS,
  bootstrapViaApi,
  countRows,
  createPairingViaApi,
  jsonPost,
  readAuditEvents,
  resetIdentityState,
} from './helpers';

beforeEach(async () => {
  await resetIdentityState();
});

/** 从 batch 结果里取出 `changes()` 的标量值。 */
function changedValue(result: D1Result<unknown> | undefined): number | undefined {
  const row = result?.results?.[0];
  if (row === null || typeof row !== 'object') {
    return undefined;
  }
  const record: Record<string, unknown> = row as Record<string, unknown>;
  const value = record['changed'];
  return typeof value === 'number' ? value : undefined;
}

async function pairingUsedAt(pairingCode: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT used_at FROM device_pairings WHERE pairing_hash = ?')
    .bind(await hashCredential(pairingCode))
    .first<{ used_at: number | null }>();
  return row?.used_at ?? null;
}

async function countAudit(eventType: string): Promise<number> {
  return (await readAuditEvents()).filter((row) => row.event_type === eventType).length;
}

/** 用于识别配对诊断查询的模式（对应被测实现里的那条 SELECT，仅供测试替身定位）。 */
const DIAGNOSTIC_SQL_PATTERN = /FROM device_pairings p[\s\S]*?JOIN devices d/i;

interface InterleaveHooks {
  /** 在诊断查询返回**旧快照之后**、被测代码提交 batch **之前**执行。 */
  readonly afterDiagnosticRead: () => Promise<void>;
}

/**
 * 窄范围 D1 委托：只拦截配对诊断查询的 `first()`，在它拿到结果之后插入一个动作；
 * 其余语句以及 `batch`/`exec` 一律转发给真实 D1。
 *
 * 为什么不整个 Proxy 化：传给 `real.batch` 的必须是**原始**的 D1PreparedStatement，
 * 因此这里用 WeakMap 把代理对象映射回真实对象，避免把 Proxy 交给 D1 内部实现。
 *
 * 这是纯测试替身，生产代码里没有任何测试钩子。
 */
function createInterleavingDb(real: D1Database, hooks: InterleaveHooks): D1Database {
  const realStatements = new WeakMap<object, D1PreparedStatement>();

  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property, receiver) {
        if (property === 'first') {
          return async (...args: unknown[]): Promise<unknown> => {
            const firstValue: unknown = Reflect.get(target, 'first');
            if (typeof firstValue !== 'function') {
              throw new Error('测试替身：D1PreparedStatement.first 不可调用');
            }
            const first = firstValue as (...callArgs: unknown[]) => Promise<unknown>;
            const result = await first.apply(target, args);
            if (DIAGNOSTIC_SQL_PATTERN.test(query)) {
              await hooks.afterDiagnosticRead();
            }
            return result;
          };
        }
        if (property === 'bind') {
          return (...args: unknown[]): D1PreparedStatement => {
            const bindValue: unknown = Reflect.get(target, 'bind');
            if (typeof bindValue !== 'function') {
              throw new Error('测试替身：D1PreparedStatement.bind 不可调用');
            }
            const bind = bindValue as (...callArgs: unknown[]) => D1PreparedStatement;
            return wrap(bind.apply(target, args), query);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as (...callArgs: unknown[]) => unknown).bind(target) : value;
      },
    });

    realStatements.set(proxy, statement);
    return proxy;
  };

  const delegate = {
    prepare: (query: string): D1PreparedStatement => wrap(real.prepare(query), query),
    batch: (statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> =>
      real.batch(statements.map((statement) => realStatements.get(statement) ?? statement)),
    exec: (query: string) => real.exec(query),
  };

  return delegate as unknown as D1Database;
}

describe('D1 batch 语义（本项目一致性判定的基础）', () => {
  it('changes() 反映**上一条语句**的受影响行数（0 行时为 0）', async () => {
    const owner = await bootstrapViaApi();

    const rows = await env.DB.batch([
      env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind('改名后', owner.deviceId),
      env.DB.prepare('SELECT changes() AS changed'),
      // 匹配不到任何行：changes() 必须为 0。
      env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind('无此行', 'does-not-exist'),
      env.DB.prepare('SELECT changes() AS changed'),
    ]);

    expect(changedValue(rows[1])).toBe(1);
    expect(changedValue(rows[3])).toBe(0);
  });

  it('意外失败（被触发器阻止）时整批回滚，先前的写入不保留', async () => {
    const owner = await bootstrapViaApi();
    await env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS test_block_audit_any BEFORE INSERT ON identity_audit
       WHEN NEW.detail_json = '{"blocked":true}'
       BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
    ).run();

    try {
      await expect(
        env.DB.batch([
          env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind('不应保留', owner.deviceId),
          env.DB.prepare(
            `INSERT INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json)
             VALUES (?, ?, 'device_revoked', ?, ?, '{"blocked":true}')`,
          ).bind(crypto.randomUUID(), owner.workspaceId, owner.deviceId, Date.now()),
        ]),
      ).rejects.toThrow();

      const row = await env.DB.prepare('SELECT name FROM devices WHERE id = ?')
        .bind(owner.deviceId)
        .first<{ name: string }>();
      expect(row?.name).not.toBe('不应保留');
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS test_block_audit_any').run();
    }
  });
});

describe('配对领取：单事务消费', () => {
  it('并发领取后独占标记恰好一行，且只创建一台设备、只写一条审计', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);

    const responses = await Promise.all(
      Array.from({ length: 4 }, (_unused, index) =>
        SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: pairing.pairingCode, deviceName: `并发-${index}` })),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(await countRows('pairing_claims')).toBe(1);
    expect(await countRows('devices')).toBe(2);
    expect(await countAudit('device_paired')).toBe(1);
    // 消费标记与设备一一对应。
    const usedAt = await pairingUsedAt(pairing.pairingCode);
    expect(usedAt).not.toBeNull();
  });

  it('确定性交错：claimPairing 自身预读之后、批提交之前发起设备被撤销 → 批内拒绝且无残留', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    const devicesBefore = await countRows('devices');

    // 用窄范围 D1 委托，把撤销插进 **claimPairing 自身**的诊断查询返回之后、batch 提交之前。
    // 关键：这里驱动的是被测实现的真实时序，而不是测试自己编排的「先 SELECT 再撤销」——
    // 后者即使面对一个「预读后不再复核」的有竞态实现也会通过。
    let interleaved = false;
    const interleavingDb = createInterleavingDb(env.DB, {
      afterDiagnosticRead: async () => {
        interleaved = true;
        // 只翻转 revoked_at，**故意保留配对行**：此时唯一能拦住领取的，
        // 就是批内那条「发起设备未撤销」的检查。
        await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(Date.now(), owner.deviceId).run();
      },
    });

    const outcome = await claimPairing(interleavingDb, { pairingCode: pairing.pairingCode, deviceName: '交错' });

    // 先确认交错真的发生了，避免测试空转通过。
    expect(interleaved).toBe(true);
    expect(outcome.ok).toBe(false);

    expect(await countRows('devices')).toBe(devicesBefore);
    expect(await countRows('pairing_claims')).toBe(0);
    expect(await countAudit('device_paired')).toBe(0);
    // 配对未被消费：故障/竞态不会烧毁配对码。
    expect(await pairingUsedAt(pairing.pairingCode)).toBeNull();
  });

  it('确定性交错：走真实撤销流程（连带删除配对）后领取失败', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);

    await revokeDevice(env.DB, {
      workspaceId: owner.workspaceId,
      deviceId: owner.deviceId,
      actingDeviceId: owner.deviceId,
    });
    expect(await countRows('device_pairings')).toBe(0);

    const response = await SELF.fetch(
      URLS.pairingClaim,
      jsonPost({ pairingCode: pairing.pairingCode, deviceName: '撤销后' }),
    );
    expect(response.status).toBe(401);
    expect(await countRows('devices')).toBe(1);
    expect(await countRows('pairing_claims')).toBe(0);
  });
});

describe('故障注入：消费标记与设备/审计一起回滚', () => {
  it('阻止设备插入 → 整批回滚，配对未被烧毁，恢复后仍可正常领取', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    const devicesBefore = await countRows('devices');

    await env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS test_block_device_insert BEFORE INSERT ON devices
       WHEN NEW.name = 'trigger-blocked'
       BEGIN SELECT RAISE(ABORT, 'injected device insert failure'); END`,
    ).run();

    try {
      const response = await SELF.fetch(
        URLS.pairingClaim,
        jsonPost({ pairingCode: pairing.pairingCode, deviceName: 'trigger-blocked' }),
      );
      // 触发器让整批失败 → 统一错误处理给出脱敏 500。
      expect(response.status).toBe(500);

      // 关键断言：没有任何中间状态被保留。
      expect(await countRows('pairing_claims')).toBe(0);
      expect(await pairingUsedAt(pairing.pairingCode)).toBeNull();
      expect(await countRows('devices')).toBe(devicesBefore);
      expect(await countAudit('device_paired')).toBe(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS test_block_device_insert').run();
    }

    // 故障排除后，同一个配对码仍然可用——配对没有被烧毁。
    const retry = await SELF.fetch(
      URLS.pairingClaim,
      jsonPost({ pairingCode: pairing.pairingCode, deviceName: '恢复后' }),
    );
    expect(retry.status).toBe(201);
    expect(await countRows('pairing_claims')).toBe(1);
    expect(await countRows('devices')).toBe(devicesBefore + 1);
    expect(await countAudit('device_paired')).toBe(1);
  });

  it('阻止审计插入 → 同样整批回滚（不会出现「有设备但无审计」）', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    const devicesBefore = await countRows('devices');

    await env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS test_block_audit_paired BEFORE INSERT ON identity_audit
       WHEN NEW.event_type = 'device_paired'
       BEGIN SELECT RAISE(ABORT, 'injected audit insert failure'); END`,
    ).run();

    try {
      const response = await SELF.fetch(
        URLS.pairingClaim,
        jsonPost({ pairingCode: pairing.pairingCode, deviceName: '审计被阻止' }),
      );
      expect(response.status).toBe(500);

      expect(await countRows('devices')).toBe(devicesBefore);
      expect(await countRows('pairing_claims')).toBe(0);
      expect(await pairingUsedAt(pairing.pairingCode)).toBeNull();
      expect(await countAudit('device_paired')).toBe(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS test_block_audit_paired').run();
    }

    const retry = await SELF.fetch(
      URLS.pairingClaim,
      jsonPost({ pairingCode: pairing.pairingCode, deviceName: '恢复后' }),
    );
    expect(retry.status).toBe(201);
    expect(await countAudit('device_paired')).toBe(1);
  });

  it('并发领取中失败的一方不会留下设备或审计（无跨事务补偿）', async () => {
    const owner = await bootstrapViaApi();
    const pairing = await createPairingViaApi(owner.authorization);
    const unknownCode = `ffh_pair_${'W'.repeat(TOKEN_BODY_LENGTH)}`;

    // 混入一个必然失败的配对码，确认它不会因为「先消费后建设备」的写法而留下痕迹。
    const responses = await Promise.all([
      SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: pairing.pairingCode, deviceName: '有效' })),
      SELF.fetch(URLS.pairingClaim, jsonPost({ pairingCode: unknownCode, deviceName: '无效' })),
    ]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 401]);

    expect(await countRows('devices')).toBe(2);
    expect(await countRows('pairing_claims')).toBe(1);
    expect(await countAudit('device_paired')).toBe(1);
  });
});

describe('撤销审计：以数据库受影响行数为条件', () => {
  it('时钟冻结在同一时刻时，两次 revokeDevice 只产生一条审计', async () => {
    const owner = await bootstrapViaApi();
    const frozenNow = 1_760_000_000_000;

    // 冻结时钟，让两次调用的 `Date.now()` 完全相同——这正是「用时间戳相等去判定
    // 本次是否发生撤销」会失效的场景。直接调用被测函数，而不是在测试里复制 SQL。
    const clock = vi.spyOn(Date, 'now').mockReturnValue(frozenNow);
    try {
      const first = await revokeDevice(env.DB, {
        workspaceId: owner.workspaceId,
        deviceId: owner.deviceId,
        actingDeviceId: owner.deviceId,
      });
      const second = await revokeDevice(env.DB, {
        workspaceId: owner.workspaceId,
        deviceId: owner.deviceId,
        actingDeviceId: owner.deviceId,
      });

      // 第一次真正撤销，第二次是幂等命中（没有行被更新）。
      expect(first.ok && !first.alreadyRevoked).toBe(true);
      expect(second.ok && second.alreadyRevoked).toBe(true);
    } finally {
      clock.mockRestore();
    }

    expect(await countAudit('device_revoked')).toBe(1);
  });

  it('并发撤销同一设备只产生一条审计', async () => {
    const owner = await bootstrapViaApi();

    const outcomes = await Promise.all([
      revokeDevice(env.DB, {
        workspaceId: owner.workspaceId,
        deviceId: owner.deviceId,
        actingDeviceId: owner.deviceId,
      }),
      revokeDevice(env.DB, {
        workspaceId: owner.workspaceId,
        deviceId: owner.deviceId,
        actingDeviceId: owner.deviceId,
      }),
      revokeDevice(env.DB, {
        workspaceId: owner.workspaceId,
        deviceId: owner.deviceId,
        actingDeviceId: owner.deviceId,
      }),
    ]);

    // 恰好一个请求报告「本次真的撤销了」。
    expect(outcomes.filter((outcome) => outcome.ok && !outcome.alreadyRevoked)).toHaveLength(1);
    expect(await countAudit('device_revoked')).toBe(1);
  });

  it('顺序重复撤销只产生一条审计，且第二次是幂等成功', async () => {
    const owner = await bootstrapViaApi();
    const first = await revokeDevice(env.DB, {
      workspaceId: owner.workspaceId,
      deviceId: owner.deviceId,
      actingDeviceId: owner.deviceId,
    });
    const second = await revokeDevice(env.DB, {
      workspaceId: owner.workspaceId,
      deviceId: owner.deviceId,
      actingDeviceId: owner.deviceId,
    });

    expect(first.ok && !first.alreadyRevoked).toBe(true);
    expect(second.ok && second.alreadyRevoked).toBe(true);
    expect(await countAudit('device_revoked')).toBe(1);
  });
});
