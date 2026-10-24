/** 当前共享包导出边界：退役服务端接口不应随 barrel 再次进入产品。 */
import {describe,expect,it} from 'vitest';
import * as shared from '../src/index';

describe('单用户共享契约',()=>{
  it('仅公开现行 Web/Worker/Android 与本地同步工具',()=>{
    expect(shared.API_ROUTES.health).toBe('/api/v1/health');
    expect(shared.API_ROUTES.navCatalog).toBe('/api/v1/navigation/catalog');
    expect(shared.API_ROUTES.localNotifications).toBe('/api/v1/local-notifications');
    expect(shared.API_ROUTES.siteData).toBe('/api/v1/site/data');
    expect(typeof shared.siteGameDataSchema.parse).toBe('function');
    expect(typeof shared.managedPresentationSchema.parse).toBe('function');
    expect(shared.API_ROUTES).not.toHaveProperty('meWorkbench');
    expect(shared.API_ROUTES).not.toHaveProperty('bootstrap');
    expect(shared).not.toHaveProperty('DEVICE_TOKEN_PREFIX');
    expect(shared).not.toHaveProperty('syncChangesResponseSchema');
    expect(shared).not.toHaveProperty('WORKBENCH_BACKUP_SCHEMA_VERSION');
    expect(shared).not.toHaveProperty('MODULE_CAPABILITIES');
    expect(typeof shared.parseFishDocument).toBe('function');
    expect(typeof shared.fishWindows).toBe('function');
    expect(typeof shared.canonicalNavUrl).toBe('function');
  });
  it('操作 ID 形状沿用现行钓鱼保存契约而不是旧工作台',()=>{
    expect(shared.operationIdSchema.safeParse('op-12345678').success).toBe(true);
    expect(shared.operationIdSchema.safeParse('op 12345678').success).toBe(false);
    expect(shared.operationIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(shared.fishProgressWriteSchema.safeParse({region:'cn',fishId:1,field:'caught',value:true,
      expectedRevision:0,operationId:'op-12345678'}).success).toBe(true);
  });
  it('Web Push schema 已独立且没有放宽订阅来源或密钥长度',()=>{
    const sample={endpoint:'https://fcm.googleapis.com/fcm/send/123',
      expirationTime:null,keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}};
    expect(shared.pushSubscriptionInputSchema.safeParse(sample).success).toBe(true);
    expect(shared.pushSubscriptionInputSchema.safeParse({...sample,endpoint:'https://example.net/send'}).success).toBe(false);
    expect(shared.localNotificationChannelSchema.safeParse({kind:'webpush',subscription:sample}).success).toBe(true);
  });
});
