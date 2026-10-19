/**
 * CI 浏览器测试编排器。
 * 每一条原有阶段脚本都在独立 POSIX 进程组中执行；结束后清理整个进程组，
 * 避免 pnpm -> shell -> wrangler -> workerd 遗留后台服务而干扰后一阶段。
 * 不更改任何测试断言，不吞掉失败；全部阶段执行结束后统一返回非零退出码。
 */
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

const scripts = process.argv.slice(2);
const allowed = new Set([
  'e2e:phase02', 'e2e:phase03', 'e2e:phase04', 'e2e:phase05',
  'e2e:phase05b', 'e2e:phase06a', 'e2e:phase06b', 'e2e:phase06c',
]);
if (scripts.length === 0 || scripts.some((script) => !allowed.has(script))) {
  throw new Error('Expected one or more known E2E scripts');
}

async function execute(script) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(command, ['run', script], {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: { ...process.env, CI: 'true' },
  });
  const exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (typeof child.pid === 'number') {
    try {
      if (process.platform === 'win32') {
        const cleanup = spawn('C:\\Windows\\System32\\taskkill.exe',
          ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        cleanup.unref();
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    // Wrangler 的 shell 包装可能先退出，workerd 后释放 8787/8788 监听端口。
    await pause(1000);
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
  }
  return exitCode;
}

let failed = false;
for (const script of scripts) {
  console.log(`::group::${script}`);
  const result = await execute(script);
  console.log('::endgroup::');
  if (result !== 0) {
    console.error(`::error title=浏览器验收失败::${script} (exit ${result})`);
    failed = true;
  } else console.log(`PASS: ${script}`);
}
if (failed) process.exitCode = 1;
