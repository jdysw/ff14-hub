/**
 * 盛趣国服活动资讯只读适配器。仅访问固定的官方新闻列表及详情接口。
 * 这是“官方公告 API”，并非官方活动日程 API：不能以发布时间推断活动起止。
 */
import type { EventCalendarItem, EventCalendarResponse } from '@ff14-hub/shared';

const HOST = 'https://cqnews.web.sdo.com';
const NEWS_INDEX = 'https://ff.web.sdo.com/web8/index.html#/newstab/newslist';
export const CN_CALENDAR_CACHE_MS = 6 * 60 * 60_000;
const STALE_MS = 12 * 60 * 60_000;
type NewsCode='5310'|'5311'|'5203';
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
function isAsciiWordCode(code:number):boolean{
  return code===95||(code>=48&&code<=57)||(code>=65&&code<=90)||(code>=97&&code<=122);
}
/** 单一 HTML 标签的线性扫描；无需反复对未闭合标签后的长文本做正则回溯。 */
function stripOfficialBlock(html:string,tag:string):string{
  const lower=html.toLowerCase(),chunks:string[]=[];
  let cursor=0,last=0;
  const prefix='<'+tag,closing='</'+tag+'>';
  while(cursor<html.length){
    const open=lower.indexOf(prefix,cursor);
    if(open<0)break;
    // 仅识别 script/style 标签本身，不剔除 scripted / stylesheet。
    if(isAsciiWordCode(lower.codePointAt(open+prefix.length)??-1)){
      cursor=open+prefix.length;
      continue;
    }
    const tagEnd=lower.indexOf('>',open+prefix.length);
    if(tagEnd<0)break;
    const close=lower.indexOf(closing,tagEnd+1);
    if(close<0)break;
    chunks.push(html.slice(last,open),' ');
    last=close+closing.length;
    cursor=last;
  }
  if(!chunks.length)return html;
  chunks.push(html.slice(last));
  return chunks.join('');
}
/** 只移除可执行代码区块；保留普通文字和相似的非代码标签。 */
function stripOfficialExecutableBlocks(html:string):string{
  return stripOfficialBlock(stripOfficialBlock(html,'script'),'style');
}

/** 线性剥离 HTML 标签，避免多个未闭合 '<' 触发正则重复回溯。 */
function stripOfficialTags(html: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open < 0) break;
    const close = html.indexOf('>', open + 1);
    if (close < 0) break;
    chunks.push(html.slice(cursor, open), ' ');
    cursor = close + 1;
  }
  chunks.push(html.slice(cursor));
  return chunks.join('');
}

/** 仅解析紧随“活动时间/活动期间”的两个完整日期时间；其他含糊日期一律不猜。 */
export function extractOfficialActivityRange(html: string): { startsAt: number; endsAt: number } | null {
  const plain = stripOfficialTags(stripOfficialExecutableBlocks(html))
    .replace(/&nbsp;|&#160;/gi, ' ')
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

/** Keep a confirmed start when the official ending is a named maintenance, never invent its date. */
export function extractOfficialActivityTiming(html: string): { startsAt: number; endsAt: number | null; endCondition?: string } | null {
  const complete = extractOfficialActivityRange(html);
  if (complete) return complete;
  const plain = stripOfficialTags(stripOfficialExecutableBlocks(html))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/[\u3000\s]+/g, ' ').slice(0, 100_000);
  // 将日期、分隔符和维护条件分开匹配，避免单个高复杂度正则。
  for (const marker of plain.matchAll(/活动时间|活动期间|举办时间|起止时间/g)) {
    let remaining = plain.slice((marker.index ?? 0) + marker[0].length).trimStart();
    if (remaining.startsWith('：') || remaining.startsWith(':')) {
      remaining = remaining.slice(1).trimStart();
    }
    const date = /^(\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(remaining);
    if (!date) continue;
    remaining = remaining.slice(date[0].length).trimStart();
    if (!'至到~～—－–-'.includes(remaining[0] ?? '')) continue;
    remaining = remaining.slice(1).trimStart();
    const ending = /^(\d{1,2}\.\d{1,2}版本(?:更新)?维护(?:开始)?前)/.exec(remaining);
    if (!ending) continue;
    const startsAt = chinaTimestamp(date[1] ?? '');
    if (startsAt !== null) return { startsAt, endsAt: null, endCondition: ending[1]! };
  }
  return null;
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
  const content = stripOfficialTags(stripOfficialExecutableBlocks(html))
    .replace(/&nbsp;|&#160;/gi, ' ')
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
  let completedEnd = '';
  if (/^\d{4}年/.test(rawEnd)) completedEnd = rawEnd;
  else if (firstYear !== undefined && lastMonth >= firstMonth) completedEnd = firstYear + '年' + rawEnd;
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

async function newsCategory(code: NewsCode, signal?:AbortSignal): Promise<Record<string, unknown>[]> {
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
function officialEntry(row: Record<string, unknown>, code: NewsCode): OfficialEntry | null {
  const id = typeof row['Id'] === 'number' ? row['Id'] : Number(row['Id']);
  const title = clean(row['Title']);
  if (!Number.isSafeInteger(id) || id <= 0 || !title) return null;
  // News is broader than activities; retain explicit event/release signals, not every news post.
  if(code==='5310'&&!/活动|联动|正式登场|限时|季节|庆典|转播|通行证|免费畅玩|签到/.test(title+' '+clean(row['Summary'],600)))return null;
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
function combineEntry(existing: OfficialEntry, current: OfficialEntry, code: NewsCode): OfficialEntry {
  // 5311 公告详情通常有完整正文；5203 通常携带完整官网活动专题链接。
  return {
    ...existing,
    published: existing.published >= current.published ? existing.published : current.published,
    detailId: code === '5311'||code==='5310' ? current.id : existing.detailId,
    projectUrl: existing.projectUrl ?? current.projectUrl,
    sourceUrl: current.projectUrl ?? existing.projectUrl ?? existing.sourceUrl,
    description: existing.description || current.description,
  };
}
function deduplicate(rows: {
  code: NewsCode;
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
  const sources = await Promise.allSettled([newsCategory('5311',signal), newsCategory('5203',signal),newsCategory('5310',signal)]);
  const successful: { code: NewsCode; values: Record<string, unknown>[] }[] = [];
  const first = sources[0];
  const second = sources[1];
  if (first?.status === 'fulfilled') successful.push({ code: '5311', values: first.value });
  if (second?.status === 'fulfilled') successful.push({ code: '5203', values: second.value });
  const third=sources[2];if(third?.status==='fulfilled')successful.push({code:'5310',values:third.value});
  if (successful.length === 0) throw new Error('official_sources_unavailable');

  const entries = deduplicate(successful);
  // Independent per-category budgets prevent a busy news feed starving long-running activities.
  // At most 3 lists + 36 details + 8 landing pages: below the free Worker subrequest limit.
  const detailKeys=new Set(successful.flatMap(group=>deduplicate([group]).slice(0,12).map(entry=>entryKey(entry.title))));
  const events: EventCalendarItem[] = entries.map((entry) => ({
    id: 'official:' + entry.id, region: 'cn',
    title: entry.title, description: entry.description, category: entry.category,
    location: '', startsAt: null, endsAt: null, allDay: false, sourceUrl: entry.sourceUrl,
  }));

  const selected=entries.map((entry,index)=>({entry,event:events[index]!})).filter(({entry})=>detailKeys.has(entryKey(entry.title)));
  let landingBudget=8,detailFailures=0;
  for (let i = 0; i < selected.length; i += 6) {
    await Promise.all(selected.slice(i,i+6).map(async ({entry,event}) => {
      const content = await articleDetail(entry.detailId,signal);
      if(content===null)detailFailures++;
      let range = content === null ? null : extractOfficialActivityTiming(content);
      const linkedProject=content?.matchAll(/href\s*=\s*["']([^"']+)["']/gi);
      const projectUrl=entry.projectUrl??(linkedProject?[...linkedProject].map(m=>officialProjectUrl(m[1])).find(Boolean)??null:null);
      if (range === null && projectUrl !== null&&landingBudget>0) {
        landingBudget--;
        const landing = await officialHtml(projectUrl,signal);
        const complete=landing===null?null:extractOfficialLandingRange(landing);
        if(complete)range=complete;
      }
      if (range !== null) {
        event.startsAt = range.startsAt;
        event.endsAt = range.endsAt;
        // Existing strict clients accept description; preserve the ending without a wire-contract change.
        if('endCondition' in range&&range.endCondition)event.description=[event.description.slice(0,450),'活动结束条件：'+range.endCondition].filter(Boolean).join('\n');
      }
    }));
  }
  signal?.throwIfAborted();
  console.info(JSON.stringify({event:'official_calendar_coverage',categories:successful.map(group=>({code:group.code,count:group.values.length})),discovered:events.length,detailsChecked:selected.length,detailFailures,scheduled:events.filter(e=>e.startsAt!==null&&e.endsAt!==null).length,startOnly:events.filter(e=>e.startsAt!==null&&e.endsAt===null).length,detailsDeferred:entries.length-selected.length}));
  cache = { checkedAtMs: Date.now(), events, partial: detailFailures>0||sources.some((value) => value.status === 'rejected') };
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
