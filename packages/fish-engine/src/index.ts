import { z } from 'zod';

export const regionSchema = z.enum(['cn', 'global']);
export const verificationSchema = z.enum(['verified', 'unverified', 'incomplete']);
export type FishRegion = z.infer<typeof regionSchema>;
export const ET_HOUR_MS = 175_000;
export const ET_DAY_MS = ET_HOUR_MS * 24;
export const WEATHER_PERIOD_MS = ET_HOUR_MS * 8;
const MAX_UTC = Date.UTC(2100, 0, 1);
export const utcSchema = z.number().int().min(0).max(MAX_UTC);

export function eorzeaTime(utcMs: number): { day: number; hour: number; minute: number } {
  utcSchema.parse(utcMs);
  return { day: Math.floor(utcMs / ET_DAY_MS), hour: Math.floor(utcMs / ET_HOUR_MS) % 24,
    minute: Math.floor((utcMs % ET_HOUR_MS) * 60 / ET_HOUR_MS) };
}

/** Adapted from node-eorzea-weather, MIT, 900314c8. See THIRD_PARTY_NOTICES.md. */
export function forecastTarget(utcMs: number): number {
  utcSchema.parse(utcMs);
  const seconds = Math.floor(utcMs / 1000);
  const bell = seconds / 175;
  const increment = (bell + 8 - (bell % 8)) % 24;
  const days = Math.floor(seconds / 4200) >>> 0;
  const base = days * 100 + increment;
  const step1 = ((base << 11) ^ base) >>> 0;
  return (((step1 >>> 8) ^ step1) >>> 0) % 100;
}

export const weatherRateSchema = z.object({ weather: z.string().min(1).max(60), chance: z.number().int().min(1).max(100) }).strict();
export const weatherRatesSchema = z.array(weatherRateSchema).min(1).max(20)
  .refine((rates) => rates.reduce((sum, rate) => sum + rate.chance, 0) === 100, '天气概率合计须为100');
export type WeatherRates = z.infer<typeof weatherRatesSchema>;
export function weatherAt(utcMs: number, rates: WeatherRates): string {
  const target = forecastTarget(utcMs);
  let threshold = 0;
  for (const rate of weatherRatesSchema.parse(rates)) {
    threshold += rate.chance;
    if (target < threshold) return rate.weather;
  }
  throw new RangeError('invalid weather table');
}

export const fishRuleSchema = z.object({
  schemaVersion: z.literal(1), region: regionSchema, fishId: z.number().int().positive(),
  version: z.string().min(1).max(80), zoneId: z.string().min(1).max(80),
  startHour: z.number().min(0).max(24), endHour: z.number().min(0).max(24),
  weatherRates: weatherRatesSchema,
  currentWeather: z.array(z.string().min(1).max(60)).max(20),
  previousWeather: z.array(z.string().min(1).max(60)).max(20),
  // Additional mechanisms remain explicit requirements, never silently treated as satisfied.
  conditions: z.array(z.object({ kind: z.enum(['intuition', 'predators', 'bait', 'folklore', 'fishEyes', 'unknown']),
    description: z.string().min(1).max(300) }).strict()).max(20),
  validationStatus: verificationSchema,
}).strict().refine((r) => r.startHour !== r.endHour, '全天请显式使用0到24小时')
  .refine((r) => [...r.currentWeather, ...r.previousWeather].every((w) => r.weatherRates.some((rate) => rate.weather === w)), '条件引用未知天气');
export type FishRule = z.infer<typeof fishRuleSchema>;
export const fishSourceSchema = z.object({ url: z.url().startsWith('https://'), version: z.string().min(1).max(100),
  fetchedAt: utcSchema, authorizationStatus: z.enum(['permitted','unverified']), verificationStatus: verificationSchema }).strict();
export const fishRecordSchema = z.object({ id: z.number().int().positive(), region: regionSchema,
  name: z.string().min(1).max(100), fishType: z.enum(['normal','big','legendary']),
  source: fishSourceSchema, rule: fishRuleSchema, demo: z.boolean() }).strict()
  .refine((f) => f.region === f.rule.region && f.id === f.rule.fishId, '规则与鱼类身份不一致');
export type FishRecord = z.infer<typeof fishRecordSchema>;
export const fishDataBundleSchema = z.object({ schemaVersion: z.literal(1), region: regionSchema,
  records: z.array(fishRecordSchema).max(5000) }).strict().refine((b) =>
  b.records.every((f) => f.region === b.region) && new Set(b.records.map((f) => f.id)).size === b.records.length, '区服或ID不一致');
export interface FishWindow {
  occurrenceKey: string; region: FishRegion; fishId: number; ruleVersion: string;
  startsAtUtcMs: number; endsAtUtcMs: number;
  weatherChain: { previous: string; current: string };
  validationStatus: z.infer<typeof verificationSchema>; candidateOnly: boolean;
  conditions: FishRule['conditions'];
}

/** Returns full intervals intersecting [from,to), never clipped identities. */
export function fishWindows(input: { region: FishRegion; rules: readonly FishRule[]; from: number; to: number }): FishWindow[] {
  const { region, from, to } = input;
  regionSchema.parse(region); utcSchema.parse(from); utcSchema.parse(to);
  if (to <= from || to - from > 168 * 3_600_000 || input.rules.length > 50) throw new RangeError('窗口查询超出计算上限');
  const result: FishWindow[] = [];
  for (const raw of input.rules) {
    const rule = fishRuleSchema.parse(raw);
    if (rule.region !== region) throw new RangeError('规则区服不匹配');
    // Time intervals never exceed one ET day; a one-day halo preserves stable starts.
    const firstDay = Math.max(0, Math.floor(from / ET_DAY_MS) - 1);
    const lastDay = Math.floor(to / ET_DAY_MS);
    for (let day = firstDay; day <= lastDay; day += 1) {
      const start = Math.round(day * ET_DAY_MS + rule.startHour * ET_HOUR_MS);
      const endHour = rule.endHour <= rule.startHour ? rule.endHour + 24 : rule.endHour;
      const end = Math.round(day * ET_DAY_MS + endHour * ET_HOUR_MS);
      for (let period = Math.floor(start / WEATHER_PERIOD_MS) * WEATHER_PERIOD_MS; period < end; period += WEATHER_PERIOD_MS) {
        const current = weatherAt(period, rule.weatherRates);
        // At the Unix origin there is no supported preceding period. Reject constrained chains.
        if (period === 0 && rule.previousWeather.length > 0) continue;
        const previous = period === 0 ? 'unknown' : weatherAt(period - WEATHER_PERIOD_MS, rule.weatherRates);
        if (rule.currentWeather.length > 0 && !rule.currentWeather.includes(current)) continue;
        if (rule.previousWeather.length > 0 && !rule.previousWeather.includes(previous)) continue;
        const begins = Math.max(start, period);
        const ends = Math.min(end, period + WEATHER_PERIOD_MS);
        if (begins >= to || ends <= from) continue;
        const incomplete = rule.conditions.length > 0 || rule.validationStatus === 'incomplete';
        result.push({ occurrenceKey: `${region}:${String(rule.fishId)}:${rule.version}:${String(begins)}`,
          region, fishId: rule.fishId, ruleVersion: rule.version, startsAtUtcMs: begins, endsAtUtcMs: ends,
          weatherChain: { previous, current }, validationStatus: incomplete ? 'incomplete' : rule.validationStatus,
          candidateOnly: incomplete || rule.validationStatus !== 'verified', conditions: rule.conditions });
        if (result.length > 5000) throw new RangeError('窗口结果超出上限，请缩小范围');
      }
    }
  }
  return result.sort((a,b) => a.startsAtUtcMs - b.startsAtUtcMs || a.fishId - b.fishId);
}
