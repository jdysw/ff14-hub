/** E2E 编排通用进程清理：关闭 pnpm -> shell -> wrangler -> workerd 整棵进程树。 */
import { spawn } from 'node:child_process';

/**
 * POSIX 独立进程组可一次性关闭包装 shell 和全部后代。
 * Windows 则通过 taskkill /T 结束整个进程树。
 */
export function stopE2EServer(child) {
  const pid = child.pid;
  if (typeof pid !== 'number') return;

  if (process.platform === 'win32') {
    spawn('C:\\Windows\\System32\\taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        console.error('[e2e] 无法结束本地测试服务进程组', error);
      }
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 3000).unref();
}
