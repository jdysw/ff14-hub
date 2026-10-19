/**
 * 阶段 02 真实浏览器验收链（HUB-044 / HUB-050）。
 *
 * 它验证的是**真实浏览器里的真实联动**，不是组件单测的重复：
 *   匿名目录 → 设备鉴权（会话内存凭证）→ 启用模块 → 添加实例 → 多实例配置互不串扰
 *   → 异步错误隔离 → 停用降级 → 卸载清理实例 → 恢复后设置仍在 → 窄屏无溢出。
 *
 * 前置条件由 `scripts/e2e-phase02.mjs` 保证：
 *   - 本地 wrangler dev（本地 D1，全新持久目录）已就绪；
 *   - 工作空间已通过真实 HTTP 端点初始化，设备凭证写在 `tests/e2e/.credentials.json`（临时文件）。
 *
 * 该文件**不读取任何仓库 secret**，使用的凭证是本次运行随机生成的一次性测试凭证。
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface E2ECredentials {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly moduleIds: { readonly basics: string; readonly solo: string };
  readonly widgetIds: { readonly counter: string; readonly fault: string; readonly solo: string };
}

function loadCredentials(): E2ECredentials {
  const file = path.join(process.cwd(), 'tests/e2e/.credentials.json');
  return JSON.parse(readFileSync(file, 'utf8')) as E2ECredentials;
}

const credentials = loadCredentials();
const authHeaders = { Authorization: `Bearer ${credentials.token}` };

function moduleCard(page: Page, moduleId: string) {
  return page.locator(`[data-testid="module-card"][data-module-id="${moduleId}"]`);
}

/** 当前的横向溢出像素数（>1 视为窄屏溢出）。 */
async function horizontalOverflow(page: Page): Promise<number> {
  return await page.evaluate((): number => {
    const element = document.documentElement;
    return element.scrollWidth - element.clientWidth;
  });
}

/** 从文档起点开始按 Tab，直到聚焦的元素文本包含目标字样（纯键盘导航）。 */
async function tabUntilFocused(page: Page, includes: string, maxTries = 80): Promise<boolean> {
  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate((target): boolean => {
      const element = document.activeElement;
      if (!(element instanceof HTMLButtonElement)) return false;
      // 首页包含大量用户自定义网站：其它按钮的文字可能也包含“设置”。
      // 对系统设置入口严格定位，避免 Tab 误命中业务内容导致 Enter 未打开设置。
      if (target === '设置') return element.classList.contains('shell__settings');
      return (element.textContent ?? '').includes(target);
    }, includes);
    if (focused) return true;
  }
  return false;
}

/** 让模块进入「已启用」状态（跨项目复用时保证起点确定）。 */
async function ensureModuleEnabled(request: APIRequestContext, moduleId: string): Promise<void> {
  const response = await request.get(`${credentials.baseUrl}/api/v1/me/modules/${moduleId}`, {
    headers: authHeaders,
  });
  const body = (await response.json()) as {
    module: { status: string; revision: number };
  };
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

test.describe('阶段 02：模块状态驱动 Widget Host', () => {
  test('完整链路（桌面）：匿名目录 → 鉴权 → 启用 → 实例隔离 → 降级 → 卸载 → 恢复', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', '完整链路只在桌面项目执行一次（两个项目共用同一个服务）');

    await page.goto('/');
    expect(await tabUntilFocused(page, '设置'), '首页设置入口必须可用键盘到达').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'FF14 Hub' })).toBeVisible();

    // 1) 普通设置默认隐藏高级工具，先由玩家主动展开。
    await page.locator('details.settings-advanced > summary').click();
    // 匿名可以浏览公开目录，但私有状态不可读写。
    await page.getByRole('button', { name: /模块管理/ }).click();
    await expect(page.getByText(/尚未保存设备凭证/)).toBeVisible();
    const basics = moduleCard(page, credentials.moduleIds.basics);
    await expect(basics).toHaveAttribute('data-status', 'not_installed');
    await expect(basics).toContainText('演示计数（可多实例）');

    // 2) 模块未启用时不能添加实例（这就是「模块状态驱动 Host」的第一处证据）。
    await page.getByRole('button', { name: /组件验收/ }).click();
    await expect(page.getByTestId('widget-host')).toBeVisible();
    const counterPicker = page.locator(`[data-widget-id="${credentials.widgetIds.counter}"]`);
    await expect(counterPicker.getByRole('button', { name: '添加实例' })).toBeDisabled();
    await expect(counterPicker.getByRole('button', { name: '添加实例' })).toHaveAttribute('title', /模块未启用/);

    // 3) 纯键盘导航：重新加载以复位焦点，然后 Tab 到「会话凭证」并回车进入。
    await page.goto('/');
    expect(await tabUntilFocused(page, '设置'), '首页设置入口必须可用键盘到达').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: '系统级入口（不可移除）' })).toBeVisible();
    expect(await tabUntilFocused(page, '会话凭证'), '未能用 Tab 键聚焦到「会话凭证」入口').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('设备令牌（Bearer）')).toBeVisible();

    // 4) 保存会话凭证（仅内存）→ 自动进入模块管理并加载真实状态。
    await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);
    await page.getByRole('button', { name: '保存到会话内存' }).click();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'not_installed');

    // 5) 启用模块（真实 PATCH，带 expectedRevision）。
    await moduleCard(page, credentials.moduleIds.basics).getByRole('button', { name: '启用' }).click();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'enabled');
    await expect(page.getByText('模块已启用。').first()).toBeVisible();

    // 6) 组件验收：添加两个同类型实例。
    await page.getByRole('button', { name: /组件验收/ }).click();
    const counterRow = page.locator(`[data-widget-id="${credentials.widgetIds.counter}"]`);
    await counterRow.getByRole('button', { name: '添加实例' }).click();
    await counterRow.getByRole('button', { name: '添加实例' }).click();
    await expect(page.getByTestId('widget-instance')).toHaveCount(2);

    const first = page.getByTestId('widget-instance').nth(0);
    const second = page.getByTestId('widget-instance').nth(1);
    await expect(first).toHaveAttribute('data-phase', 'ready');
    await expect(second).toHaveAttribute('data-phase', 'ready');

    // 7) 键盘激活第一个实例的 +1 三次：焦点 + Enter，不用鼠标点击。
    await first.getByRole('button', { name: '+1' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(first.locator('output')).toHaveText('3');
    // 兄弟实例的计数与配置完全不受影响。
    await expect(second.locator('output')).toHaveText('0');

    // 8) 只改第二个实例的配置：步长变 3，第一个实例仍是 1。
    const secondConfig = page.locator('li.instance-config').nth(1);
    await secondConfig.getByRole('textbox').fill('{"step":3,"label":"乙实例","initDelayMs":0}');
    await secondConfig.getByRole('button', { name: '应用配置' }).click();
    await expect(second.getByRole('button', { name: '+3' })).toBeVisible();
    await expect(first.getByRole('button', { name: '+1' })).toBeVisible();
    await first.getByRole('button', { name: '+1' }).click();
    await expect(first.locator('output')).toHaveText('4');
    await expect(second.locator('output')).toHaveText('0');

    // 9) 再加一个「故意异步失败」的实例：异步错误被 Host 渲染成错误卡片，兄弟与 Shell 存活。
    await page.locator(`[data-widget-id="${credentials.widgetIds.fault}"]`).getByRole('button', { name: '添加实例' }).click();
    await expect(page.getByTestId('widget-instance')).toHaveCount(3);
    const faulty = page.getByTestId('widget-instance').nth(2);
    await page.locator('li.instance-config').nth(2).getByRole('textbox').fill('{"mode":"async-error","delayMs":0}');
    await page.locator('li.instance-config').nth(2).getByRole('button', { name: '应用配置' }).click();
    await expect(faulty).toHaveAttribute('data-phase', 'error');
    await expect(faulty.getByText('组件异步加载失败')).toBeVisible();
    await expect(first.locator('output')).toHaveText('4');
    await expect(page.getByRole('navigation', { name: '系统级入口（不可移除）' })).toBeVisible();

    // 10) 停用模块：实例保留但降级（组件不再执行）。
    await page.getByRole('button', { name: /模块管理/ }).click();
    await moduleCard(page, credentials.moduleIds.basics).getByRole('button', { name: '停用' }).click();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'disabled');
    await page.getByRole('button', { name: /组件验收/ }).click();
    await expect(page.getByTestId('widget-instance').nth(0)).toHaveAttribute('data-phase', 'blocked:module');
    await expect(page.getByText(/个人数据与模块状态不会因为实例降级而改变/).first()).toBeVisible();

    // 11) 卸载模块：当前 Host 的实例被清理，个人数据与设置保留。
    await page.getByRole('button', { name: /模块管理/ }).click();
    await moduleCard(page, credentials.moduleIds.basics).getByRole('button', { name: '卸载' }).click();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'uninstalled');
    await expect(page.getByText(/个人数据与设置保留/).first()).toBeVisible();
    await page.getByRole('button', { name: /组件验收/ }).click();
    await expect(page.getByTestId('widget-instance')).toHaveCount(0);
    await expect(page.getByText(/当前没有可见的组件实例/)).toBeVisible();

    // 12) 恢复：模块重新可用（设置沿用，卸载 ≠ 清数据）。
    await page.getByRole('button', { name: /模块管理/ }).click();
    await moduleCard(page, credentials.moduleIds.basics).getByRole('button', { name: '恢复' }).click();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'enabled');
    await expect(page.getByText(/沿用原有设置与个人数据/).first()).toBeVisible();

    // 13) 清数据入口被显式拒绝（不是静默删除）。
    await moduleCard(page, credentials.moduleIds.basics).getByRole('button', { name: /清数据/ }).click();
    await expect(page.getByText(/清数据被明确拒绝/).first()).toBeVisible();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'enabled');

    // 14) 桌面端同样不允许横向溢出。
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('窄屏与键盘：模块切换后实例表现正常，且不产生横向溢出', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', '窄屏用例只在移动项目执行');

    await ensureModuleEnabled(request, credentials.moduleIds.basics);

    await page.goto('/');
    expect(await tabUntilFocused(page, '设置'), '首页设置入口必须可用键盘到达').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: '系统级入口（不可移除）' })).toBeVisible();

    // 纯键盘进入凭证视图并保存凭证。
    expect(await tabUntilFocused(page, '会话凭证'), '窄屏下未能用 Tab 聚焦到「会话凭证」').toBe(true);
    await page.keyboard.press('Enter');
    await page.getByLabel('设备令牌（Bearer）').fill(credentials.token);
    await page.getByRole('button', { name: '保存到会话内存' }).click();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'enabled');

    // 添加实例并用键盘激活。
    await page.getByRole('button', { name: /组件验收/ }).click();
    await page
      .locator(`[data-widget-id="${credentials.widgetIds.counter}"]`)
      .getByRole('button', { name: '添加实例' })
      .click();
    const instance = page.getByTestId('widget-instance').first();
    await expect(instance).toHaveAttribute('data-phase', 'ready');
    await instance.getByRole('button', { name: '+1' }).focus();
    await page.keyboard.press('Enter');
    await expect(instance.locator('output')).toHaveText('1');

    // 窄屏不得横向溢出（组件卡片、JSON 编辑框、模块卡片都在此校验）。
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    // 展开模块设置编辑器后仍然不溢出（长 JSON 与长模块 ID 都要能换行或滚动）。
    await page.getByRole('button', { name: /模块管理/ }).click();
    await expect(moduleCard(page, credentials.moduleIds.basics)).toHaveAttribute('data-status', 'enabled');
    await page.getByText('模块设置（JSON）与版本').first().click();
    await expect(page.locator('textarea').first()).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});

