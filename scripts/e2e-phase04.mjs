#!/usr/bin/env node
/**
 * 阶段 04 真实浏览器验收链的编排脚本（HUB-007~012 / 047 / 048 / 051）。
 *
 * 与 `e2e-phase03.mjs` 同构，只改「需要准备什么」与「跑哪份用例」：
 *   1. 清空专用的本地 D1 持久目录（不碰默认的 .wrangler/state，也不碰任何远程资源）；
 *   2. 构建前端产物（Worker 通过 ASSETS 同域提供）；
 *   3. 对专用目录应用迁移（重复应用安全）；
 *   4. 启动 `wrangler dev --local`，用 `--var` 注入**本次随机生成**的一次性初始化密钥
 *      （不写 .dev.vars，因此绝不覆盖或读取用户本地的 secrets 文件）；
 *   5. 通过真实 HTTP 端点初始化单工作空间设备凭证，并启用真实业务模块
 *      `ff14.navigation` 与 `ff14.events`（Widget 只允许给处于 enabled 的模块新建实例）；
 *      刻意**不**启用 `demo.basics`/`demo.solo`：阶段 04 用例不使用演示组件。
 *   6. 运行 `playwright test ... phase04-navigation.spec.ts`；
 *   7. 无论成败都关掉本地服务并删除凭证文件。
 *
 * 它**不**做：部署、创建远程 D1/Worker/域名、读取仓库 Secrets、注册 Cron、访问外网。
 * 端口默认 8788（与阶段 02/03 的 8787 分开），可用 E2E_PORT 覆盖。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['E2E_PORT'] ?? 8788);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;
/** 专用持久目录：与本地开发的默认目录隔离，随便删。 */
const FISHING = process.env['E2E_FISH'] === 'true';
const PERSIST_DIR = FISHING ? '.wrangler/e2e-phase05-state' : '.wrangler/e2e-phase04-state';
const CREDENTIALS_FILE = path.join(root, FISHING ? 'tests/e2e/.credentials.phase05.json' : 'tests/e2e/.credentials.phase04.json');

/** 真实业务模块与组件 ID（与 packages/shared 的 Manifest 常量保持一致）。 */
const NAV_MODULE_ID = 'ff14.navigation';
const EVENTS_MODULE_ID = 'ff14.events';
const NAV_QUICK_LINKS_WIDGET = 'nav-quick-links';
const NAV_SEARCH_WIDGET = 'nav-search';
const EVENTS_UPCOMING_WIDGET = 'events-upcoming';
const EVENTS_MANAGE_WIDGET = 'events-manage';

// 明显是「本次运行专用」的测试值：随机生成，长度满足服务端 32 字符下限，绝不入库。
const BOOTSTRAP_SECRET = `e2e-only-${randomBytes(32).toString('hex')}`;

function log(message) {
  console.log(`[e2e-phase04] ${message}`);
}

const childEnv = {
  ...process.env,
  CI: process.env['CI'] ?? 'true',
  WRANGLER_SEND_METRICS: 'false',
  // 传给 Playwright：本阶段的默认端口是 8788，而 playwright.config.ts 的默认 baseURL 是 8787，
  // 因此必须显式传入，否则页面会打到另一个（可能不存在的）服务上。
  E2E_BASE_URL: BASE_URL,
};

/** 执行一条 shell 命令（继承 stdio，便于在 CI 日志里看清每一步）。 */
function run(command) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: root, stdio: 'inherit', shell: true, env: childEnv });
    child.on('error', (error) => {
      resolve({ code: 1, error });
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 1 });
    });
  });
}

/** 结束整棵子进程树（Windows 下 shell 包装会挡住直接 kill）。 */
function killTree(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === 'win32') {
    // 用**绝对路径**调用系统工具：不通过 PATH 解析可执行文件。
    spawn('C:\\Windows\\System32\\taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    child.kill('SIGKILL');
  }, 3000).unref();
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/health`);
      if (response.ok) {
        return true;
      }
      lastError = `status=${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  log(`等待服务就绪超时（最后一次错误：${lastError}）`);
  return false;
}

async function bootstrapIdentity() {
  const response = await fetch(`${BASE_URL}/api/v1/identity/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bootstrap-Secret': BOOTSTRAP_SECRET },
    body: JSON.stringify({ deviceName: 'Playwright 阶段04 验收设备' }),
  });
  if (response.status !== 201) {
    throw new Error(`初始化失败：status=${String(response.status)} body=${await response.text()}`);
  }
  return await response.json();
}

/**
 * 通过真实 HTTP 端点启用一个模块。
 * 第一次启用时允许 `expectedRevision: 0`（「从未装过」派生为 revision 0）。
 */
async function enableModule(authorization, moduleId) {
  const response = await fetch(`${BASE_URL}/api/v1/me/modules/${encodeURIComponent(moduleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({ action: 'enable', expectedRevision: 0 }),
  });
  if (!response.ok) {
    throw new Error(`启用模块 ${moduleId} 失败：status=${String(response.status)} body=${await response.text()}`);
  }
}

/**
 * 为阶段 04 用例预置一条**真实**的个人链接与一个活动：
 * 用例本身也会通过界面创建数据，但多设备/同步场景需要一个已知起点。
 * 这里只用真实 HTTP 端点（不直接写库），因此预置过程本身也被端到端验证。
 */
async function seedPersonalData(authorization) {
  const linkResponse = await fetch(`${BASE_URL}/api/v1/me/navigation/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({
      operationId: `e2e-phase04-link-${randomBytes(8).toString('hex')}`,
      title: 'E2E 预置链接',
      url: 'https://example.com/e2e',
      description: '阶段 04 验收预置数据',
      tags: ['e2e'],
      region: 'cn',
    }),
  });
  if (linkResponse.status !== 201) {
    throw new Error(`预置链接失败：status=${String(linkResponse.status)} body=${await linkResponse.text()}`);
  }

  const eventResponse = await fetch(`${BASE_URL}/api/v1/me/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({
      operationId: `e2e-phase04-event-${randomBytes(8).toString('hex')}`,
      title: 'E2E 预置活动',
      region: 'cn',
      startsAt: Date.now() + 3_600_000,
      endsAt: Date.now() + 7_200_000,
      description: '阶段 04 验收预置数据',
    }),
  });
  if (eventResponse.status !== 201) {
    throw new Error(`预置活动失败：status=${String(eventResponse.status)} body=${await eventResponse.text()}`);
  }
}

async function main() {
  log('清理专用本地 D1 持久目录');
  await rm(path.join(root, PERSIST_DIR), { recursive: true, force: true });
  await rm(CREDENTIALS_FILE, { force: true });

  log('构建前端产物');
  const build = await run('pnpm run build:web');
  if (build.code !== 0) {
    throw new Error('前端构建失败');
  }

  log('应用本地 D1 迁移（专用目录）');
  const migrate = await run(`pnpm exec wrangler d1 migrations apply DB --local --persist-to ${PERSIST_DIR}`);
  if (migrate.code !== 0) {
    throw new Error('本地迁移失败');
  }
  if (FISHING) {
    for (const region of ['cn','global']) {
      const prepared = await run(`node --experimental-strip-types scripts/prepare-fish-import.mjs data/fish-demo-${region}.json .wrangler/e2e-fish-${region}.sql`);
      if (prepared.code !== 0) throw new Error('示例数据校验失败');
      const imported = await run(`pnpm exec wrangler d1 execute DB --local --persist-to ${PERSIST_DIR} --file .wrangler/e2e-fish-${region}.sql`);
      if (imported.code !== 0) throw new Error('示例数据导入失败');
    }
  }

  log(`启动本地 wrangler dev（端口 ${String(PORT)}）`);
  const server = spawn(
    `pnpm exec wrangler dev --local --ip 127.0.0.1 --port ${String(PORT)} --persist-to ${PERSIST_DIR} --var BOOTSTRAP_SECRET:${BOOTSTRAP_SECRET}`,
    { cwd: root, stdio: 'inherit', shell: true, env: childEnv },
  );

  try {
    if (!(await waitForHealth(120_000))) {
      throw new Error('本地服务未能在限定时间内就绪');
    }

    log('通过真实 HTTP 端点初始化工作空间与设备凭证');
    const bootstrap = await bootstrapIdentity();
    const authorization = `Bearer ${bootstrap.deviceToken}`;

    log(`启用真实业务模块 ${NAV_MODULE_ID} 与 ${EVENTS_MODULE_ID}`);
    await enableModule(authorization, NAV_MODULE_ID);
    await enableModule(authorization, EVENTS_MODULE_ID);
    if (FISHING) await enableModule(authorization, 'ff14.fishing');

    log('通过真实 HTTP 端点预置个人链接与个人活动');
    await seedPersonalData(authorization);

    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
    await writeFile(
      CREDENTIALS_FILE,
      `${JSON.stringify(
        {
          baseUrl: BASE_URL,
          workspaceId: bootstrap.workspaceId,
          deviceId: bootstrap.device.id,
          token: bootstrap.deviceToken,
          moduleIds: { navigation: NAV_MODULE_ID, events: EVENTS_MODULE_ID },
          enabledModuleIds: [NAV_MODULE_ID, EVENTS_MODULE_ID],
          widgetIds: {
            quickLinks: NAV_QUICK_LINKS_WIDGET,
            navSearch: NAV_SEARCH_WIDGET,
            eventsUpcoming: EVENTS_UPCOMING_WIDGET,
            eventsManage: EVENTS_MANAGE_WIDGET,
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    log('运行 Playwright 阶段 04 验收链');
    const playwright = await run(
      FISHING ? 'pnpm exec playwright test phase05-fishing.spec.ts --config tests/e2e/playwright.config.ts' : 'pnpm exec playwright test phase04-navigation.spec.ts --config tests/e2e/playwright.config.ts',
    );
    if (playwright.code !== 0) {
      log(`验收链失败（退出码 ${String(playwright.code)}）`);
      process.exitCode = playwright.code;
      return;
    }
    log('验收链全部通过');
    process.exitCode = 0;
  } finally {
    log('关闭本地服务并删除临时凭证文件');
    killTree(server);
    await rm(CREDENTIALS_FILE, { force: true });
  }
}

main().catch((error) => {
  console.error(`[e2e-phase04] 编排失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
