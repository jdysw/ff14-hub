/** 将国服官方已核实的活动时间段导出为标准只读 ICS 订阅日历。 */
import { eventCalendarResponseSchema, type EventCalendarItem, type EventCalendarResponse } from '@ff14-hub/shared';

const HOST = 'ff14.zhixia.uk';
const decoder = new TextEncoder();

function escapedText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n')
    .replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/** RFC 5545 行折叠必须以 UTF-8 octet 数而非 JS 字符数计算。 */
export function foldIcsLine(line: string): string {
  const lines: string[] = [];
  let current = '';
  let bytes = 0;
  for (const point of line) {
    const size = decoder.encode(point).length;
    if (bytes + size > 75) {
      lines.push(current);
      current = ' ';
      bytes = 1;
    }
    current += point;
    bytes += size;
  }
  lines.push(current);
  return lines.join('\r\n');
}

function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function validRange(event: EventCalendarItem): boolean {
  return event.startsAt !== null && event.endsAt !== null &&
    Number.isSafeInteger(event.startsAt) && Number.isSafeInteger(event.endsAt) &&
    event.startsAt >= 0 && event.endsAt > event.startsAt &&
    event.endsAt <= 8_640_000_000_000_000 - 1000;
}

function officialUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname === 'sdo.com' || url.hostname.endsWith('.sdo.com'))) return url.toString();
  } catch { /* invalid */
  }
  return null;
}

/** 未知日期、空日期和零时长的公告不进入 ICS；不伪造日历占用时间。 */
export function createOfficialCalendarIcs(value: EventCalendarResponse): string {
  const source = eventCalendarResponseSchema.parse(value);
  const rows: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FF14 Hub//Official CN Events//ZH',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:FF14 Hub 国服活动', 'X-WR-TIMEZONE:Asia/Shanghai',
    'REFRESH-INTERVAL;VALUE=DURATION:PT3H',
  ];
  const stamp = icsUtc(source.source.checkedAtMs);
  const seen = new Set<string>();
  for (const event of source.events) {
    if (!validRange(event) || seen.has(event.id)) continue;
    seen.add(event.id);
    const url = officialUrl(event.sourceUrl);
    rows.push('BEGIN:VEVENT');
    rows.push('UID:' + escapedText(event.id) + '@' + HOST);
    rows.push('DTSTAMP:' + stamp);
    rows.push('DTSTART:' + icsUtc(event.startsAt!));
    // 活动公告的结束时刻视作含末秒，iCalendar 的 DTEND 为排他的时刻。
    rows.push('DTEND:' + icsUtc(event.endsAt! + 1000));
    rows.push('SUMMARY:' + escapedText(event.title));
    if (event.category) rows.push('CATEGORIES:' + escapedText(event.category));
    if (event.description || url) {
      rows.push('DESCRIPTION:' + escapedText([event.description, url && '官方链接：' + url].filter(Boolean).join('\n')));
    }
    if (url) rows.push('URL:' + url);
    rows.push('STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  rows.push('END:VCALENDAR');
  return rows.map(foldIcsLine).join('\r\n') + '\r\n';
}
