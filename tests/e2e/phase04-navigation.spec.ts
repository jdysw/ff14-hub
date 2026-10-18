/**
 * 阶段 04 真实浏览器验收链（HUB-007 / 008 / 009 / 010 / 011 / 012 / 047 / 048 / 051）。
 *
 * 验证目标与阶段 03 同构：**真实浏览器里的真实交互 + 真实服务端持久化**，不是组件单测的重复。
 *   推荐目录 → 个人副本 → 修改 → 墓碑 → 目录升级不覆盖/不复活 → 另设备墓碑传播
 *   → 书签 HTML 预览（逐项跳过原因、不执行外来 HTML）→ 应用 → 导出 round-trip
 *   → 导航/活动 Widget 真实放入 → 模块停用降级 → 重新启用恢复 → 移除组件但数据保留
 *   → 活动维护表单真手工录入 + 就地拒绝非法区间（零写入）
 *   → manifest/SW/缓存隐私/离线降级/窄屏无横向溢出/纯键盘可达
 *   → 双浏览器上下文：导航并发冲突不静默覆盖、草稿不被远程变化覆盖、墓碑跨设备、布局两端独立。
 *
 * 前置条件由 `scripts/e2e-phase04.mjs` 保证（本地 D1 + wrangler dev 8788 + 一次性设备凭证 +
 * 已启用 `ff14.navigation` / `ff14.events` + 预置一条个人链接与一个个人活动），
 * 凭证写在 `tests/e2e/.credentials.phase04.json`（临时文件，运行结束即删除）。
 *
 * ── 为什么需要相对路径 import `@ff14-hub/shared` ────────────────────────────────
 * 仓库根 `node_modules` 里**没有** `@ff14-hub/shared` 的链接（只有 apps/web 与 worker 的
 * `node_modules` 里有），因此从 `tests/e2e` 裸 import 包名在 tsc 与 Playwright 运行时都解析不了。
 * 这里改为**相对路径**引用同一份源文件（`zod` 可从 `packages/shared/node_modules` 解析），
 * 因此断言的仍然是前后端共用的**唯一实现**（`parseNavExportDocument` / `navCatalogEntryState`）。
 *
 * ── 与验收口径的如实偏差（详见 tests/e2e/README.md 与交付报告）────────────────
 * 1. 导航「编辑表单」保存链接恒定 409（缺陷 #1：前端提交工作空间修订作为行 CAS）。
 *    A 用例的「用户已修改的副本」改用界面真实可用、且共享 `navCatalogEntryState` 计为
 *    `user_modified` 的**收藏切换**；改名 / 改 URL / 改分组在本链中**未覆盖**。
 * 2. F 用例的「A 改名保存成功 → B 基于旧修订改名冲突」无法成立（同一缺陷），
 *    改用同样由真实行级 CAS 保护的**删除**路径触发 409（语义等价：后写者不静默覆盖），
 *    并用 /me/sync/changes 与 409 details 的断言补上结构化冲突的字段级证据。
 * 3. 目录条目的「你删除过」状态在界面上不可达（缺陷 #3：快照不返回墓碑行），
 *    因此本链不断言 `data-catalog-state="tombstoned"`，改由服务端决策 + 另一设备的
 *    非显式导入证明「墓碑不复活」。
 * 4. 目录导入不会给**新建**的分类分组建立成员关系（缺陷 #4：批次内 group INSERT 排在
 *    membership INSERT 之后），因此本链不对目录导入断言分组归属；书签导入（通用路径）
 *    的分组归属有正向断言。
 * 5. 离线降级文案由 `apps/web/src/app/pwa/PwaStatusBar.tsx` 渲染成 `data-testid="offline-notice"`，
 *    本链直接断言 `install-state.ts` 的 `OFFLINE_DISCLOSURE` 出现，并同时断言不白屏
 *    （该组件是本次会话期间由并行改动加入的；在它出现之前这条验收在浏览器链里无法断言）。
 * 6. SW 预缓存清单不含带哈希的 `/assets/*`，首访后立刻离线会白屏（缺陷 #5）；
 *    本用例按真实用户路径做「第二次受控访问」后再验证离线降级。
 * 7. 全跳过的目录导入仍会推进 `workspace_nav_state.revision`（观察 #6），
 *    因此本链断言 ADR D1 的真正契约「绝不写个人表」，而不是我最初假定的「完全零写入」。
 */
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVENTS_MESSAGES } from '../../packages/shared/src/events-api';
import {
  navCatalogEntryState,
  parseNavExportDocument,
  type NavCatalogEntry,
  type NavLink,
  type NavSnapshot,
} from '../../packages/shared/src/nav-api';
import type { SyncChange } from '../../packages/shared/src/sync-api';
import type { WorkspaceEvent } from '../../packages/shared/src/events-api';
// 离线降级文案的**唯一来源**（与界面 `PwaStatusBar` 引用的是同一份实现）。
// `install-state.ts` 只依赖同目录的纯函数 `cache-policy.ts`（无 DOM、无 React），
// 因此可以安全地相对引用，而不必把整块应用代码拉进 e2e 的编译单元。
import { OFFLINE_DISCLOSURE } from '../../apps/web/src/app/pwa/install-state';

// ---------------------------------------------------------------------------
// 凭证（编排脚本生成的一次性测试凭证；本文件不读取任何仓库 secret）
// ---------------------------------------------------------------------------

interface E2ECredentials {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly moduleIds: { readonly navigation: string; readonly events: string };
  readonly enabledModuleIds: readonly string[];
  readonly widgetIds: {
    readonly quickLinks: string;
    readonly navSearch: string;
    readonly eventsUpcoming: string;
    readonly eventsManage: string;
  };
}

function loadCredentials(): E2ECredentials {
  const file = path.join(process.cwd(), 'tests/e2e/.credentials.phase04.json');
  return JSON.parse(readFileSync(file, 'utf8')) as E2ECredentials;
}

const credentials = loadCredentials();
const authHeaders: Record<string, string> = { Authorization: `Bearer ${credentials.token}` };
const jsonHeaders: Record<string, string> = { ...authHeaders, 'Content-Type': 'application/json' };

/** 编排脚本预置的链接 / 活动标题（用例在这些「预置数据」上做断言，缺失时用真实 HTTP 补齐）。 */
const PRESET_LINK_TITLE = 'E2E 预置链接';
const PRESET_EVENT_TITLE = 'E2E 预置活动';

/** 本次运行的唯一后缀：让每条用例创建的数据互不污染、也不受历史数据影响。 */
function uniqueStamp(): string {
  return crypto.randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------------------
// 响应形状（与服务端响应包一一对应）
// ---------------------------------------------------------------------------

interface GridRectDto {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface LayoutBody {
  readonly layouts: readonly {
    readonly breakpoint: string;
    readonly revision: number;
    readonly cols: number;
    readonly rects: readonly GridRectDto[];
  }[];
}

interface PageListBody {
  readonly pages: readonly { readonly id: string; readonly name: string; readonly isDefault: boolean; readonly revision: number }[];
  readonly defaultPageId: string | null;
}

interface CatalogBody {
  readonly entries: readonly NavCatalogEntry[];
  readonly sourceVersion: number;
  readonly updatedAt: number;
}

interface CatalogDecision {
  readonly catalogId: string;
  readonly action: string;
  readonly reason: string;
  readonly linkId: string | null;
}

interface CatalogImportBody {
  readonly decisions: readonly CatalogDecision[];
  readonly importedCount: number;
  readonly skippedCatalogIds: readonly string[];
  readonly restoredLinkIds: readonly string[];
  readonly revision: number;
}

interface EventListBody {
  readonly events: readonly WorkspaceEvent[];
  readonly serverTimeMs: number;
}

// ---------------------------------------------------------------------------
// 通过界面完成的最小动作（会话凭证 / 视图切换）
// ---------------------------------------------------------------------------

/** 通过界面保存会话内存凭证（阶段 02 已有的最小入口）。 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /会话凭证/ }).click();
  await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);
  await page.getByRole('button', { name: '保存到会话内存' }).click();
}

/** 「个人导航」是 AppShell 里与 SystemBar 同级的系统级入口。 */
async function openNav(page: Page): Promise<void> {
  await page.getByTestId('nav-entry').click();
  await expect(page.getByTestId('nav-view')).toBeVisible();
  // 等快照真的落地：列表 / 空态 / 无匹配三者之一出现，说明 `state.snapshot !== null`。
  // 这很重要——目录条目的「相对个人副本的状态」是由快照算出来的，快照还没到时一律算成「尚未导入」。
  await expect(
    page.locator(
      '[data-testid="nav-link-list"], [data-testid="nav-empty"], [data-testid="nav-no-match"]',
    ),
  ).toBeVisible();
}

/** 系统级入口栏里的按钮；「自定义工作台」排第一，因此用 `.first()` 精确命中它。 */
function systemBar(page: Page) {
  return page.getByRole('navigation', { name: '系统级入口（不可移除）' });
}

async function openWorkbench(page: Page): Promise<void> {
  await systemBar(page).getByRole('button', { name: /工作台/ }).first().click();
  await expect(page.getByTestId('workbench-view')).toBeVisible();
}

async function openModules(page: Page): Promise<void> {
  await systemBar(page).getByRole('button', { name: /模块管理/ }).click();
  await expect(page.getByTestId('module-card').first()).toBeVisible();
}

/** 链接列表里的一行（`data-link-id` 由前端写在每行上）。 */
function linkRow(page: Page, linkId: string) {
  return page.locator(`[data-testid="nav-link-item"][data-link-id="${linkId}"]`);
}

/** 目录里的一行（`data-catalog-state` 是共享 `catalogUpgradePlan` 算出的状态）。 */
function catalogRow(page: Page, catalogId: string) {
  return page.locator(`[data-testid="nav-catalog-entry"][data-catalog-id="${catalogId}"]`);
}

function widgetCard(page: Page, widgetType: string) {
  return page.locator(`[data-testid="widget-card"][data-widget-type="${widgetType}"]`);
}

async function addWidgetViaUi(page: Page, widgetType: string): Promise<void> {
  // 组件库在网格下方；RGL 的高度收敛会让按钮位置持续变化，先等它稳定再点。
  await waitForStablePosition(page, 'widget-library');
  const item = page.locator(`[data-testid="widget-library-item"][data-widget-type="${widgetType}"]`);
  await expect(item).toBeVisible();
  await item.getByTestId('widget-add').click();
  await expect(widgetCard(page, widgetType)).toBeVisible();
}

async function createPageViaUi(page: Page, name: string): Promise<void> {
  await page.getByTestId('page-add').click();
  await page.getByTestId('page-name-input').fill(name);
  await page.getByTestId('page-create-confirm').click();
  await expect(page.getByTestId('page-tab').filter({ hasText: name })).toBeVisible();
}

/**
 * 等待某个元素的位置连续多帧不再变化。
 *
 * 为什么需要（与阶段 03 同一理由）：RGL 在容器行数变化后会做一次高度收敛（CSS transition），
 * 这期间下方面板里的按钮位置会移动，Playwright 会以「element is not stable」拒绝点击。
 */
async function waitForStablePosition(page: Page, testId: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      if (element === null) {
        return false;
      }
      const top = Math.round(element.getBoundingClientRect().top * 100) / 100;
      const holder = window as unknown as { __stableTop?: number; __stableFrames?: number };
      if (holder.__stableTop === top) {
        holder.__stableFrames = (holder.__stableFrames ?? 0) + 1;
      } else {
        holder.__stableTop = top;
        holder.__stableFrames = 0;
      }
      return (holder.__stableFrames ?? 0) >= 5;
    },
    testId,
    { timeout },
  );
}

/**
 * 键盘替代操作：点击该卡片上第一个「可用」的方向/尺寸按钮。
 *
 * 布局在越界 / 超尺寸 / 重叠时会**正确禁用**按钮，写死某个动作会让用例依赖当时的空位。
 */
const ACTION_ORDER = ['widget-move-down', 'widget-move-right', 'widget-move-up', 'widget-move-left'] as const;

async function clickFirstEnabledMove(page: Page, widgetType: string): Promise<string> {
  const card = widgetCard(page, widgetType);
  for (const action of ACTION_ORDER) {
    const button = card.getByTestId(action);
    if ((await button.count()) === 0) {
      continue;
    }
    if (await button.isEnabled()) {
      await button.click();
      return action;
    }
  }
  throw new Error(`${widgetType} 卡片没有任何可用的移动按钮（四个方向都被禁用）`);
}

/** 纯键盘：从当前焦点按 Tab 直到聚焦到目标 testId（找不到即失败，绝不静默继续）。 */
async function tabUntilTestId(page: Page, testId: string, maxTabs = 80): Promise<void> {
  for (let index = 0; index <= maxTabs; index += 1) {
    const current = await page.evaluate((): string => document.activeElement?.getAttribute('data-testid') ?? '');
    if (current === testId) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`按 Tab ${String(maxTabs)} 次仍未聚焦到 ${testId}`);
}

/** 当前焦点元素的计算样式（用于断言「焦点可见」）。 */
async function focusedOutline(page: Page): Promise<{ readonly style: string; readonly width: string }> {
  return await page.evaluate((): { style: string; width: string } => {
    const element = document.activeElement;
    if (element === null) {
      return { style: 'none', width: '0px' };
    }
    const computed = getComputedStyle(element);
    return { style: computed.outlineStyle, width: computed.outlineWidth };
  });
}

// ---------------------------------------------------------------------------
// 真实 HTTP 辅助（只用于前置收敛与事实断言，关键行为一律走界面）
// ---------------------------------------------------------------------------

async function readSnapshot(request: APIRequestContext): Promise<NavSnapshot> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/navigation`, { headers: authHeaders });
  if (!response.ok()) {
    throw new Error(`读取导航快照失败：${await response.text()}`);
  }
  return (await response.json()) as NavSnapshot;
}

async function readCatalog(request: APIRequestContext): Promise<CatalogBody> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/navigation/catalog`);
  if (!response.ok()) {
    throw new Error(`读取推荐目录失败：${await response.text()}`);
  }
  return (await response.json()) as CatalogBody;
}

async function readEvents(request: APIRequestContext): Promise<EventListBody> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/events`, { headers: authHeaders });
  if (!response.ok()) {
    throw new Error(`读取个人活动失败：${await response.text()}`);
  }
  return (await response.json()) as EventListBody;
}

async function listPages(request: APIRequestContext): Promise<PageListBody> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/pages`, { headers: authHeaders });
  if (!response.ok()) {
    throw new Error(`读取页面列表失败：${await response.text()}`);
  }
  return (await response.json()) as PageListBody;
}

async function readLayouts(request: APIRequestContext, pageId: string): Promise<LayoutBody> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/pages/${pageId}/layout`, {
    headers: authHeaders,
  });
  if (!response.ok()) {
    throw new Error(`读取布局失败：${await response.text()}`);
  }
  return (await response.json()) as LayoutBody;
}

function layoutFor(body: LayoutBody, breakpoint: string) {
  return body.layouts.find((entry) => entry.breakpoint === breakpoint);
}

/** 取消目录导入（`explicitReimport` 缺省 = false：这就是「目录升级」的非显式路径）。 */
async function importCatalogViaHttp(
  request: APIRequestContext,
  body: { readonly catalogIds: readonly string[]; readonly explicitReimport?: boolean },
): Promise<CatalogImportBody> {
  const response = await request.post(`${credentials.baseUrl}/api/v1/me/navigation/catalog/import`, {
    headers: jsonHeaders,
    data: { operationId: crypto.randomUUID(), catalogIds: [...body.catalogIds], ...(body.explicitReimport === undefined ? {} : { explicitReimport: body.explicitReimport }) },
  });
  if (!response.ok()) {
    throw new Error(`目录导入失败：${await response.text()}`);
  }
  return (await response.json()) as CatalogImportBody;
}

async function createNavLinkViaHttp(
  request: APIRequestContext,
  input: { readonly title: string; readonly url: string; readonly isFavorite?: boolean },
): Promise<NavLink> {
  const response = await request.post(`${credentials.baseUrl}/api/v1/me/navigation/links`, {
    headers: jsonHeaders,
    data: {
      operationId: crypto.randomUUID(),
      title: input.title,
      url: input.url,
      ...(input.isFavorite === undefined ? {} : { isFavorite: input.isFavorite }),
    },
  });
  if (!response.ok()) {
    throw new Error(`新建链接失败：${await response.text()}`);
  }
  const body = (await response.json()) as { link: NavLink };
  return body.link;
}

async function ensureModuleEnabled(request: APIRequestContext, moduleId: string): Promise<void> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/modules/${moduleId}`, { headers: authHeaders });
  if (!response.ok()) {
    throw new Error(`读取模块状态失败：${await response.text()}`);
  }
  const body = (await response.json()) as { module: { status: string; revision: number } };
  if (body.module.status === 'enabled') {
    return;
  }
  const action = body.module.status === 'uninstalled' ? 'restore' : 'enable';
  const mutation = await request.patch(`${credentials.baseUrl}/api/v1/me/modules/${moduleId}`, {
    headers: jsonHeaders,
    data: { action, expectedRevision: body.module.revision },
  });
  if (!mutation.ok()) {
    throw new Error(`启用模块 ${moduleId} 失败：${await mutation.text()}`);
  }
}

/** 通过模块管理界面启停（真实交互；服务端就是 PATCH /api/v1/me/modules/:id）。 */
async function setModuleEnabledViaUi(page: Page, moduleId: string, enabled: boolean): Promise<void> {
  await openModules(page);
  const card = page.locator(`[data-testid="module-card"][data-module-id="${moduleId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: enabled ? '启用' : '停用', exact: true }).click();
  await expect(card).toHaveAttribute('data-status', enabled ? 'enabled' : 'disabled');
}

/**
 * 在**变更水位端点**里找一条指定实体的**最新**变更（按 `seq` 升序返回，因此取最后一条）。
 *
 * 为什么需要它：`GET /me/navigation` 刻意**只返回未删除行**（SQL `deleted_at IS NULL`），
 * 因此「删除是墓碑（行还在、只是 deleted_at 非空）」这一事实无法从快照读出。
 * 服务端权威证据在 `/me/sync/changes`：墓碑以 `op: 'delete'` + `payload: null` 下发。
 *
 * 协议说明（第三轮复核修正）：`since` 缺省表示「请先读快照」——服务端会返回
 * `resetRequired: true` 而**不返回历史**，因为变更的 payload 是**当前**实体内容，
 * 把历史重放到一个已经是当前状态的副本上会误删已恢复的数据。
 * 本助手是**测试观察**用途（要检查「某条删除是否进入了变更流」），因此显式从 `v2:0`
 * 读取历史；真实客户端永远不这么做（它先读快照，再从快照水位增量）。
 */
async function findLatestSyncChange(
  request: APIRequestContext,
  entityType: string,
  entityId: string,
): Promise<SyncChange | null> {
  let since: string | null = 'v2:0';
  let latest: SyncChange | null = null;
  for (let page = 0; page < 20; page += 1) {
    const query = since === null ? '' : `?since=${encodeURIComponent(since)}`;
    const response = await request.get(`${credentials.baseUrl}/api/v1/me/sync/changes${query}`, {
      headers: authHeaders,
    });
    if (!response.ok()) {
      throw new Error(`读取同步水位失败：${await response.text()}`);
    }
    const body = (await response.json()) as {
      readonly changes: readonly SyncChange[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
    };
    for (const change of body.changes) {
      if (change.entityType === entityType && change.entityId === entityId) {
        latest = change;
      }
    }
    if (!body.hasMore || body.nextCursor === null) {
      break;
    }
    since = body.nextCursor;
  }
  return latest;
}

/** 预置链接（编排脚本预置）必须存在且是收藏：`nav-quick-links` 默认只显示收藏。 */
async function ensurePresetFavoriteLink(page: Page, request: APIRequestContext): Promise<NavLink> {
  let snapshot = await readSnapshot(request);
  let link = snapshot.links.find((candidate) => candidate.title === PRESET_LINK_TITLE);
  if (link === undefined) {
    link = await createNavLinkViaHttp(request, {
      title: PRESET_LINK_TITLE,
      url: 'https://example.com/e2e',
      isFavorite: true,
    });
  }
  if (!link.isFavorite) {
    // 用界面真实入口改收藏（行级 CAS 是正确实现的路径），并断言界面与快照都变了。
    const row = linkRow(page, link.id);
    await expect(row).toBeVisible();
    await row.getByTestId('nav-link-toggle-favorite').click();
    await expect(row.getByTestId('nav-link-favorite-mark')).toBeVisible();
  }
  snapshot = await readSnapshot(request);
  const refreshed = snapshot.links.find((candidate) => candidate.id === link.id);
  if (refreshed === undefined) {
    throw new Error('预置链接在收藏后从快照里消失了');
  }
  expect(refreshed.isFavorite, '预置链接必须处于收藏状态（nav-quick-links 默认只显示收藏）').toBe(true);
  return refreshed;
}

/** 预置活动（编排脚本预置）必须存在且未开始：`events-upcoming` 默认只显示未开始。 */
async function ensurePresetUpcomingEvent(request: APIRequestContext): Promise<WorkspaceEvent> {
  const body = await readEvents(request);
  let event = body.events.find((candidate) => candidate.title === PRESET_EVENT_TITLE);
  if (event === undefined) {
    const startsAt = Date.now() + 3_600_000;
    const response = await request.post(`${credentials.baseUrl}/api/v1/me/events`, {
      headers: jsonHeaders,
      data: {
        operationId: crypto.randomUUID(),
        title: PRESET_EVENT_TITLE,
        region: 'cn',
        startsAt,
        endsAt: startsAt + 3_600_000,
        description: '阶段 04 验收预置数据',
      },
    });
    if (!response.ok()) {
      throw new Error(`预置活动失败：${await response.text()}`);
    }
    const created = (await response.json()) as { event: WorkspaceEvent };
    event = created.event;
  }
  expect(event.startsAt, '预置活动必须是「未开始」的，否则活动时间表 Widget 不显示它').toBeGreaterThan(Date.now());
  return event;
}

/** 活跃的个人副本（按目录 ID）。 */
function copiesOfCatalogEntries(snapshot: NavSnapshot, catalogIds: readonly string[]): NavLink[] {
  return snapshot.links.filter(
    (link) => link.sourceCatalogId !== null && catalogIds.includes(link.sourceCatalogId),
  );
}

function bookmarkHtml(urls: {
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly missing: string;
}): string {
  // 真实形态的 Netscape 书签导出：≥3 条 https + 1 条 javascript: + 1 条重复 URL + 1 条缺标题，
  // 外加一个脚本块（用来证明外来脚本没有被解析成数据，更没有被执行）。
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    '  <DT><H3>E2E 书签夹</H3>',
    '  <DL><p>',
    `    <DT><A HREF="${urls.a}">书签甲</A>`,
    `    <DT><A HREF="${urls.b}">书签乙 查询串</A>`,
    `    <DT><A HREF="${urls.c}">书签丙 &lt;script&gt;alert('xss-marker')&lt;/script&gt;</A>`,
    `    <DT><A HREF="${urls.b}">书签乙 重复</A>`,
    '    <DT><A HREF="javascript:alert(\'js-marker\')">危险协议条目</A>',
    `    <DT><A HREF="${urls.missing}"> </A>`,
    "    <SCRIPT>document.title='script-marker';</SCRIPT>",
    '  </DL><p>',
    '</DL><p>',
    '',
  ].join('\n');
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close();
}

// ---------------------------------------------------------------------------
// A. 推荐目录 → 个人副本 → 删除 → 目录升级 → 另设备墓碑（HUB-047 / HUB-048）
// ---------------------------------------------------------------------------

test.describe('阶段 04：自由导航（HUB-047 / 048 / 007 / 008）', () => {
  test('A. 目录导入 → 个人副本 → 墓碑 → 目录升级不覆盖不复活 → 另设备不复活墓碑', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'A 链只在桌面项目执行一次');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.navigation);
    const catalog = await readCatalog(request);
    expect(catalog.entries.length, '推荐目录至少要有 2 条可导入条目').toBeGreaterThanOrEqual(2);
    const first = catalog.entries[0];
    const second = catalog.entries[1];
    if (first === undefined || second === undefined) {
      throw new Error('推荐目录条目不足 2 条');
    }
    const catalogIds = [first.id, second.id];

    await signIn(page);
    await openNav(page);

    // 1) 界面加载推荐目录，并把它作为「个人副本」导入工作空间。
    const copiesBeforeImport = copiesOfCatalogEntries(await readSnapshot(request), catalogIds).length;
    const importOnce = async (): Promise<CatalogImportBody> => {
      await page.getByTestId('nav-catalog-load').click();
      await expect(page.getByTestId('nav-catalog-list')).toBeVisible();
      // 目录默认把**所有**「可安全导入」的条目都勾上；本用例要的是「这一批只导入这两条」，
      // 因此显式收敛选择集（勾上目标、取消其它），请求体里就只有这两个目录 ID。
      const rows = page.locator('[data-testid="nav-catalog-entry"]');
      const rowCount = await rows.count();
      expect(rowCount, '推荐目录应有条目').toBeGreaterThanOrEqual(2);
      for (let index = 0; index < rowCount; index += 1) {
        const row = rows.nth(index);
        const catalogId = (await row.getAttribute('data-catalog-id')) ?? '';
        const checkbox = row.getByTestId('nav-catalog-select');
        const shouldSelect = catalogIds.includes(catalogId);
        if (shouldSelect && !(await checkbox.isChecked())) {
          await checkbox.check();
        }
        if (!shouldSelect && (await checkbox.isChecked())) {
          await checkbox.uncheck();
        }
      }
      const responsePromise = page.waitForResponse((response) =>
        response.url().includes('/navigation/catalog/import'),
      );
      await page.getByTestId('nav-catalog-import').click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      await expect(page.getByTestId('nav-notice')).toBeVisible();
      const body = (await response.json()) as CatalogImportBody;
      expect(body.decisions.length, '请求里只应包含这两条目录条目').toBe(2);
      return body;
    };

    let importBody = await importOnce();
    let copies = copiesOfCatalogEntries(await readSnapshot(request), catalogIds);
    if (copies.length !== 2) {
      // 前置收敛：若这个工作空间里已经存在这两条的墓碑副本（同一服务实例被重复使用），
      // 则只有「显式再次导入」能复活它们——界面上的那个复选框就是这条唯一入口。
      await page.getByTestId('nav-catalog-explicit').check();
      importBody = await importOnce();
      copies = copiesOfCatalogEntries(await readSnapshot(request), catalogIds);
    }
    if (copiesBeforeImport === 0) {
      // 全新起点：界面上这一下必须真的写入两条。
      expect(importBody.importedCount, '全新起点导入两条目录条目应写入 2 条').toBe(2);
    }
    expect(copies.length, '工作空间里应恰好有 2 条来自这两个目录条目的副本').toBe(2);
    const modifiedCopy = copies.find((link) => link.sourceCatalogId === first.id);
    const deletedCopy = copies.find((link) => link.sourceCatalogId === second.id);
    if (modifiedCopy === undefined || deletedCopy === undefined) {
      throw new Error('导入后未找到两条个人副本');
    }
    // 界面与快照双验：两条副本都真的在列表里。
    await expect(linkRow(page, modifiedCopy.id)).toBeVisible();
    await expect(linkRow(page, deletedCopy.id)).toBeVisible();
    // 导入即完全独立：副本带上 `sourceCatalogId` 与导入版本（弱关联、无外键），
    // 因此目录条目之后改名/下线都不影响这条个人副本。
    for (const copy of copies) {
      expect(copy.sourceCatalogId, '副本必须记住来源目录条目').not.toBeNull();
      expect(copy.importedSourceVersion, '副本必须记住导入时的目录版本').toBeGreaterThan(0);
    }
    // 目录自带的分类会被复用/新建为个人分组（分组本身确实建立了），
    // 并且副本**真的**带上该分组归属（复核缺陷 #4 修复后：成员关系不再静默插 0 行）。
    const snapshotAfterImport = await readSnapshot(request);
    expect(
      snapshotAfterImport.groups.map((group) => group.name),
      '目录导入会复用/新建分类同名分组',
    ).toContain(first.category);
    const membershipsOfCopy = snapshotAfterImport.memberships.filter(
      (membership) => membership.linkId === modifiedCopy.id && membership.deletedAt === null,
    );
    expect(membershipsOfCopy, '导入的副本必须真的落在分类分组里').toHaveLength(1);

    // 2) 修改其中一条副本：走**真实编辑表单**（改名），这正是验收要求的「改私人副本」。
    await linkRow(page, modifiedCopy.id).getByTestId('nav-link-edit').click();
    const titleInput = page.getByTestId('nav-link-title');
    await expect(titleInput).toBeVisible();
    const renamed = '我把这条改名了（阶段04验收）';
    await titleInput.fill(renamed);
    await page.getByTestId('nav-link-submit').click();
    // 复核缺陷 #1 修复前这里恒定 409（前端拿工作空间修订当行 CAS 基数）。
    await expect(linkRow(page, modifiedCopy.id)).toContainText(renamed);
    await expect(page.getByTestId('nav-conflict')).toHaveCount(0);

    const afterRename = await readSnapshot(request);
    const modifiedAfterRename = afterRename.links.find((link) => link.id === modifiedCopy.id);
    expect(modifiedAfterRename?.title, '改名必须真的持久化到服务端').toBe(renamed);
    expect(modifiedAfterRename?.revision, '行修订必须推进').toBe(modifiedCopy.revision + 1);
    expect(
      navCatalogEntryState({ entry: first, link: modifiedAfterRename }),
      '被改过的那条必须被判为 user_modified（这是「目录升级不覆盖」的前提）',
    ).toBe('user_modified');
    // 界面上的目录状态也要跟着变（共享 catalogUpgradePlan 的可见证据）。
    await page.getByTestId('nav-catalog-load').click();
    await expect(catalogRow(page, first.id)).toHaveAttribute('data-catalog-state', 'user_modified');

    // 3) 删除第二条 = 墓碑。
    await linkRow(page, deletedCopy.id).getByTestId('nav-link-delete').click();
    await expect(linkRow(page, deletedCopy.id), '墓碑行必须从界面消失').toHaveCount(0);
    const afterDelete = await readSnapshot(request);
    expect(afterDelete.links.some((link) => link.id === deletedCopy.id)).toBe(false);
    // 墓碑的服务端权威证据：变更水位里的 op='delete' + payload=null（快照刻意不返回墓碑行）。
    const tombstoneChange = await findLatestSyncChange(request, 'nav_link', deletedCopy.id);
    expect(tombstoneChange, '删除必须进入同步流（否则跨设备无法知道它被删了）').not.toBeNull();
    expect(tombstoneChange?.op, '删除必须以墓碑（op=delete）形式进入同步流').toBe('delete');
    expect(tombstoneChange?.payload, '墓碑变更不重复传内容').toBeNull();
    await page.getByTestId('nav-catalog-load').click();
    // 界面侧：刷新目录后该条目的行仍然在（目录是只读系统目录，删掉的只是个人副本），
    // 并且必须如实显示「你删除过」（复核缺陷 #3 修复后：状态来自服务端 catalogPlan 投影，
    // 它包含墓碑行；本地快照只有活跃行，是看不到这件事的）。
    await expect(catalogRow(page, second.id)).toBeVisible();
    await expect(catalogRow(page, second.id)).toHaveAttribute('data-catalog-state', 'tombstoned');
    await expect(catalogRow(page, second.id).getByTestId('nav-catalog-state')).toContainText('你删除过');

    // 4) 目录升级：用真实 HTTP 再调一次非显式导入（explicitReimport 缺省 = false）。
    const beforeUpgrade = await readSnapshot(request);
    const modifiedBeforeUpgrade = beforeUpgrade.links.find((link) => link.id === modifiedCopy.id);
    const personalTablesBefore = JSON.stringify({
      links: beforeUpgrade.links,
      groups: beforeUpgrade.groups,
      memberships: beforeUpgrade.memberships,
    });
    const upgrade = await importCatalogViaHttp(request, { catalogIds });
    expect(upgrade.importedCount, '目录升级不得写入任何个人行').toBe(0);
    expect([...upgrade.skippedCatalogIds].sort((a, b) => a.localeCompare(b))).toEqual([...catalogIds].sort((a, b) => a.localeCompare(b)));
    const decisionOf = (catalogId: string): CatalogDecision | undefined =>
      upgrade.decisions.find((decision) => decision.catalogId === catalogId);
    expect(decisionOf(first.id)?.action).toBe('skip');
    expect(decisionOf(first.id)?.reason, '被用户改过的副本必须因「个人修改」被跳过').toContain('个人修改');
    expect(decisionOf(second.id)?.action).toBe('skip');
    expect(decisionOf(second.id)?.reason, '被删除的条目必须因「删除」被跳过').toContain('删除');

    const afterUpgrade = await readSnapshot(request);
    // ADR-0004 D1 的硬约束：目录升级只更新系统目录，**绝不写个人表**。
    // 这里对链接 / 分组 / 成员关系做逐字节比对（比只比一条链接更强）。
    expect(
      JSON.stringify({
        links: afterUpgrade.links,
        groups: afterUpgrade.groups,
        memberships: afterUpgrade.memberships,
      }),
      '目录升级不得写个人表（链接 / 分组 / 成员关系逐字节不变）',
    ).toBe(personalTablesBefore);
    // 复核缺陷 #6 修复后：全部决策都是 skip 时**不推进**同步水位，也不在响应里假装 +1。
    expect(upgrade.revision, '全跳过的导入不得假装推进 revision').toBe(beforeUpgrade.revision);
    expect(afterUpgrade.revision, '全跳过的导入不得推进工作空间水位').toBe(beforeUpgrade.revision);
    const modifiedAfterUpgrade = afterUpgrade.links.find((link) => link.id === modifiedCopy.id);
    expect(modifiedAfterUpgrade, '被改过的副本必须仍然存在').toEqual(modifiedBeforeUpgrade);
    expect(afterUpgrade.links.some((link) => link.id === deletedCopy.id), '被删的条目必须仍然删除').toBe(false);
    // 界面双验：改过的那条仍在（内容未变），删掉的那条仍然不在。
    await expect(linkRow(page, modifiedCopy.id)).toContainText(renamed);
    await expect(linkRow(page, deletedCopy.id)).toHaveCount(0);

    // 5) 另一台设备（新的 BrowserContext + 同一凭证）：墓碑已传播，且非显式导入不会让它回来。
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await signIn(otherPage);
      await openNav(otherPage);
      await expect(linkRow(otherPage, modifiedCopy.id), '另一设备必须看到同一条活跃副本').toBeVisible();
      await expect(linkRow(otherPage, deletedCopy.id), '另一设备必须看不到被删除的那条').toHaveCount(0);
      await otherPage.getByTestId('nav-catalog-load').click();
      await expect(otherPage.getByTestId('nav-catalog-list')).toBeVisible();
      // 只勾选「被删除的那一条」，并且**不**勾选「显式再次导入」：这是非显式导入路径。
      const otherRows = otherPage.locator('[data-testid="nav-catalog-entry"]');
      const otherRowCount = await otherRows.count();
      for (let index = 0; index < otherRowCount; index += 1) {
        const row = otherRows.nth(index);
        const catalogId = (await row.getAttribute('data-catalog-id')) ?? '';
        const checkbox = row.getByTestId('nav-catalog-select');
        const shouldSelect = catalogId === second.id;
        if (shouldSelect && !(await checkbox.isChecked())) {
          await checkbox.check();
        }
        if (!shouldSelect && (await checkbox.isChecked())) {
          await checkbox.uncheck();
        }
      }
      await expect(otherPage.getByTestId('nav-catalog-explicit'), '不得勾选「显式再次导入」').not.toBeChecked();
      const reimportPromise = otherPage.waitForResponse((response) =>
        response.url().includes('/navigation/catalog/import'),
      );
      await otherPage.getByTestId('nav-catalog-import').click();
      const reimportBody = (await (await reimportPromise).json()) as CatalogImportBody;
      expect(reimportBody.importedCount, '非显式导入不得写入任何行').toBe(0);
      expect(reimportBody.skippedCatalogIds, '非显式再导入必须跳过墓碑条目').toContain(second.id);
      const skippedDecision = reimportBody.decisions.find((decision) => decision.catalogId === second.id);
      expect(skippedDecision?.action).toBe('skip');
      expect(skippedDecision?.reason, '跳过原因必须说明「已被用户删除」').toContain('删除');
      await expect(linkRow(otherPage, deletedCopy.id), '墓碑不得被非显式导入复活').toHaveCount(0);
      const afterOtherDevice = await readSnapshot(request);
      expect(afterOtherDevice.links.some((link) => link.id === deletedCopy.id)).toBe(false);
    } finally {
      await closeContext(otherContext);
    }
  });

  // -------------------------------------------------------------------------
  // B. 书签 HTML 预览与导出往返（HUB-007 / HUB-008）
  // -------------------------------------------------------------------------

  test('B. 书签 HTML 预览逐项原因 + 应用导入 + 导出 round-trip', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'B 链只在桌面项目执行一次');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.navigation);
    const stamp = uniqueStamp();
    const urls = {
      a: `https://a.${stamp}.e2e-bookmarks.test/one`,
      b: `https://b.${stamp}.e2e-bookmarks.test/two?x=1&y=2`,
      c: `https://c.${stamp}.e2e-bookmarks.test/three`,
      missing: `https://d.${stamp}.e2e-bookmarks.test/no-title`,
    };
    const htmlPath = testInfo.outputPath('bookmarks.html');
    writeFileSync(htmlPath, bookmarkHtml(urls), 'utf8');

    await signIn(page);
    await openNav(page);
    const before = await readSnapshot(request);

    // 预览：本地解析（共享 parseBookmarkHtml）逐项列出 items 与 skipped（含原因）。
    await page.getByTestId('nav-import-file-input').setInputFiles(htmlPath);
    await expect(page.getByTestId('nav-import-local')).toBeVisible();
    await expect(page.getByTestId('nav-import-local-summary')).toContainText('可导入');
    await expect(page.getByTestId('nav-import-item')).toHaveCount(3);
    await expect(page.getByTestId('nav-import-skip-reason')).toHaveCount(3);
    const skipped = page.getByTestId('nav-import-local-skipped');
    await expect(skipped).toContainText('只允许 https');
    await expect(skipped).toContainText('同一地址重复出现');
    await expect(skipped).toContainText('缺少标题');

    // 外来 HTML 没有被执行/插入：页面文本里不出现原始标签；书签里的 <SCRIPT> 块内容
    // （`script-marker`）也不得被当成数据回显；注入的标题虽然作为**纯文本**出现
    // （尖括号被渲染成全角字符），但它绝不能变成真正的 <script> 元素。
    const bodyText = await page.locator('body').innerText();
    expect(bodyText, '页面文本不得出现原始 <script 标签').not.toContain('<script');
    expect(bodyText, '页面文本不得出现原始 <a 标签').not.toContain('<a ');
    expect(bodyText, '书签里的脚本块内容不得被解析成数据').not.toContain('script-marker');
    expect(await page.title(), '书签里的脚本不得被执行').not.toBe('script-marker');
    const injectedScripts = await page.evaluate((): number => {
      return [...document.querySelectorAll('script')].filter((element) =>
        (element.textContent ?? '').includes('xss-marker'),
      ).length;
    });
    expect(injectedScripts, '书签标题里的脚本片段不得被插入成真正的 script 元素').toBe(0);
    // 反证：标题里的尖括号被渲染成**全角文本**（说明它确实进入了页面，但是作为纯文本）。
    await expect(page.getByTestId('nav-import-item-list')).toContainText('＜script＞');

    // 应用导入：服务端重新校验后再落地。
    await page.getByTestId('nav-import-preview').click();
    await expect(page.getByTestId('nav-import-preview-result')).toBeVisible();
    await expect(page.getByTestId('nav-import-preview-summary')).toContainText('可写入');
    await page.getByTestId('nav-import-apply').click();
    await expect(page.getByTestId('nav-notice')).toBeVisible();

    const after = await readSnapshot(request);
    for (const url of [urls.a, urls.b, urls.c]) {
      expect(after.links.some((link) => link.url === url), `导入后应存在：${url}`).toBe(true);
    }
    expect(after.links.length, '只有 3 条被接受，跳过项不得进入').toBe(before.links.length + 3);
    expect(after.links.some((link) => link.url.startsWith('javascript:'))).toBe(false);
    expect(after.links.some((link) => link.title === '危险协议条目')).toBe(false);
    await expect(page.getByTestId('nav-link-list')).toContainText('书签甲');
    // 书签导入走**通用导入路径**，它按「先建分组、再建链接、最后建成员关系」的顺序入批，
    // 因此同名分组（`<H3>`）的归属是真的建立起来的（与目录导入的分类分组形成对照：
    // 后者见 A 用例与报告里的产品缺陷 #3）。
    const bookmarked = after.links.find((link) => link.url === urls.a);
    expect(bookmarked, '导入的书签必须存在于快照里').toBeDefined();
    expect(
      after.memberships.some(
        (membership) => membership.linkId === bookmarked?.id && membership.deletedAt === null,
      ),
      '书签导入必须真的建立同名分组成员关系',
    ).toBe(true);

    // 导出（真实 HTTP）→ 用共享 parseNavExportDocument 读回。
    const exportResponse = await request.get(`${credentials.baseUrl}/api/v1/me/navigation/export`, {
      headers: authHeaders,
    });
    expect(exportResponse.ok()).toBe(true);
    const exportBody = (await exportResponse.json()) as { document: unknown; exportedAt: number };
    const parsed = parseNavExportDocument(exportBody.document);
    expect(parsed.ok, parsed.ok ? '' : parsed.reason).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const snapshotForExport = await readSnapshot(request);
    expect(parsed.document.links.length, '导出链接数必须与活跃快照一致').toBe(snapshotForExport.links.length);
    expect(parsed.document.links.some((link) => link.url === urls.a), '导出必须包含刚导入的链接').toBe(true);
    const exportText = JSON.stringify(parsed.document).toLowerCase();
    for (const forbidden of ['token', 'secret', 'password']) {
      expect(exportText.includes(forbidden), `导出文档不得包含 ${forbidden}`).toBe(false);
    }

    // 界面里的导出 + 读回校验也必须成功（真实按钮 + 共享纯函数）。
    await page.getByTestId('nav-export-run').click();
    await expect(page.getByTestId('nav-export-notice')).toBeVisible();
    await page.getByTestId('nav-export-copy').click();
    await expect(page.getByTestId('nav-export-readback-result')).toContainText('读回成功');
    await expect(page.getByTestId('nav-export-readback-result')).toContainText('往返稳定');
  });
});

// ---------------------------------------------------------------------------
// C. 导航 / 活动 Widget：真实放入、模块停用降级、移除后数据保留（HUB-010 / HUB-011）
// ---------------------------------------------------------------------------

test.describe('阶段 04：内置模块与组件（HUB-010 / HUB-011）', () => {
  test('C1. 组件库放入导航/活动组件 → 真实数据 → 停用模块降级 → 恢复 → 移除组件但数据保留', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'C1 链只在桌面项目执行一次');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.navigation);
    await ensureModuleEnabled(request, credentials.moduleIds.events);

    await signIn(page);
    await openNav(page);
    const presetLink = await ensurePresetFavoriteLink(page, request);
    const presetEvent = await ensurePresetUpcomingEvent(request);

    // 新建一个专用页面，避免与其它用例的页面 / 组件互相影响。
    const pageName = `E2E 组件页 ${uniqueStamp()}`;
    await openWorkbench(page);
    await createPageViaUi(page, pageName);
    const pageId = (await listPages(request)).pages.find((candidate) => candidate.name === pageName)?.id ?? '';
    expect(pageId.length).toBeGreaterThan(0);

    // 组件库 → 真实服务端写入 → 组件真的渲染出预置数据（D1 里的那条链接 / 活动）。
    await addWidgetViaUi(page, credentials.widgetIds.quickLinks);
    const navCard = widgetCard(page, credentials.widgetIds.quickLinks);
    await expect(navCard.getByTestId('nav-quick-links')).toBeVisible();
    await expect(navCard.getByTestId('nav-quick-links-list')).toContainText(presetLink.title);

    await addWidgetViaUi(page, credentials.widgetIds.eventsUpcoming);
    const eventsCard = widgetCard(page, credentials.widgetIds.eventsUpcoming);
    const eventsList = eventsCard.getByLabel('活动列表');
    await expect(eventsList).toContainText(presetEvent.title);
    await expect(eventsList).toContainText('国服');
    await expect(eventsList).toContainText(EVENTS_MESSAGES.unverifiedBadge);

    // 停用 ff14.navigation：其实例必须降级（显示可读原因、不执行组件），活动组件不受影响。
    await setModuleEnabledViaUi(page, credentials.moduleIds.navigation, false);
    await openWorkbench(page);
    const degradedCard = widgetCard(page, credentials.widgetIds.quickLinks);
    await expect(degradedCard.getByTestId('widget-degraded')).toBeVisible();
    await expect(degradedCard.getByTestId('widget-degraded')).toContainText('已停用');
    await expect(degradedCard.getByTestId('nav-quick-links')).toHaveCount(0);
    await expect(widgetCard(page, credentials.widgetIds.eventsUpcoming).getByLabel('活动列表')).toContainText(
      presetEvent.title,
    );
    const statusWhileDisabled = await request.get(
      `${credentials.baseUrl}/api/v1/me/modules/${credentials.moduleIds.navigation}`,
      { headers: authHeaders },
    );
    expect(((await statusWhileDisabled.json()) as { module: { status: string } }).module.status).toBe('disabled');

    // 重新启用：实例保留，组件恢复执行。
    await setModuleEnabledViaUi(page, credentials.moduleIds.navigation, true);
    await openWorkbench(page);
    await expect(widgetCard(page, credentials.widgetIds.quickLinks).getByTestId('nav-quick-links-list')).toContainText(
      presetLink.title,
    );

    // 移除该组件实例：组件消失，但个人导航数据与活动数据一条都不能少。
    await waitForStablePosition(page, 'widget-library');
    await widgetCard(page, credentials.widgetIds.quickLinks).getByTestId('widget-remove').click();
    await expect(widgetCard(page, credentials.widgetIds.quickLinks), '移除后该组件实例必须消失').toHaveCount(0);
    const snapshotAfterRemove = await readSnapshot(request);
    const linkAfterRemove = snapshotAfterRemove.links.find((link) => link.id === presetLink.id);
    expect(linkAfterRemove, '移除组件不得删除个人链接').toBeDefined();
    expect(linkAfterRemove?.isFavorite).toBe(true);
    const eventsAfterRemove = await readEvents(request);
    expect(eventsAfterRemove.events.some((event) => event.id === presetEvent.id)).toBe(true);
  });

  test('C2. 活动维护：界面手工录入一条活动并断言 UTC 毫秒；非法区间就地拒绝且零写入', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'C2 链只在桌面项目执行一次');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.events);
    const stamp = uniqueStamp();
    const title = `E2E 手工活动 ${stamp}`;
    const badTitle = `E2E 倒置活动 ${stamp}`;

    await signIn(page);
    const pageName = `E2E 活动页 ${stamp}`;
    await openWorkbench(page);
    await createPageViaUi(page, pageName);
    await addWidgetViaUi(page, credentials.widgetIds.eventsManage);

    const manageForm = page.getByRole('form', { name: '新建活动' });
    await expect(manageForm).toBeVisible();

    // 起止时间用「本地时间」输入；期望的 UTC 毫秒由**浏览器自己**解释，避免测试进程与浏览器时区不一致。
    const startMs = Date.now() + 5 * 3_600_000;
    const endMs = startMs + 2 * 3_600_000;
    const localInput = (ms: number): string => {
      const date = new Date(ms);
      const pad = (value: number): string => String(value).padStart(2, '0');
      return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const startsLocal = localInput(startMs);
    const endsLocal = localInput(endMs);
    const startsExpected = await page.evaluate((value) => new Date(value).getTime(), startsLocal);
    const endsExpected = await page.evaluate((value) => new Date(value).getTime(), endsLocal);

    await manageForm.getByLabel('标题').fill(title);
    await manageForm.getByLabel('区服').selectOption('cn');
    await manageForm.getByLabel('开始时间（本地时间）').fill(startsLocal);
    await manageForm.getByLabel('结束时间（本地时间）').fill(endsLocal);
    await manageForm.getByLabel('描述').fill('阶段 04 界面录入');
    await manageForm.getByLabel('来源链接（可选，必须是 https）').fill(`https://events.${stamp}.e2e-manual.test/list`);
    await manageForm.getByRole('button', { name: '添加活动' }).click();

    const eventList = page.getByLabel('个人活动列表');
    await expect(eventList).toContainText(title);
    const createdRow = eventList.locator('li', { hasText: title });
    await expect(createdRow).toContainText('国服');
    await expect(createdRow).toContainText(EVENTS_MESSAGES.unverifiedBadge);
    await expect(createdRow).toContainText('—');

    const listed = await readEvents(request);
    const created = listed.events.find((event) => event.title === title);
    expect(created, '界面录入的活动必须真的落到服务端').toBeDefined();
    expect(created?.region).toBe('cn');
    expect(created?.verificationStatus, '用户自述来源永不被标记为已验证').toBe('unverified');
    expect(created?.startsAt, '开始时间必须与输入一致（UTC 毫秒）').toBe(startsExpected);
    expect(created?.endsAt, '结束时间必须与输入一致（UTC 毫秒）').toBe(endsExpected);

    // 非法区间（结束早于开始）：必须就地报错，且**一个写请求都不发**。
    const postWrites: string[] = [];
    const recordPost = (target: { method: () => string; url: () => string }): void => {
      if (target.method() === 'POST' && target.url().includes('/api/v1/me/events')) {
        postWrites.push(target.url());
      }
    };
    page.on('request', recordPost);
    const countBeforeInvalid = (await readEvents(request)).events.length;
    await manageForm.getByLabel('标题').fill(badTitle);
    await manageForm.getByLabel('开始时间（本地时间）').fill(localInput(endMs + 3_600_000));
    await manageForm.getByLabel('结束时间（本地时间）').fill(localInput(startMs));
    await manageForm.getByRole('button', { name: '添加活动' }).click();
    await expect(manageForm.getByRole('alert')).toContainText('结束时间不能早于开始时间');
    page.off('request', recordPost);
    expect(postWrites, '非法区间必须在本地拒绝，不得发出任何写请求').toEqual([]);
    const listedAfterInvalid = await readEvents(request);
    expect(listedAfterInvalid.events.length, '被拒绝的输入不得多出行').toBe(countBeforeInvalid);
    expect(listedAfterInvalid.events.some((event) => event.title === badTitle)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. PWA 安装元数据、SW、缓存隐私、离线降级（HUB-012）
// ---------------------------------------------------------------------------

test.describe('阶段 04：PWA（HUB-012）', () => {
  test('D. manifest / Service Worker / 缓存隐私 / 离线降级不白屏', async ({ page, request, context }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'D 链只在桌面项目执行一次');
    test.slow();

    // 1) manifest：200 + manifest MIME + 可 JSON.parse + 每个图标都是真 PNG。
    const manifestResponse = await request.get(`${credentials.baseUrl}/manifest.webmanifest`);
    expect(manifestResponse.status()).toBe(200);
    expect(manifestResponse.headers()['content-type'] ?? '').toContain('manifest+json');
    const manifest = (await manifestResponse.json()) as {
      readonly icons: readonly { readonly src: string; readonly sizes: string; readonly type: string }[];
      readonly start_url: string;
      readonly display: string;
    };
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      const iconResponse = await request.get(`${credentials.baseUrl}${icon.src}`);
      expect(iconResponse.status(), icon.src).toBe(200);
      expect(iconResponse.headers()['content-type'], icon.src).toBe('image/png');
    }

    // 2) 真实走一遍私有交互（导航 + 工作台），再检查缓存里**没有**私有数据。
    await signIn(page);
    await openNav(page);
    await page.getByTestId('nav-catalog-load').click();
    await expect(page.getByTestId('nav-catalog-list')).toBeVisible();
    await openWorkbench(page);
    await expect(page.getByTestId('workbench-view')).toBeVisible();
    await openNav(page);

    // 3) Service Worker 必须真的就绪（等待注册完成，而不是假设它已生效）。
    const controllerReady = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null && registration.active !== undefined;
    });
    expect(controllerReady, 'navigator.serviceWorker.ready 必须就绪').toBe(true);

    /**
     * 4) 让公开资源真的进入缓存。
     *
     * 为什么要**再访问一次**：SW 是在首次加载之后才被注册的，首访时的哈希资源
     * （`/assets/index-*.js`）在 SW 接管之前就已经加载完毕，因此它们不在缓存里；
     * SW 的预缓存清单只含 `/`、`/index.html`、`/manifest.webmanifest`、`/favicon.svg`。
     * 于是「首访后立刻离线」会拿到缓存外壳但缺 JS（白屏）——这是真实的产品差距（见交付报告），
     * 本用例按真实用户路径走「第二次访问」（此时请求经过 SW 并被写入缓存），再验证离线降级。
     */
    await page.reload();
    await expect(page.getByTestId('nav-entry')).toBeVisible();
    await page.waitForFunction(
      async () => {
        const names = await caches.keys();
        let hasShell = false;
        let hasAsset = false;
        for (const name of names) {
          const cache = await caches.open(name);
          for (const entry of await cache.keys()) {
            const path = new URL(entry.url).pathname;
            if (path === '/index.html' || path === '/') {
              hasShell = true;
            }
            if (path.startsWith('/assets/')) {
              hasAsset = true;
            }
          }
        }
        return hasShell && hasAsset;
      },
      undefined,
      { timeout: 30_000 },
    );

    // 缓存隐私：绝不含 /api/v1/me/*、绝不含设备凭证；同时确认公开资源确实被缓存了。
    const cacheReport = await page.evaluate(async () => {
      const report: { name: string; urls: string[]; bodies: string[]; jsonBodies: string[] }[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        const bodies: string[] = [];
        const jsonBodies: string[] = [];
        for (const entry of requests) {
          const matched = await cache.match(entry);
          if (matched === undefined) {
            continue;
          }
          const text = await matched.text();
          bodies.push(text);
          if ((matched.headers.get('content-type') ?? '').includes('json')) {
            jsonBodies.push(text);
          }
        }
        report.push({ name, urls: requests.map((entry) => entry.url), bodies, jsonBodies });
      }
      return report;
    });
    const allUrls = cacheReport.flatMap((entry) => entry.urls);
    expect(allUrls.length, '应至少缓存了公开资源（离线兜底需要它）').toBeGreaterThan(0);
    for (const url of allUrls) {
      expect(url.includes('/api/v1/me/'), `缓存里不得出现私有端点：${url}`).toBe(false);
      expect(url.includes(credentials.token), `缓存里不得出现设备凭证：${url}`).toBe(false);
    }
    // 响应体：任何缓存内容都不得含设备凭证；**公开目录响应**（JSON）里也不得出现私有端点。
    // （JS 产物里出现 `/api/v1/me/...` 字面量是正常的接口常量，因此只对 JSON 响应做这项断言。）
    for (const entry of cacheReport) {
      for (const body of entry.bodies) {
        expect(body.includes(credentials.token), `缓存响应体不得含设备凭证（${entry.name}）`).toBe(false);
      }
    }
    for (const entry of cacheReport) {
      for (const body of entry.jsonBodies) {
        expect(body.includes('/api/v1/me/'), `公开 JSON 响应不得含私有端点（${entry.name}）`).toBe(false);
      }
    }
    expect(
      allUrls.some((url) => url.includes('/assets/')),
      '公开静态资源（/assets/ 下的哈希产物）必须被缓存——离线打开应用外壳靠它',
    ).toBe(true);

    // 6) 离线降级：必须出现明确的降级文案（来源 = install-state 的纯函数），
    //    并且 Service Worker 用缓存的应用外壳兜底，页面**不白屏**（系统级入口仍在）。
    await context.setOffline(true);
    try {
      await page.reload();
      const offlineNotice = page.getByTestId('offline-notice');
      await expect(offlineNotice, '离线时必须出现明确的降级文案').toBeVisible();
      await expect(offlineNotice).toContainText(OFFLINE_DISCLOSURE);
      await expect(offlineNotice, '离线时不得暗示私有修改已保存').toContainText('不会在离线时持久化到服务端');
      await expect(page.getByTestId('nav-entry'), '离线重载后系统级入口必须仍然存在（不白屏）').toBeVisible();
      await expect(systemBar(page)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'FF14 Hub' })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
    await page.reload();
    await expect(page.getByTestId('nav-entry')).toBeVisible();
  });

  test('D 窄屏. 390×844 无横向溢出，导航与活动组件关键按钮可见可点', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', '窄屏用例只在移动项目执行');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.navigation);
    await ensureModuleEnabled(request, credentials.moduleIds.events);
    await page.setViewportSize({ width: 390, height: 844 });

    await signIn(page);
    await openNav(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    // 导航视图的关键按钮：可见、可点、点了真的进入表单。
    const newLink = page.getByTestId('nav-new-link');
    await expect(newLink).toBeVisible();
    await newLink.click();
    await expect(page.getByTestId('nav-link-form')).toBeVisible();
    await expect(page.getByTestId('nav-link-submit')).toBeEnabled();
    await page.getByTestId('nav-link-cancel').click();
    await expect(page.getByTestId('nav-link-form')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    // 活动维护组件的关键按钮：可见、可点。
    await openWorkbench(page);
    await createPageViaUi(page, `E2E 窄屏页 ${uniqueStamp()}`);
    await addWidgetViaUi(page, credentials.widgetIds.eventsManage);
    const manageForm = page.getByRole('form', { name: '新建活动' });
    await expect(manageForm).toBeVisible();
    const submit = manageForm.getByRole('button', { name: '添加活动' });
    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(manageForm.getByRole('alert')).toBeVisible();
    await expect(manageForm.getByRole('button', { name: '清空表单' })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test('E. 窄屏 + 键盘：Tab/Enter 进入导航、聚焦搜索框、真实筛选、焦点可见', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', '键盘可达用例只在移动项目执行');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.navigation);
    const stamp = uniqueStamp();
    const firstTitle = `E2E 键盘甲 ${stamp}`;
    const secondTitle = `E2E 键盘乙 ${stamp}`;
    await createNavLinkViaHttp(request, { title: firstTitle, url: `https://kb1.${stamp}.e2e-keyboard.test/` });
    await createNavLinkViaHttp(request, { title: secondTitle, url: `https://kb2.${stamp}.e2e-keyboard.test/` });

    await signIn(page);
    await page.setViewportSize({ width: 390, height: 844 });

    // 键盘进入导航：聚焦系统级入口后按 Enter（原生按钮的键盘激活）。
    await page.getByTestId('nav-entry').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('nav-view')).toBeVisible();
    // 等快照落地再数行数（`nav-link-item` 只在快照到达后才有）。
    await expect(
      page.locator('[data-testid="nav-link-list"], [data-testid="nav-empty"], [data-testid="nav-no-match"]'),
    ).toBeVisible();

    // 继续用 Tab 走到搜索框（不依赖固定 Tab 次数），并断言焦点可见。
    await tabUntilTestId(page, 'nav-filter-text');
    const outlineBefore = await focusedOutline(page);
    expect(outlineBefore.style, '聚焦的搜索框必须有可见 outline').not.toBe('none');
    expect(outlineBefore.width, '聚焦的搜索框 outline 宽度不得为 0').not.toBe('0px');

    const beforeCount = await page.getByTestId('nav-link-item').count();
    expect(beforeCount, '筛选前应有至少 2 条链接').toBeGreaterThanOrEqual(2);
    await page.keyboard.type(firstTitle);
    await expect(page.getByTestId('nav-link-item')).toHaveCount(1);
    await expect(page.getByTestId('nav-link-list')).toContainText(firstTitle);
    await expect(page.getByTestId('nav-link-list')).not.toContainText(secondTitle);
    const outlineAfter = await focusedOutline(page);
    expect(outlineAfter.style, '输入过程中焦点必须保持可见').not.toBe('none');

    // 清空筛选：列表恢复到筛选前的数量（证明筛选是真的按输入生效，而不是一次性渲染）。
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('nav-link-item')).toHaveCount(beforeCount);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// F. 双浏览器上下文：导航冲突 / 草稿保留 / 墓碑跨设备 / 布局两端独立（HUB-051）
// ---------------------------------------------------------------------------

test.describe('阶段 04：跨设备同步（HUB-051）', () => {
  test('F1. 导航并发冲突不静默覆盖 + 草稿不被远程变化覆盖 + 墓碑跨设备不复活', async ({
    request,
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'F1 链只在桌面项目执行一次');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.navigation);
    const stamp = uniqueStamp();
    const conflictLink = await createNavLinkViaHttp(request, {
      title: `E2E 并发甲 ${stamp}`,
      url: `https://concurrent.${stamp}.e2e-nav.test/a`,
    });
    const draftLink = await createNavLinkViaHttp(request, {
      title: `E2E 并发乙 ${stamp}`,
      url: `https://concurrent.${stamp}.e2e-nav.test/b`,
    });
    const otherLink = await createNavLinkViaHttp(request, {
      title: `E2E 并发丙 ${stamp}`,
      url: `https://concurrent.${stamp}.e2e-nav.test/c`,
    });

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      await signIn(pageA);
      await signIn(pageB);
      await openNav(pageA);
      await openNav(pageB);

      // (a) 并发写入：A 先用正确的行级 CAS 成功，B 基于同一修订再写 → 必须 409，且不静默覆盖。
      //     说明：验收原文的「A 改名保存成功 → B 改名冲突」依赖编辑表单，而该表单目前恒定 409
      //     （产品缺陷 #1）；这里是**语义等价**的实现 —— 收藏 / 删除同样带行级 CAS，
      //     且 B 的写入意图与 A 的结果可区分（A 收藏、B 删除），因此能真正区分「覆盖」与「不覆盖」。
      const rowA = linkRow(pageA, conflictLink.id);
      const rowB = linkRow(pageB, conflictLink.id);
      await expect(rowA).toBeVisible();
      await expect(rowB).toBeVisible();
      await rowA.getByTestId('nav-link-toggle-favorite').click();
      await expect(rowA.getByTestId('nav-link-favorite-mark')).toBeVisible();
      const afterAWrite = await readSnapshot(request);
      const linkAfterA = afterAWrite.links.find((link) => link.id === conflictLink.id);
      expect(linkAfterA?.isFavorite).toBe(true);
      expect(linkAfterA?.revision).toBe(conflictLink.revision + 1);

      await rowB.getByTestId('nav-link-delete').click();
      // 服务端 409 的文案是 `资源状态冲突。（nav_link 的修订号已从 R 变为 R+1）`：
      // 界面必须把**新旧修订号**与冲突码一起呈现出来（这就是「结构化冲突提示」的可读形态）。
      const conflictError = pageB.getByTestId('nav-error');
      await expect(conflictError, '后写者必须看到明确的冲突提示').toContainText('资源状态冲突');
      await expect(conflictError, '冲突提示必须包含新旧修订号').toContainText(
        `修订号已从 ${String(conflictLink.revision)} 变为 ${String(conflictLink.revision + 1)}`,
      );
      await expect(conflictError).toContainText('conflict');
      // 乐观更新必须回滚：B 的列表里该行仍然在，没有被本地「假删掉」。
      await expect(rowB, '冲突后 B 的列表必须回滚到服务端事实').toBeVisible();
      const afterBConflict = await readSnapshot(request);
      const survived = afterBConflict.links.find((link) => link.id === conflictLink.id);
      expect(survived, 'B 的冲突写入不得删除该行').toBeDefined();
      expect(survived?.isFavorite, 'B 的冲突写入不得覆盖 A 的结果').toBe(true);

      // (a2) 结构化冲突的字段级证据（真实 HTTP，与服务端契约一一对应）。
      const staleDelete = await request.delete(
        `${credentials.baseUrl}/api/v1/me/navigation/links/${conflictLink.id}`,
        {
          headers: jsonHeaders,
          data: { operationId: crypto.randomUUID(), expectedRevision: conflictLink.revision },
        },
      );
      expect(staleDelete.status()).toBe(409);
      const conflictBody = (await staleDelete.json()) as {
        code: string;
        details?: { conflict?: Record<string, unknown> };
      };
      expect(conflictBody.code).toBe('conflict');
      expect(conflictBody.details?.conflict).toMatchObject({
        reason: 'revision_conflict',
        entityType: 'nav_link',
        entityId: conflictLink.id,
        baseRevision: conflictLink.revision,
        currentRevision: conflictLink.revision + 1,
      });

      // (b) 草稿不被远程变化覆盖：B 正在编辑 draftLink，A 删除另一条 → B 同步后草稿仍在。
      const draftTitle = `B 的草稿标题 ${stamp}`;
      await linkRow(pageB, draftLink.id).getByTestId('nav-link-edit').click();
      await expect(pageB.getByTestId('nav-link-form')).toHaveAttribute('data-mode', 'edit');
      await pageB.getByTestId('nav-link-title').fill(draftTitle);

      await linkRow(pageA, otherLink.id).getByTestId('nav-link-delete').click();
      await expect(linkRow(pageA, otherLink.id)).toHaveCount(0);

      await pageB.getByTestId('nav-sync-now').click();
      // 远端删除必须真的被应用到 B（这证明同步确实跑过，而不是「碰巧没变」）。
      await expect(linkRow(pageB, otherLink.id), 'B 必须收到并应用其它设备的删除').toHaveCount(0);
      await expect(pageB.getByTestId('nav-link-title'), '后台同步不得清空/覆盖正在编辑的草稿').toHaveValue(
        draftTitle,
      );
      // (c) 无草稿路径的墓碑传播：A 删除 conflictLink，B 同步后该行消失，再同步也不会回来。
      await linkRow(pageA, conflictLink.id).getByTestId('nav-link-delete').click();
      await expect(linkRow(pageA, conflictLink.id)).toHaveCount(0);
      const tombstone = await findLatestSyncChange(request, 'nav_link', conflictLink.id);
      expect(tombstone, '删除必须进入同步流').not.toBeNull();
      expect(tombstone?.op).toBe('delete');
      await pageB.getByTestId('nav-sync-now').click();
      await expect(linkRow(pageB, conflictLink.id), '墓碑必须传播到另一设备').toHaveCount(0);
      await pageB.getByTestId('nav-sync-now').click();
      await expect(linkRow(pageB, conflictLink.id), '墓碑不得被后续同步复活').toHaveCount(0);

      // (d) 编辑中的草稿遇到远端墓碑（D7 最后一条）：保留草稿 + 结构化冲突横幅；
      //     用户显式「放弃草稿并重新载入」后，墓碑才落到列表上。
      await linkRow(pageA, draftLink.id).getByTestId('nav-link-delete').click();
      await expect(linkRow(pageA, draftLink.id)).toHaveCount(0);
      await pageB.getByTestId('nav-sync-now').click();
      await expect(pageB.getByTestId('nav-conflict'), '与草稿冲突的远端变化必须弹出结构化横幅').toBeVisible();
      await expect(pageB.getByTestId('nav-conflict')).toContainText('你的本地草稿仍然保留');
      // CAS 冲突与快照检测都必须给出他端修改提示；附加 notice 节点取决于检测路径。
      // 校验必需的冲突横幅，避免把可选补充节点当作同步完成的判据。
      await expect(pageB.getByTestId('nav-conflict')).toContainText('其他设备');
      await expect(
        pageB.getByTestId('nav-link-title'),
        '远端墓碑不得清空/覆盖正在编辑的草稿',
      ).toHaveValue(draftTitle);
      await pageB.getByTestId('nav-conflict-discard').click();
      await expect(pageB.getByTestId('nav-link-form')).toHaveCount(0);
      await expect(linkRow(pageB, draftLink.id), '放弃草稿并重新载入后墓碑才落到列表').toHaveCount(0);
      await pageB.getByTestId('nav-sync-now').click();
      await expect(linkRow(pageB, draftLink.id), '墓碑不得被后续同步复活').toHaveCount(0);

      const finalSnapshot = await readSnapshot(request);
      expect(finalSnapshot.links.some((link) => link.id === draftLink.id)).toBe(false);
      expect(finalSnapshot.links.some((link) => link.id === conflictLink.id)).toBe(false);
      expect(finalSnapshot.links.some((link) => link.id === otherLink.id)).toBe(false);
    } finally {
      await closeContext(contextA);
      await closeContext(contextB);
    }
  });

  test('F2. 布局两端独立：桌面上下文保存桌面布局、手机上下文保存手机布局，互不影响', async ({
    request,
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'F2 链只在桌面项目执行一次（内部自建桌面/手机两个上下文）');
    test.slow();

    await ensureModuleEnabled(request, credentials.moduleIds.navigation);
    const stamp = uniqueStamp();
    const pageName = `E2E 布局页 ${stamp}`;

    // 先用一个桌面上下文把「页面 + 一个真实组件」准备好（全部走界面）。
    const setupContext = await browser.newContext();
    const pageId = await (async (): Promise<string> => {
      try {
        const setupPage = await setupContext.newPage();
        await signIn(setupPage);
        await openWorkbench(setupPage);
        await createPageViaUi(setupPage, pageName);
        await addWidgetViaUi(setupPage, credentials.widgetIds.quickLinks);
        return (await listPages(request)).pages.find((candidate) => candidate.name === pageName)?.id ?? '';
      } finally {
        await closeContext(setupContext);
      }
    })();
    expect(pageId.length).toBeGreaterThan(0);

    const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    // 「手机上下文」显式使用移动设备形态（视口 / 触摸 / 移动 UA 语义），
    // 与 Playwright 的 mobile-chromium 项目等价；这样布局独立性可以在同一个用例里被两端同时验证。
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    try {
      const desktopPage = await desktopContext.newPage();
      const mobilePage = await mobileContext.newPage();
      await signIn(desktopPage);
      await signIn(mobilePage);

      const baseline = await readLayouts(request, pageId);
      const desktopBaseline = layoutFor(baseline, 'desktop');
      const mobileBaseline = layoutFor(baseline, 'mobile');
      expect(desktopBaseline, '桌面断点必须有布局行').toBeDefined();
      expect(mobileBaseline, '手机断点必须有布局行').toBeDefined();

      // 桌面端：编辑模式 → 桌面断点 → 移动组件 → 保存。
      await openWorkbench(desktopPage);
      await desktopPage.getByTestId('page-tab').filter({ hasText: pageName }).click();
      await expect(widgetCard(desktopPage, credentials.widgetIds.quickLinks)).toBeVisible();
      await desktopPage.getByTestId('edit-toggle').click();
      await desktopPage.locator('[data-testid="breakpoint-switch"][data-breakpoint="desktop"]').click();
      const desktopAction = await clickFirstEnabledMove(desktopPage, credentials.widgetIds.quickLinks);
      await expect(desktopPage.getByTestId('dirty-indicator')).toBeVisible();
      await desktopPage.getByTestId('save-layout').click();
      await expect(desktopPage.getByTestId('dirty-indicator')).toBeHidden();

      const afterDesktop = await readLayouts(request, pageId);
      const desktopAfter = layoutFor(afterDesktop, 'desktop');
      const mobileAfterDesktop = layoutFor(afterDesktop, 'mobile');
      expect(desktopAfter?.revision, `桌面保存(${desktopAction})必须推进桌面修订`).toBeGreaterThan(
        desktopBaseline?.revision ?? -1,
      );
      expect(desktopAfter?.rects).not.toEqual(desktopBaseline?.rects);
      expect(mobileAfterDesktop?.revision, '桌面保存不得碰手机断点的修订').toBe(mobileBaseline?.revision);
      expect(mobileAfterDesktop?.rects).toEqual(mobileBaseline?.rects);

      // 手机端：编辑模式 → 手机断点 → 移动组件 → 保存。
      await openWorkbench(mobilePage);
      await mobilePage.getByTestId('page-tab').filter({ hasText: pageName }).click();
      await expect(widgetCard(mobilePage, credentials.widgetIds.quickLinks)).toBeVisible();
      await mobilePage.getByTestId('edit-toggle').click();
      await mobilePage.locator('[data-testid="breakpoint-switch"][data-breakpoint="mobile"]').click();
      const mobileAction = await clickFirstEnabledMove(mobilePage, credentials.widgetIds.quickLinks);
      await expect(mobilePage.getByTestId('dirty-indicator')).toBeVisible();
      await mobilePage.getByTestId('save-layout').click();
      await expect(mobilePage.getByTestId('dirty-indicator')).toBeHidden();

      const afterMobile = await readLayouts(request, pageId);
      const mobileFinal = layoutFor(afterMobile, 'mobile');
      const desktopFinal = layoutFor(afterMobile, 'desktop');
      expect(mobileFinal?.revision, `手机保存(${mobileAction})必须推进手机修订`).toBeGreaterThan(
        mobileBaseline?.revision ?? -1,
      );
      expect(mobileFinal?.rects).not.toEqual(mobileBaseline?.rects);
      // 关键：手机保存**不**改变桌面端的修订与坐标（两端各自独立）。
      expect(desktopFinal?.revision, '手机保存不得碰桌面断点的修订').toBe(desktopAfter?.revision);
      expect(desktopFinal?.rects, '手机保存不得覆盖桌面坐标').toEqual(desktopAfter?.rects);
      expect(await desktopPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

      // 同一断点的**陈旧写**必须被 409 拒绝，且不改动已保存的布局。
      // 为什么走 HTTP：在界面里稳定触发「两个上下文同时保存同一断点」需要精确的时序，
      // 而验收口径明确允许退化为「用真实 HTTP 做同断点陈旧写 → 断言 409」。
      const staleRevision = Math.max(0, (desktopFinal?.revision ?? 1) - 1);
      const staleWrite = await request.put(`${credentials.baseUrl}/api/v1/me/pages/${pageId}/layout`, {
        headers: jsonHeaders,
        data: {
          breakpoint: 'desktop',
          baseRevision: staleRevision,
          rects: desktopFinal?.rects ?? [],
          operationId: crypto.randomUUID(),
        },
      });
      expect(staleWrite.status(), '陈旧 baseRevision 的布局写必须被拒绝').toBe(409);
      expect(((await staleWrite.json()) as { code: string }).code).toBe('conflict');
      // 用一次**全新的 GET** 复核（不读缓存值）：布局与修订都没被这次陈旧写改动。
      const afterStaleWrite = await readLayouts(request, pageId);
      expect(layoutFor(afterStaleWrite, 'desktop')?.revision).toBe(desktopFinal?.revision);
      expect(layoutFor(afterStaleWrite, 'desktop')?.rects).toEqual(desktopFinal?.rects);
      expect(layoutFor(afterStaleWrite, 'mobile')?.revision).toBe(mobileFinal?.revision);
    } finally {
      await closeContext(desktopContext);
      await closeContext(mobileContext);
    }
  });
});
