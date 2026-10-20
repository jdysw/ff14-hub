/**
 * 盛趣国服活动资讯只读适配器。仅访问固定的官方新闻列表及详情接口。
 * 这是“官方公告 API”，并非官方活动日程 API：不能以发布时间推断活动起止。
 */
import type { EventCalendarItem, EventCalendarResponse } from '@ff14-hub/shared';

const HOST = 'https://cqnews.web.sdo.com';
const NEWS_INDEX = 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist';
export const CN_CALENDAR_CACHE_MS = 6 * 60 * 60_000;
const STALE_MS = 12 * 60 * 60_000;
let cache: { checkedAtMs: number; events: EventCalendarItem[]; partial: boolean } | null = null;
const requestSignal=(signal?:AbortSignal)=>signal?AbortSignal.any([signal,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000);

async function boundedBody(response:Response):Promise<string>{
  if(!response.body)return '';
  if(Number(response.headers.get('content-length')??0)>1_000_000)throw new Error('official_payload_too_large');
  const reader=response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder=new TextDecoder();let bytes=0,text='';
  try{
    while(true){const part=await reader.read();if(part.done)break;
      bytes+=part.value.byteLength;if(bytes>1_000_000)throw new Error('official_payload_too_large');
      text+=decoder.decode(part.value,{stream:true});
    }
    return text+decoder.decode();
  }finally{await reader.cancel().catch(()=>{});}
}

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
async function officialHtml(url: string, signal?:AbortSignal): Promise<string | null> {
  if (officialProjectUrl(url) === null) return null;
  try {
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' },
      signal: requestSignal(signal),
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) return null;
    return await boundedBody(response);
  } catch { return null; }
}

async function json(path: string, signal?:AbortSignal): Promise<unknown> {
  let status:number|undefined;
  try{
    const response = await fetch(HOST + path, {
      method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' },
      signal: requestSignal(signal),
    });
    status=response.status;
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new Error('official_http_error');
    const body = await boundedBody(response);
    return JSON.parse(body) as unknown;
  }catch(error){
    // Fixed endpoint role/status only: no URLs, query strings, bodies or credentials.
    const reason=error instanceof Error&&['TypeError','TimeoutError','AbortError'].includes(error.name)
      ?error.message.replace(/https?:\/\/\S+/g,'[origin]').slice(0,160):undefined;
    console.warn(JSON.stringify({event:'official_calendar_origin_failure',endpoint:path.includes('newsList')?'list':'detail',status,kind:error instanceof Error?error.name:'unknown',reason}));
    throw error;
  }
}
async function articleDetail(id: number, signal?:AbortSignal): Promise<string | null> {
  try {
    const payload = await json('/api/news/newsDetail?gameCode=ff&id=' + id, signal);
    if (!record(payload) || !record(payload['Data'])) return null;
    const content = payload['Data']['Content'];
    return typeof content === 'string' ? content : null;
  } catch { return null; }
}
interface OfficialEntry {
  id: number;
  title: string;
  description: string;
  category: string;
  published: string;
  detailId: number;
  sourceUrl: string;
  projectUrl: string | null;
}

async function newsCategory(code: '5311' | '5203', signal?:AbortSignal): Promise<Record<string, unknown>[]> {
  const payload = await json('/api/news/newsList?gameCode=ff&CategoryCode=' + code + '&pageIndex=0&pageSize=30', signal);
  if (!record(payload) || String(payload['Code']) !== '0' || !Array.isArray(payload['Data'])) {
    throw new Error('official_list_shape_changed');
  }
  return (payload['Data'] as unknown[]).filter(record).slice(0, 30);
}

/**
 * 两个官方分类可能发布同名新闻（例如糖豆人 ID 393660 / 393967）。
 * 保留 5311 的正文接口以提取时间，保留 5203 的活动专题作为用户来源链接。
 */
/** 分类只根据官方公告明确文案，不按日期或内容猜测活动性质。 */
export function eventCategory(title: string): string {
  if (/季节活动|守护天节|降神节|恋人节|星芒节|红莲节|金蝶游乐场庆典|女儿节|猎蛋节|新生祭/.test(title)) return '季节活动';
  if (/莫古莫古|大收集/.test(title)) return '莫古莫古大收集';
  if (/联动|联名|糖豆人|Fall Guys/i.test(title)) return '限时联动';
  if (/Fan Festival|FanFest|转播|直播|粉丝节/i.test(title)) return '直播与线下';
  if (/版本更新|(?:^|[【〖 ])\d{1,2}\.\d{1,2}(?:版本|更新|补丁)|补丁说明/.test(title)) return '版本更新';
  if (/月卡|商城|商品|道具商店/.test(title)) return '月卡与商城';
  if (/通行证/.test(title)) return '通行证';
  // 官方新闻可能只是宣传报道；不能把它们当成有真实时间段的活动。
  return '官方公告';
}
function entryKey(title: string): string {
  return title.normalize('NFKC').replace(/[\s！!。·・~～【】]/g, '').toLowerCase();
}
function officialEntry(row: Record<string, unknown>, code: '5311' | '5203'): OfficialEntry | null {
  const id = typeof row['Id'] === 'number' ? row['Id'] : Number(row['Id']);
  const title = clean(row['Title']);
  if (!Number.isSafeInteger(id) || id <= 0 || !title) return null;
  const projectUrl = officialProjectUrl(row['OutLink']);
  // 5203 栏还包含道具商城公告；不能将整个栏目都当作活动。
  if (code === '5203' && projectUrl === null &&
      !/(?:【季节活动】|〖季节活动〗|官方转播)/i.test(title)) return null;
  return {
    id, title, category: eventCategory(title), description: clean(row['Summary'], 600),
    published: clean(row['PublishDate'], 30),
    detailId: id, sourceUrl: officialLink(row['OutLink'], id), projectUrl,
  };
}
function combineEntry(existing: OfficialEntry, current: OfficialEntry, code: '5311' | '5203'): OfficialEntry {
  // 5311 公告详情通常有完整正文；5203 通常携带完整官网活动专题链接。
  return {
    ...existing,
    published: existing.published >= current.published ? existing.published : current.published,
    detailId: code === '5311' ? current.id : existing.detailId,
    projectUrl: existing.projectUrl ?? current.projectUrl,
    sourceUrl: current.projectUrl ?? existing.projectUrl ?? existing.sourceUrl,
    description: existing.description || current.description,
  };
}
function deduplicate(rows: {
  code: '5311' | '5203';
  values: Record<string, unknown>[];
}[]): OfficialEntry[] {
  const unique = new Map<string, OfficialEntry>();
  for (const group of rows) {
    for (const row of group.values) {
      const entry = officialEntry(row, group.code);
      if (!entry) continue;
      const key = entryKey(entry.title);
      const existing = unique.get(key);
      unique.set(key, existing ? combineEntry(existing, entry, group.code) : entry);
    }
  }
  return [...unique.values()].sort((left, right) =>
    right.published.localeCompare(left.published) || right.id - left.id);
}

async function refresh(signal?:AbortSignal): Promise<void> {
  const sources = await Promise.allSettled([newsCategory('5311',signal), newsCategory('5203',signal)]);
  const successful: { code: '5311' | '5203'; values: Record<string, unknown>[] }[] = [];
  const first = sources[0];
  const second = sources[1];
  if (first?.status === 'fulfilled') successful.push({ code: '5311', values: first.value });
  if (second?.status === 'fulfilled') successful.push({ code: '5203', values: second.value });
  if (successful.length === 0) throw new Error('official_sources_unavailable');

  const entries = deduplicate(successful).slice(0, 30);
  const events: EventCalendarItem[] = entries.map((entry) => ({
    id: 'official:' + entry.id, region: 'cn',
    title: entry.title, description: entry.description, category: entry.category,
    location: '', startsAt: null, endsAt: null, allDay: false, sourceUrl: entry.sourceUrl,
  }));

  // 最新的 16 条按 3 路并发查询官方详情/专题。其余公告仍展示，但不伪造时间。
  for (let i = 0; i < Math.min(events.length, 16); i += 3) {
    await Promise.all(events.slice(i, i + 3).map(async (event, offset) => {
      const entry = entries[i + offset];
      if (!entry) return;
      const content = await articleDetail(entry.detailId,signal);
      let range = content === null ? null : extractOfficialActivityRange(content);
      if (range === null && entry.projectUrl !== null) {
        const landing = await officialHtml(entry.projectUrl,signal);
        range = landing === null ? null : extractOfficialLandingRange(landing);
      }
      if (range !== null) {
        event.startsAt = range.startsAt;
        event.endsAt = range.endsAt;
      }
    }));
  }
  signal?.throwIfAborted();
  cache = { checkedAtMs: Date.now(), events, partial: sources.some((value) => value.status === 'rejected') };
}
export async function readCnCalendar(nowMs = Date.now(),signal?:AbortSignal,force=false): Promise<EventCalendarResponse> {
  let stale = false;
  if (force || !cache || nowMs - cache.checkedAtMs >= CN_CALENDAR_CACHE_MS) {
    try {
      await refresh(signal);
    } catch {
      if (!cache || nowMs - cache.checkedAtMs >= STALE_MS) throw new Error('国服官方活动 API 暂不可用');
      stale = true;
    }
  }
  if (!cache) throw new Error('国服官方活动 API 暂不可用');
  return {
    events: cache.events,
    serverTimeMs: nowMs,
    source: { name: '盛趣游戏 · FF14 国服官方公告', homeUrl: NEWS_INDEX, checkedAtMs: cache.checkedAtMs, stale: stale || cache.partial },
  };
}
export function resetCnCalendarCacheForTests(): void { cache = null; }
