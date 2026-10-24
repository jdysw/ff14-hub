import {z} from 'zod';
import {fishDigestSchema,fishRuleSchema,fishWindows,type FishDigestSettings,type EventCalendarItem} from '@ff14-hub/shared';
import type {Env} from '../../env';
import {readOfficialCalendarSnapshot} from '../events/calendar-snapshot';
import {refreshOfficialCalendarSnapshot} from '../events/calendar-refresh';
import {applyCalendarEdits} from '../events/calendar-editor';
import {CN_CALENDAR_CACHE_MS} from '../events/calendar-feed';
const DAY=86_400_000,OFFSET=8*3_600_000;
export function nextDigestAt(now:number,time:string){const [hours,minutes]=time.split(':').map(Number);const today=Math.floor((now+OFFSET)/DAY)*DAY-OFFSET+hours!*3_600_000+minutes!*60_000;return today>now?today:today+DAY;}
const digestFishSchema=z.object({id:z.number().int().positive(),name:z.string().max(100),location:z.string().max(200),rule:fishRuleSchema.nullable()});
type Catalog={fish:z.infer<typeof digestFishSchema>[]};
type DigestRow={time:number;end:number;name:string;location:string;region:string;candidate:boolean};
const digestDate=(stamp:number)=>new Date(stamp+OFFSET).toISOString().slice(0,10);
const digestClock=(stamp:number)=>new Date(stamp+OFFSET).toISOString().slice(11,16);
/** 临期活动与两日鱼窗分开格式化，保留原有日界限与输出顺序。 */
function appendDeadlineRows(text:string[],settings:FishDigestSettings,now:number,events:EventCalendarItem[]):number{
  if(!settings.eventEndDays.length)return 0;
  text.push('活动截止提醒','');
  const ending=events.filter(item=>item.endsAt!==null&&item.endsAt>now&&settings.eventEndDays.includes(Math.ceil((item.endsAt-now)/DAY) as 1|3)).sort((a,b)=>a.endsAt!-b.endsAt!);
  for(const item of ending){text.push(`${item.title} · 距结束不足 ${Math.ceil((item.endsAt!-now)/DAY)} 天 · ${digestDate(item.endsAt!)} ${digestClock(item.endsAt!)}`,'');}
  if(!ending.length)text.push('没有达到所选提前天数的活动。','');
  return ending.length;
}
function appendDailyRows(text:string[],rows:DigestRow[],settings:FishDigestSettings,start:number,now:number):void{
  for(let day=0;day<2&&settings.targets.length>0;day++){
    const from=start+day*DAY,to=from+DAY;
    text.push(`${day===0?'今天':'明天'} ${digestDate(from)}`,'');
    const items=rows.filter(row=>row.time<to&&row.end>from);
    for(const row of items){text.push(`${digestClock(Math.max(from,row.time))}–${row.end>=to?'24:00':digestClock(row.end)} ${row.name} · ${row.location}（${row.region}）${row.candidate?' [候选]':''}${row.end<=now?' [已过]':''}`,'');}
    if(items.length===0)text.push('没有符合时间天气规则的有限窗口。','');
  }
}
export function renderFishDigest(settings:FishDigestSettings,now:number,catalogs:Partial<Record<'cn'|'global',Catalog>>,events:EventCalendarItem[]=[]){
  const start=Math.floor((now+OFFSET)/DAY)*DAY-OFFSET;
  const rows:DigestRow[]=[];
  let unverified=0;
  for(const target of settings.targets){const fish=catalogs[target.region]?.fish.find(item=>item.id===target.fishId);
    if(!fish?.rule||fish.rule.conditions.some(c=>c.kind==='unknown')){unverified++;continue;}
    for(const window of fishWindows({region:target.region,rules:[fish.rule],from:start,to:start+2*DAY})){
      if(!window.unrestricted)rows.push({time:window.startsAtUtcMs,end:window.endsAtUtcMs,name:fish.name,location:fish.location,region:target.region==='cn'?'国服':'国际服',candidate:window.candidateOnly});
    }
  }
  rows.sort((a,b)=>a.time-b.time||a.name.localeCompare(b.name,'zh-CN'));
  const text=['FF14 每日汇总（北京时间）',''];
  if(rows.some(row=>row.candidate))text.push('候选鱼窗来自社区时间天气规则；鱼饵、鱼识及技能条件仍需另行满足。','');
  const endingCount=appendDeadlineRows(text,settings,now,events);
  appendDailyRows(text,rows,settings,start,now);
  if(unverified)text.push(`另有 ${unverified} 条鱼缺少规则或包含未知机制，请在网页中确认，未编造可钓时间。`);
  return {title:`FF14 每日汇总 · ${digestDate(start)}`,body:text.join('\n'),actionable:rows.length>0||endingCount>0};
}
export async function planDailyFishDigests(env:Env,now:number){
  const rows=await env.DB.prepare('SELECT id,digest_json FROM local_push_devices WHERE digest_next_at<=? AND expires_at>? ORDER BY digest_next_at LIMIT 5').bind(now,now).all<{id:string;digest_json:string}>();
  const catalogs:Partial<Record<'cn'|'global',Catalog>>={};
  const rawCatalogs:Partial<Record<'cn'|'global',unknown[]>>={};
  let events:EventCalendarItem[]|undefined;
  for(const row of rows.results){
    const settings=fishDigestSchema.parse(JSON.parse(row.digest_json) as unknown);
    if(!settings.enabled){continue;}
    for(const region of new Set(settings.targets.map(target=>target.region))){
      if(!rawCatalogs[region]){
        const response=await env.ASSETS.fetch(new Request('https://assets.invalid/fishing/catalog-'+region+'.json'));
        if(!response.ok){throw new Error('digest_catalog_unavailable');}
        const raw=await response.json<{fish?:unknown}>();
        if(!Array.isArray(raw.fish)||raw.fish.length>5000){throw new Error('digest_catalog_invalid');}rawCatalogs[region]=raw.fish as unknown[];
      }
      const wanted=new Set(settings.targets.filter(target=>target.region===region).map(target=>target.fishId));
      catalogs[region]={fish:rawCatalogs[region].filter((item):item is {id:number}=>item!==null&&typeof item==='object'&&'id' in item&&typeof item.id==='number'&&wanted.has(item.id)).map(item=>digestFishSchema.parse(item))};
    }
    if(settings.eventEndDays.length&&events===undefined){
      let snapshot=await readOfficialCalendarSnapshot(env.DB);
      if(!snapshot||now-snapshot.source.checkedAtMs>=CN_CALENDAR_CACHE_MS){await refreshOfficialCalendarSnapshot(env.DB);snapshot=await readOfficialCalendarSnapshot(env.DB)??snapshot;}
      events=snapshot?(await applyCalendarEdits(env.DB,snapshot)).events:[];
    }
    const content=renderFishDigest(settings,now,catalogs,events??[]),day=Math.floor((now+OFFSET)/DAY);
    if(!content.actionable){await env.DB.prepare('UPDATE local_push_devices SET digest_next_at=? WHERE id=? AND digest_next_at<=?').bind(nextDigestAt(now,settings.time),row.id,now).run();continue;}
    // Daily job key deduplicates concurrent ticks. No per-fish background jobs.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO local_push_jobs(device_id,job_key,payload,due_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(device_id,job_key) DO NOTHING`)
        .bind(row.id,'digest:'+day,JSON.stringify({key:'digest:'+day,...content,dueAt:now,expiresAt:now+6*3_600_000}),now,now+6*3_600_000),
      env.DB.prepare('UPDATE local_push_devices SET digest_next_at=? WHERE id=? AND digest_next_at<=?').bind(nextDigestAt(now,settings.time),row.id,now),
    ]);
  }
}
