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
import type { IdentityAuditEvent, Region } from '@ff14-hub/shared';
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

/** 全部表的集合，供 drizzle 客户端与测试使用。 */
export const schema = {
  workspaces,
  devices,
  devicePairings,
  identityAudit,
} as const;
