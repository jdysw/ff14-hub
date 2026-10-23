/** 仅执行当前本机用户的独立通知订阅；不再调度旧工作空间任务。 */
import type {Env} from '../env';
import {deliverLocalNotifications} from '../modules/reminders/local-push';

export async function handleScheduled(controller:ScheduledController,env:Env,_ctx:ExecutionContext):Promise<void>{
  if(controller.cron!=='*/5 * * * *')return;
  await deliverLocalNotifications(env,controller.scheduledTime);
}
