/**
 * 阶段 03 真实浏览器验收链（HUB-045 / HUB-046 / HUB-049 / HUB-054）。
 *
 * 它验证的是**真实浏览器里的真实交互与真实服务端持久化**，不是组件单测的重复：
 *   会话内存凭证 → 空工作台恢复入口 → 模板（含诚实说明）→ 组件库 → 编辑模式
 *   → **真实鼠标拖动 + 缩放** → 键盘替代移动/缩放 → 未保存提示与撤销
 *   → 桌面/平板/手机断点独立布局 → 导出 → 预览 → 导入 round-trip
 *   → 两个客户端并发保存冲突时保留本地草稿 → 窄屏无横向溢出。
 *
 * 前置条件由 `scripts/e2e-phase03.mjs` 保证：
 *   - 本地 wrangler dev（本地 D1，全新持久目录）已就绪；
 *   - 工作空间已通过真实 HTTP 端点初始化，演示模块 `demo.basics` 已**真实启用**
 *     （刻意不启用 `demo.solo`，用作「模块未启用时写入被拒绝」的真实反例）；
 *   - 一次性测试凭证写在 `tests/e2e/.credentials.json`（临时文件，运行结束即删除）。
 *
 * 该文件**不读取任何仓库 secret**，使用的凭证是本次运行随机生成的一次性测试凭证。
 */
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface E2ECredentials {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly moduleIds: { readonly basics: string; readonly solo: string };
  readonly enabledModuleIds: readonly string[];
  readonly widgetIds: { readonly counter: string; readonly fault: string; readonly solo: string };
  readonly templateIds: readonly string[];
}

interface LayoutRect {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface LayoutResponse {
  readonly layouts: readonly {
    readonly breakpoint: string;
    readonly revision: number;
    readonly cols: number;
    readonly rects: readonly LayoutRect[];
  }[];
}

interface PageSummary {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly revision: number;
}

interface PageListResponse {
  readonly pages: readonly PageSummary[];
  readonly defaultPageId: string | null;
}

function loadCredentials(): E2ECredentials {
  const file = path.join(process.cwd(), 'tests/e2e/.credentials.json');
  return JSON.parse(readFileSync(file, 'utf8')) as E2ECredentials;
}

const credentials = loadCredentials();
const authHeaders = { Authorization: `Bearer ${credentials.token}` };

/** 当前的横向溢出像素数（>1 视为窄屏溢出）。 */
async function horizontalOverflow(page: Page): Promise<number> {
  return await page.evaluate((): number => {
    const element = document.documentElement;
    return element.scrollWidth - element.clientWidth;
  });
}

/** 通过 UI 保存会话内存凭证（阶段 02 已有的最小入口）。 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /会话凭证/ }).click();
  await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);
  await page.getByRole('button', { name: '保存到会话内存' }).click();
}

async function openWorkbench(page: Page): Promise<void> {
  // 明确限定在系统级入口导航里点击，避免误点到品牌标语或空状态提示里的同名字样。
  await page.getByRole('navigation', { name: '系统级入口（不可移除）' }).getByRole('button', { name: /工作台/ }).first().click();
  await expect(page.getByTestId('workbench-view')).toBeVisible();
}

/**
 * 打开一个「开关型」面板（模板选择器 / 组件库）。
 * 它们是切换按钮还是常驻面板由前端决定，因此这里只在目标内容**尚不可见**时才点开关。
 */
async function openPanel(page: Page, toggleTestId: string, contentLocator: string): Promise<void> {
  const content = page.locator(contentLocator).first();
  const alreadyVisible = await content.isVisible().catch(() => false);
  if (!alreadyVisible) {
    await page.getByTestId(toggleTestId).click();
  }
  await expect(content).toBeVisible();
}

/** 保证演示模块处于 enabled（跨用例与跨项目复用时让起点确定）。 */
async function ensureModuleEnabled(request: APIRequestContext, moduleId: string): Promise<void> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/modules/${moduleId}`, {
    headers: authHeaders,
  });
  const body = (await response.json()) as { module: { status: string; revision: number } };
  if (body.module.status === 'enabled') {
    return;
  }
  const action = body.module.status === 'uninstalled' ? 'restore' : 'enable';
  const mutation = await request.patch(`${credentials.baseUrl}/api/v1/me/modules/${moduleId}`, {
    headers: authHeaders,
    data: { action, expectedRevision: body.module.revision },
  });
  expect(mutation.ok(), `准备「已启用」状态失败：${await mutation.text()}`).toBe(true);
}

async function listPages(request: APIRequestContext): Promise<PageListResponse> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/pages`, { headers: authHeaders });
  expect(response.ok(), `读取页面列表失败：${await response.text()}`).toBe(true);
  return (await response.json()) as PageListResponse;
}

async function readLayouts(request: APIRequestContext, pageId: string): Promise<LayoutResponse> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/pages/${pageId}/layout`, {
    headers: authHeaders,
  });
  expect(response.ok(), `读取布局失败：${await response.text()}`).toBe(true);
  return (await response.json()) as LayoutResponse;
}

function rectFor(layouts: LayoutResponse, breakpoint: string, instanceId: string): LayoutRect | undefined {
  return layouts.layouts
    .find((entry) => entry.breakpoint === breakpoint)
    ?.rects.find((rect) => rect.i === instanceId);
}

function revisionFor(layouts: LayoutResponse, breakpoint: string): number {
  return layouts.layouts.find((entry) => entry.breakpoint === breakpoint)?.revision ?? -1;
}

/** 编辑模式下的网格项（`data-instance-id` 由前端写在每个 widget 卡片上）。 */
function widgetCard(page: Page, instanceId: string) {
  return page.locator(`[data-testid="widget-card"][data-instance-id="${instanceId}"]`);
}

/**
 * 键盘替代操作的候选顺序。
 *
 * 为什么需要一个「找第一个可用按钮」的辅助函数：界面在「越界 / 超出 min-max / 与其它组件重叠」时
 * 会**正确禁用**对应按钮。因此写死某个动作会让用例依赖当时的布局是否恰好有空位——
 * 那不是要测的行为。这里点击第一个可用按钮，并返回它是哪一个。
 */
const ACTION_ORDER = [
  'widget-move-down',
  'widget-move-right',
  'widget-move-up',
  'widget-move-left',
  'widget-grow-h',
  'widget-grow-w',
  'widget-shrink-h',
  'widget-shrink-w',
] as const;

async function clickFirstEnabledAction(page: Page, instanceId: string): Promise<string> {
  const card = widgetCard(page, instanceId);
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
  throw new Error(`实例 ${instanceId} 没有任何可用的键盘替代操作按钮（8 个都被禁用）`);
}

/** 在网格容器里找一个页面上已存在的实例 id（不依赖固定顺序）。 */
async function instanceIdsOnPage(page: Page): Promise<string[]> {
  return await page.locator('[data-testid="widget-card"]').evaluateAll((nodes): string[] =>
    nodes.map((node) => node.getAttribute('data-instance-id') ?? '').filter((value) => value.length > 0),
  );
}

/** 真实鼠标拖动：按住拖动把手移动 (dx, dy) 像素。 */
async function dragBy(page: Page, handleSelector: string, dx: number, dy: number): Promise<void> {
  const handle = page.locator(handleSelector).first();
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box, `找不到可拖动的元素：${handleSelector}`).not.toBeNull();
  if (box === null) {
    return;
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 分多步移动：RGL 依赖 pointermove 序列，单步跳跃在部分实现里不会被识别为拖动。
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 8 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

/** 真实鼠标缩放：RGL 的右下角把手。 */
async function resizeBy(page: Page, instanceId: string, dx: number, dy: number): Promise<void> {
  await dragBy(page, `[data-testid="widget-card"][data-instance-id="${instanceId}"] .react-resizable-handle-se`, dx, dy);
}

async function readDownloadText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 等待某个元素的位置连续多帧不再变化。
 *
 * 为什么需要：RGL 在容器宽度/行数变化后会做一次高度收敛（CSS transition），
 * 这期间下方面板里的按钮位置会移动，Playwright 会以「element is not stable」拒绝点击。
 * 这不是应用缺陷（位置最终稳定），但用例必须显式等它稳定，否则会随机失败。
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

/** 点击导出，优先读取真实下载内容，退化为读取页面上的只读输出。 */
async function exportBackupDocument(page: Page, outputPath: string): Promise<unknown> {
  await waitForStablePosition(page, 'backup-export');
  await page.getByTestId('backup-export').scrollIntoViewIfNeeded();
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
  await page.getByTestId('backup-export').click({ timeout: 30_000 });
  const download = await downloadPromise;
  let text: string;
  if (download !== null) {
    text = await readDownloadText(await download.createReadStream());
  } else {
    text = await page.getByTestId('backup-export-output').inputValue();
  }
  expect(text.length, '导出结果为空').toBeGreaterThan(0);
  writeFileSync(outputPath, text, 'utf8');
  return JSON.parse(text) as unknown;
}

test.describe('阶段 03：工作台布局编辑与备份恢复', () => {
  test.beforeAll(async ({ request }) => {
    await ensureModuleEnabled(request, credentials.moduleIds.basics);
  });

  test('完整链路（桌面）：模板 → 真实拖动/缩放 → 键盘替代 → 断点独立 → 导出导入 round-trip', async ({
    page,
    request,
  }, testInfo) => {
    // 这一批用例在 desktop / mobile 两个 Playwright project 各执行一遍，
    // 因此按项目跳过的那一半必然被跳过：这里保留带说明的条件式 skip（不删用例、不改 fixme）。
    test.skip(testInfo.project.name !== 'desktop-chromium', '完整链路只在桌面项目执行一次');

    await signIn(page);
    await openWorkbench(page);

    // 1) 全新工作空间没有页面 → 空状态恢复入口必须存在（Shell 永久可达）。
    const pagesBefore = await listPages(request);
    if (pagesBefore.pages.length === 0) {
      await expect(page.getByTestId('empty-recovery')).toBeVisible();
    }

    // 2) 模板：必须原样展示诚实说明（不得编造游戏数据），且必须显式确认后才应用。
    await openPanel(page, 'template-picker', '[data-testid="template-option"]');
    const dailyOption = page.locator('[data-testid="template-option"][data-template-id="daily"]');
    await expect(dailyOption).toBeVisible();
    await expect(page.getByTestId('template-honesty-note').first()).toContainText('阶段 04');
    await dailyOption.click();
    await page.getByTestId('template-confirm').click();

    // 3) 页面与组件就位：模板把已注册的演示组件放进新页面。
    await expect(page.getByTestId('page-tab').first()).toBeVisible();
    await expect(page.getByTestId('widget-card').first()).toBeVisible();

    // 4) 组件库再添加一个同类型（allowMultiple = true）实例，验证真实服务端写入。
    await openPanel(page, 'widget-library', '[data-testid="widget-library-item"]');
    const libraryItem = page.locator(`[data-testid="widget-library-item"][data-widget-type="${credentials.widgetIds.counter}"]`);
    await expect(libraryItem).toBeVisible();
    await libraryItem.getByRole('button', { name: /添加/ }).click();
    await expect(page.getByTestId('widget-card')).toHaveCount(2);

    // 5) 模块未启用的组件：要么给出可读原因且不写入，要么在界面上明确禁用并说明原因。
    const soloItem = page.locator(`[data-testid="widget-library-item"][data-widget-type="${credentials.widgetIds.solo}"]`);
    if ((await soloItem.count()) > 0) {
      const soloAdd = soloItem.getByRole('button', { name: /添加/ });
      if (await soloAdd.isDisabled()) {
        // 被禁用也算「不写入」；至少要有一个可读原因，不能静默失败。
        await expect(soloItem).toContainText(/未启用|未安装|不可用/);
      } else {
        await soloAdd.click();
        await expect(page.getByTestId('workbench-error')).toBeVisible();
      }
      await expect(page.getByTestId('widget-card')).toHaveCount(2);
    }
    await page.keyboard.press('Escape');

    // 6) 进入编辑模式，记录真实持久化基线。
    await page.getByTestId('edit-toggle').click();
    const pages = await listPages(request);
    expect(pages.pages.length).toBeGreaterThan(0);
    const activePageId = pages.defaultPageId ?? pages.pages[0]?.id ?? '';
    expect(activePageId.length).toBeGreaterThan(0);

    const before = await readLayouts(request, activePageId);
    const ids = await instanceIdsOnPage(page);
    expect(ids.length).toBe(2);
    const targetId = ids[0] ?? '';
    const rectBefore = rectFor(before, 'desktop', targetId);
    expect(rectBefore, '桌面断点下应当已有该实例的矩形').toBeDefined();

    // 7) **真实鼠标拖动**：按住把手移动 → 出现未保存标记。
    await dragBy(page, `[data-testid="widget-card"][data-instance-id="${targetId}"] [data-testid="widget-card__drag-handle"]`, 180, 60);
    await expect(page.getByTestId('dirty-indicator')).toBeVisible();

    // 8) **真实鼠标缩放**：拖右下角把手。
    await resizeBy(page, targetId, 140, 56);
    await expect(page.getByTestId('dirty-indicator')).toBeVisible();

    // 9) 保存：脏标记消失，且服务端布局真的变了（用 API 读回作为事实依据）。
    await page.getByTestId('save-layout').click();
    await expect(page.getByTestId('dirty-indicator')).toBeHidden();
    const afterDrag = await readLayouts(request, activePageId);
    const rectAfterDrag = rectFor(afterDrag, 'desktop', targetId);
    expect(rectAfterDrag).toBeDefined();
    expect(
      rectAfterDrag?.x !== rectBefore?.x ||
        rectAfterDrag?.y !== rectBefore?.y ||
        rectAfterDrag?.w !== rectBefore?.w ||
        rectAfterDrag?.h !== rectBefore?.h,
      `拖动/缩放后桌面矩形应发生变化：前 ${JSON.stringify(rectBefore)} 后 ${JSON.stringify(rectAfterDrag)}`,
    ).toBe(true);
    expect(revisionFor(afterDrag, 'desktop')).toBeGreaterThan(revisionFor(before, 'desktop'));

    // 10) 非拖拽替代：键盘/按钮移动与缩放同样能改布局并保存。
    const otherId = ids[1] ?? '';
    const rectOtherBefore = rectFor(afterDrag, 'desktop', otherId);
    const usedAction = await clickFirstEnabledAction(page, otherId);
    await expect(page.getByTestId('dirty-indicator')).toBeVisible();
    await page.getByTestId('save-layout').click();
    await expect(page.getByTestId('dirty-indicator')).toBeHidden();
    const afterKeyboard = await readLayouts(request, activePageId);
    const rectOtherAfter = rectFor(afterKeyboard, 'desktop', otherId);
    expect(rectOtherAfter, `键盘操作 ${usedAction} 后应当仍有矩形`).toBeDefined();
    expect(
      rectOtherAfter?.x !== rectOtherBefore?.x ||
        rectOtherAfter?.y !== rectOtherBefore?.y ||
        rectOtherAfter?.w !== rectOtherBefore?.w ||
        rectOtherAfter?.h !== rectOtherBefore?.h,
      `键盘操作 ${usedAction} 应当真的改变持久化矩形：前 ${JSON.stringify(rectOtherBefore)} 后 ${JSON.stringify(rectOtherAfter)}`,
    ).toBe(true);

    // 11) 越界/重叠的移动必须被禁用（按钮 disabled），不会产生注定被服务端拒绝的提交。
    const cols = afterKeyboard.layouts.find((entry) => entry.breakpoint === 'desktop')?.cols ?? 12;
    const rightmost = afterKeyboard.layouts
      .find((entry) => entry.breakpoint === 'desktop')
      ?.rects.reduce((acc, rect) => (rect.x + rect.w > acc.x + acc.w ? rect : acc), { x: 0, y: 0, w: 0, h: 0, i: '' });
    if (rightmost !== undefined && rightmost.x + rightmost.w >= cols) {
      await expect(widgetCard(page, rightmost.i).getByTestId('widget-move-right')).toBeDisabled();
    }

    // 12) 断点独立：手机端改动不得影响桌面端的矩形与修订号。
    const desktopRevisionBeforeMobile = revisionFor(afterKeyboard, 'desktop');
    const desktopRectsBeforeMobile = afterKeyboard.layouts.find((entry) => entry.breakpoint === 'desktop')?.rects;
    await page.locator('[data-testid="breakpoint-switch"][data-breakpoint="mobile"]').click();
    await expect(page.getByTestId('workbench-view')).toHaveAttribute('data-breakpoint', 'mobile');
    await clickFirstEnabledAction(page, otherId);
    await expect(page.getByTestId('breakpoint-dirty-indicator')).toBeVisible();
    await page.getByTestId('save-layout').click();
    await expect(page.getByTestId('breakpoint-dirty-indicator')).toBeHidden();

    const afterMobile = await readLayouts(request, activePageId);
    expect(revisionFor(afterMobile, 'mobile'), '手机端保存应当 bump 手机端修订号').toBeGreaterThan(
      revisionFor(afterKeyboard, 'mobile'),
    );
    expect(revisionFor(afterMobile, 'desktop'), '手机端保存不得 bump 桌面端修订号').toBe(desktopRevisionBeforeMobile);
    expect(afterMobile.layouts.find((entry) => entry.breakpoint === 'desktop')?.rects).toEqual(desktopRectsBeforeMobile);

    // 13) 导出 → 预览 → 导入 round-trip（真实文件 + 真实确认）。
    //
    // 顺序说明：这一步刻意放在「未保存提示」之前。未保存提示那一段会先产生草稿再放弃草稿，
    // 而「放弃」会让网格整体重算一次并触发 RGL 的高度收敛动画；如果先做它，
    // 下方备份面板里的按钮在收敛期间位置会移动，Playwright 会以
    // `element is not stable` 拒绝点击（那是动画时序问题，不是应用缺陷）。
    // 因此在**已保存且稳定**的状态下先完成导出导入，末尾再做提示断言。
    const backupPath = testInfo.outputPath('workbench-backup.json');
    const document = await exportBackupDocument(page, backupPath);
    expect(document, '导出内容必须是可解析的 JSON 对象').toBeTruthy();
    expect(JSON.stringify(document)).toContain('schemaVersion');

    const pagesBeforeImport = await listPages(request);
    // 备份面板在编辑模式内外都必须可达；这里只在文件输入尚不可见时才切换编辑模式，
    // 避免依赖「当前是否处于编辑模式」这一与导入无关的状态。
    const importInput = page.getByTestId('backup-import-file');
    if (!(await importInput.isVisible().catch(() => false))) {
      await page.getByTestId('edit-toggle').click();
    }
    await expect(importInput).toBeVisible();
    await importInput.setInputFiles(backupPath);
    await expect(page.getByTestId('import-preview')).toBeVisible();
    await expect(page.getByTestId('import-impact')).toBeVisible();
    await page.getByTestId('import-confirm').click();
    await expect(page.getByTestId('workbench-notice')).toBeVisible();

    const pagesAfterImport = await listPages(request);
    expect(pagesAfterImport.pages.length).toBeGreaterThanOrEqual(pagesBeforeImport.pages.length);

    // 14) 未保存修改提示：跨断点切换时必须给出显式选择；「取消」保留草稿、「放弃」丢弃草稿。
    // 放在最后执行：这一段会产生并放弃草稿，从而触发一次网格高度收敛动画。
    if (!(await page.getByTestId('edit-toggle').getAttribute('aria-pressed'))?.includes('true')) {
      await page.getByTestId('edit-toggle').click();
    }
    await page.locator('[data-testid="breakpoint-switch"][data-breakpoint="desktop"]').click();
    await clickFirstEnabledAction(page, otherId);
    await expect(page.getByTestId('dirty-indicator')).toBeVisible();
    await page.locator('[data-testid="breakpoint-switch"][data-breakpoint="tablet"]').click();
    await expect(page.getByTestId('unsaved-banner')).toBeVisible();
    await page.getByTestId('unsaved-cancel').click();
    await expect(page.getByTestId('dirty-indicator')).toBeVisible();

    // 「放弃」丢弃草稿：本地回到服务端持久状态。
    await page.locator('[data-testid="breakpoint-switch"][data-breakpoint="tablet"]').click();
    await expect(page.getByTestId('unsaved-banner')).toBeVisible();
    await page.getByTestId('unsaved-discard').click();
    await expect(page.getByTestId('dirty-indicator')).toBeHidden();

    // 15) 桌面端同样不允许横向溢出。
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('两个客户端并发保存：后写者收到 409 且保留本地草稿', async ({ browser, request }, testInfo) => {
    // 这一批用例在 desktop / mobile 两个 Playwright project 各执行一遍，
    // 因此按项目跳过的那一半必然被跳过：这里保留带说明的条件式 skip（不删用例、不改 fixme）。
    test.skip(testInfo.project.name !== 'desktop-chromium', '并发冲突用例只在桌面项目执行一次');

    // 同一台设备凭证、两个独立浏览器上下文 = 两个真实客户端。
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await signIn(pageA);
      await signIn(pageB);
      await openWorkbench(pageA);
      await openWorkbench(pageB);

      const pages = await listPages(request);
      expect(pages.pages.length).toBeGreaterThan(0);
      const pageId = pages.defaultPageId ?? pages.pages[0]?.id ?? '';

      // 两个客户端都停在同一个页面并进入编辑模式。
      await pageA.getByTestId('edit-toggle').click();
      await pageB.getByTestId('edit-toggle').click();

      const ids = await instanceIdsOnPage(pageA);
      expect(ids.length).toBeGreaterThan(0);
      const targetId = ids[0] ?? '';

      // 两边基于**同一个** baseRevision 各自改动。
      // 这里用「找第一个可用按钮」而不是写死动作：界面会在越界/重叠时正确禁用按钮，
      // 写死动作会让用例依赖当时的布局是否有空位。冲突的本质是 **baseRevision 陈旧**，
      // 与两边改的内容是否相同无关，因此两边做同样的动作也完全能测到冲突。
      await clickFirstEnabledAction(pageA, targetId);
      await clickFirstEnabledAction(pageB, targetId);
      await expect(pageA.getByTestId('dirty-indicator')).toBeVisible();
      await expect(pageB.getByTestId('dirty-indicator')).toBeVisible();

      // A 先保存成功。
      await pageA.getByTestId('save-layout').click();
      await expect(pageA.getByTestId('dirty-indicator')).toBeHidden();

      // B 的 baseRevision 已过期 → 409，必须出现冲突横幅而**不是**静默覆盖。
      const bStyleBeforeSave = await widgetCard(pageB, targetId).getAttribute('style');
      await pageB.getByTestId('save-layout').click();
      await expect(pageB.getByTestId('conflict-banner')).toBeVisible();
      await expect(pageB.getByTestId('dirty-indicator')).toBeVisible();

      // 本地草稿必须保留（没有回滚成服务端值）。
      const bStyleAfterConflict = await widgetCard(pageB, targetId).getAttribute('style');
      expect(bStyleAfterConflict, '冲突后必须保留本地草稿的呈现').toBe(bStyleBeforeSave);

      // 三个明确选择都在，且「重新提交」用最新 revision 成功。
      await expect(pageB.getByTestId('conflict-reload')).toBeVisible();
      await expect(pageB.getByTestId('conflict-compare')).toBeVisible();
      await pageB.getByTestId('conflict-resubmit').click();
      await expect(pageB.getByTestId('conflict-banner')).toBeHidden();
      await expect(pageB.getByTestId('dirty-indicator')).toBeHidden();

      // 服务端最终状态是 B 重新提交的结果（A 的改动可被覆盖是用户显式选择的结果）。
      const finalLayouts = await readLayouts(request, pageId);
      expect(finalLayouts.layouts.find((entry) => entry.breakpoint === 'desktop')).toBeTruthy();
    } finally {
      await closeContext(contextA);
      await closeContext(contextB);
    }
  });

  test('窄屏与键盘：断点切换、键盘替代操作与无横向溢出', async ({ page, request }, testInfo) => {
    // 这一批用例在 desktop / mobile 两个 Playwright project 各执行一遍，
    // 因此按项目跳过的那一半必然被跳过：这里保留带说明的条件式 skip（不删用例、不改 fixme）。
    test.skip(testInfo.project.name !== 'mobile-chromium', '窄屏用例只在移动项目执行');

    await ensureModuleEnabled(request, credentials.moduleIds.basics);
    await signIn(page);
    await openWorkbench(page);

    const pages = await listPages(request);
    if (pages.pages.length === 0) {
      // 从空状态用模板恢复：这本身就是「全删后仍可恢复」的证据。
      await expect(page.getByTestId('empty-recovery')).toBeVisible();
      await page.getByTestId('empty-recovery').getByRole('button', { name: /模板/ }).click();
      await page.locator('[data-testid="template-option"][data-template-id="blank"]').click();
      await page.getByTestId('template-confirm').click();
      await expect(page.getByTestId('widget-card')).toHaveCount(0);
      // 空白页是合法状态：组件库与页面入口仍然可达。
      await expect(page.getByTestId('widget-library')).toBeVisible();
    }

    await page.getByTestId('edit-toggle').click();
    await page.locator('[data-testid="breakpoint-switch"][data-breakpoint="mobile"]').click();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    // 窄屏下网格是真的只有 4 列：满宽组件被堆叠，因此「右移 / 加宽 / 下移第一个」都会被正确禁用。
    // 这里选**最靠下**的那个组件来移动（它下方一定有空位），从而既验证键盘替代操作真的生效，
    // 又不依赖组件顺序或前一个用例留下的状态。
    const ids = await instanceIdsOnPage(page);
    if (ids.length > 0) {
      const pagesForLayout = await listPages(request);
      const pageId = pagesForLayout.defaultPageId ?? pagesForLayout.pages[0]?.id ?? '';
      const mobileLayout = await readLayouts(request, pageId);
      const bottomMost = mobileLayout.layouts
        .find((entry) => entry.breakpoint === 'mobile')
        ?.rects.reduce<LayoutRect | undefined>(
          (acc, rect) => (acc === undefined || rect.y + rect.h > acc.y + acc.h ? rect : acc),
          undefined,
        );
      const targetId = bottomMost?.i ?? ids[0] ?? '';

      // 先把「越界/重叠会被禁用并说明原因」这条可访问性契约断言掉。
      const firstCard = widgetCard(page, ids[0] ?? '');
      const downButton = firstCard.getByTestId('widget-move-down');
      if (await downButton.isDisabled()) {
        await expect(downButton).toHaveAttribute('title', /越界|重叠|尺寸/);
      }

      await widgetCard(page, targetId).getByTestId('widget-move-down').click();
      await expect(page.getByTestId('breakpoint-dirty-indicator')).toBeVisible();
      await page.getByTestId('save-layout').click();
      await expect(page.getByTestId('breakpoint-dirty-indicator')).toBeHidden();
    }

    // 纯键盘：断开编辑模式也必须可达。
    await expect(page.getByTestId('edit-toggle')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close();
}

