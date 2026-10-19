#!/usr/bin/env node
/**
 * 阶段 02 真实浏览器验收链的编排脚本（HUB-044 / HUB-050）。
 *
 * 它做的每一件事都是为了让验收**可重复**且**只动本地**：
 *   1. 清空专用的本地 D1 持久目录（不碰默认的 .wrangler/state，也不碰任何远程资源）；
 *   2. 构建前端产物（Worker 通过 ASSETS 同域提供）；
 *   3. 对专用目录应用迁移（重复应用安全）；
 *   4. 启动 `wrangler dev --local`，用 `--var` 注入**本次随机生成**的一次性初始化密钥
 *      （不写 .dev.vars，因此绝不覆盖或读取用户本地的 secrets 文件，也不产生任何真实秘密）；
 *   5. 通过真实 HTTP 端点初始化单工作空间设备并拿到设备凭证，写入
 *      `tests/e2e/.credentials.json`（该文件在 .gitignore 中，仅用于本次运行，结束即删除）；
 *   6. 运行 `playwright test`；
 *   7. 无论成败都关掉本地服务并删除凭证文件。
 *
 * 它**不**做：部署、创建远程 D1/Worker/域名、读取仓库 Secrets、注册 Cron。
 */
import { spawn } from 'node:child_process';
import { stopE2EServer } from './e2e-process.mjs';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['E2E_PORT'] ?? 8787);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;
/** 专用持久目录：与本地开发的默认目录隔离，随便删。 */
const PERSIST_DIR = '.wrangler/e2e-state';
const CREDENTIALS_FILE = path.join(root, 'tests/e2e/.credentials.json');

// 明显是「本次运行专用」的测试值：随机生成，长度满足服务端 32 字符下限，绝不入库。
const BOOTSTRAP_SECRET = `e2e-only-${randomBytes(32).toString('hex')}`;

function log(message) {
  console.log(`[e2e-phase02] ${message}`);
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
    body: JSON.stringify({ deviceName: 'Playwright 验收设备' }),
  });
  if (response.status !== 201) {
    throw new Error(`初始化失败：status=${String(response.status)} body=${await response.text()}`);
  }
  return await response.json();
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

    await mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
    await writeFile(
      CREDENTIALS_FILE,
      `${JSON.stringify(
        {
          baseUrl: BASE_URL,
          workspaceId: bootstrap.workspaceId,
          deviceId: bootstrap.device.id,
          token: bootstrap.deviceToken,
          moduleIds: { basics: 'demo.basics', solo: 'demo.solo' },
          widgetIds: { counter: 'demo-counter', fault: 'demo-fault', solo: 'demo-solo' },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    log('运行 Playwright 验收链');
    // 显式指定本阶段的用例文件：`playwright.config.ts` 的 testMatch 会匹配 `tests/e2e/` 下所有
    // `*.spec.ts`，而两个阶段的服务准备条件不同（阶段 03 会预先启用演示模块，
    // 阶段 02 的用例恰恰要从「未安装」开始断言）。不做限定就会互相破坏前提。
    const playwright = await run(
      'pnpm exec playwright test phase02-modules.spec.ts --config tests/e2e/playwright.config.ts',
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
    stopE2EServer(server);
    await rm(CREDENTIALS_FILE, { force: true });
    // 保留测试产物目录，便于人工复核失败时的产物（当前配置不产出截图/轨迹）。
  }
}

main().catch((error) => {
  console.error(`[e2e-phase02] 编排失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
