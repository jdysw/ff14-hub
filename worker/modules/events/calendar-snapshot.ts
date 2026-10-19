/**
 * 持久化国服官方活动快照（全公开数据）。
 *
 * 生产 Worker 到盛趣官网的出站请求可能受到网络限制。D1 保存独立构建机
 * 从固定官方接口获取的最近一次完整快照，任何用户都能匿名读取。
 * 失效快照明确标 stale；不把网络故障伪装成“暂无活动”。
 */
import { eventCalendarResponseSchema, type EventCalendarResponse } from '@ff14-hub/shared';

export const OFFICIAL_CALENDAR_SNAPSHOT_STALE_MS = 6 * 60 * 60_000;

interface SnapshotRow {
  readonly payload: string;
  readonly checked_at_ms: number;
}

export function parseOfficialCalendarSnapshot(row: SnapshotRow, nowMs = Date.now()): EventCalendarResponse | null {
  if (!Number.isSafeInteger(row.checked_at_ms) || row.checked_at_ms <= 0 ||
      row.checked_at_ms > nowMs + 5 * 60_000) return null;

  let payload: unknown;
  try { payload = JSON.parse(row.payload); }
  catch { return null; }
  const parsed = eventCalendarResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.source.checkedAtMs !== row.checked_at_ms) return null;
  if (!parsed.data.source.homeUrl.startsWith('https://ff.web.sdo.com/')) return null;

  return {
    ...parsed.data,
    serverTimeMs: nowMs,
    source: {
      ...parsed.data.source,
      stale: parsed.data.source.stale ||
        nowMs - row.checked_at_ms >= OFFICIAL_CALENDAR_SNAPSHOT_STALE_MS,
    },
  };
}

export async function readOfficialCalendarSnapshot(db: D1Database, nowMs = Date.now()): Promise<EventCalendarResponse | null> {
  try {
    const row = await db.prepare(
      "SELECT payload, checked_at_ms FROM official_calendar_snapshots WHERE source = 'cn'",
    ).first<SnapshotRow>();
    return row === null ? null : parseOfficialCalendarSnapshot(row, nowMs);
  } catch {
    // 首次部署（迁移未应用）或暂时性 D1 故障仍允许尝试现有官方直连逻辑。
    return null;
  }
}
