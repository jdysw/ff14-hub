/**
 * 国服活动人工策展：允许覆盖官方活动和建立管理员活动。
 * 人工覆盖与官方快照独立存储，定时更新只写官方快照，永远不会覆盖人工修订。
 */
import { eventCalendarItemSchema, eventCalendarResponseSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';

interface CuratedRow {
  readonly id: string;
  readonly payload: string;
  readonly hidden: number;
  readonly revision: number;
  readonly updated_at: number;
}

export interface CuratedEventEntry {
  readonly id: string;
  readonly event: EventCalendarItem | null;
  readonly hidden: boolean;
  readonly revision: number;
  readonly updatedAt: number;
}

function parseRow(row: CuratedRow): CuratedEventEntry | null {
  if (row.hidden === 1) return { id: row.id, event: null, hidden: true, revision: row.revision, updatedAt: row.updated_at };
  try {
    const parsed = eventCalendarItemSchema.safeParse(JSON.parse(row.payload) as unknown);
    return parsed.success && parsed.data.id === row.id ?
      { id: row.id, event: parsed.data, hidden: false, revision: row.revision, updatedAt: row.updated_at } : null;
  } catch { return null; }
}

export async function listCuratedCalendarEntries(db: D1Database): Promise<CuratedEventEntry[]> {
  const result = await db.prepare(
    'SELECT id, payload, hidden, revision, updated_at FROM curated_calendar_events ORDER BY updated_at DESC LIMIT 500',
  ).all<CuratedRow>();
  return result.results.map(parseRow).filter((entry): entry is CuratedEventEntry => entry !== null);
}

export function mergeCuratedCalendar(
  base: EventCalendarResponse,
  entries: readonly CuratedEventEntry[],
): EventCalendarResponse {
  const official = new Map(base.events.map(event => [event.id, event]));
  for (const item of entries) {
    if (item.hidden) official.delete(item.id);
    else if (item.event !== null) official.set(item.id, item.event);
  }
  return eventCalendarResponseSchema.parse({
    ...base,
    events: [...official.values()].slice(0, 250),
  });
}

/** 公开读取在迁移尚未应用或 D1 临时故障时回退原始快照，不暴露任何内部错误。 */
export async function mergePublicCalendar(db: D1Database, base: EventCalendarResponse): Promise<EventCalendarResponse> {
  try {
    return mergeCuratedCalendar(base, await listCuratedCalendarEntries(db));
  } catch { return base; }
}
