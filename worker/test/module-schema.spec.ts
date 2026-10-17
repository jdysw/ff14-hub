/**
 * `workspace_modules` 迁移与约束测试（HUB-050 验收）。
 *
 * 立场（规划 5.1）：约束必须在**真实 D1** 上实测，不能假设独立 SQLite 的行为一致，
 * 也不能只看迁移文件「写了 CHECK」就认为约束生效。
 * 覆盖：状态枚举、revision / settings_version 的取值下界、主键唯一、外键与级联、
 * NOT NULL、必需索引、迁移重放安全，以及「module_id 刻意没有外键」这一设计决定。
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const NOW = 1_760_000_000_000;

async function insertWorkspace(id: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO workspaces (id, region, timezone, locale, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, 'cn', 'Asia/Shanghai', 'zh-CN', `hash-${id}`, NOW, NOW)
    .run();
}

interface ModuleRowInput {
  readonly workspaceId: string;
  readonly moduleId: string;
  readonly status?: string;
  readonly settingsJson?: string;
  readonly settingsVersion?: number;
  readonly revision?: number;
}

function insertModuleRow(input: ModuleRowInput): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO workspace_modules (
       workspace_id, module_id, status, settings_json, settings_version, revision,
       installed_at, enabled_at, disabled_at, uninstalled_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.workspaceId,
      input.moduleId,
      input.status ?? 'enabled',
      input.settingsJson ?? '{}',
      input.settingsVersion ?? 1,
      input.revision ?? 1,
      NOW,
      NOW,
      null,
      null,
      NOW,
      NOW,
    )
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

describe('workspace_modules 迁移', () => {
  it('表与索引都已建立', async () => {
    expect(await tableExists('workspace_modules')).toBe(true);
    expect(await indexExists('idx_workspace_modules_workspace_status')).toBe(true);
  });

  it('唯一一条到 workspaces 的外键，module_id 刻意没有外键（模块是代码注册项，不是数据库行）', async () => {
    const keys = await env.DB.prepare("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list('workspace_modules')").all<{
      table: string;
      from: string;
      to: string;
    }>();
    expect(keys.results).toHaveLength(1);
    expect(keys.results[0]?.table).toBe('workspaces');
    expect(keys.results[0]?.from).toBe('workspace_id');
    expect(keys.results[0]?.to).toBe('id');
  });

  it('迁移重放依然安全（IF NOT EXISTS 幂等），重放后仍可正常写入', async () => {
    for (const migration of env.TEST_MIGRATIONS) {
      for (const query of migration.queries) {
        await env.DB.prepare(query).run();
      }
    }
    expect(await tableExists('workspace_modules')).toBe(true);
    await insertWorkspace('ws-replay-modules');
    await insertModuleRow({ workspaceId: 'ws-replay-modules', moduleId: 'demo.basics' });
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workspace_modules WHERE workspace_id = ?',
    )
      .bind('ws-replay-modules')
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});

describe('workspace_modules 约束', () => {
  it('拒绝把派生状态 not_installed 写进数据库（CHECK 只允许三种持久状态）', async () => {
    await insertWorkspace('ws-status');
    await expect(insertModuleRow({ workspaceId: 'ws-status', moduleId: 'demo.basics', status: 'not_installed' })).rejects.toThrow();
    // 「未安装」只能由行缺失表达。
    await insertModuleRow({ workspaceId: 'ws-status', moduleId: 'demo.basics', status: 'disabled' });
  });

  it('拒绝未知状态字符串', async () => {
    await insertWorkspace('ws-status-bad');
    await expect(
      insertModuleRow({ workspaceId: 'ws-status-bad', moduleId: 'demo.basics', status: 'paused' }),
    ).rejects.toThrow();
  });

  it('revision 必须 >= 1（0 只表示「还没有行」）', async () => {
    await insertWorkspace('ws-revision');
    await expect(
      insertModuleRow({ workspaceId: 'ws-revision', moduleId: 'demo.basics', revision: 0 }),
    ).rejects.toThrow();
  });

  it('settings_version 不允许为负', async () => {
    await insertWorkspace('ws-settings-version');
    await expect(
      insertModuleRow({ workspaceId: 'ws-settings-version', moduleId: 'demo.basics', settingsVersion: -1 }),
    ).rejects.toThrow();
  });

  it('主键 (workspace_id, module_id) 保证同一工作空间同一模块只有一行', async () => {
    await insertWorkspace('ws-pk');
    await insertModuleRow({ workspaceId: 'ws-pk', moduleId: 'demo.basics' });
    await expect(insertModuleRow({ workspaceId: 'ws-pk', moduleId: 'demo.basics' })).rejects.toThrow();
    // 不同工作空间的同名模块互不影响。
    await insertWorkspace('ws-pk-other');
    await insertModuleRow({ workspaceId: 'ws-pk-other', moduleId: 'demo.basics' });
  });

  it('拒绝悬空工作空间引用', async () => {
    await expect(insertModuleRow({ workspaceId: 'no-such-workspace', moduleId: 'demo.basics' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );
  });

  it('删除工作空间时级联删除其模块状态（不留下孤儿行）', async () => {
    await insertWorkspace('ws-cascade-modules');
    await insertModuleRow({ workspaceId: 'ws-cascade-modules', moduleId: 'demo.basics' });
    await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind('ws-cascade-modules').run();
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM workspace_modules WHERE workspace_id = ?')
      .bind('ws-cascade-modules')
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it('NOT NULL：缺少必需列时插入失败', async () => {
    await insertWorkspace('ws-not-null');
    await expect(
      env.DB.prepare(
        'INSERT INTO workspace_modules (workspace_id, module_id, status, settings_json, settings_version, installed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind('ws-not-null', 'demo.basics', 'enabled', '{}', 1, NOW, NOW)
        .run(),
    ).rejects.toThrow();
  });

  it('缺省 settings_json 为 {}（新行不会留下 NULL 设置）', async () => {
    await insertWorkspace('ws-default-settings');
    await env.DB.prepare(
      `INSERT INTO workspace_modules (
         workspace_id, module_id, status, settings_version, revision,
         installed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind('ws-default-settings', 'demo.basics', 'enabled', 1, 1, NOW, NOW, NOW)
      .run();
    const row = await env.DB.prepare('SELECT settings_json FROM workspace_modules WHERE workspace_id = ?')
      .bind('ws-default-settings')
      .first<{ settings_json: string }>();
    expect(row?.settings_json).toBe('{}');
  });

  it('条件更新（WHERE revision = ?）是防静默覆盖的机制：旧 revision 更新影响 0 行', async () => {
    await insertWorkspace('ws-conditional');
    await insertModuleRow({ workspaceId: 'ws-conditional', moduleId: 'demo.basics', revision: 1 });

    const first = await env.DB.prepare(
      'UPDATE workspace_modules SET status = ?, revision = revision + 1 WHERE workspace_id = ? AND module_id = ? AND revision = ?',
    )
      .bind('disabled', 'ws-conditional', 'demo.basics', 1)
      .run();
    expect(first.meta.changes).toBe(1);

    // 同一个（已经过期的）revision 再来一次：必须影响 0 行。
    const second = await env.DB.prepare(
      'UPDATE workspace_modules SET status = ?, revision = revision + 1 WHERE workspace_id = ? AND module_id = ? AND revision = ?',
    )
      .bind('enabled', 'ws-conditional', 'demo.basics', 1)
      .run();
    expect(second.meta.changes).toBe(0);

    const row = await env.DB.prepare('SELECT status, revision FROM workspace_modules WHERE workspace_id = ?')
      .bind('ws-conditional')
      .first<{ status: string; revision: number }>();
    expect(row?.status).toBe('disabled');
    expect(row?.revision).toBe(2);
  });
});

describe('workspace_module_operations（待完成操作的持久事实）', () => {
  async function insertOperation(overrides: Partial<Record<string, unknown>> = {}): Promise<unknown> {
    return await env.DB.prepare(
      `INSERT INTO workspace_module_operations (
         workspace_id, module_id, action, target_status, revision, started_at, attempts, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        overrides['workspace_id'] ?? 'ws-ops',
        overrides['module_id'] ?? 'demo.basics',
        overrides['action'] ?? 'uninstall',
        overrides['target_status'] ?? 'uninstalled',
        overrides['revision'] ?? 2,
        NOW,
        overrides['attempts'] ?? 1,
        overrides['last_error'] ?? null,
      )
      .run();
  }

  it('表已建立', async () => {
    expect(await tableExists('workspace_module_operations')).toBe(true);
  });

  it('复合外键指向 workspace_modules：没有模块行就不能有待完成操作（不留孤儿）', async () => {
    await expect(insertOperation({ workspace_id: 'no-such-workspace' })).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );

    await insertWorkspace('ws-ops');
    await insertModuleRow({ workspaceId: 'ws-ops', moduleId: 'demo.basics', status: 'disabled' });
    await insertOperation({ workspace_id: 'ws-ops', module_id: 'demo.basics' });
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workspace_module_operations WHERE workspace_id = ?',
    )
      .bind('ws-ops')
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it('主键 (workspace_id, module_id) 保证同一模块同时最多一个待完成操作', async () => {
    await insertWorkspace('ws-ops-pk');
    await insertModuleRow({ workspaceId: 'ws-ops-pk', moduleId: 'demo.basics' });
    await insertOperation({ workspace_id: 'ws-ops-pk', module_id: 'demo.basics' });
    await expect(insertOperation({ workspace_id: 'ws-ops-pk', module_id: 'demo.basics', action: 'enable' })).rejects.toThrow();
  });

  it('枚举 CHECK 拒绝未知动作与未知目标状态', async () => {
    await insertWorkspace('ws-ops-enum');
    await insertModuleRow({ workspaceId: 'ws-ops-enum', moduleId: 'demo.basics' });
    await expect(
      insertOperation({ workspace_id: 'ws-ops-enum', module_id: 'demo.basics', action: 'purge' }),
    ).rejects.toThrow();
    await expect(
      insertOperation({ workspace_id: 'ws-ops-enum', module_id: 'demo.basics', target_status: 'not_installed' }),
    ).rejects.toThrow();
  });

  it('attempts 必须 >= 1（0 次尝试没有意义）', async () => {
    await insertWorkspace('ws-ops-attempts');
    await insertModuleRow({ workspaceId: 'ws-ops-attempts', moduleId: 'demo.basics' });
    await expect(
      insertOperation({ workspace_id: 'ws-ops-attempts', module_id: 'demo.basics', attempts: 0 }),
    ).rejects.toThrow();
  });

  it('删除模块状态时级联删除其待完成操作（不会留下指向不存在模块的记录）', async () => {
    await insertWorkspace('ws-ops-cascade');
    await insertModuleRow({ workspaceId: 'ws-ops-cascade', moduleId: 'demo.basics' });
    await insertOperation({ workspace_id: 'ws-ops-cascade', module_id: 'demo.basics' });
    await env.DB.prepare('DELETE FROM workspace_modules WHERE workspace_id = ?').bind('ws-ops-cascade').run();
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workspace_module_operations WHERE workspace_id = ?',
    )
      .bind('ws-ops-cascade')
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it('迁移重放安全：重跑全部迁移后仍可正常写入与级联', async () => {
    for (const migration of env.TEST_MIGRATIONS) {
      for (const query of migration.queries) {
        await env.DB.prepare(query).run();
      }
    }
    expect(await tableExists('workspace_module_operations')).toBe(true);
    await insertWorkspace('ws-ops-replay');
    await insertModuleRow({ workspaceId: 'ws-ops-replay', moduleId: 'demo.basics' });
    await insertOperation({ workspace_id: 'ws-ops-replay', module_id: 'demo.basics' });
    await env.DB.prepare('DELETE FROM workspace_modules WHERE workspace_id = ?').bind('ws-ops-replay').run();
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM workspace_module_operations WHERE workspace_id = ?',
    )
      .bind('ws-ops-replay')
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
});
