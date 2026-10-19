/**
 * 全站公共展示设置：白名单字段、服务器输入验证、D1 乐观锁和数据库触发器审计。
 * 禁止保存密钥、数据库参数、CORS、安全开关等运维级配置。
 */
import { ApiError } from '@ff14-hub/shared';
import { z } from 'zod';

export const siteSettingsSchema = z.object({
  siteName: z.string().trim().min(2).max(48),
  announcement: z.string().max(500),
  announcementEnabled: z.boolean(),
  homeCalendarEnabled: z.boolean(),
}).strict();
export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export const DEFAULT_SITE_SETTINGS: SiteSettings = Object.freeze({
  siteName: 'FF14 Hub',
  announcement: '',
  announcementEnabled: false,
  homeCalendarEnabled: true,
});
export const siteSettingsMutationSchema = z.object({
  expectedRevision: z.number().int().min(0),
  settings: siteSettingsSchema,
}).strict();

export interface SiteSettingsDocument {
  readonly revision: number;
  readonly settings: SiteSettings;
}
export async function readSiteSettings(db: D1Database): Promise<SiteSettingsDocument> {
  const row = await db.prepare('SELECT payload, revision FROM site_admin_settings WHERE singleton=1')
    .first<{payload:string;revision:number}>();
  if (!row) return { revision: 0, settings: DEFAULT_SITE_SETTINGS };
  const parsed = siteSettingsSchema.safeParse(JSON.parse(row.payload) as unknown);
  if (!parsed.success) throw new ApiError('internal_error','站点配置格式异常');
  return { revision: row.revision, settings: parsed.data };
}
export async function updateSiteSettings(
  db: D1Database, input: z.infer<typeof siteSettingsMutationSchema>,
): Promise<SiteSettingsDocument> {
  const settings = siteSettingsSchema.parse(input.settings);
  const result = await db.prepare(`INSERT INTO site_admin_settings(singleton,payload,revision,updated_at)
      SELECT 1,?,1,? WHERE ?=0
      ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,
        revision=site_admin_settings.revision+1,updated_at=excluded.updated_at
        WHERE site_admin_settings.revision=?`)
    .bind(JSON.stringify(settings),Date.now(),input.expectedRevision,input.expectedRevision).run();
  if (result.meta.changes !== 1) throw new ApiError('conflict','配置已由其他会话修改，请重新读取');
  return readSiteSettings(db);
}
