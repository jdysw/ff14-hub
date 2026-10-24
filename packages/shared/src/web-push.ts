/** 当前独立设备通知系统所需的 Web Push 订阅校验。 */
import {z} from 'zod';
export const pushEndpointSchema=z.url().max(2048).refine((raw)=>{
  try{const u=new URL(raw);
    return u.protocol==='https:'&&u.username===''&&u.password===''&&u.port===''&&
      ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(u.hostname);
  }catch{return false;}
},'仅支持受信任的浏览器推送服务');
const urlKey=z.string().regex(/^[A-Za-z0-9_-]+$/);
export const pushSubscriptionInputSchema=z.object({
  endpoint:pushEndpointSchema,
  expirationTime:z.number().int().positive().nullable(),
  keys:z.object({p256dh:urlKey.length(87),auth:urlKey.length(22)}).strict(),
}).strict();
