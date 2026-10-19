import { ApiError, canonicalNavUrl, directoryItemSchema, navCatalogEntrySchema, type DirectoryItem, type DirectoryRecord, type NavCatalogEntry } from '@ff14-hub/shared';

interface EditRow { id: string; payload: string; hidden: number; revision: number }

export async function readDirectoryRecords(db: D1Database, base: readonly NavCatalogEntry[]): Promise<DirectoryRecord[]> {
  const records = new Map(base.map(entry => [entry.id, { entry, revision: 0, hidden: false }]));
  const edits = await db.prepare('SELECT id,payload,hidden,revision FROM nav_catalog_edits').all<EditRow>();
  for (const row of edits.results) {
    const entry = navCatalogEntrySchema.parse(JSON.parse(row.payload));
    if (entry.id !== row.id) throw new Error('目录编辑记录不完整');
    records.set(row.id, { entry, revision: row.revision, hidden: row.hidden === 1 });
  }
  return [...records.values()].sort((a,b) => a.entry.sortOrder-b.entry.sortOrder || a.entry.id.localeCompare(b.entry.id));
}

export async function saveDirectoryRecord(db: D1Database, records: readonly DirectoryRecord[], input: {
  id: string; expectedRevision: number; item: DirectoryItem; hidden: boolean;
}): Promise<DirectoryRecord> {
  const old = records.find(record => record.entry.id === input.id);
  if ((old?.revision ?? 0) !== input.expectedRevision) throw new ApiError('conflict','网站已由其他页面修改，请重新读取；当前草稿仍保留');
  const item = directoryItemSchema.strip().parse(input.item);
  const canonical = canonicalNavUrl(item.url);
  // Include hidden records: the owner should restore the existing site, not create a duplicate.
  if (records.some(record => record.entry.id !== input.id && canonicalNavUrl(record.entry.url) === canonical)) {
    throw new ApiError('conflict','该网址已存在（可能已下架），请编辑或恢复已有网站');
  }
  const now = Date.now();
  const entry: NavCatalogEntry = navCatalogEntrySchema.parse({
    ...item, url: canonical, id: input.id,
    sourceVersion: Math.max(1, ...records.map(record => record.entry.sourceVersion)) + 1,
    sourceUrl: old?.entry.sourceUrl ?? canonical, sourceName: old?.entry.sourceName ?? '站长维护',
    verifiedAt: old?.entry.verifiedAt ?? now,
    verificationStatus: old?.entry.verificationStatus ?? 'unverified', updatedAt: now,
  });
  let changed: D1Result;
  try {
    changed = input.expectedRevision === 0
      ? await db.prepare(`INSERT INTO nav_catalog_edits(id,payload,canonical_url,hidden,revision,updated_at)
          VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO NOTHING`)
        .bind(input.id,JSON.stringify(entry),canonical,input.hidden?1:0,now).run()
      : await db.prepare(`UPDATE nav_catalog_edits SET payload=?,canonical_url=?,hidden=?,revision=revision+1,updated_at=?
          WHERE id=? AND revision=?`)
        .bind(JSON.stringify(entry),canonical,input.hidden?1:0,now,input.id,input.expectedRevision).run();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('UNIQUE constraint failed')) throw new ApiError('conflict','该网址已存在，请重新读取目录');
    throw cause;
  }
  if (changed.meta.changes < 1) throw new ApiError('conflict','网站已由其他页面修改，请重新读取；当前草稿仍保留');
  return { entry, revision: input.expectedRevision+1, hidden: input.hidden };
}
