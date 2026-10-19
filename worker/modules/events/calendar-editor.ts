/** 人工维护的公开活动覆盖层：独立保存，不会被三小时官方源同步覆盖。 */
import { eventCalendarItemSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';
import { ApiError } from '@ff14-hub/shared';
import { z } from 'zod';

export const calendarEditSchema = eventCalendarItemSchema.omit({ id: true, region: true }).superRefine((item, context) => {
  if ((item.startsAt === null) !== (item.endsAt === null) ||
      (item.startsAt !== null && item.endsAt !== null && item.endsAt <= item.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: '时间必须为有效区间' });
  }
});
export const calendarMutationSchema = z.object({
  expectedRevision: z.number().int().min(0),
  item: calendarEditSchema,
}).strict();
export const calendarToggleSchema = z.object({
  expectedRevision: z.number().int().min(0),
}).strict();

export interface EditorRow {
  id: string;
  mode: 'upsert' | 'hide' | 'restore';
  payload: string | null;
  revision: number;
  updated_at: number;
}

export interface CalendarEditorEntry {
  id: string;
  mode: EditorRow['mode'];
  revision: number;
  item: EventCalendarItem | null;
}

export async function listEditorEntries(db: D1Database): Promise<CalendarEditorEntry[]> {
  const rows = await db.prepare('SELECT id, mode, payload, revision, updated_at FROM calendar_editor_entries ORDER BY updated_at DESC')
    .all<EditorRow>();
  return rows.results.map(row => {
    let item: EventCalendarItem | null = null;
    if (row.payload !== null) {
      try {
        const parsed = eventCalendarItemSchema.safeParse(JSON.parse(row.payload));
        if (parsed.success && parsed.data.id === row.id) item = parsed.data;
      } catch { /* 非法内容不能越过事件 Schema 进入客户端 */ }
    }
    return { id: row.id, mode: row.mode, revision: row.revision, item };
  });
}

export async function applyCalendarEdits(db: D1Database, source: EventCalendarResponse): Promise<EventCalendarResponse> {
  const records = await listEditorEntries(db);
  const result = new Map(source.events.map(item => [item.id, item]));
  for (const record of records) {
    if (record.mode === 'hide') result.delete(record.id);
    else if (record.mode === 'upsert' && record.item !== null) result.set(record.id, record.item);
  }
  return { ...source, events: Array.from(result.values()).slice(0, 250) };
}

export async function saveCalendarEdit(
  db: D1Database, accountId: string, id: string, mode: EditorRow['mode'],
  item: EventCalendarItem | null, expectedRevision: number,
): Promise<number> {
  const now = Date.now();
  const payload = mode !== 'restore' && item !== null ? JSON.stringify(eventCalendarItemSchema.parse(item)) : null;
  const changed = expectedRevision === 0
    ? await db.prepare(`INSERT INTO calendar_editor_entries
        (id,mode,payload,revision,editor_account_id,updated_at)
        VALUES (?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, mode, payload, accountId, now).run()
    : await db.prepare(`UPDATE calendar_editor_entries SET mode=?,payload=?,revision=revision+1,
        editor_account_id=?,updated_at=? WHERE id=? AND revision=?`)
      .bind(mode, payload, accountId, now, id, expectedRevision).run();
  // D1 changes 统计可能包含审计触发器的写入：成功时不保证恰好为 1。
  // 乐观锁冲突只会让 INSERT DO NOTHING / 带 revision 的 UPDATE 修改 0 行。
  if (!changed.success || changed.meta.changes < 1) throw new ApiError('conflict', '活动已经在其他页面修改，请刷新后重试');
  return expectedRevision + 1;
}
