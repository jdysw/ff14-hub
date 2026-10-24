import {localNotificationJobsSchema,type LocalNotificationJob} from '@ff14-hub/shared';
import type {Env} from '../../env';
import {decryptChannel,sendChannel} from './notification-channel';
import {planDailyFishDigests} from './fish-digest';
export function checkedJobs(raw:unknown,now=Date.now()):LocalNotificationJob[]{
  return localNotificationJobsSchema.parse(raw).filter(job=>job.expiresAt>now&&job.dueAt>=now-60_000&&job.dueAt<=now+(job.key.startsWith('todo:')?365*86400000:72*3600_000)&&job.expiresAt>job.dueAt&&job.expiresAt<=job.dueAt+15*60_000);
}
export async function replaceLocalJobs(db:D1Database,device:string,jobs:LocalNotificationJob[],now=Date.now()){
  const statements=[db.prepare(`UPDATE local_push_jobs SET status='cancelled' WHERE device_id=? AND status IN('queued','leased') AND job_key NOT LIKE 'digest:%' AND job_key NOT IN(SELECT value FROM json_each(?))`).bind(device,JSON.stringify(jobs.map(job=>job.key))),
    ...jobs.map(job=>db.prepare(`INSERT INTO local_push_jobs(device_id,job_key,payload,due_at,expires_at) VALUES(?,?,?,?,?)
      ON CONFLICT(device_id,job_key) DO UPDATE SET payload=excluded.payload,due_at=excluded.due_at,expires_at=excluded.expires_at,status='queued',attempts=CASE WHEN local_push_jobs.status='cancelled' THEN 0 ELSE local_push_jobs.attempts END
      WHERE local_push_jobs.status IN('queued','cancelled')`).bind(device,job.key,JSON.stringify(job),job.dueAt,job.expiresAt)),
    db.prepare('UPDATE local_push_devices SET expires_at=?,updated_at=? WHERE id=?').bind(now+90*86400_000,now,device)];
  await db.batch(statements);
}
type Sender=(id:string,ciphertext:string,tag:string,content:{title:string;body:string})=>Promise<number>;
/** Idle ticks only query an index; due jobs are batched per device with leases and daily caps. */
export async function runLocalNotifications(db:D1Database,now:number,send:Sender):Promise<number>{
  const day=new Date(now).toISOString().slice(0,10);
  const devices=await db.prepare(`SELECT j.device_id FROM local_push_jobs j JOIN local_push_devices d ON d.id=j.device_id
    WHERE j.due_at<=? AND j.expires_at>? AND d.expires_at>? AND j.attempts<3
      AND (j.status='queued' OR(j.status='leased' AND j.lease_until<=?))
      AND (d.sent_day<>? OR d.sent_count<d.daily_limit) GROUP BY j.device_id ORDER BY MIN(j.due_at) LIMIT 5`)
    .bind(now,now,now,now,day).all<{device_id:string}>();
  let count=0;
  for(const device of devices.results){
    const id=device.device_id,claim=crypto.randomUUID();
    const jobs=await db.prepare(`UPDATE local_push_jobs SET status='leased',lease_until=?,claim_token=?,attempts=attempts+1 WHERE device_id=? AND job_key IN(
      SELECT job_key FROM local_push_jobs WHERE device_id=? AND due_at<=? AND expires_at>? AND attempts<3 AND (status='queued' OR(status='leased' AND lease_until<=?)) ORDER BY due_at LIMIT 10) RETURNING job_key,payload`)
      .bind(now+120_000,claim,id,id,now,now,now).all<{job_key:string;payload:string}>();
    if(jobs.results.length===0)continue;
    const owner=await db.prepare(`UPDATE local_push_devices SET sent_count=CASE WHEN sent_day=? THEN sent_count+1 ELSE 1 END,sent_day=?
      WHERE id=? AND expires_at>? AND (sent_day<>? OR sent_count<daily_limit) RETURNING channel_ciphertext`)
      .bind(day,day,id,now,day).first<{channel_ciphertext:string}>();
    if(!owner)continue;
    const items=jobs.results.map(job=>JSON.parse(job.payload) as LocalNotificationJob);
    const title=items.length===1?items[0]!.title:`FF14 Hub · ${items.length} 项提醒`;
    const body=items.map(item=>item.title+'：'+item.body).join('\n');
    const tag=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id+jobs.results.map(j=>j.job_key).sort().join('|')))),b=>b.toString(16).padStart(2,'0')).join('');
    let status=0;try{status=await send(id,owner.channel_ciphertext,tag,{title,body});}catch{/* Never log credentials, recipient addresses or notification content. */}
    const accepted=status>=200&&status<300,retry=status===0||status===429||status>=500;
    // Reserve quota before sending to keep concurrent ticks below the daily cap.
    // A provider rejection must release that reservation, but only if this tick
    // still owns the leased jobs. Both updates are in one D1 transaction.
    const complete=db.prepare(`UPDATE local_push_jobs
      SET status=?,due_at=CASE WHEN ?=1 THEN ? ELSE due_at END,lease_until=0
      WHERE device_id=? AND claim_token=? AND status='leased'`)
      .bind(accepted?'sent':retry?'queued':'failed',retry?1:0,now+300_000,id,claim);
    if(accepted){
      const result=await complete.run();
      if(result.meta.changes>0)count++;
    }else{
      await db.batch([
        complete,
        db.prepare(`UPDATE local_push_devices SET sent_count=sent_count-1
          WHERE id=? AND sent_day=? AND sent_count>0 AND changes()>0`).bind(id,day),
      ]);
    }
  }
  if(Math.floor(now/60_000)%1440<5){
    await db.prepare('DELETE FROM local_push_devices WHERE id IN(SELECT id FROM local_push_devices WHERE expires_at<=? LIMIT 10)').bind(now).run();
    await db.prepare('DELETE FROM local_push_jobs WHERE (device_id,job_key) IN(SELECT device_id,job_key FROM local_push_jobs WHERE expires_at<? LIMIT 100)').bind(now-7*86400_000).run();
  }
  return count;
}
export async function deliverLocalNotifications(env:Env,now:number){
  if((env.BOOTSTRAP_SECRET?.length??0)<32)return 0;
  await planDailyFishDigests(env,now);
  return runLocalNotifications(env.DB,now,async(id,ciphertext,tag,content)=>sendChannel(env,await decryptChannel(ciphertext,env.BOOTSTRAP_SECRET!,id),tag,content));
}
