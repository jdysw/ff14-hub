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
  CatalogRegion,
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

/**
 * 系统推荐目录（HUB-047，由 migrations/0008_navigation.sql 建立）。
 *
 * 只读参考数据：只有 `worker/modules/nav/catalog.ts` 的版本化种子会写它，
 * 没有任何用户 API 能修改；因此它**没有** `workspace_id`——目录不属于任何工作空间。
 * `source_version` 单调递增（种子版本更大时才覆盖，永不降级）；
 * `source_url` + `verified_at` 是「这条推荐来自哪里、何时核对过」的留痕。
 * `region` 用 `CatalogRegion`（含 `both`）：目录条目可以同时适用于国服与国际服；
 * 这与 `workspace_nav_links` 的 personal 副本一致，而 `events` 刻意不含 `both`。
 * `verification_status` 只表示来源条目本身是否核对过，**不代表**网站当前在线状态
 * （在线健康状态是 `workspace_nav_links.health`）。
 */
export const navCatalogLinks = sqliteTable('nav_catalog_links', {
  id: text('id').primaryKey(),
  sourceVersion: integer('source_version').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  tagsJson: text('tags_json').notNull(),
  aliasesJson: text('aliases_json').notNull(),
  icon: text('icon').notNull(),
  openMode: text('open_mode').notNull(),
  region: text('region').$type<CatalogRegion>().notNull(),
  sortOrder: integer('sort_order').notNull(),
  sourceUrl: text('source_url').notNull(),
  sourceName: text('source_name').notNull(),
  verifiedAt: integer('verified_at').notNull(),
  verificationStatus: text('verification_status').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * 个人链接副本（HUB-048，由 migrations/0008_navigation.sql 建立）。
 *
 * 导入即**完全独立**：目录升级绝不覆盖用户修改，也绝不复活墓碑。
 * `source_catalog_id` 是**弱关联**（刻意无外键）：目录条目被下线/改名后副本必须继续存在；
 * 「至多一条活跃副本」由部分唯一索引 `idx_workspace_nav_links_catalog_active`
 * （`source_catalog_id IS NOT NULL AND deleted_at IS NULL`）在数据库层保证，
 * 墓碑行不受约束，因此「删除后再次显式导入」可以复用同一行。
 * `health` 里没有 `blocked`：403 只能映射为 `maybe_blocked`，本阶段不做探测（默认 `unknown`）。
 * 工作空间回溯（规划 5.1）：带 NOT NULL 的 `workspace_id` 外键，所有查询只取认证得到的工作空间。
 */
export const workspaceNavLinks = sqliteTable(
  'workspace_nav_links',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 弱关联：刻意无外键（目录条目可以下线；个人副本必须能活下去）。 */
    sourceCatalogId: text('source_catalog_id'),
    importedSourceVersion: integer('imported_source_version'),
    title: text('title').notNull(),
    url: text('url').notNull(),
    description: text('description').notNull(),
    tagsJson: text('tags_json').notNull(),
    aliasesJson: text('aliases_json').notNull(),
    icon: text('icon').notNull(),
    openMode: text('open_mode').notNull(),
    region: text('region').$type<CatalogRegion>().notNull(),
    /** `active` / `archived` 的持久状态（CHECK 在迁移里，这里不重复声明）。 */
    status: text('status').notNull(),
    isFavorite: integer('is_favorite').notNull(),
    sortOrder: integer('sort_order').notNull(),
    health: text('health').notNull(),
    healthCheckedAt: integer('health_checked_at'),
    /** 乐观并发与同步水位：任何写入都必须 bump 它（ADR-0004 D7）。 */
    revision: integer('revision').notNull(),
    /** 墓碑：跨设备同步删除；本阶段不做 GC。 */
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    // 唯一性约束（不是性能索引）：数据库级的「每目录条目每工作空间至多一条活跃副本」。
    uniqueIndex('idx_workspace_nav_links_catalog_active')
      .on(table.workspaceId, table.sourceCatalogId)
      .where(sql`source_catalog_id IS NOT NULL AND deleted_at IS NULL`),
  ],
);

/**
 * 个人分类 / 分组（HUB-048，由 migrations/0008_navigation.sql 建立）。
 *
 * 「分类」与「分组」是同一个用户产出物（ADR-0004 D2）：目录条目自带的 `category`
 * 只在导入时用于创建/关联同名分组，此后完全由用户控制。
 * 主键是稳定 ID，名称只作为可编辑字段——因此名称可以重复、可以随时改（没有名称唯一约束）。
 * 工作空间回溯：带 NOT NULL 的 `workspace_id` 外键。
 */
export const workspaceNavGroups = sqliteTable('workspace_nav_groups', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull(),
  revision: integer('revision').notNull(),
  deletedAt: integer('deleted_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * 链接 × 分组（多分组 + 组内顺序，HUB-048，由 migrations/0008_navigation.sql 建立）。
 *
 * 主键 `(link_id, group_id)`：同一对关系只有一行，删除是墓碑，因此「再次加入同一分组」
 * 复用同一行而不产生重复。
 * 工作空间回溯：`workspace_id` 是冗余列，同时外键到 `workspaces`；
 * 它**不替代**服务层的三者一致性校验——`link_id` 与 `group_id` 各自的外键
 * 无法证明这两行与本行的 `workspace_id` 相同，因此服务层必须在同一事务内校验三者相等。
 */
export const workspaceNavMemberships = sqliteTable(
  'workspace_nav_memberships',
  {
    linkId: text('link_id')
      .notNull()
      .references(() => workspaceNavLinks.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => workspaceNavGroups.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    deletedAt: integer('deleted_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.linkId, table.groupId] })],
);

/** 工作空间级导航修订号（新鲜度令牌）。行缺失等价于 `revision = 0`（与工作台同构）。 */
export const workspaceNavState = sqliteTable('workspace_nav_state', {
  workspaceId: text('workspace_id')
    .notNull()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * 导航写入的幂等 operationId 结果留痕（由 migrations/0008_navigation.sql 建立）。
 *
 * 与 `workbenchOperations` 是**同一套算法**的两份账本：算法只有一份实现
 * （`worker/modules/idempotency/ledger.ts`），导航只是换成这张表
 * （见 ADR-0004 D11）。拆表的理由是 kind 命名空间不同——混在一张表里会让
 * 「同一 operationId 换意图」的判定跨域误伤。
 * `attemptToken` 是本次尝试的随机标记，收尾后置空；守卫语句据此区分「本次尝试」与「重放」。
 */
export const navOperations = sqliteTable(
  'nav_operations',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    kind: text('kind').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: integer('created_at').notNull(),
    attemptToken: text('attempt_token'),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.operationId] })],
);

/**
 * 导航幂等记录的**请求意图指纹**（由 migrations/0008_navigation.sql 建立）。
 *
 * 单独一张表的原因与 `workbenchOperationIntents` 相同：SQLite 不支持
 * `ADD COLUMN IF NOT EXISTS`，给既有表加列会破坏「迁移语句可逐条重放」的验收点。
 * 两份记录在同一个 batch 里写入，因此不存在「有结果没指纹」的持久半状态。
 */
export const navOperationIntents = sqliteTable(
  'nav_operation_intents',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    kind: text('kind').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.operationId] })],
);

/**
 * 个人活动写入的幂等账本（HUB-011，由 migrations/0010_event_operations.sql 建立）。
 *
 * 与 `navOperations` / `workbenchOperations` 是**同一套算法、不同的账本表**：
 * 拆表是为了让 `kind` 命名空间互不干扰（同一 operationId 换意图的判定不会跨域误伤），
 * 算法实现只有 `worker/modules/idempotency/ledger.ts` 一份。
 */
export const eventOperations = sqliteTable(
  'event_operations',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    kind: text('kind').notNull(),
    resultJson: text('result_json').notNull(),
    createdAt: integer('created_at').notNull(),
    attemptToken: text('attempt_token'),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.operationId] })],
);

/** 活动幂等记录的请求意图指纹（由 migrations/0010_event_operations.sql 建立）。 */
export const eventOperationIntents = sqliteTable(
  'event_operation_intents',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    kind: text('kind').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.operationId] })],
);

/**
 * 公共来源活动（HUB-011，由 migrations/0009_events.sql 建立）。
 *
 * **只读参考数据**，刻意**不带** `workspace_id`：它不属于任何工作空间，
 * 公共接口只返回这张表的行，个人行（`workspaceEvents`）永不进入公共响应。
 * `region` 只允许 `cn` / `global`：活动是分区服的事实（INV-08），
 * 「通用活动」不是合法状态——宁可分别录两条，也不要一个含糊的 `both`。
 * 本阶段这张表是**空表**：不捆绑任何未经核实的数据（ADR-0004 D9）。
 */
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  region: text('region').$type<Region>().notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  /** UTC 毫秒；显示时区由客户端决定（国服默认 Asia/Shanghai）。 */
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  sourceUrl: text('source_url').notNull(),
  sourceName: text('source_name').notNull(),
  verificationStatus: text('verification_status').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * 个人活动（HUB-011，由 migrations/0009_events.sql 建立）。
 *
 * 与公共表分开：公共 API 只读 `events`，个人行永不泄露。
 * `source_url` 可为 NULL（用户自己记的活动可能没有来源）；一旦填写就必须通过 https 校验。
 * `region` 同样只允许 `cn` / `global`：个人活动不接受含糊的 `both`。
 * `created_by_device` 在设备被删除时置空（保留活动本身），与审计表的做法一致。
 * 工作空间回溯：带 NOT NULL 的 `workspace_id` 外键；删除工作空间时级联清理。
 */
export const workspaceEvents = sqliteTable('workspace_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull(),
  region: text('region').$type<Region>().notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  sourceUrl: text('source_url'),
  verificationStatus: text('verification_status').notNull(),
  revision: integer('revision').notNull(),
  deletedAt: integer('deleted_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  createdByDevice: text('created_by_device').references(() => devices.id, { onDelete: 'set null' }),
});

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
  // 阶段 04：自由导航（0008）与手工活动（0009）。
  navCatalogLinks,
  workspaceNavLinks,
  workspaceNavGroups,
  workspaceNavMemberships,
  workspaceNavState,
  navOperations,
  navOperationIntents,
  eventOperations,
  eventOperationIntents,
  events,
  workspaceEvents,
} as const;
