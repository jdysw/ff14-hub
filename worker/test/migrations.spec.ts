import './setup-d1';
/**
 * 单用户 D1 初始基线回归。真实 workerd/D1；从空数据库应用 migrations/0001_core.sql。
 * 不再要求旧设备、工作空间、服务器端工作台和旧通知表存在。
 */
import {env} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';


describe('单文件初始迁移',()=>{






  it('公共鱼类与活动的基本数据约束仍由 D1 拒绝非法记录',async()=>{
    await expect(env.DB.prepare("INSERT INTO fish_catalog(region,fish_id,record_json) VALUES ('eu',1,'{}')").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO fish_catalog(region,fish_id,record_json) VALUES ('cn',1,'broken-json')").run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO fish_catalog(region,fish_id,record_json) VALUES ('cn',1,'{}')").run();
    await expect(env.DB.prepare("INSERT INTO events(id,region,title,starts_at,ends_at,source_url,verification_status,created_at,updated_at) VALUES ('event-a','both','a',1,2,'https://x.test','unverified',1,1)").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO events(id,region,title,starts_at,ends_at,source_url,verification_status,created_at,updated_at) VALUES ('event-b','cn','b',2,1,'https://x.test','unverified',1,1)").run()).rejects.toThrow();
  });

  it('通知任务只能属于现行订阅设备，删除设备会级联清理队列',async()=>{
    const insertJob=(deviceId:string)=>env.DB.prepare("INSERT INTO local_push_jobs(device_id,job_key,payload,due_at,expires_at) VALUES (?,'job','{}',1,2)").bind(deviceId).run();
    await expect(insertJob('not-exists')).rejects.toThrow();
    await env.DB.prepare("INSERT INTO local_push_devices(id,token_hash,endpoint_hash,channel_ciphertext,expires_at,updated_at) VALUES ('notify-unit','token-unit','endpoint-unit','encrypted',100,1)").run();
    await insertJob('notify-unit');
    await env.DB.prepare("DELETE FROM local_push_devices WHERE id='notify-unit'").run();
    const row=await env.DB.prepare("SELECT 1 AS present FROM local_push_jobs WHERE device_id='notify-unit'").first();
    expect(row).toBeNull();
  });


});
