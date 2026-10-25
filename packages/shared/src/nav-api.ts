/** Public navigation catalog and HTTPS URL validation. */
import { z } from 'zod';

export const MAX_NAV_TITLE_LENGTH = 80;

export const MAX_NAV_URL_LENGTH = 2048;

export const MAX_NAV_DESCRIPTION_LENGTH = 500;

export const MAX_NAV_TAGS = 20;

export const MAX_NAV_TAG_LENGTH = 24;

export const MAX_NAV_ALIASES = 10;

export const MAX_NAV_ALIAS_LENGTH = 60;

export const MAX_NAV_ICON_LENGTH = 200;

export const MAX_NAV_GROUP_NAME_LENGTH = 40;

export const NAV_OPEN_MODES = ['new_tab', 'same_tab'] as const;

export const NAV_REGIONS = ['cn', 'global', 'both'] as const;

export type NavRegion = (typeof NAV_REGIONS)[number];

export type NavUrlValidation =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'scheme' | 'credentials' | 'host' | 'length' };

function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = (value.codePointAt(index) ?? Number.NaN);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function validateNavUrl(raw: unknown): NavUrlValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'length' };
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_NAV_URL_LENGTH) {
    return { ok: false, reason: 'length' };
  }
  if (hasControlOrSpace(value)) {
    return { ok: false, reason: 'length' };
  }
  // scheme 按 RFC 3986 **不区分大小写**：`HTTPS://` 必须与 `https://` 同等接受，
  // 否则同一份书签文件会因为大小写写法不同而解析结果不同（复核发现的真实差异）。
  const scheme = value.slice(0, 8).toLowerCase();
  if (scheme !== 'https://') {
    // http 与其他所有协议（javascript: / data: / file: / blob: / vbscript: …）都在这里被拒绝。
    return { ok: false, reason: 'scheme' };
  }
  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority.length === 0) {
    return { ok: false, reason: 'host' };
  }
  if (authority.includes('@')) {
    // user:pass@host 形式：既可能是钓鱼，也会把凭证写进配置与日志。
    return { ok: false, reason: 'credentials' };
  }
  const host = authority.split(':')[0] ?? '';
  if (host.length === 0 || !host.includes('.')) {
    return { ok: false, reason: 'host' };
  }
  return { ok: true, url: value };
}

export const navUrlSchema = z.string().refine((value) => validateNavUrl(value).ok, {
  message: '导航 URL 必须是以 https:// 开头的合法地址（不允许 http 与危险协议，不允许内嵌凭证）',
});

export const navOpenModeSchema = z.enum(NAV_OPEN_MODES);

export const navRegionSchema = z.enum(NAV_REGIONS);

const idSchema = z.string().min(1).max(64);

const utcMsSchema = z.number().int().nonnegative();

export const navCatalogEntrySchema = z
  .object({
    id: idSchema,
    sourceVersion: z.number().int().positive(),
    title: z.string().min(1).max(MAX_NAV_TITLE_LENGTH),
    url: navUrlSchema,
    description: z.string().max(MAX_NAV_DESCRIPTION_LENGTH),
    category: z.string().min(1).max(MAX_NAV_GROUP_NAME_LENGTH),
    tags: z.array(z.string().min(1).max(MAX_NAV_TAG_LENGTH)).max(MAX_NAV_TAGS),
    aliases: z.array(z.string().min(1).max(MAX_NAV_ALIAS_LENGTH)).max(MAX_NAV_ALIASES),
    icon: z.string().max(MAX_NAV_ICON_LENGTH),
    openMode: navOpenModeSchema,
    region: navRegionSchema,
    sortOrder: z.number().int(),
    sourceUrl: navUrlSchema,
    sourceName: z.string().max(80),
    verifiedAt: utcMsSchema,
    verificationStatus: z.enum(['verified', 'unverified']),
    updatedAt: utcMsSchema,
  })
  .strict();

export type NavCatalogEntry = z.infer<typeof navCatalogEntrySchema>;

export const navCatalogResponseSchema=z.object({entries:z.array(navCatalogEntrySchema),sourceVersion:z.number().int().nonnegative(),updatedAt:z.number().int().nonnegative()});
