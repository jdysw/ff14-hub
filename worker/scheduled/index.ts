/**
 * 本地可运行的提醒调度入口（阶段 05B，规划 7.2）。
 *
 * wrangler.jsonc 未注册 Cron；真实定时触发与设备收件需在后续部署阶段验证。
 * 每次调用有界规划规则、认领到期任务、发送前重验，并持久化结果；未配置渠道不会伪装成功。
 */
import { logLine } from '../lib/redact';
import type { Env } from '../env';
import { planNotifications } from '../modules/reminders/planner';
import { runNotifications } from '../modules/reminders/runner';
import { createPushTransport } from '../modules/reminders/push';

export async function handleScheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const planned=await planNotifications(env.DB,controller.scheduledTime);
  const processed=await runNotifications(env.DB,createPushTransport(env));
  console.info(
    logLine('info', 'scheduled_notifications', {
      planned:String(planned),processed:String(processed),
      cron: controller.cron,
      scheduledTime: String(controller.scheduledTime),
      // 只记录绑定是否存在，不记录其内容。
      dbBound: env.DB === undefined ? 'no' : 'yes',
    }),
  );
}
