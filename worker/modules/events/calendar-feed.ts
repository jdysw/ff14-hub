/**
 * 盛趣国服活动资讯只读适配器。仅访问固定的官方新闻列表及详情接口。
 * 这是“官方公告 API”，并非官方活动日程 API：不能以发布时间推断活动起止。
 */
import type { EventCalendarItem, EventCalendarResponse } from '@ff14-hub/shared';

const HOST = 'https://cqnews.web.sdo.com';
const NEWS_INDEX = 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist';
const CACHE_MS = 20 * 60_000;
const STALE_MS = 12 * 60 * 60_000;
let cache: { checkedAtMs: number; events: EventCalendarItem[] } | null = null;
let request: Promise<void> | null = null;

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function clean(v: unknown, max = 120): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}
function officialLink(v: unknown, id: number): string {
  if (typeof v === 'string') {
    try {
      const url = new URL(v);
      if (url.protocol === 'https:' && !url.username && !url.password &&
          (url.hostname === 'sdo.com' || url.hostname.endsWith('.sdo.com'))) return url.toString();
    } catch { /* 非法外链不渲染 */ }
  }
  return 'https://ff.web.sdo.com/web8/index.html#/newstab/newscont/' + id;
}
function chinaTimestamp(v: string): number | null {
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((part) => part === undefined ? 0 : Number(part));
  if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined ||
      !Number.isInteger(y) || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (s ?? 0) > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s ?? 0);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return utc - 8 * 3_600_000;
}
/** 仅解析紧随“活动时间/活动期间”的两个完整日期时间；其他含糊日期一律不猜。 */
export function extractOfficialActivityRange(html: string): { startsAt: number; endsAt: number } | null {
  const plain = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&(?:mdash|ndash);/gi, '-').replace(/[\u3000\s]+/g, ' ').slice(0, 100_000);
  const date = '(\\d{4}年\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)';
  const pattern = new RegExp('(?:活动时间|活动期间|举办时间|起止时间)\\s*[：:]?\\s*' + date +
    '\\s*(?:至|到|~|～|—|－|-|–)\\s*' + date);
  const m = pattern.exec(plain);
  if (!m) return null;
  const startsAt = chinaTimestamp(m[1] ?? '');
  const endsAt = chinaTimestamp(m[2] ?? '');
  return startsAt !== null && endsAt !== null && endsAt >= startsAt ? { startsAt, endsAt } : null;
}

/** 仅允许官网活动专题 URL（固定官方域名和 /project/ 路径），拒绝任意网页代理。 */
function officialProjectUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'actff1.web.sdo.com' &&
        url.pathname.startsWith('/project/') && !url.username && !url.password) return url.toString();
  } catch { /* 拒绝非法 URL */ }
  return null;
}

/**
 * 官方专题 HTML 可能只给起始年份，如“2026年10月15日16:00 ～ 11月2日22:59”。
 * 只推导明确在同一日历年的结束日；跨年缺失年份则保持未知。
 */
export function extractOfficialLandingRange(html: string): { startsAt: number; endsAt: number } | null {
  const content = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/[\u3000\s]+/g, ' ').slice(0, 100_000);
  const start = '(\\d{4}年\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)';
  const end = '((?:\\d{4}年)?\\d{1,2}月\\d{1,2}日\\s*\\d{1,2}:\\d{2}(?::\\d{2})?)';
  const pattern = new RegExp(start + '\\s*(?:至|到|~|～|—|－|-|–)\\s*' + end);
  const match = pattern.exec(content);
  if (!match) return null;
  const startsAt = chinaTimestamp(match[1] ?? '');
  const rawEnd = match[2] ?? '';
  const firstYear = match[1]?.match(/^\d{4}/)?.[0];
  const firstMonth = Number(match[1]?.match(/年(\d{1,2})月/)?.[1]);
  const lastMonth = Number(rawEnd.match(/(?:年|^)(\d{1,2})月/)?.[1]);
  const completedEnd = /^\d{4}年/.test(rawEnd)
    ? rawEnd
    : firstYear !== undefined && lastMonth >= firstMonth ? firstYear + '年' + rawEnd : '';
  const endsAt = chinaTimestamp(completedEnd);
  return startsAt !== null && endsAt !== null && endsAt >= startsAt ? { startsAt, endsAt } : null;
}

/** 只允许官方固定 URL 或经严格校验的官方活动专题，响应超过 1MB 拒绝。 */
async function officialHtml(url: string): Promise<string | null> {
  if (officialProjectUrl(url) === null) return null;
  try {
    const response = await fetch(url, {
      method: 'GET', redirect: 'error', headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) return null;
    const body = await response.text();
    return body.length <= 1_000_000 ? body : null;
  } catch { return null; }
}

async function json(path: string): Promise<unknown> {
  const response = await fetch(HOST + path, {
    method: 'GET', redirect: 'error', headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new Error('official_http_error');
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error('official_payload_too_large');
  return JSON.parse(body) as unknown;
}
async function articleDetail(id: number): Promise<string | null> {
  try {
    const payload = await json('/api/news/newsDetail?gameCode=ff&id=' + id);
    if (!record(payload) || !record(payload['Data'])) return null;
    const content = payload['Data']['Content'];
    return typeof content === 'string' ? content : null;
  } catch { return null; }
}
async function refresh(): Promise<void> {
  // 分类 5311：RSSHub 国服适配器采用的官方活动资讯分类。
  const payload = await json('/api/news/newsList?gameCode=ff&CategoryCode=5311&pageIndex=0&pageSize=30');
  if (!record(payload) || !Array.isArray(payload['Data'])) throw new Error('official_list_shape_changed');
  const seen = new Set<number>();
  const events: EventCalendarItem[] = (payload['Data'] as unknown[]).slice(0, 30).flatMap((row) => {
    if (!record(row)) return [];
    const id = typeof row['Id'] === 'number' ? row['Id'] : Number(row['Id']);
    const title = clean(row['Title']);
    if (!Number.isSafeInteger(id) || id <= 0 || !title || seen.has(id)) return [];
    seen.add(id);
    const category = title.includes('季节活动') ? '季节活动' :
      title.includes('联动') ? '联动活动' : '官方活动';
    const result: EventCalendarItem = {
      id: 'official:' + id, region: 'cn', title, description: clean(row['Summary'], 600),
      category, location: '', startsAt: null, endsAt: null, allDay: false,
      sourceUrl: officialLink(row['OutLink'], id),
    };
    return [result];
  });
  // 逐批处理以限制对上游接口的瞬时负载。详情失败只影响倒计时，不影响标题列表。
  for (let i = 0; i < Math.min(events.length, 12); i += 3) {
    await Promise.all(events.slice(i, i + 3).map(async (event) => {
      const id = Number(event.id.slice('official:'.length));
      const html = await articleDetail(id);
      const range = html === null ? null : extractOfficialActivityRange(html);
      if (range) { event.startsAt = range.startsAt; event.endsAt = range.endsAt; }
    }));
  }
  cache = { checkedAtMs: Date.now(), events };
}
export async function readCnCalendar(nowMs = Date.now()): Promise<EventCalendarResponse> {
  let stale = false;
  if (!cache || nowMs - cache.checkedAtMs >= CACHE_MS) {
    try {
      request ??= refresh().finally(() => { request = null; });
      await request;
    } catch {
      if (!cache || nowMs - cache.checkedAtMs >= STALE_MS) throw new Error('国服官方活动 API 暂不可用');
      stale = true;
    }
  }
  if (!cache) throw new Error('国服官方活动 API 暂不可用');
  return {
    events: cache.events,
    serverTimeMs: nowMs,
    source: { name: '盛趣游戏 · FF14 国服官方公告', homeUrl: NEWS_INDEX, checkedAtMs: cache.checkedAtMs, stale },
  };
}
export function resetCnCalendarCacheForTests(): void { cache = null; request = null; }
