/**
 * D1 迁移与约束测试（HUB-003 验收）。
 *
 * 立场（规划 5.1）：事务行为与约束必须**实测 D1**，不能假设独立 SQLite 的行为完全一致。
 * 因此所有断言都在 workerd + Miniflare D1 中执行。
 *
 * 覆盖：
 * - 全新库可应用迁移；重复应用安全（记账表幂等 + 原始语句逐条重放幂等）
 * - 外键约束（拒绝悬空引用 + 级联删除 + SET NULL）
 * - 唯一约束（恢复密钥 / Token 摘要 / 配对摘要）
 * - 枚举 CHECK 约束（region / event_type）
 * - NOT NULL 与必需索引
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const NOW = 1_760_000_000_000;

async function insertWorkspace(id: string, overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO workspaces (id, region, timezone, locale, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      overrides['region'] ?? 'cn',
      'Asia/Shanghai',
      'zh-CN',
      overrides['recovery_hash'] ?? `hash-${id}`,
      NOW,
      NOW,
    )
    .run();
}

async function insertDevice(
  id: string,
  workspaceId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO devices (id, workspace_id, token_hash, name, revoked_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, workspaceId, overrides['token_hash'] ?? `token-${id}`, '测试设备', null, null, NOW)
    .run();
}

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

async function indexExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

describe('迁移应用与幂等性', () => {
  it('迁移已在 D1 记账表中登记', async () => {
    expect(await tableExists('d1_migrations')).toBe(true);
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{ count: number }>();
    expect(row?.count).toBeGreaterThanOrEqual(1);
  });

  it('阶段 01 必需的四张表都已建立', async () => {
    for (const table of ['workspaces', 'devices', 'device_pairings', 'identity_audit']) {
      expect(await tableExists(table), `缺少表 ${table}`).toBe(true);
    }
  });

  it('0002_identity.sql 的表与索引都已建立（HUB-006）', async () => {
    for (const table of ['workspace_bootstrap_guard', 'auth_rate_limits', 'pairing_claims']) {
      expect(await tableExists(table), `缺少表 ${table}`).toBe(true);
    }
    for (const index of ['idx_auth_rate_limits_window', 'idx_pairing_claims_device', 'idx_identity_audit_device_revoked_once']) {
      expect(await indexExists(index), `缺少索引 ${index}`).toBe(true);
    }
  });

  it('device_revoked 审计经部分唯一索引限制为「每工作空间每设备至多一条」', async () => {
    await insertWorkspace('ws-audit-once');
    await insertDevice('dev-audit-once', 'ws-audit-once');

    const insertAudit = (id: string, eventType: string) =>
      env.DB.prepare(
        'INSERT INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(id, 'ws-audit-once', eventType, 'dev-audit-once', NOW, '{}')
        .run();

    await insertAudit('audit-revoked-1', 'device_revoked');
    await expect(insertAudit('audit-revoked-2', 'device_revoked')).rejects.toThrow();

    // 部分索引只约束 device_revoked，其它事件类型不受影响。
    await insertAudit('audit-paired-1', 'device_paired');
    await insertAudit('audit-paired-2', 'device_paired');
  });

  /** 建一个完整的「工作空间 → 设备 → 配对」链，供 pairing_claims 的约束测试使用。 */
  async function seedPairing(pairingId: string, workspaceId: string, deviceId: string): Promise<void> {
    await insertWorkspace(workspaceId);
    await insertDevice(deviceId, workspaceId);
    await env.DB.prepare(
      'INSERT INTO device_pairings (id, workspace_id, pairing_hash, expires_at, used_at, created_by_device, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
    )
      .bind(pairingId, workspaceId, `hash-${pairingId}`, NOW + 60_000, deviceId, NOW)
      .run();
  }

  async function countClaimsFor(pairingId: string): Promise<number> {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM pairing_claims WHERE pairing_id = ?')
      .bind(pairingId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  it('pairing_claims 的 pairing_id 为主键（同一配对只能被占位一次）', async () => {
    await seedPairing('pairing-x', 'ws-claim', 'dev-claim');
    const insertClaim = (claimerDeviceId: string) =>
      env.DB.prepare('INSERT INTO pairing_claims (pairing_id, device_id, claimed_at) VALUES (?, ?, ?)')
        .bind('pairing-x', claimerDeviceId, NOW)
        .run();
    await insertClaim('claimer-1');
    await expect(insertClaim('claimer-2')).rejects.toThrow();
    expect(await countClaimsFor('pairing-x')).toBe(1);
  });

  it('拒绝孤儿占位记录（pairing 不存在时外键失败）', async () => {
    await expect(
      env.DB.prepare('INSERT INTO pairing_claims (pairing_id, device_id, claimed_at) VALUES (?, ?, ?)')
        .bind('no-such-pairing', 'claimer-orphan', NOW)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('删除配对记录时级联清理其占位记录（不留孤儿）', async () => {
    await seedPairing('pairing-cascade', 'ws-claim-cascade', 'dev-claim-cascade');
    await env.DB.prepare('INSERT INTO pairing_claims (pairing_id, device_id, claimed_at) VALUES (?, ?, ?)')
      .bind('pairing-cascade', 'claimer-cascade', NOW)
      .run();
    expect(await countClaimsFor('pairing-cascade')).toBe(1);

    await env.DB.prepare('DELETE FROM device_pairings WHERE id = ?').bind('pairing-cascade').run();
    expect(await countClaimsFor('pairing-cascade')).toBe(0);
  });

  it('占位记录可经受约束的 FK 链唯一回溯到工作空间（规划 5.1）', async () => {
    await seedPairing('pairing-scope', 'ws-claim-scope', 'dev-claim-scope');
    await env.DB.prepare('INSERT INTO pairing_claims (pairing_id, device_id, claimed_at) VALUES (?, ?, ?)')
      .bind('pairing-scope', 'claimer-scope', NOW)
      .run();

    const row = await env.DB.prepare(
      `SELECT p.workspace_id AS workspace_id
         FROM pairing_claims c
         JOIN device_pairings p ON p.id = c.pairing_id
        WHERE c.pairing_id = ?`,
    )
      .bind('pairing-scope')
      .first<{ workspace_id: string }>();
    expect(row?.workspace_id).toBe('ws-claim-scope');
  });

  it('初始化守卫表的 singleton_key 只能是 primary（枚举约束即单例语义）', async () => {
    await expect(
      env.DB.prepare('INSERT INTO workspace_bootstrap_guard (singleton_key, workspace_id, claimed_at) VALUES (?, ?, ?)')
        .bind('secondary', 'ws-x', NOW)
        .run(),
    ).rejects.toThrow();
  });

  it('速率限制表的 attempt_count 不允许为负', async () => {
    await expect(
      env.DB.prepare(
        'INSERT INTO auth_rate_limits (scope_key, window_start, attempt_count, updated_at) VALUES (?, ?, ?, ?)',
      )
        .bind('neg:test', NOW, -1, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it('认证与约束相关索引存在', async () => {
    const required = [
      'idx_workspaces_recovery_hash',
      'idx_devices_token_hash',
      'idx_devices_workspace',
      'idx_devices_workspace_active',
      'idx_device_pairings_pairing_hash',
      'idx_device_pairings_expires',
      'idx_identity_audit_workspace_created',
    ];
    for (const index of required) {
      expect(await indexExists(index), `缺少索引 ${index}`).toBe(true);
    }
  });

  it('重复应用迁移安全：原始语句逐条重放仍然成功（IF NOT EXISTS 幂等）', async () => {
    // 直接把迁移里拆分出的每条语句再执行一次，不经过记账表的「已应用」短路，
    // 这才是对「重复应用安全」的真实检验。
    for (const migration of env.TEST_MIGRATIONS) {
      for (const query of migration.queries) {
        await env.DB.prepare(query).run();
      }
    }
    // 表仍然只有一份，数据未被清空。
    expect(await tableExists('workspaces')).toBe(true);
    await insertWorkspace('replay-ws');
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?')
      .bind('replay-ws')
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});

describe('外键约束', () => {
  it('拒绝引用不存在工作空间的设备（悬空外键）', async () => {
    await expect(insertDevice('orphan-device', 'no-such-workspace')).rejects.toThrow();
  });

  it('拒绝配对记录引用不存在的设备', async () => {
    await insertWorkspace('ws-fk-pairing');
    await expect(
      env.DB.prepare(
        'INSERT INTO device_pairings (id, workspace_id, pairing_hash, expires_at, used_at, created_by_device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind('pairing-1', 'ws-fk-pairing', 'pairing-hash-1', NOW + 60_000, null, 'ghost-device', NOW)
        .run(),
    ).rejects.toThrow();
  });

  it('删除工作空间时级联删除其设备', async () => {
    await insertWorkspace('ws-cascade');
    await insertDevice('device-cascade', 'ws-cascade');
    await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind('ws-cascade').run();
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM devices WHERE workspace_id = ?')
      .bind('ws-cascade')
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it('删除设备时审计记录的 device_id 置空但审计本身保留', async () => {
    await insertWorkspace('ws-audit');
    await insertDevice('device-audit', 'ws-audit');
    await env.DB.prepare(
      'INSERT INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('audit-1', 'ws-audit', 'device_paired', 'device-audit', NOW, '{}')
      .run();

    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind('device-audit').run();

    const row = await env.DB.prepare('SELECT device_id FROM identity_audit WHERE id = ?')
      .bind('audit-1')
      .first<{ device_id: string | null }>();
    expect(row).not.toBeNull();
    expect(row?.device_id).toBeNull();
  });
});

describe('唯一约束', () => {
  it('拒绝重复的恢复密钥摘要', async () => {
    await insertWorkspace('ws-uniq-1', { recovery_hash: 'same-recovery-hash' });
    await expect(insertWorkspace('ws-uniq-2', { recovery_hash: 'same-recovery-hash' })).rejects.toThrow();
  });

  it('拒绝重复的设备 Token 摘要', async () => {
    await insertWorkspace('ws-uniq-device');
    await insertDevice('device-uniq-1', 'ws-uniq-device', { token_hash: 'same-token-hash' });
    await expect(insertDevice('device-uniq-2', 'ws-uniq-device', { token_hash: 'same-token-hash' })).rejects.toThrow();
  });

  it('拒绝重复的配对凭证摘要（一次性配对的底层保证）', async () => {
    await insertWorkspace('ws-uniq-pairing');
    await insertDevice('device-uniq-pairing', 'ws-uniq-pairing');
    const insert = (id: string): Promise<unknown> =>
      env.DB.prepare(
        'INSERT INTO device_pairings (id, workspace_id, pairing_hash, expires_at, used_at, created_by_device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(id, 'ws-uniq-pairing', 'same-pairing-hash', NOW + 60_000, null, 'device-uniq-pairing', NOW)
        .run();
    await insert('pairing-a');
    await expect(insert('pairing-b')).rejects.toThrow();
  });
});

describe('枚举与 NOT NULL 约束', () => {
  it('拒绝非法 region 取值', async () => {
    await expect(insertWorkspace('ws-bad-region', { region: 'eu' })).rejects.toThrow();
  });

  it('接受 cn 与 global 两个合法区服', async () => {
    await insertWorkspace('ws-region-cn', { region: 'cn' });
    await insertWorkspace('ws-region-global', { region: 'global' });
  });

  it('拒绝非法审计事件类型', async () => {
    await insertWorkspace('ws-bad-audit');
    await expect(
      env.DB.prepare(
        'INSERT INTO identity_audit (id, workspace_id, event_type, device_id, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind('audit-bad', 'ws-bad-audit', 'not_a_real_event', null, NOW, '{}')
        .run(),
    ).rejects.toThrow();
  });

  it('拒绝缺少必需列的插入（NOT NULL）', async () => {
    await expect(
      env.DB.prepare('INSERT INTO workspaces (id, region, timezone, locale, recovery_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('ws-missing-col', 'cn', 'Asia/Shanghai', 'zh-CN', 'hash-x', NOW)
        .run(),
    ).rejects.toThrow();
  });
});

describe('只保存摘要', () => {
  it('凭证相关列都是摘要列，没有任何明文列', async () => {
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('devices')").all<{ name: string }>();
    const names = columns.results.map((row) => row.name);
    expect(names).toContain('token_hash');
    expect(names).not.toContain('token');
    expect(names).not.toContain('secret');

    const pairingColumns = await env.DB.prepare("SELECT name FROM pragma_table_info('device_pairings')").all<{
      name: string;
    }>();
    const pairingNames = pairingColumns.results.map((row) => row.name);
    expect(pairingNames).toContain('pairing_hash');
    expect(pairingNames).not.toContain('pairing_code');
  });
});

// ---------------------------------------------------------------------------
// 阶段 04：自由导航（0008_navigation.sql）与手工活动（0009_events.sql）
// ---------------------------------------------------------------------------
//
// 这里只**追加**断言，既有用例一字未改。上面「原始语句逐条重放仍然成功」的用例
// 已经覆盖 0008 / 0009（`env.TEST_MIGRATIONS` 由 migrations 目录整体读取），
// 因此新表的可重放性由那条用例证明；本段负责表 / 索引的存在性和**行为级**约束。

/** `workspace_nav_links` 一行（默认值取迁移里的默认，便于只覆盖待测字段）。 */
function insertNavLinkRow(input: {
  readonly workspaceId: string;
  readonly id: string;
  readonly sourceCatalogId?: string | null;
  readonly openMode?: string;
  readonly region?: string;
  readonly health?: string;
  readonly deletedAt?: number | null;
}): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO workspace_nav_links
       (id, workspace_id, source_catalog_id, title, url, open_mode, region, health, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, '链接', 'https://example.test/', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.workspaceId,
      input.sourceCatalogId ?? null,
      input.openMode ?? 'new_tab',
      input.region ?? 'cn',
      input.health ?? 'unknown',
      input.deletedAt ?? null,
      NOW,
      NOW,
    )
    .run();
}

function insertNavGroupRow(input: { readonly workspaceId: string; readonly id: string }): Promise<unknown> {
  return env.DB.prepare(
    'INSERT INTO workspace_nav_groups (id, workspace_id, name, sort_order, revision, deleted_at, created_at, updated_at) VALUES (?, ?, ?, 0, 0, NULL, ?, ?)',
  )
    .bind(input.id, input.workspaceId, '分组', NOW, NOW)
    .run();
}

function insertNavMembershipRow(input: {
  readonly workspaceId: string;
  readonly linkId: string;
  readonly groupId: string;
}): Promise<unknown> {
  return env.DB.prepare(
    'INSERT INTO workspace_nav_memberships (link_id, group_id, workspace_id, sort_order, deleted_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?)',
  )
    .bind(input.linkId, input.groupId, input.workspaceId, NOW)
    .run();
}

/** 公共来源活动（`events` 刻意没有 workspace_id：它不属于任何工作空间）。 */
function insertEventRow(input: {
  readonly id: string;
  readonly region?: string;
  readonly startsAt?: number;
  readonly endsAt?: number;
}): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO events (id, region, title, starts_at, ends_at, source_url, verification_status, created_at, updated_at)
     VALUES (?, ?, '公共活动', ?, ?, 'https://example.test/event', 'unverified', ?, ?)`,
  )
    .bind(input.id, input.region ?? 'cn', input.startsAt ?? NOW, input.endsAt ?? NOW + 3_600_000, NOW, NOW)
    .run();
}

/** 个人活动（工作空间私有，可带墓碑与设备留痕）。 */
function insertWorkspaceEventRow(input: {
  readonly workspaceId: string;
  readonly id: string;
  readonly region?: string;
  readonly startsAt?: number;
  readonly endsAt?: number;
}): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO workspace_events (id, workspace_id, title, region, starts_at, ends_at, created_at, updated_at)
     VALUES (?, ?, '个人活动', ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.workspaceId,
      input.region ?? 'cn',
      input.startsAt ?? NOW,
      input.endsAt ?? NOW + 3_600_000,
      NOW,
      NOW,
    )
    .run();
}

function insertNavOperationRow(input: { readonly workspaceId: string; readonly operationId: string }): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO nav_operations (workspace_id, operation_id, kind, result_json, created_at, attempt_token)
     VALUES (?, ?, 'nav.link.create', '{}', ?, NULL)`,
  )
    .bind(input.workspaceId, input.operationId, NOW)
    .run();
}

function insertNavOperationIntentRow(input: {
  readonly workspaceId: string;
  readonly operationId: string;
}): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO nav_operation_intents (workspace_id, operation_id, kind, request_fingerprint, created_at)
     VALUES (?, ?, 'nav.link.create', 'fingerprint-0001', ?)`,
  )
    .bind(input.workspaceId, input.operationId, NOW)
    .run();
}

/**
 * 按工作空间统计阶段 04 的表行数。
 * SQL 是常量表里的字面量（不拼接表名），因此不存在注入面。
 */
const NAV_WORKSPACE_COUNT_SQL = {
  links: 'SELECT COUNT(*) AS count FROM workspace_nav_links WHERE workspace_id = ?',
  groups: 'SELECT COUNT(*) AS count FROM workspace_nav_groups WHERE workspace_id = ?',
  memberships: 'SELECT COUNT(*) AS count FROM workspace_nav_memberships WHERE workspace_id = ?',
  state: 'SELECT COUNT(*) AS count FROM workspace_nav_state WHERE workspace_id = ?',
  operations: 'SELECT COUNT(*) AS count FROM nav_operations WHERE workspace_id = ?',
  intents: 'SELECT COUNT(*) AS count FROM nav_operation_intents WHERE workspace_id = ?',
  events: 'SELECT COUNT(*) AS count FROM workspace_events WHERE workspace_id = ?',
} as const;

type NavWorkspaceCountTable = keyof typeof NAV_WORKSPACE_COUNT_SQL;

async function countNavRows(table: NavWorkspaceCountTable, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare(NAV_WORKSPACE_COUNT_SQL[table]).bind(workspaceId).first<{ count: number }>();
  return row?.count ?? -1;
}

describe('阶段 04：导航与活动迁移（0008 / 0009）', () => {
  it('新表与关键索引都已建立', async () => {
    for (const table of [
      'nav_catalog_links',
      'workspace_nav_links',
      'workspace_nav_groups',
      'workspace_nav_memberships',
      'workspace_nav_state',
      'nav_operations',
      'nav_operation_intents',
      'events',
      'workspace_events',
    ]) {
      expect(await tableExists(table), `缺少表 ${table}`).toBe(true);
    }
    for (const index of [
      'idx_nav_catalog_links_category',
      'idx_nav_catalog_links_region',
      // 「每个目录条目在每个工作空间至多一条活跃副本」的部分唯一索引。
      'idx_workspace_nav_links_catalog_active',
      'idx_workspace_nav_links_active',
      'idx_workspace_nav_links_favorite',
      'idx_workspace_nav_links_region',
      'idx_workspace_nav_links_sync',
      'idx_workspace_nav_groups_active',
      'idx_workspace_nav_groups_sync',
      'idx_workspace_nav_memberships_group',
      'idx_workspace_nav_memberships_sync',
      'idx_nav_operations_created',
      'idx_nav_operation_intents_created',
      'idx_events_region_start',
      'idx_events_start',
      'idx_workspace_events_active',
      'idx_workspace_events_region',
      'idx_workspace_events_sync',
    ]) {
      expect(await indexExists(index), `缺少索引 ${index}`).toBe(true);
    }

    // 公共活动表承担「全局只读参考数据」：它**不能**带 workspace_id，
    // 否则「个人行永不进入公共响应」这条边界会退化成查询纪律而不是结构事实。
    const eventColumns = await env.DB.prepare("SELECT name FROM pragma_table_info('events')").all<{
      name: string;
    }>();
    expect(eventColumns.results.map((row) => row.name)).not.toContain('workspace_id');
  });

  it('idx_workspace_nav_links_catalog_active：活跃副本唯一，墓碑可与新活跃行共存，不同工作空间互不影响', async () => {
    await insertWorkspace('ws-nav-unique');
    const workspaceId = 'ws-nav-unique';
    await insertNavLinkRow({ workspaceId, id: 'nav-u-1', sourceCatalogId: 'catalog-1' });

    // 同工作空间同目录条目的**第二条活跃副本**被数据库拒绝。
    await expect(insertNavLinkRow({ workspaceId, id: 'nav-u-2', sourceCatalogId: 'catalog-1' })).rejects.toThrow(
      /unique/i,
    );

    // 墓碑行不受部分索引约束：墓碑 + 新活跃行可以共存（这正是「删除后再导入复用同一行」的基础）。
    await insertNavLinkRow({ workspaceId, id: 'nav-u-3', sourceCatalogId: 'catalog-2', deletedAt: NOW });
    await insertNavLinkRow({ workspaceId, id: 'nav-u-4', sourceCatalogId: 'catalog-2' });
    // 但同一目录条目仍然只能有**一条**活跃副本（墓碑那条不算活跃）。
    await expect(insertNavLinkRow({ workspaceId, id: 'nav-u-5', sourceCatalogId: 'catalog-2' })).rejects.toThrow(
      /unique/i,
    );

    // 弱关联为空的行完全不受该索引约束（个人手建链接可以有多条）。
    await insertNavLinkRow({ workspaceId, id: 'nav-u-6' });
    await insertNavLinkRow({ workspaceId, id: 'nav-u-7' });

    // 不同工作空间各有一条同名目录条目的副本。
    await insertWorkspace('ws-nav-unique-other');
    await insertNavLinkRow({ workspaceId: 'ws-nav-unique-other', id: 'nav-u-8', sourceCatalogId: 'catalog-1' });
  });

  it('workspace_nav_links 的 open_mode / region / health CHECK 拒绝非法值', async () => {
    await insertWorkspace('ws-nav-check');
    const workspaceId = 'ws-nav-check';

    await expect(
      insertNavLinkRow({ workspaceId, id: 'nav-c-open', openMode: 'iframe' }),
    ).rejects.toThrow();
    await expect(insertNavLinkRow({ workspaceId, id: 'nav-c-region', region: 'eu' })).rejects.toThrow();
    // 枚举里刻意没有 'blocked'：403 只能映射为 maybe_blocked，不得写成永久失效。
    await expect(insertNavLinkRow({ workspaceId, id: 'nav-c-health', health: 'blocked' })).rejects.toThrow();

    // 合法取值被接受（含 both 与 maybe_blocked）。
    await insertNavLinkRow({ workspaceId, id: 'nav-c-ok-open', openMode: 'same_tab' });
    await insertNavLinkRow({ workspaceId, id: 'nav-c-ok-region', region: 'both' });
    await insertNavLinkRow({ workspaceId, id: 'nav-c-ok-health', health: 'maybe_blocked' });
  });

  it('workspace_nav_memberships.link_id 在删除链接时级联清理，分组本身保留', async () => {
    await insertWorkspace('ws-nav-cascade-link');
    const workspaceId = 'ws-nav-cascade-link';
    await insertNavLinkRow({ workspaceId, id: 'nav-member-link' });
    await insertNavGroupRow({ workspaceId, id: 'nav-member-group' });
    await insertNavMembershipRow({ workspaceId, linkId: 'nav-member-link', groupId: 'nav-member-group' });
    expect(await countNavRows('memberships', workspaceId)).toBe(1);

    await env.DB.prepare('DELETE FROM workspace_nav_links WHERE id = ? AND workspace_id = ?')
      .bind('nav-member-link', workspaceId)
      .run();

    // 成员关系随链接消失；分组是独立实体，不受影响。
    expect(await countNavRows('memberships', workspaceId)).toBe(0);
    expect(await countNavRows('groups', workspaceId)).toBe(1);
  });

  it('删除工作空间级联删除其导航行、nav_operations / 意图与 workspace_events', async () => {
    await insertWorkspace('ws-nav-workspace-cascade');
    const workspaceId = 'ws-nav-workspace-cascade';
    await insertNavLinkRow({ workspaceId, id: 'nav-ws-link' });
    await insertNavGroupRow({ workspaceId, id: 'nav-ws-group' });
    await insertNavMembershipRow({ workspaceId, linkId: 'nav-ws-link', groupId: 'nav-ws-group' });
    await env.DB.prepare('INSERT INTO workspace_nav_state (workspace_id, revision, updated_at) VALUES (?, 3, ?)')
      .bind(workspaceId, NOW)
      .run();
    await insertNavOperationRow({ workspaceId, operationId: 'op-nav-cascade-0001' });
    await insertNavOperationIntentRow({ workspaceId, operationId: 'op-nav-cascade-0001' });
    await insertWorkspaceEventRow({ workspaceId, id: 'we-cascade' });

    expect(await countNavRows('links', workspaceId)).toBe(1);
    expect(await countNavRows('groups', workspaceId)).toBe(1);
    expect(await countNavRows('memberships', workspaceId)).toBe(1);
    expect(await countNavRows('state', workspaceId)).toBe(1);
    expect(await countNavRows('operations', workspaceId)).toBe(1);
    expect(await countNavRows('intents', workspaceId)).toBe(1);
    expect(await countNavRows('events', workspaceId)).toBe(1);

    await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspaceId).run();

    expect(await countNavRows('links', workspaceId)).toBe(0);
    expect(await countNavRows('groups', workspaceId)).toBe(0);
    expect(await countNavRows('memberships', workspaceId)).toBe(0);
    expect(await countNavRows('state', workspaceId)).toBe(0);
    expect(await countNavRows('operations', workspaceId)).toBe(0);
    expect(await countNavRows('intents', workspaceId)).toBe(0);
    expect(await countNavRows('events', workspaceId)).toBe(0);
  });

  it('workspace_events 拒绝 ends_at < starts_at 与 region = both，接受端点相等', async () => {
    await insertWorkspace('ws-event-check');
    const workspaceId = 'ws-event-check';

    await expect(
      insertWorkspaceEventRow({ workspaceId, id: 'we-bad-region', region: 'both' }),
    ).rejects.toThrow();
    await expect(insertWorkspaceEventRow({ workspaceId, id: 'we-bad-region-eu', region: 'eu' })).rejects.toThrow();
    await expect(
      insertWorkspaceEventRow({ workspaceId, id: 'we-bad-range', startsAt: NOW, endsAt: NOW - 1 }),
    ).rejects.toThrow();

    // 零长度区间合法（CHECK 是 ends_at >= starts_at）。
    await insertWorkspaceEventRow({ workspaceId, id: 'we-ok-zero', startsAt: NOW, endsAt: NOW });
  });

  it('events 拒绝 region = both 与倒置区间', async () => {
    await expect(insertEventRow({ id: 'ev-bad-region', region: 'both' })).rejects.toThrow();
    await expect(insertEventRow({ id: 'ev-bad-region-eu', region: 'eu' })).rejects.toThrow();
    await expect(insertEventRow({ id: 'ev-bad-range', startsAt: NOW, endsAt: NOW - 1 })).rejects.toThrow();
    await insertEventRow({ id: 'ev-ok', region: 'global' });
  });
});
