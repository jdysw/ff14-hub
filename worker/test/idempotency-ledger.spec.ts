/**
 * 幂等账本机制的**行为**验证（HUB-048 / HUB-051；ADR-0004 D11）。
 *
 * 立场：这里断言的是**行为**，不是实现文本。全部用例都在真实 workerd + Miniflare D1 里
 * 跑真实的 `nav_operations` / `nav_operation_intents` 表（migrations/0008_navigation.sql）
 * 与真实的 `workspace_nav_links` 副作用目标表，不复制实现 SQL 做字符串比对——
 * 字符串比对在实现重构（例如提取账本）时会全部失效，却什么机制也没证明。
 *
 * 覆盖：
 * - 认领 + 施加副作用成功（`replayed:false`）；
 * - 同 ID 同 kind 同指纹重放：`replayed:true`，副作用只发生一次；
 * - 同 ID 不同 kind / 不同指纹：分别 `operation_id_reused` / `operation_payload_mismatch`，零写入；
 * - `Promise.all` 并发两次同 ID：恰好一次首次、一次重放（ON CONFLICT DO NOTHING + token 守卫）；
 * - 变更语句违反唯一约束：整个 batch 回滚（目标表无残留、幂等记录不存在、返回 persist_failed）；
 * - `readReplay` 无记录返回 null；
 * - `guardedStatements` 的绑定顺序被真实验证（守卫不成立时语句不生效）；
 * - 工作台绑定把账本的 `reason: string` 显式收窄（未知原因降级为 `persist_failed`）。
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLedger,
  fingerprintOf,
  guardedStatements,
  type IdempotencyGuard,
  type LedgerResult,
} from '../modules/idempotency/ledger';
import {
  ERROR_CODE_BY_WORKBENCH_REJECTION,
  isWorkbenchRejection,
  runIdempotentWrite,
  type WorkbenchFailure,
  type WorkbenchRejection,
} from '../modules/workbench/tx';
import { resetIdentityState, seedWorkspace } from './helpers';

const NOW = 1_760_000_000_000;
/** 导航域的 kind 命名空间（与工作台的 `page.create` 等互不干扰）。 */
const NAV_KIND = 'nav.link.create';

/** 导航账本：绑定 0008_navigation.sql 的两张表。 */
const navLedger = createLedger({ operations: 'nav_operations', intents: 'nav_operation_intents' });

/** 被写入的副作用结果（形状无所谓，重点是重放必须逐字节返回同一份）。 */
interface NavWriteResult {
  readonly linkId: string;
  readonly note: string;
}

/** 一条可被追加守卫的变更语句（`INSERT ... SELECT ... WHERE 1 = 1` 是守卫追加的前提）。 */
interface Statement {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

/** 目标表里的插入语句：与工作台的 `insertPageStatement` 同构（末尾 `WHERE 1 = 1` 供守卫追加）。 */
function insertNavLinkStatement(input: {
  readonly linkId: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly sourceCatalogId?: string | null;
}): Statement {
  return {
    sql: `INSERT INTO workspace_nav_links
            (id, workspace_id, source_catalog_id, title, url, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'https://example.test/', ?, ?
           WHERE 1 = 1`,
    binds: [
      input.linkId,
      input.workspaceId,
      input.sourceCatalogId ?? null,
      input.title ?? '链接',
      NOW,
      NOW,
    ],
  };
}

/** 读一个标量计数。SQL 一律是**字面量**，不拼接变量（因此不存在注入面）。 */
async function scalar(sql: string, ...binds: readonly unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ value: number }>();
  return row?.value ?? -1;
}

function operationCount(workspaceId: string): Promise<number> {
  return scalar('SELECT COUNT(*) AS value FROM nav_operations WHERE workspace_id = ?', workspaceId);
}

function intentCount(workspaceId: string): Promise<number> {
  return scalar('SELECT COUNT(*) AS value FROM nav_operation_intents WHERE workspace_id = ?', workspaceId);
}

function linkCount(workspaceId: string): Promise<number> {
  return scalar('SELECT COUNT(*) AS value FROM workspace_nav_links WHERE workspace_id = ?', workspaceId);
}

async function linkTitle(workspaceId: string, linkId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT title FROM workspace_nav_links WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, linkId)
    .first<{ title: string }>();
  return row?.title ?? null;
}

/** 一次真实的导航幂等写入（全部用例共用，只改 kind / 指纹 / 语句）。 */
async function writeNavLink(input: {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly linkId: string;
  readonly kind?: string;
  readonly requestFingerprint: string;
  readonly statements?: readonly Statement[];
  readonly preconditionSql?: string;
}): Promise<LedgerResult<NavWriteResult>> {
  return await navLedger.runIdempotentWrite<NavWriteResult>({
    db: env.DB,
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    kind: input.kind ?? NAV_KIND,
    requestFingerprint: input.requestFingerprint,
    now: NOW,
    preconditionSql: input.preconditionSql ?? '',
    preconditionBinds: [],
    buildStatements: (guard) =>
      guardedStatements(
        env.DB,
        guard,
        input.statements ?? [insertNavLinkStatement({ linkId: input.linkId, workspaceId: input.workspaceId })],
      ),
    result: { linkId: input.linkId, note: '首次结果' },
    explain: () => Promise.resolve(null),
  });
}

beforeEach(async () => {
  await resetIdentityState();
});

describe('账本的认领与重放', () => {
  it('首次写入：replayed=false，目标行 / 结果行 / 指纹行各一份', async () => {
    const { workspaceId } = await seedWorkspace();
    const fingerprint = await fingerprintOf(NAV_KIND, { linkId: 'link-first' });

    const result = await writeNavLink({
      workspaceId,
      operationId: 'op-nav-first-0001',
      linkId: 'link-first',
      requestFingerprint: fingerprint,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.replayed).toBe(false);
    expect(result.value).toEqual({ linkId: 'link-first', note: '首次结果' });

    // 副作用真的发生了，且账本两张表各一行。
    expect(await linkCount(workspaceId)).toBe(1);
    expect(await operationCount(workspaceId)).toBe(1);
    expect(await intentCount(workspaceId)).toBe(1);

    // 收尾后 attempt_token 必须置空（否则重放会被误判成「未收尾」）。
    const row = await navLedger.readOperationRow(env.DB, workspaceId, 'op-nav-first-0001');
    expect(row?.attempt_token).toBeNull();
    expect(row?.kind).toBe(NAV_KIND);
    expect(row?.request_fingerprint).toBe(fingerprint);
  });

  it('同 ID 同 kind 同指纹重放：replayed=true，副作用只发生一次', async () => {
    const { workspaceId } = await seedWorkspace();
    const fingerprint = await fingerprintOf(NAV_KIND, { linkId: 'link-replay' });
    const request = {
      workspaceId,
      operationId: 'op-nav-replay-0001',
      linkId: 'link-replay',
      requestFingerprint: fingerprint,
    } as const;

    const first = await writeNavLink(request);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.replayed).toBe(false);
    }

    const second = await writeNavLink(request);
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) {
      return;
    }
    expect(second.replayed).toBe(true);
    // 重放返回的是**首次**存入的同一份结果（JSON 往返）。
    expect(second.value).toEqual(first.value);

    // 副作用只发生一次：目标表仍只有一行；账本也没有被重复写入。
    expect(await linkCount(workspaceId)).toBe(1);
    expect(await operationCount(workspaceId)).toBe(1);
    expect(await intentCount(workspaceId)).toBe(1);
  });
});

describe('账本的冲突判定（都是零写入）', () => {
  it('同 ID 不同 kind ⇒ operation_id_reused', async () => {
    const { workspaceId } = await seedWorkspace();
    const first = await writeNavLink({
      workspaceId,
      operationId: 'op-nav-kind-0001',
      linkId: 'link-kind',
      requestFingerprint: await fingerprintOf(NAV_KIND, { linkId: 'link-kind' }),
    });
    expect(first.ok).toBe(true);

    const reused = await writeNavLink({
      workspaceId,
      operationId: 'op-nav-kind-0001',
      linkId: 'link-kind-other',
      kind: 'nav.link.update',
      requestFingerprint: await fingerprintOf('nav.link.update', { linkId: 'link-kind-other' }),
    });

    expect(reused.ok).toBe(false);
    if (!reused.ok) {
      expect(reused.reason).toBe('operation_id_reused');
    }
    expect(await linkCount(workspaceId)).toBe(1);
    expect(await operationCount(workspaceId)).toBe(1);
    expect(await intentCount(workspaceId)).toBe(1);
  });

  it('同 ID 同 kind 但指纹不同 ⇒ operation_payload_mismatch', async () => {
    const { workspaceId } = await seedWorkspace();
    const first = await writeNavLink({
      workspaceId,
      operationId: 'op-nav-fp-0001',
      linkId: 'link-fp',
      requestFingerprint: await fingerprintOf(NAV_KIND, { linkId: 'link-fp', title: '甲' }),
    });
    expect(first.ok).toBe(true);

    const mismatch = await writeNavLink({
      workspaceId,
      operationId: 'op-nav-fp-0001',
      linkId: 'link-fp-changed',
      requestFingerprint: await fingerprintOf(NAV_KIND, { linkId: 'link-fp', title: '乙' }),
    });

    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.reason).toBe('operation_payload_mismatch');
    }
    expect(await linkCount(workspaceId)).toBe(1);
    expect(await operationCount(workspaceId)).toBe(1);
    expect(await intentCount(workspaceId)).toBe(1);
  });
});

describe('并发同 ID', () => {
  it('Promise.all 两次同 ID：恰好一次 replayed=false、一次 replayed=true，副作用一次', async () => {
    const { workspaceId } = await seedWorkspace();
    const request = {
      workspaceId,
      operationId: 'op-nav-race-0001',
      linkId: 'link-race',
      requestFingerprint: await fingerprintOf(NAV_KIND, { linkId: 'link-race' }),
    } as const;

    const results = await Promise.all([writeNavLink(request), writeNavLink(request)]);

    // 两边都必须是**可解释**的结果：一次首次成功、一次重放；不允许任何失败。
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(results.map((result) => (result.ok ? result.replayed : null)).sort()).toEqual([false, true]);

    // 无论哪一次先提交，副作用与账本都只落一份。
    expect(await linkCount(workspaceId)).toBe(1);
    expect(await operationCount(workspaceId)).toBe(1);
    expect(await intentCount(workspaceId)).toBe(1);
    const row = await navLedger.readOperationRow(env.DB, workspaceId, 'op-nav-race-0001');
    expect(row?.attempt_token).toBeNull();
  });
});

describe('约束冲突：整个 batch 回滚', () => {
  it('变更语句违反部分唯一索引 ⇒ 目标表无残留、幂等记录不存在、返回 persist_failed', async () => {
    const { workspaceId } = await seedWorkspace();
    // 同一个目录条目在本工作空间只允许一条活跃副本（idx_workspace_nav_links_catalog_active）。
    // 两条同 source_catalog_id 的插入在同一个 batch 里：第二条必然违反唯一索引。
    const result = await writeNavLink({
      workspaceId,
      operationId: 'op-nav-rollback-0001',
      linkId: 'link-rollback-a',
      requestFingerprint: await fingerprintOf(NAV_KIND, { linkId: 'link-rollback-a' }),
      statements: [
        insertNavLinkStatement({ linkId: 'link-rollback-a', workspaceId, sourceCatalogId: 'catalog-dup-0001' }),
        insertNavLinkStatement({ linkId: 'link-rollback-b', workspaceId, sourceCatalogId: 'catalog-dup-0001' }),
      ],
    });

    // 约束冲突如实报告为内部错误，绝不假装成功。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('persist_failed');
    }

    // 整个 batch 回滚：第一条插入、认领行、指纹行都没有留下。
    expect(await linkCount(workspaceId)).toBe(0);
    expect(await operationCount(workspaceId)).toBe(0);
    expect(await intentCount(workspaceId)).toBe(0);
  });
});

describe('readReplay 短路', () => {
  it('无记录返回 null；有记录时返回首次结果且 replayed=true', async () => {
    const { workspaceId } = await seedWorkspace();
    const kind = NAV_KIND;
    const fingerprint = await fingerprintOf(kind, { linkId: 'link-replay-read' });

    const missing = await navLedger.readReplay<NavWriteResult>({
      db: env.DB,
      workspaceId,
      operationId: 'op-nav-absent-0001',
      kind,
      requestFingerprint: fingerprint,
    });
    expect(missing).toBeNull();

    const written = await writeNavLink({
      workspaceId,
      operationId: 'op-nav-replay-read-0001',
      linkId: 'link-replay-read',
      requestFingerprint: fingerprint,
    });
    expect(written.ok).toBe(true);

    const replay = await navLedger.readReplay<NavWriteResult>({
      db: env.DB,
      workspaceId,
      operationId: 'op-nav-replay-read-0001',
      kind,
      requestFingerprint: fingerprint,
    });
    expect(replay?.ok).toBe(true);
    if (replay?.ok !== true) {
      return;
    }
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual({ linkId: 'link-replay-read', note: '首次结果' });
  });
});

describe('guardedStatements 的绑定顺序', () => {
  it('守卫不成立时语句不生效；成立时才生效，且语句绑定先于守卫绑定', async () => {
    const { workspaceId } = await seedWorkspace();
    const operationId = 'op-nav-guard-0001';
    const linkId = 'link-guard';

    // 目标行直接写入（不经账本），标题作为「是否被改动」的可观测事实。
    await env.DB.prepare(
      `INSERT INTO workspace_nav_links (id, workspace_id, title, url, created_at, updated_at)
       VALUES (?, ?, '原标题', 'https://example.test/', ?, ?)`,
    )
      .bind(linkId, workspaceId, NOW, NOW)
      .run();

    // 一条「持有认领」的幂等行：token 就是本次尝试的标记。
    await env.DB.prepare(
      `INSERT INTO nav_operations (workspace_id, operation_id, kind, result_json, created_at, attempt_token)
       VALUES (?, ?, 'nav.link.update', '', ?, 'token-live')`,
    )
      .bind(workspaceId, operationId, NOW)
      .run();

    // 语句自己的绑定是 [标题, workspaceId]，守卫追加的绑定是 [workspaceId, operationId, token]。
    // 若实现把两组绑定顺序搞反，`SET title` 会收到 workspaceId、
    // `WHERE workspace_id` 会收到标题，于是更新影响 0 行——下面的断言就会失败。
    const updateStatement: Statement = {
      sql: 'UPDATE workspace_nav_links SET title = ? WHERE workspace_id = ?',
      binds: ['守卫生效后的标题', workspaceId],
    };

    // 1) 过期 token：守卫不成立，语句不生效。
    const staleGuard: IdempotencyGuard = {
      sql: navLedger.guardSql,
      binds: [workspaceId, operationId, 'token-stale'],
    };
    const stale = await env.DB.batch(guardedStatements(env.DB, staleGuard, [updateStatement]));
    expect(stale[0]?.meta.changes).toBe(0);
    expect(await linkTitle(workspaceId, linkId)).toBe('原标题');

    // 2) 正确 token：守卫成立，同样的语句生效，且标题被写成了正确的值
    //（这一条同时钉住两件事：守卫绑定顺序，以及语句绑定先于守卫绑定）。
    const liveGuard = navLedger.idempotencyGuard({ workspaceId, operationId, token: 'token-live' });
    const applied = await env.DB.batch(guardedStatements(env.DB, liveGuard, [updateStatement]));
    expect(applied[0]?.meta.changes).toBe(1);
    expect(await linkTitle(workspaceId, linkId)).toBe('守卫生效后的标题');
  });
});

describe('工作台绑定对账本原因的显式收窄', () => {
  it('常量集合只接受联合类型内的原因', () => {
    expect(isWorkbenchRejection('persist_failed')).toBe(true);
    expect(isWorkbenchRejection('operation_payload_mismatch')).toBe(true);
    expect(isWorkbenchRejection('not_a_real_reason')).toBe(false);
    expect(isWorkbenchRejection('')).toBe(false);
  });

  it('账本给出联合类型之外的原因时降级为 persist_failed（绝不产出非法错误码）', async () => {
    const { workspaceId } = await seedWorkspace();
    // 伪造一个域层未知的原因（模拟「账本新增/改名了原因而本文件未同步」）。
    // 双重断言是刻意的：先绕开类型系统，才能真的检验运行期守卫。
    const forgedReason = 'not_a_real_reason' as unknown as WorkbenchRejection;
    const forged: WorkbenchFailure = { ok: false, reason: forgedReason, detail: '伪造原因' };

    const result = await runIdempotentWrite<{ readonly n: number }>({
      db: env.DB,
      workspaceId,
      operationId: 'op-narrow-0001',
      kind: 'page.create',
      requestFingerprint: await fingerprintOf('page.create', { n: 1 }),
      now: NOW,
      // 认领必然失败（前置条件不成立），且没有同 ID 记录 ⇒ 走 explain()。
      preconditionSql: '0 = 1',
      preconditionBinds: [],
      buildStatements: () => [],
      result: { n: 1 },
      explain: () => Promise.resolve(forged),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('persist_failed');
    expect(ERROR_CODE_BY_WORKBENCH_REJECTION[result.reason]).toBe('internal_error');
    // 零写入：认领失败不会留下任何幂等记录。
    expect(await scalar('SELECT COUNT(*) AS value FROM workbench_operations WHERE workspace_id = ?', workspaceId)).toBe(0);
  });
});
