import { z } from 'zod';
import { navCatalogEntrySchema, type NavCatalogEntry } from './nav-api';

/** Conservative identity: preserve functional query parameters, paths and hash routes. */
export function canonicalNavUrl(raw: string): string {
  const url = new URL(raw);
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(spm|from_spmid|vd_source|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.hash === '#' || url.hash === '#/') url.hash = '';
  return url.href;
}

export const directoryItemSchema = navCatalogEntrySchema.pick({
  title: true, url: true, description: true, category: true, tags: true,
  aliases: true, icon: true, openMode: true, region: true, sortOrder: true,
}).extend({ title: z.string().trim().min(1).max(80), category: z.string().trim().min(1).max(40) }).strict();
export type DirectoryItem = z.infer<typeof directoryItemSchema>;
export const directoryMutationSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), item: directoryItemSchema,
}).strict();
export const directoryToggleSchema = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
export const directoryRecordSchema = z.object({
  entry: navCatalogEntrySchema, revision: z.number().int().nonnegative(), hidden: z.boolean(),
}).strict();
export type DirectoryRecord = z.infer<typeof directoryRecordSchema>;
export const directoryAdminResponseSchema = z.object({ records: z.array(directoryRecordSchema) }).strict();

export function matchesDirectorySearch(entry: Pick<NavCatalogEntry, 'title'|'url'|'description'|'category'|'tags'|'aliases'>, query: string): boolean {
  const haystack = [entry.title, entry.url, entry.description, entry.category, ...entry.tags, ...entry.aliases].join(' ').normalize('NFKC').toLocaleLowerCase();
  return query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word));
}
