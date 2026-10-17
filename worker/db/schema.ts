/**
 * Drizzle schema（HUB-003）。
 *
 * 事实来源（single source of truth）是 `migrations/*.sql`：
 * - 表、列、FK、唯一约束、CHECK 枚举与索引都由 SQL 迁移定义并实际落到 D1。
 * - 本文件是 SQL 的**类型化镜像**，只用于类型安全查询，不参与建表。
 *   因此这里不重复声明 CHECK 与索引，避免两处定义漂移；
 *   一旦迁移变更，必须同步修改本文件。
 * - D1 的 FK 约束由运行时强制（`PRAGMA foreign_keys` 默认开启），
 *   不依赖 ORM 层的 `references()`。
 */
import type { IdentityAuditEvent, ModulePersistedStatus, Region } from '@ff14-hub/shared';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** 单个私有工作空间（INV-05：无传统账号，一个工作空间 + 多设备凭证）。 */
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    region: text('region').$type<Region>().notNull(),
    timezone: text('timezone').notNull(),
    locale: text('locale').notNull(),
    /** 恢复密钥的 SHA-256 摘要；明文永不落库。 */
    recoveryHash: text('recovery_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [uniqueIndex('idx_workspaces_recovery_hash').on(table.recoveryHash)],
);

/** 独立设备身份（每台设备一个独立凭证，可单独撤销）。 */
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 设备 Token 的 SHA-256 摘要；明文永不落库。 */
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    /** 非空即表示已撤销；撤销后立即拒绝该凭证的后续访问。 */
    revokedAt: integer('revoked_at'),
    lastSeenAt: integer('last_seen_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_devices_token_hash').on(table.tokenHash),
    index('idx_devices_workspace').on(table.workspaceId),
    index('idx_devices_workspace_active').on(table.workspaceId, table.revokedAt),
  ],
);

/** 一次性、有限期的设备配对（HUB-006 实现领取流程）。 */
export const devicePairings = sqliteTable(
  'device_pairings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 配对凭证的 SHA-256 摘要。 */
    pairingHash: text('pairing_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    /** 非空即表示已被消费；一次性语义由该列 + 条件 UPDATE 保证。 */
    usedAt: integer('used_at'),
    createdByDevice: text('created_by_device')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_device_pairings_pairing_hash').on(table.pairingHash),
    index('idx_device_pairings_workspace').on(table.workspaceId),
    index('idx_device_pairings_expires').on(table.expiresAt),
  ],
);

/** 身份操作审计。detail_json 只允许放非敏感事实，禁止放凭证或其摘要。 */
export const identityAudit = sqliteTable(
  'identity_audit',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventType: text('event_type').$type<IdentityAuditEvent>().notNull(),
    /** 设备被删除时置空，保留审计记录本身。 */
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
    detailJson: text('detail_json').notNull(),
  },
  (table) => [index('idx_identity_audit_workspace_created').on(table.workspaceId, table.createdAt)],
);

/** 单工作空间初始化守卫（HUB-006，由 migrations/0002_identity.sql 建立）。 */
export const workspaceBootstrapGuard = sqliteTable('workspace_bootstrap_guard', {
  /** 固定为 'primary'：主键唯一约束即「只能初始化一次」的数据库级保证。 */
  singletonKey: text('singleton_key').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  claimedAt: integer('claimed_at').notNull(),
});

/** 身份端点速率限制计数（HUB-006）。scope_key 是端点 + 客户端标识摘要，不含明文 IP。 */
export const authRateLimits = sqliteTable(
  'auth_rate_limits',
  {
    scopeKey: text('scope_key').primaryKey(),
    windowStart: integer('window_start').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_auth_rate_limits_window').on(table.windowStart)],
);

/**
 * 配对领取记录（HUB-006，由 migrations/0002_identity.sql 建立）。
 * `pairingId` 是主键：并发领取时只有一个事务能插入成功；`deviceId` 是本次调用独有的 UUID，
 * 用作「这一次消费」的无歧义标记（时间戳会撞、UUID 不会）。
 *
 * 工作空间回溯（规划 5.1）：`pairingId` 外键指向 `device_pairings`，
 * 后者带 NOT NULL 的 `workspace_id` 外键，因此本表可经受约束的 FK 链唯一回溯到工作空间，
 * 无需再存一份 workspace_id 副本。`ON DELETE CASCADE` 保证配对被删除时不留下孤儿占位行。
 */
export const pairingClaims = sqliteTable(
  'pairing_claims',
  {
    pairingId: text('pairing_id')
      .primaryKey()
      .references(() => devicePairings.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    claimedAt: integer('claimed_at').notNull(),
  },
  (table) => [index('idx_pairing_claims_device').on(table.deviceId)],
);

/**
 * 工作空间模块状态（HUB-050，由 migrations/0003_modules.sql 建立）。
 *
 * - 主键 `(workspace_id, module_id)`：模块状态天然按工作空间隔离。
 * - `module_id` 刻意**没有**外键：模块是代码里的静态注册项（worker/modules/registry），
 *   不是数据库行；合法性由注册表校验。
 * - `revision` 是防静默覆盖的乐观并发列：所有变更都以 `WHERE revision = ?` 的条件更新提交。
 * - `status` 只允许三种持久状态；「未安装」是行缺失时的派生值，永远不会被写进来。
 * - 停用与卸载都不删除本行，因此个人设置会保留（卸载 ≠ 清数据）。
 */
export const workspaceModules = sqliteTable(
  'workspace_modules',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    status: text('status').$type<ModulePersistedStatus>().notNull(),
    settingsJson: text('settings_json').notNull(),
    settingsVersion: integer('settings_version').notNull(),
    revision: integer('revision').notNull(),
    installedAt: integer('installed_at').notNull(),
    enabledAt: integer('enabled_at'),
    disabledAt: integer('disabled_at'),
    uninstalledAt: integer('uninstalled_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_workspace_modules_workspace_status').on(table.workspaceId, table.status)],
);

/** 全部表的集合，供 drizzle 客户端与测试使用。 */
export const schema = {
  workspaces,
  devices,
  devicePairings,
  identityAudit,
  workspaceBootstrapGuard,
  authRateLimits,
  pairingClaims,
  workspaceModules,
} as const;
