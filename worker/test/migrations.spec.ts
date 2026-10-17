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
