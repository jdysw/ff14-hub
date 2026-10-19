#!/usr/bin/env node
/**
 * 阶段 03 真实浏览器验收链的编排脚本（HUB-045 / HUB-046 / HUB-049 / HUB-054）。
 *
 * 与 `e2e-phase02.mjs` 同构，只改「需要准备什么」与「跑哪份用例」：
 *   1. 清空专用的本地 D1 持久目录（不碰默认的 .wrangler/state，也不碰任何远程资源）；
 *   2. 构建前端产物（Worker 通过 ASSETS 同域提供）；
 *   3. 对专用目录应用迁移（重复应用安全）；
 *   4. 启动 `wrangler dev --local`，用 `--var` 注入**本次随机生成**的一次性初始化密钥
 *      （不写 .dev.vars，因此绝不覆盖或读取用户本地的 secrets 文件）；
 *   5. 通过真实 HTTP 端点初始化单工作空间设备凭证，并**启用演示模块 `demo.basics`**
 *      （工作台只允许给处于 enabled 的模块新建实例）；
 *      刻意**不**启用 `demo.solo`：它被用作「模块未启用时写入应被拒绝并给出可读原因」的真实反例。
 *   6. 运行 `playwright test --config tests/e2e/playwright.config.ts`（阶段 03 用例）；
 *   7. 无论成败都关掉本地服务并删除凭证文件。
 *
 * 它**不**做：部署、创建远程 D1/Worker/域名、读取仓库 Secrets、注册 Cron。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['E2E_PORT'] ?? 8787);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;
/** 专用持久目录：与本地开发的默认目录隔离，随便删。 */
const PERSIST_DIR = '.wrangler/e2e-phase03-state';
const CREDENTIALS_FILE = path.join(root, 'tests/e2e/.credentials.json');

/** 演示模块与组件 ID（与 packages/shared/src/builtin-modules.ts 保持一致）。 */
const DEMO_BASICS_MODULE_ID = 'demo.basics';
const DEMO_SOLO_MODULE_ID = 'demo.solo';
const DEMO_COUNTER_WIDGET = 'demo-counter';
const DEMO_FAULT_WIDGET = 'demo-fault';
const DEMO_SOLO_WIDGET = 'demo-solo';

// 明显是「本次运行专用」的测试值：随机生成，长度满足服务端 32 字符下限，绝不入库。
const BOOTSTRAP_SECRET = `e2e-only-${randomBytes(32).toString('hex')}`;

function log(message) {
  console.log(`[e2e-phase03] ${message}`);
}

const childEnv = {
  ...process.env,
  CI: process.env['CI'] ?? 'true',
  WRANGLER_SEND_METRICS: 'false',
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
  const pid = child.pid;
  if (typeof pid !== 'number') return;
  if (process.platform === 'win32') {
    // Windows 下显式结束包装 shell 及其所有子进程。
    spawn('C:\\Windows\\System32\\taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // POSIX 下 npm/pnpm -> shell -> wrangler -> workerd 有多层进程。
  // 只向 shell PID 发 SIGTERM 会遗留监听端口的后代，导致同一 CI runner 后续阶段误连旧实例。
  // server 以独立进程组启动，此处停止整个组，而不是仅结束首层 shell。
  const signalGroup = (signal) => {
    try { process.kill(-pid, signal); }
    catch (error) {
      if (error?.code !== 'ESRCH') {
        console.error('[e2e] 停止测试服务进程组失败', error);
      }
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 3000).unref();
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
    body: JSON.stringify({ deviceName: 'Playwright 阶段03 验收设备' }),
  });
  if (response.status !== 201) {
    throw new Error(`初始化失败：status=${String(response.status)} body=${await response.text()}`);
  }
  return await response.json();
}

/**
 * 通过真实 HTTP 端点启用一个模块。
 * 第一次启用时允许 `expectedRevision: 0`（「从未装过」派生为 revision 0）。
 * 幂等：已经是 enabled 时服务端返回 no-op，不视为失败。
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

  log(`启动本地 wrangler dev（端口 ${String(PORT)}）`);
  const server = spawn(
    `pnpm exec wrangler dev --local --ip 127.0.0.1 --port ${String(PORT)} --persist-to ${PERSIST_DIR} --var BOOTSTRAP_SECRET:${BOOTSTRAP_SECRET}`,
    { cwd: root, stdio: 'inherit', shell: true, detached: process.platform !== 'win32', env: childEnv },
  );

  try {
    if (!(await waitForHealth(120_000))) {
      throw new Error('本地服务未能在限定时间内就绪');
    }

    log('通过真实 HTTP 端点初始化工作空间与设备凭证');
    const bootstrap = await bootstrapIdentity();
    const authorization = `Bearer ${bootstrap.deviceToken}`;

    log(`启用演示模块 ${DEMO_BASICS_MODULE_ID}（刻意不启用 ${DEMO_SOLO_MODULE_ID}）`);
    await enableModule(authorization, DEMO_BASICS_MODULE_ID);

    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
    await writeFile(
      CREDENTIALS_FILE,
      `${JSON.stringify(
        {
          baseUrl: BASE_URL,
          workspaceId: bootstrap.workspaceId,
          deviceId: bootstrap.device.id,
          token: bootstrap.deviceToken,
          moduleIds: { basics: DEMO_BASICS_MODULE_ID, solo: DEMO_SOLO_MODULE_ID },
          enabledModuleIds: [DEMO_BASICS_MODULE_ID],
          widgetIds: { counter: DEMO_COUNTER_WIDGET, fault: DEMO_FAULT_WIDGET, solo: DEMO_SOLO_WIDGET },
          templateIds: ['daily', 'fishing', 'raid', 'blank'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    log('运行 Playwright 阶段 03 验收链');
    // 只跑本阶段的用例文件：`tests/e2e/` 下同时存在两个阶段的 spec，
    // 而它们的前置条件不同（本脚本会预先启用 demo.basics，阶段 02 的用例却要从「未安装」开始）。
    const playwright = await run(
      'pnpm exec playwright test phase03-workbench.spec.ts --config tests/e2e/playwright.config.ts',
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
    // 保留测试产物目录，便于人工复核失败时的产物（当前配置不产出截图/轨迹）。
  }
}

main().catch((error) => {
  console.error(`[e2e-phase03] 编排失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
