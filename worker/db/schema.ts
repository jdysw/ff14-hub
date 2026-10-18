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
import type {
  IdentityAuditEvent,
  LayoutBreakpoint,
  ModulePersistedStatus,
  ModuleSupportedAction,
  Region,
  WorkbenchBackupKind,
} from '@ff14-hub/shared';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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

/**
 * 待完成的模块生命周期操作（HUB-050，由 migrations/0004_module_operations.sql 建立）。
 *
 * 存在一行 = 有一次已原子准入但尚未完成（或已失败待重试）的操作。
 * 此时门禁状态为 `transitioning`（见 `@ff14-hub/shared` 的 `moduleGateStatus()`），
 * 因此它绝不会被当成「可以运行」。全部副作用成功后本行才被删除。
 */
export const workspaceModuleOperations = sqliteTable(
  'workspace_module_operations',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    action: text('action').$type<ModuleSupportedAction>().notNull(),
    targetStatus: text('target_status').$type<ModulePersistedStatus>().notNull(),
    revision: integer('revision').notNull(),
    startedAt: integer('started_at').notNull(),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error'),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.moduleId] })],
);

/**
 * 生命周期副作用的**独占执行认领**（HUB-050，由 migrations/0005_module_operation_claims.sql 建立）。
 *
 * 主键 `(workspace_id, module_id)` 保证同一时刻只有一个执行者持有 `token`；
 * 所有副作用写入（收尾 / 失败记录）都以 token 为条件，因此被取代的执行者写不进去。
 * `expires_at` 是租约，只用于崩溃后的原子抢占——**不**假设 TTL 到期旧执行者已停止，
 * 端口清理另有 revision fence（`upToRevision` / `maxRevision`）。
 */
export const workspaceModuleOperationClaims = sqliteTable(
  'workspace_module_operation_claims',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    token: text('token').notNull(),
    claimedAt: integer('claimed_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.moduleId] })],
);

/**
 * 工作台页面（HUB-046，由 migrations/0006_workbench.sql 建立）。
 *
 * - `slug` 在**整个工作空间（含墓碑）**内唯一：这样恢复已删除页面永不与新页面撞 slug。
 * - 「活跃页面中默认页至多一个」是数据库级硬约束（部分唯一索引
 *   `idx_workspace_pages_single_default`）；「有活跃页面时恰好一个」由服务层事务补足，
 *   并在测试中用真实 D1 并发验证。
 * - `deleted_at` 是墓碑：本阶段不做硬删除，供后续跨设备同步使用。
 */
export const workspacePages = sqliteTable(
  'workspace_pages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isDefault: integer('is_default').notNull(),
    sortOrder: integer('sort_order').notNull(),
    revision: integer('revision').notNull(),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_workspace_pages_slug').on(table.workspaceId, table.slug),
    uniqueIndex('idx_workspace_pages_single_default')
      .on(table.workspaceId)
      .where(sql`is_default = 1 AND deleted_at IS NULL`),
    index('idx_workspace_pages_active').on(table.workspaceId, table.deletedAt, table.sortOrder),
  ],
);

/**
 * Widget 实例（HUB-045 / HUB-046）。
 *
 * `createdRevision` 是模块代际标记：卸载模块的清理 SQL 把
 * 「workspace + module + created_revision <= 上界」作为同一原子条件，
 * 因此被取代的旧执行者删不掉 restore 之后的新实例。
 */
export const widgetInstances = sqliteTable(
  'widget_instances',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pageId: text('page_id')
      .notNull()
      .references(() => workspacePages.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    widgetType: text('widget_type').notNull(),
    configJson: text('config_json').notNull(),
    configVersion: integer('config_version').notNull(),
    isHidden: integer('is_hidden').notNull(),
    revision: integer('revision').notNull(),
    createdRevision: integer('created_revision').notNull(),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_widget_instances_page').on(table.pageId, table.deletedAt, table.createdAt),
    index('idx_widget_instances_workspace_module').on(
      table.workspaceId,
      table.moduleId,
      table.deletedAt,
      table.createdRevision,
    ),
    index('idx_widget_instances_workspace_widget').on(table.workspaceId, table.widgetType, table.deletedAt),
  ],
);

/** 「实例 × 断点」矩形。min/maxSize 来自静态注册表，不在数据库层表达。 */
export const widgetLayouts = sqliteTable(
  'widget_layouts',
  {
    widgetId: text('widget_id')
      .notNull()
      .references(() => widgetInstances.id, { onDelete: 'cascade' }),
    breakpoint: text('breakpoint').$type<LayoutBreakpoint>().notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    w: integer('w').notNull(),
    h: integer('h').notNull(),
  },
  (table) => [primaryKey({ columns: [table.widgetId, table.breakpoint] })],
);

/** 「页面 × 断点」独立修订号（ADR-010）。行缺失等价于 revision = 0。 */
export const pageLayoutRevisions = sqliteTable(
  'page_layout_revisions',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => workspacePages.id, { onDelete: 'cascade' }),
    breakpoint: text('breakpoint').$type<LayoutBreakpoint>().notNull(),
    revision: integer('revision').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.pageId, table.breakpoint] })],
);

/** 工作空间级工作台修订号：导入预览的新鲜度令牌 + 前端「有没有变」信号。 */
export const workspaceWorkbenchState = sqliteTable('workspace_workbench_state', {
  workspaceId: text('workspace_id')
    .notNull()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** 幂等 operationId 的结果留痕（重放时直接返回已存结果，不重复施加副作用）。 */
export const workbenchOperations = sqliteTable(
  'workbench_operations',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    kind: text('kind').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: integer('created_at').notNull(),
    /** 本次尝试的随机标记；收尾后置空。守卫语句据此区分「本次尝试」与「重放」。 */
    attemptToken: text('attempt_token'),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.operationId] }),
    index('idx_workbench_operations_created').on(table.createdAt),
  ],
);

/**
 * 幂等记录的**请求意图指纹**（由 migrations/0007_workbench_hardening.sql 建立）。
 *
 * 单独一张表而不是给 `workbench_operations` 加列：SQLite 不支持
 * `ADD COLUMN IF NOT EXISTS`，加列会破坏「迁移语句可逐条重放」的既定验收点。
 * 两份记录在同一个 batch 里写入，因此不存在「有结果没指纹」的持久半状态。
 */
export const workbenchOperationIntents = sqliteTable(
  'workbench_operation_intents',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    kind: text('kind').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.operationId] }),
    index('idx_workbench_operation_intents_created').on(table.createdAt),
  ],
);

/**
 * 清理的**本次影响标记**（由 migrations/0007_workbench_hardening.sql 建立）。
 * 每次 `removeInstancesForModule` 用随机 token 收集「本次将要墓碑化」的实例，
 * 后续语句全部按该 token 过滤，从而做到「0 个新增墓碑 → 零 revision 变更」。
 */
export const widgetCleanupMarks = sqliteTable(
  'widget_cleanup_marks',
  {
    cleanupToken: text('cleanup_token').notNull(),
    widgetId: text('widget_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    pageId: text('page_id')
      .notNull()
      .references(() => workspacePages.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.cleanupToken, table.widgetId] }),
    index('idx_widget_cleanup_marks_token').on(table.cleanupToken),
    index('idx_widget_cleanup_marks_workspace').on(table.workspaceId, table.moduleId, table.cleanupToken),
  ],
);

/** 替换导入前的可恢复备份（只含工作台配置，不含任何凭证）。 */
export const workbenchBackups = sqliteTable(
  'workbench_backups',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<WorkbenchBackupKind>().notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
    createdByDevice: text('created_by_device').references(() => devices.id, { onDelete: 'set null' }),
    consumedAt: integer('consumed_at'),
  },
  (table) => [index('idx_workbench_backups_workspace').on(table.workspaceId, table.createdAt)],
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
  workspaceModuleOperations,
  workspaceModuleOperationClaims,
  workspacePages,
  widgetInstances,
  widgetLayouts,
  pageLayoutRevisions,
  workspaceWorkbenchState,
  workbenchOperations,
  workbenchOperationIntents,
  widgetCleanupMarks,
  workbenchBackups,
} as const;
