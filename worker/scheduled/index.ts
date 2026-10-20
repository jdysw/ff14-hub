/**
 * 本地可运行的提醒调度入口（阶段 05B，规划 7.2）。
 *
 * production 的 5 分钟 Cron 只处理本地用户的每日汇总；其它旧工作空间调度路径保持独立。
 * 每次调用有界规划规则、认领到期任务、发送前重验，并持久化结果；未配置渠道不会伪装成功。
 */
import type { Env } from '../env';
import { planNotifications } from '../modules/reminders/planner';
import { runNotifications } from '../modules/reminders/runner';
import { createPushTransport } from '../modules/reminders/push';
import { observeScheduled } from '../modules/operations/scheduler';
import {deliverLocalNotifications} from '../modules/reminders/local-push';

export async function handleScheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  if(controller.cron==='*/5 * * * *'){
    await deliverLocalNotifications(env,controller.scheduledTime);
    return;
  }
  await observeScheduled(env.DB,controller.scheduledTime,{
    plan:()=>planNotifications(env.DB,controller.scheduledTime),
    deliver:()=>runNotifications(env.DB,createPushTransport(env)),
  });
}
