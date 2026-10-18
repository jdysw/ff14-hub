/**
 * 本地可运行的提醒调度入口（阶段 05B，规划 7.2）。
 *
 * wrangler.jsonc 未注册 Cron；真实定时触发与设备收件需在后续部署阶段验证。
 * 每次调用有界规划规则、认领到期任务、发送前重验，并持久化结果；未配置渠道不会伪装成功。
 */
import type { Env } from '../env';
import { planNotifications } from '../modules/reminders/planner';
import { runNotifications } from '../modules/reminders/runner';
import { createPushTransport } from '../modules/reminders/push';
import { observeScheduled } from '../modules/operations/scheduler';

export async function handleScheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await observeScheduled(env.DB,controller.scheduledTime,{
    plan:()=>planNotifications(env.DB,controller.scheduledTime),
    deliver:()=>runNotifications(env.DB,createPushTransport(env)),
  });
}
