/**
 * Cron / 定时任务入口占用点（阶段 05 实现，规划 7.2）。
 *
 * 本轮边界：**不实现任何业务调度**。
 * - wrangler.jsonc 未配置 cron，因此该处理器在生产中不会被触发；
 * - 保留它只是为了让 HUB-002 的「Worker 入口形状」完整，并让阶段 05 有确定的落点。
 * - 未来实现时必须遵守：dedup_key 唯一、原子租约抢占、发送前重验状态、失败可重试可回收。
 */
import { logLine } from '../lib/redact';
import type { Env } from '../env';

export function handleScheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): void {
  console.info(
    logLine('info', 'scheduled_noop', {
      cron: controller.cron,
      scheduledTime: String(controller.scheduledTime),
      // 只记录绑定是否存在，不记录其内容。
      dbBound: env.DB === undefined ? 'no' : 'yes',
    }),
  );
}
