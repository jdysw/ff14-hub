import { buildPushPayload } from '@block65/webcrypto-web-push';
import { pushSubscriptionInputSchema } from '@ff14-hub/shared';
import type { Env } from '../../env';
export interface PushTransport{configured:boolean;send(subscription:unknown,tag:string):Promise<{status:number;retryAfterMs?:number}>}
export function pushConfigured(env:Env):boolean{
  return /^[A-Za-z0-9_-]{87}$/.test(env.VAPID_PUBLIC_KEY??'') && /^[A-Za-z0-9_-]{43}$/.test(env.VAPID_PRIVATE_KEY??'') &&
    /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(env.VAPID_SUBJECT??'');
}
export function createPushTransport(env:Env):PushTransport{
  return {configured:pushConfigured(env),send:async(raw,tag)=>{
    if(!pushConfigured(env))return {status:0};
    const subscription=pushSubscriptionInputSchema.parse(raw);
    if(subscription.expirationTime!==null&&subscription.expirationTime<=Date.now())return {status:410};
    const payload=await buildPushPayload({data:JSON.stringify({title:'FF14 Hub 提醒',body:'一条提醒已到时间，请打开提醒管理查看。',tag}),options:{ttl:60}},
      subscription,{publicKey:env.VAPID_PUBLIC_KEY ?? '',privateKey:env.VAPID_PRIVATE_KEY ?? '',subject:env.VAPID_SUBJECT ?? ''});
    const response=await fetch(subscription.endpoint,{...payload,redirect:'manual',signal:AbortSignal.timeout(5000)});
    // Consume no arbitrary response body, never follow a provider redirect.
    const retry=Number(response.headers.get('Retry-After'));
    if(response.body!==null)await response.body.cancel();
    return {status:response.status,...(Number.isFinite(retry)&&retry>0?{retryAfterMs:Math.min(retry*1000,3600_000)}:{})};
  }};
}
