/**
 * `/api/v1/me/navigation*` —— 个人导航（阶段 04：HUB-047 / HUB-048 / HUB-007 / HUB-008 / HUB-009）。
 *
 * 安全前提（与 me-workbench.ts 同一套）：
 * - 整棵子树挂载在 `meRoutes` 之下，因此先经过 `deviceAuth()`；未授权一律 401。
 * - 作用域**只**来自 `c.get('workspaceId')`（认证结果）；路径参数与正文里的关联 ID
 *   只用于过滤，且服务层每条语句都带 `workspace_id`，因此拿 A 的凭证访问 B 的资源只会 404。
 * - 每个写请求先经 `validateJsonBody`（严格 Schema，多余字段直接拒绝），
 *   再带 `operationId` 进入原子幂等事务；陈旧写返回 409，行级冲突带结构化 `details.conflict`。
 * - 响应体**不含**任何凭证：所有实体都来自共享 Schema（`navLinkSchema` 等）。
 *
 * 路由顺序：`/navigation/links/reorder` 与 `/navigation/groups/reorder` 必须注册在
 * `/navigation/links/:id`、`/navigation/groups/:id` **之前**，否则 `reorder` 会被当成一个 ID
 * （Hono 按注册顺序匹配，`:id` 会吃掉这个路径段）。
 *
 * 关于导入：客户端已经用共享纯函数解析过 HTML / JSON，服务端**不重新解析原文**，
 * 只对客户端提交的 `items` 用 `navImportPreviewRequestSchema` / `navImportApplyRequestSchema`
 * **重新校验**（绝不相信客户端自称「已校验」），并给出服务端自己的逐项 accepted / skipped。
 */
import {
  ApiError,
  DEFAULT_ERROR_MESSAGE,
  createNavGroupRequestSchema,
  createNavLinkRequestSchema,
  deleteNavGroupRequestSchema,
  deleteNavLinkRequestSchema,
  navCatalogImportRequestSchema,
  navFilterSchema,
  navImportApplyRequestSchema,
  navImportPreviewRequestSchema,
  reorderNavGroupsRequestSchema,
  reorderNavLinksRequestSchema,
  setNavLinkGroupsRequestSchema,
  updateNavGroupRequestSchema,
  updateNavLinkRequestSchema,
  type NavFilter,
} from '@ff14-hub/shared';
// 这里只把 Hono 当作类型使用（路由注册进传入的实例）。
import type { Hono } from 'hono';
import { noStoreJson } from '../../lib/response';
import { describeIssues } from '../../lib/zod-issues';
import { parsedJsonBody, validateJsonBody } from '../../middleware/validation';
import { createNavService, type NavService } from '../../modules/nav/service';
import { ERROR_CODE_BY_NAV_REJECTION, type NavFailure } from '../../modules/nav/tx';
import type { AppBindings, AppContext } from '../../types';

/**
 * 把服务层的拒绝原因映射成统一错误契约（唯一映射表在 `nav/tx.ts`）。
 *
 * 结构化冲突只在**行级** revision 冲突时出现（`failure.conflict`），
 * 放进 `details.conflict`（ADR-0004 D7）：集合级冲突没有「哪一行、哪个字段」可言，
 * 因此不给 details，只给可读文案——凭空编一个 entityId 就是伪造事实。
 */
export function navigationError(failure: NavFailure): ApiError {
  const code = ERROR_CODE_BY_NAV_REJECTION[failure.reason];
  const details = failure.conflict === undefined ? undefined : { conflict: failure.conflict };
  return new ApiError(code, `${DEFAULT_ERROR_MESSAGE[code]}（${failure.detail}）`, failure.reason, details);
}

/** 每个请求构造一个服务实例（无状态，仅绑定 D1）。 */
function navOf(c: AppContext): NavService {
  return createNavService({ db: c.env.DB });
}

/**
 * 把 `GET /navigation/links` 的查询串解析成共享 `NavFilter`。
 *
 * 关键点：**唯一的校验器是共享 `navFilterSchema`**（`.strict()`），因此未知查询参数
 * 直接 422，而不是被静默忽略。查询串里的布尔只能是字面量 `true` / `false`
 * （前端 `toNavLinksQuery` 也只用这两种写法）；其他形式保持字符串，交给 Schema 拒绝。
 */
function navFilterFromQuery(url: string): NavFilter {
  const raw: Record<string, unknown> = Object.fromEntries(new URL(url).searchParams.entries());
  const favoritesOnly = raw['favoritesOnly'];
  if (favoritesOnly === 'true') {
    raw['favoritesOnly'] = true;
  } else if (favoritesOnly === 'false') {
    raw['favoritesOnly'] = false;
  }
  const parsed = navFilterSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = describeIssues(parsed.error.issues);
    throw new ApiError(
      'validation_failed',
      `${DEFAULT_ERROR_MESSAGE.validation_failed}（${detail}）`,
      `query_invalid:${detail}`,
    );
  }
  return parsed.data;
}

/** 在 /me 子树里注册导航路由（扁平注册，避免子应用路由优先级带来的歧义）。 */
export function registerMeNavigationRoutes(me: Hono<AppBindings>): void {
  // ---------------------------------------------------------------------
  // 快照与视图
  // ---------------------------------------------------------------------

  /** GET /me/navigation —— 一次拿到链接 + 分组 + 成员关系 + 工作空间修订号 + 目录版本 + 上限。 */
  me.get('/navigation', async (c) => {
    return noStoreJson(c, await navOf(c).readSnapshot(c.get('workspaceId')));
  });

  /** GET /me/navigation/links —— 服务端用**与前端同一份**纯函数算出的筛选/排序视图。 */
  me.get('/navigation/links', async (c) => {
    const service = navOf(c);
    const workspaceId = c.get('workspaceId');
    const filter = navFilterFromQuery(c.req.url);
    const [views, revision] = await Promise.all([
      service.listViews(workspaceId, filter),
      service.readRevision(workspaceId),
    ]);
    return noStoreJson(c, { links: views, revision });
  });

  // ---------------------------------------------------------------------
  // 个人链接
  // ---------------------------------------------------------------------

  /** POST /me/navigation/links —— 新建链接（可选初始分组归属）。 */
  me.post('/navigation/links', validateJsonBody(createNavLinkRequestSchema), async (c) => {
    const body = parsedJsonBody(c, createNavLinkRequestSchema);
    const outcome = await navOf(c).createLink({ ...body, workspaceId: c.get('workspaceId') });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, { link: outcome.value.link, replayed: outcome.replayed }, 201);
  });

  /**
   * POST /me/navigation/links/reorder —— 整体替换手动顺序。
   * 必须注册在 `/links/:id` 之前，否则路径段 `reorder` 会被 `:id` 吃掉。
   */
  me.post('/navigation/links/reorder', validateJsonBody(reorderNavLinksRequestSchema), async (c) => {
    const body = parsedJsonBody(c, reorderNavLinksRequestSchema);
    const outcome = await navOf(c).reorderLinks({ ...body, workspaceId: c.get('workspaceId') });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, { revision: outcome.value.revision, replayed: outcome.replayed });
  });

  /** PATCH /me/navigation/links/:id —— 改内容 / 收藏 / 状态 / 顺序 / 分组归属（带 expectedRevision）。 */
  me.patch('/navigation/links/:id', validateJsonBody(updateNavLinkRequestSchema), async (c) => {
    const body = parsedJsonBody(c, updateNavLinkRequestSchema);
    // 拆出 patch：`operationId` / `expectedRevision` 属于请求信封，不属于可编辑字段，
    // 否则「冲突字段」判定会把它们算进去。
    const { operationId, expectedRevision, ...patch } = body;
    const outcome = await navOf(c).updateLink({
      workspaceId: c.get('workspaceId'),
      operationId,
      linkId: c.req.param('id'),
      expectedRevision,
      patch,
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, { link: outcome.value.link, replayed: outcome.replayed });
  });

  /** DELETE /me/navigation/links/:id —— 墓碑化链接（成员关系一并墓碑化；不做硬删除）。 */
  me.delete('/navigation/links/:id', validateJsonBody(deleteNavLinkRequestSchema), async (c) => {
    const body = parsedJsonBody(c, deleteNavLinkRequestSchema);
    const outcome = await navOf(c).deleteLink({
      workspaceId: c.get('workspaceId'),
      operationId: body.operationId,
      linkId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, {
      deletedId: outcome.value.deletedId,
      revision: outcome.value.revision,
      replayed: outcome.replayed,
    });
  });

  /** PUT /me/navigation/links/:id/groups —— 整体替换该链接的分组归属（多分组）。 */
  me.put('/navigation/links/:id/groups', validateJsonBody(setNavLinkGroupsRequestSchema), async (c) => {
    const body = parsedJsonBody(c, setNavLinkGroupsRequestSchema);
    const outcome = await navOf(c).setLinkGroups({
      workspaceId: c.get('workspaceId'),
      operationId: body.operationId,
      linkId: c.req.param('id'),
      groupIds: body.groupIds,
      expectedRevision: body.expectedRevision,
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, { revision: outcome.value.revision, replayed: outcome.replayed });
  });

  // ---------------------------------------------------------------------
  // 分类 / 分组
  // ---------------------------------------------------------------------

  /** GET /me/navigation/groups —— 活跃分组 + 工作空间修订号。 */
  me.get('/navigation/groups', async (c) => {
    const snapshot = await navOf(c).readSnapshot(c.get('workspaceId'));
    return noStoreJson(c, { groups: snapshot.groups, revision: snapshot.revision });
  });

  /** POST /me/navigation/groups —— 新建分组（名称不是标识，允许重名）。 */
  me.post('/navigation/groups', validateJsonBody(createNavGroupRequestSchema), async (c) => {
    const body = parsedJsonBody(c, createNavGroupRequestSchema);
    const outcome = await navOf(c).createGroup({ ...body, workspaceId: c.get('workspaceId') });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    // 响应体就是分组对象本身：前端 `createGroup` 直接按 `navGroupSchema` 校验。
    return noStoreJson(c, outcome.value.group, 201);
  });

  /** POST /me/navigation/groups/reorder —— 整体替换分组顺序（注册在 `/groups/:id` 之前）。 */
  me.post('/navigation/groups/reorder', validateJsonBody(reorderNavGroupsRequestSchema), async (c) => {
    const body = parsedJsonBody(c, reorderNavGroupsRequestSchema);
    const outcome = await navOf(c).reorderGroups({ ...body, workspaceId: c.get('workspaceId') });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, { revision: outcome.value.revision, replayed: outcome.replayed });
  });

  /** PATCH /me/navigation/groups/:id —— 改名 / 排序（带 expectedRevision）。 */
  me.patch('/navigation/groups/:id', validateJsonBody(updateNavGroupRequestSchema), async (c) => {
    const body = parsedJsonBody(c, updateNavGroupRequestSchema);
    const outcome = await navOf(c).updateGroup({
      workspaceId: c.get('workspaceId'),
      operationId: body.operationId,
      groupId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, outcome.value.group);
  });

  /** DELETE /me/navigation/groups/:id —— 墓碑化分组（成员关系一并墓碑化；链接保留）。 */
  me.delete('/navigation/groups/:id', validateJsonBody(deleteNavGroupRequestSchema), async (c) => {
    const body = parsedJsonBody(c, deleteNavGroupRequestSchema);
    const outcome = await navOf(c).deleteGroup({
      workspaceId: c.get('workspaceId'),
      operationId: body.operationId,
      groupId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, {
      deletedId: outcome.value.deletedId,
      revision: outcome.value.revision,
      replayed: outcome.replayed,
    });
  });

  // ---------------------------------------------------------------------
  // 目录导入 / 通用导入导出
  // ---------------------------------------------------------------------

  /** POST /me/navigation/catalog/import —— 按目录 ID 导入（逐条决策，默认不覆盖个人修改）。 */
  me.post('/navigation/catalog/import', validateJsonBody(navCatalogImportRequestSchema), async (c) => {
    const body = parsedJsonBody(c, navCatalogImportRequestSchema);
    const outcome = await navOf(c).importCatalogEntries({
      workspaceId: c.get('workspaceId'),
      operationId: body.operationId,
      catalogIds: body.catalogIds,
      ...(body.explicitReimport === undefined ? {} : { explicitReimport: body.explicitReimport }),
      ...(body.overwriteUserEdits === undefined ? {} : { overwriteUserEdits: body.overwriteUserEdits }),
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, {
      decisions: outcome.value.decisions,
      importedCount: outcome.value.importedCount,
      importedLinkIds: outcome.value.importedLinkIds,
      restoredLinkIds: outcome.value.restoredLinkIds,
      skippedCatalogIds: outcome.value.skippedCatalogIds,
      revision: outcome.value.revision,
      replayed: outcome.replayed,
    });
  });

  /**
   * POST /me/navigation/import/preview —— 服务端**重新校验**客户端解析结果（不写入任何数据）。
   * 返回服务端自己的 accepted / skipped（含「与现有 URL 重复」）与预览修订号。
   */
  me.post('/navigation/import/preview', validateJsonBody(navImportPreviewRequestSchema), async (c) => {
    const body = parsedJsonBody(c, navImportPreviewRequestSchema);
    const outcome = await navOf(c).previewImport({
      workspaceId: c.get('workspaceId'),
      items: body.items,
      ...(body.targetGroupId === undefined ? {} : { targetGroupId: body.targetGroupId }),
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, {
      items: outcome.value.items,
      skipped: outcome.value.skipped,
      revision: outcome.value.revision,
    });
  });

  /**
   * POST /me/navigation/import/apply —— 导入落地。
   * `expectedRevision` 必须回显预览时的修订号，否则 409 `import_preview_stale`（不按旧预览覆盖）。
   */
  me.post('/navigation/import/apply', validateJsonBody(navImportApplyRequestSchema), async (c) => {
    const body = parsedJsonBody(c, navImportApplyRequestSchema);
    const outcome = await navOf(c).importItems({
      workspaceId: c.get('workspaceId'),
      operationId: body.operationId,
      items: body.items,
      expectedRevision: body.expectedRevision,
      ...(body.targetGroupId === undefined ? {} : { targetGroupId: body.targetGroupId }),
    });
    if (!outcome.ok) {
      throw navigationError(outcome);
    }
    return noStoreJson(c, {
      importedCount: outcome.value.importedCount,
      importedLinkIds: outcome.value.importedLinkIds,
      skipped: outcome.value.skipped,
      revision: outcome.value.revision,
      replayed: outcome.replayed,
    });
  });

  /** GET /me/navigation/export —— 导出文档（只含活跃行、不含任何凭证；可被读回）。 */
  me.get('/navigation/export', async (c) => {
    const document = await navOf(c).exportDocument(c.get('workspaceId'));
    return noStoreJson(c, { document, exportedAt: document.exportedAt });
  });
}
