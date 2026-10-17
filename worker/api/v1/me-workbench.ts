/**
 * `/api/v1/me/*` 的工作台子树（阶段 03：HUB-045 / HUB-046 / HUB-049 / HUB-054）。
 *
 * 安全前提：
 * - 全部路由挂载在 `meRoutes` 之下，因此整棵子树先经过 `deviceAuth()`；未授权一律 401。
 * - 作用域**只**来自 `c.get('workspaceId')`（认证结果）。
 *   路径参数（pageId / widgetId / backupId）只用于过滤，且服务端每条语句都带
 *   `workspace_id`，因此拿 A 的凭证访问 B 的资源只会得到 404。
 * - 每个写请求都先经 `validateJsonBody`（严格 Schema，多余字段直接拒绝），
 *   再带 `operationId` 进入原子幂等事务。
 * - 备份响应体**不含**任何凭证：它由 `workbenchBackupDocumentSchema` 约束，
 *   且服务端在导出前会拒绝疑似凭证字段。
 */
import {
  ApiError,
  BUILTIN_WORKBENCH_TEMPLATES,
  DEFAULT_ERROR_MESSAGE,
  WORKBENCH_IMPORT_MODES,
  addWidgetRequestSchema,
  applyTemplateRequestSchema,
  createPageRequestSchema,
  deletePageRequestSchema,
  deleteWidgetRequestSchema,
  duplicateWidgetRequestSchema,
  operationIdSchema,
  restoreBackupRequestSchema,
  saveLayoutRequestSchema,
  updatePageRequestSchema,
  updateWidgetRequestSchema,
} from '@ff14-hub/shared';
// 只把 Hono 当作类型使用（路由注册进传入的实例）。
import type { Hono } from 'hono';
import { z } from 'zod';
import { noStoreJson } from '../../lib/response';
import { parsedJsonBody, validateJsonBody } from '../../middleware/validation';
import { getModuleRuntime } from '../../modules/runtime';
import { ERROR_CODE_BY_WORKBENCH_REJECTION, type WorkbenchFailure } from '../../modules/workbench/tx';
import type { AppBindings } from '../../types';

/** 把服务层的拒绝原因映射成统一错误契约。刻意不把内部细节放进对外 message。 */
export function workbenchError(failure: WorkbenchFailure): ApiError {
  const code = ERROR_CODE_BY_WORKBENCH_REJECTION[failure.reason];
  return new ApiError(code, `${DEFAULT_ERROR_MESSAGE[code]}（${failure.detail}）`, failure.reason);
}

export function registerMeWorkbenchRoutes(me: Hono<AppBindings>): void {
  // ---------------------------------------------------------------------
  // 工作台快照与页面
  // ---------------------------------------------------------------------

  /** GET /me/workbench —— 一次拿到页面列表 + 默认页 + 工作台 revision + 容量上限。 */
  me.get('/workbench', async (c) => {
    const runtime = getModuleRuntime(c.env.DB);
    return noStoreJson(c, await runtime.workbench.readSnapshot(c.get('workspaceId')));
  });

  /** GET /me/pages —— 活跃页面与默认页。 */
  me.get('/pages', async (c) => {
    const runtime = getModuleRuntime(c.env.DB);
    const result = await runtime.workbench.listPages(c.get('workspaceId'));
    return noStoreJson(c, { pages: result.pages, defaultPageId: result.defaultPageId });
  });

  /** POST /me/pages —— 新建页面（可选模板初始化；空白页是合法状态）。 */
  me.post('/pages', validateJsonBody(createPageRequestSchema), async (c) => {
    const body = parsedJsonBody(c, createPageRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.createPage({
      workspaceId: c.get('workspaceId'),
      name: body.name,
      ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(
      c,
      {
        page: outcome.value.page,
        defaultPageId: outcome.value.defaultPageId,
        skipped: outcome.value.skipped,
        replayed: outcome.replayed,
      },
      201,
    );
  });

  /** PATCH /me/pages/:id —— 改名 / 排序 / 设为默认页（必须带 expectedRevision）。 */
  me.patch('/pages/:id', validateJsonBody(updatePageRequestSchema), async (c) => {
    const body = parsedJsonBody(c, updatePageRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.updatePage({
      workspaceId: c.get('workspaceId'),
      pageId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
      ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { page: outcome.value.page, noop: outcome.value.noop, replayed: outcome.replayed });
  });

  /**
   * DELETE /me/pages/:id —— 墓碑化页面（实例与布局保留，因此可整体恢复）。
   * 删除默认页 / 当前页 / 最后一页都有确定行为：默认页由服务端在**同一事务**内重新推导，
   * 最后一页被删除时 `defaultPageId` 为 null，Shell 会显示「新建页面 / 应用模板」恢复入口。
   */
  me.delete('/pages/:id', validateJsonBody(deletePageRequestSchema), async (c) => {
    const body = parsedJsonBody(c, deletePageRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.deletePage({
      workspaceId: c.get('workspaceId'),
      pageId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, {
      deletedPageId: outcome.value.deletedPageId,
      defaultPageId: outcome.value.defaultPageId,
      remainingPages: outcome.value.remainingPages,
      notice: outcome.value.notice,
      replayed: outcome.replayed,
    });
  });

  /** POST /me/pages/:id/restore —— 从墓碑恢复页面（其内容随之回来）。 */
  me.post('/pages/:id/restore', validateJsonBody(restoreBackupRequestSchema), async (c) => {
    const body = parsedJsonBody(c, restoreBackupRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.restorePage({
      workspaceId: c.get('workspaceId'),
      pageId: c.req.param('id'),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { page: outcome.value.page, defaultPageId: outcome.value.defaultPageId, replayed: outcome.replayed });
  });

  // ---------------------------------------------------------------------
  // 布局
  // ---------------------------------------------------------------------

  /** GET /me/pages/:id/layout —— 三个断点各自的矩形与独立 revision。 */
  me.get('/pages/:id/layout', async (c) => {
    const runtime = getModuleRuntime(c.env.DB);
    const layouts = await runtime.workbench.readLayouts({
      workspaceId: c.get('workspaceId'),
      pageId: c.req.param('id'),
    });
    if (layouts.length === 0) {
      throw new ApiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, 'page_not_found');
    }
    return noStoreJson(c, { layouts });
  });

  /**
   * PUT /me/pages/:id/layout —— 保存**一个断点**的整页布局。
   * 必须带 `baseRevision`；陈旧写返回 409，绝不静默覆盖。
   */
  me.put('/pages/:id/layout', validateJsonBody(saveLayoutRequestSchema), async (c) => {
    const body = parsedJsonBody(c, saveLayoutRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.saveLayout({
      workspaceId: c.get('workspaceId'),
      pageId: c.req.param('id'),
      breakpoint: body.breakpoint,
      baseRevision: body.baseRevision,
      rects: body.rects,
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { layout: outcome.value.layout, replayed: outcome.replayed });
  });

  // ---------------------------------------------------------------------
  // Widget 实例
  // ---------------------------------------------------------------------

  /** GET /me/pages/:id/widgets —— 该页面的活跃实例；页面不存在或不属于本工作空间返回 404。 */
  me.get('/pages/:id/widgets', async (c) => {
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.listInstances({
      workspaceId: c.get('workspaceId'),
      pageId: c.req.param('id'),
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { instances: outcome.value });
  });

  /** POST /me/pages/:id/widgets —— 添加实例（服务端校验模块门禁与单例约束）。 */
  me.post('/pages/:id/widgets', validateJsonBody(addWidgetRequestSchema), async (c) => {
    const body = parsedJsonBody(c, addWidgetRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.addWidget({
      workspaceId: c.get('workspaceId'),
      pageId: c.req.param('id'),
      widgetType: body.widgetType,
      ...(body.config === undefined ? {} : { config: body.config }),
      ...(body.hidden === undefined ? {} : { hidden: body.hidden }),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { instance: outcome.value.instance, replayed: outcome.replayed }, 201);
  });

  /** PATCH /me/widgets/:id —— 改配置 / 隐藏（隐藏 ≠ 移除，也不影响模块状态与个人数据）。 */
  me.patch('/widgets/:id', validateJsonBody(updateWidgetRequestSchema), async (c) => {
    const body = parsedJsonBody(c, updateWidgetRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.updateWidget({
      workspaceId: c.get('workspaceId'),
      widgetId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
      ...(body.config === undefined ? {} : { config: body.config }),
      ...(body.hidden === undefined ? {} : { hidden: body.hidden }),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { instance: outcome.value.instance, noop: outcome.value.noop, replayed: outcome.replayed });
  });

  /** DELETE /me/widgets/:id —— 移除实例（墓碑，不动模块与个人数据）。 */
  me.delete('/widgets/:id', validateJsonBody(deleteWidgetRequestSchema), async (c) => {
    const body = parsedJsonBody(c, deleteWidgetRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.deleteWidget({
      workspaceId: c.get('workspaceId'),
      widgetId: c.req.param('id'),
      expectedRevision: body.expectedRevision,
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { widgetId: outcome.value.widgetId, replayed: outcome.replayed });
  });

  /** POST /me/widgets/:id/duplicate —— 复制实例（新实例有独立配置与初始位置）。 */
  me.post('/widgets/:id/duplicate', validateJsonBody(duplicateWidgetRequestSchema), async (c) => {
    const body = parsedJsonBody(c, duplicateWidgetRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.duplicateWidget({
      workspaceId: c.get('workspaceId'),
      widgetId: c.req.param('id'),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { instance: outcome.value.instance, replayed: outcome.replayed }, 201);
  });

  // ---------------------------------------------------------------------
  // 模板（HUB-049）
  // ---------------------------------------------------------------------

  /**
   * GET /me/workbench/templates —— 模板目录（含 `honestyNote` 诚实说明）。
   * 模板内容来自共享契约，是**可自由修改的起点**，不是服务端动态生成的数据。
   */
  me.get('/workbench/templates', (c) =>
    noStoreJson(c, {
      templates: BUILTIN_WORKBENCH_TEMPLATES.map((template) => ({
        id: template.id,
        displayName: template.displayName,
        description: template.description,
        honestyNote: template.honestyNote,
        isDemoOnly: template.isDemoOnly,
        isEmpty: template.isEmpty,
        recommendedDefault: template.recommendedDefault,
        pageNames: template.pages.map((page) => page.name),
        widgetCount: template.pages.reduce((sum, page) => sum + page.widgets.length, 0),
      })),
    }),
  );

  /** POST /me/workbench/apply-template —— 应用模板（新建页 / 替换页面内容 / 重置工作台）。 */
  me.post('/workbench/apply-template', validateJsonBody(applyTemplateRequestSchema), async (c) => {
    const body = parsedJsonBody(c, applyTemplateRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbench.applyTemplate({
      workspaceId: c.get('workspaceId'),
      templateId: body.templateId,
      mode: body.mode,
      ...(body.pageName === undefined ? {} : { pageName: body.pageName }),
      ...(body.pageId === undefined ? {} : { pageId: body.pageId }),
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, {
      mode: outcome.value.mode,
      templateId: outcome.value.templateId,
      pages: outcome.value.pages,
      defaultPageId: outcome.value.defaultPageId,
      skipped: outcome.value.skipped,
      replayed: outcome.replayed,
    });
  });

  // ---------------------------------------------------------------------
  // 备份与恢复（HUB-054）
  // ---------------------------------------------------------------------

  /** GET /me/workbench/backup —— 导出工作台配置（不含任何凭证）。 */
  me.get('/workbench/backup', async (c) => {
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbenchBackup.exportDocument(c.get('workspaceId'));
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, {
      backup: outcome.value.document,
      byteLength: outcome.value.byteLength,
      maxBytes: outcome.value.maxBytes,
    });
  });

  /** GET /me/workbench/backups —— 可恢复备份列表（替换导入时自动生成的那份也在内）。 */
  me.get('/workbench/backups', async (c) => {
    const runtime = getModuleRuntime(c.env.DB);
    const backups = await runtime.workbenchBackup.listBackups(c.get('workspaceId'));
    return noStoreJson(c, { backups });
  });

  /** POST /me/workbench/import/preview —— 结构 / 版本 / 未知模块 / 影响范围预览，**不写入**。 */
  me.post('/workbench/import/preview', validateJsonBody(importPreviewBodySchema), async (c) => {
    const body = parsedJsonBody(c, importPreviewBodySchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbenchBackup.previewImport({
      workspaceId: c.get('workspaceId'),
      rawDocument: body.document,
      mode: body.mode,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { preview: outcome.value });
  });

  /** POST /me/workbench/import/apply —— 显式确认后按 workspace 作用域事务应用。 */
  me.post('/workbench/import/apply', validateJsonBody(importApplyBodySchema), async (c) => {
    const body = parsedJsonBody(c, importApplyBodySchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbenchBackup.applyImport({
      workspaceId: c.get('workspaceId'),
      deviceId: c.get('deviceId'),
      rawDocument: body.document,
      mode: body.mode,
      previewRevision: body.previewRevision,
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, { result: outcome.value, replayed: outcome.replayed });
  });

  /** POST /me/workbench/backup/:id/restore —— 用可恢复备份撤销一次替换导入。 */
  me.post('/workbench/backup/:id/restore', validateJsonBody(restoreBackupRequestSchema), async (c) => {
    const body = parsedJsonBody(c, restoreBackupRequestSchema);
    const runtime = getModuleRuntime(c.env.DB);
    const outcome = await runtime.workbenchBackup.restoreBackup({
      workspaceId: c.get('workspaceId'),
      deviceId: c.get('deviceId'),
      backupId: c.req.param('id'),
      operationId: body.operationId,
    });
    if (!outcome.ok) {
      throw workbenchError(outcome);
    }
    return noStoreJson(c, {
      result: outcome.value,
      notice: '已恢复到该备份的状态；导入后的页面已被替换。',
      replayed: outcome.replayed,
    });
  });
}

// ---------------------------------------------------------------------------
// 导入请求体
// ---------------------------------------------------------------------------
//
// `document` 刻意声明为 `unknown`：备份文档的**结构性问题**由服务层逐条给出可解释结果
// （`unsupported_version` / `duplicate_page_id` / `dangerous_field` …）。
// 如果在中间件层就用 Zod 拦掉，调用方只会拿到一句笼统的「结构不符」。

const importEnvelopeSchema = z
  .object({
    mode: z.enum(WORKBENCH_IMPORT_MODES),
    document: z.unknown(),
  })
  .strict();

/** 预览只需要 `mode` + `document`；确认与应用还必须回显 `previewRevision` 与显式 `confirm`。 */
const importPreviewBodySchema = importEnvelopeSchema;

const importApplyBodySchema = importEnvelopeSchema
  .extend({
    previewRevision: z.number().int().nonnegative(),
    confirm: z.literal(true),
    operationId: operationIdSchema,
  })
  .strict();

