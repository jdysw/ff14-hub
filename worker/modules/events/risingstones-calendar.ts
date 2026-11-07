import {z} from 'zod';
import type {EventCalendarItem,EventCalendarResponse} from '@ff14-hub/shared';
import {boundedBody,readCnCalendar} from './calendar-feed.ts';
import {mergeOfficialActivityUpdates} from './calendar-activities.ts';

const endpoint = 'https://apiff14risingstones.web.sdo.com/api/home/active/calendar/getActiveCalendarMonth';
const ttl = 60 * 60_000;
const retryDelay = 60_000;
// These three relationships were checked against the official event landing pages.
const knownIds: Record<number,string> = {110:'official:394275',102:'official:394486',99:'official:391233'};
const officialUrl = z.string().url().max(2000).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password &&
    (url.hostname === 'sdo.com' || url.hostname.endsWith('.sdo.com'));
});
const seconds = z.number().int().min(946684800).max(4102444800);
const payloadSchema = z.object({
  code:z.literal(10000),
  data:z.array(z.object({
    id:z.number().int().positive(),
    name:z.string().trim().min(1).max(120),
    url:officialUrl,
    begin_time:seconds,
    end_time:seconds,
  }).refine(event => event.end_time > event.begin_time)).max(250),
});

export function parseRisingstonesCalendar(payload: unknown): EventCalendarItem[] {
  return payloadSchema.parse(payload).data.map(event => ({
    id:knownIds[event.id] ?? 'official:risingstones-'+event.id,
    region:'cn',title:event.name,description:'日程来自石之家官方活动月历。',
    category:'官方活动',location:'',sourceUrl:event.url,allDay:false,
    startsAt:event.begin_time * 1000,endsAt:event.end_time * 1000,
  }));
}

function landingKey(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin + url.pathname.replace(/\/$/,'') + url.search + url.hash;
  } catch {
    return null;
  }
}

export function mergeRisingstonesCalendar(primary: EventCalendarItem[], additions: EventCalendarItem[]) {
  const result = new Map(primary.map(event => [event.id,event]));
  const landingIds = new Map<string,string>();
  for (const event of primary) {
    const key = landingKey(event.sourceUrl);
    if (key) landingIds.set(key,event.id);
  }
  for (const event of additions) {
    const key = landingKey(event.sourceUrl);
    const id = landingIds.get(key ?? '') ?? event.id;
    const original = result.get(id);
    if (!original || original.description === '日程来自石之家官方活动月历。') {
      result.set(id,{...event,id});
      if (key) landingIds.set(key,id);
      continue;
    }
    // A maintenance-based ending is an explicit announcement condition, not a missing date.
    const conditionalEnd = original.description.includes('活动结束条件：');
    result.set(id,{
      ...original,
      startsAt:original.startsAt ?? event.startsAt,
      endsAt:conditionalEnd ? original.endsAt : original.endsAt ?? event.endsAt,
    });
  }
  return mergeOfficialActivityUpdates([...result.values()]);
}

let cached: {period:string; at:number; events:EventCalendarItem[]} | undefined;
let failure: {period:string; at:number} | undefined;

async function monthEvents(month: string, signal?: AbortSignal) {
  const response = await fetch(endpoint+'?month='+month,{
    headers:{Accept:'application/json'},redirect:'manual',
    signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('risingstones_calendar_unavailable');
  return parseRisingstonesCalendar(JSON.parse(await boundedBody(response)) as unknown);
}

export async function withRisingstonesCalendar(calendar: EventCalendarResponse, now = Date.now(), signal?: AbortSignal, force = false): Promise<EventCalendarResponse> {
  const date = new Date(now + 8 * 3_600_000);
  const months = [0,1].map(offset => new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+offset,1)).toISOString().slice(0,7));
  const period = months[0]!;
  let stale = false;
  const fresh = !force && cached?.period === period && now - cached.at < ttl;
  const retryPending = !force && failure?.period === period && now - failure.at < retryDelay;
  if (!fresh && !retryPending) {
    try {
      const batches = await Promise.all(months.map(month => monthEvents(month,signal)));
      const unique = new Map<string,EventCalendarItem>();
      for (const event of batches.flat()) {
        if (!unique.has(event.id)) unique.set(event.id,event);
      }
      cached = {period,at:now,events:[...unique.values()]};
      failure = undefined;
    } catch {
      failure = {period,at:now};
      stale = true;
    }
  } else {
    stale = !fresh;
  }
  const events = cached?.period === period ? cached.events : [];
  return {
    ...calendar,
    events:mergeRisingstonesCalendar(calendar.events,events),
    source:{...calendar.source,stale:calendar.source.stale || stale},
  };
}

/** Store the combined feed through the existing snapshot refresh path. */
export async function readCombinedCnCalendar(now = Date.now(),signal?: AbortSignal,force = false) {
  const primary = await readCnCalendar(now,signal,force);
  const combined = await withRisingstonesCalendar(primary,now,signal,force);
  // An optional calendar outage must not prevent a fresh news snapshot from being saved.
  return combined.source.stale ? primary : combined;
}
