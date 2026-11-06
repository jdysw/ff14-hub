import {createContext,useContext,useEffect,useState} from 'react';
import {z} from 'zod';
import {housingAreas,housingResponseSchema,housingSizes,housingUses,housingWorlds,type HousingPlot} from '@ff14-hub/shared/housing';
import {chinaDateTime} from '../events/public-calendar-utils';

export const states = ['状态待确认','报名中','结果公示','准备中','阶段已结束，待上报'];
export const housingFilters = [
  ['Area','住宅区',housingAreas], ['Size','尺寸',housingSizes],
  ['RegionType','用途',housingUses], ['State','抽签状态',states],
] as const;
type Filter = typeof housingFilters[number][0];
type Selection = Partial<Record<Filter,string>>;
type Preferences = {world: string; selection: Selection};
type Result = {plots: HousingPlot[]; fetchedAt: number; observedAt: number} | {error: true};
const storageKey = 'ff14-hub:housing-filters:v1';
const worlds = new Map(Object.values(housingWorlds).flatMap(group => [...group].map(([id,name]) => [String(id),name] as const)));
const preferencesSchema = z.object({
  world: z.string().refine(world => worlds.has(world)),
  selection: z.partialRecord(z.enum(['Area','Size','RegionType','State']),z.string()),
});

function readPreferences(): Preferences | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    const parsed = preferencesSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    const selection: Selection = {};
    for (const [key,,options] of housingFilters) {
      const choice = value.selection[key];
      if (typeof choice === 'string' && options.some((_,index) => String(index) === choice)) selection[key] = choice;
    }
    return {world:value.world,selection};
  } catch {
    return null;
  }
}

export function phase(plot: HousingPlot, now: number) {
  if (plot.EndTime > 0 && plot.EndTime * 1000 <= now) return 4;
  return plot.State;
}

export function displayTime(seconds: number) {
  return seconds > 0 ? chinaDateTime(seconds * 1000) : '—';
}

export function plotLocation(plot: HousingPlot) {
  return `${housingAreas[plot.Area]} ${plot.Slot + 1} 区 ${plot.ID} 号`;
}

export function participation(plot: HousingPlot) {
  return plot.UpdateTime > 0 && (plot.State === 1 || plot.State === 2) ? plot.Participate : '—';
}

export function useHousingState(showPreview: boolean, detailOpen: boolean) {
  const [preferences,setPreferences] = useState(readPreferences);
  const [refresh,setRefresh] = useState(0);
  const [result,setResult] = useState<Result | null>(null);
  const world = preferences?.world ?? '1167';
  const selection = preferences?.selection ?? {};
  const shouldLoad = detailOpen || (showPreview && preferences !== null);

  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/housing?world=${world}`, {signal:controller.signal, credentials:'omit'});
        if (!response.ok) throw new Error('Housing lookup failed');
        const value = housingResponseSchema.parse(await response.json());
        if (!controller.signal.aborted) setResult({...value, observedAt:Date.now()});
      } catch {
        if (!controller.signal.aborted) setResult({error:true});
      }
    };
    void load();
    return () => controller.abort();
  }, [world,refresh,shouldLoad]);

  const save = (next: Preferences) => {
    setPreferences(next);
    try {localStorage.setItem(storageKey,JSON.stringify(next));} catch {/* In-memory preferences remain usable. */}
  };
  const changeWorld = (next: string) => {
    setResult(null);
    save({world:next,selection});
  };
  const changeFilter = (key: Filter,value: string) => save({world,selection:{...selection,[key]:value}});
  const reload = () => {
    setResult(null);
    setRefresh(value => value + 1);
  };
  const now = result && 'observedAt' in result ? result.observedAt : 0;
  const plots = result && 'plots' in result ? result.plots.filter(plot =>
    plot.PurchaseType === 2 && housingFilters.every(([key]) => {
      const selected = selection[key];
      return !selected || selected === String(key === 'State' ? phase(plot,now) : plot[key]);
    })) : [];
  return {world,worldName:worlds.get(world),selection,hasPreferences:preferences!==null,result,now,plots,changeWorld,changeFilter,reload};
}

export const HousingContext = createContext<ReturnType<typeof useHousingState> | null>(null);
export function useHousing() {
  const state = useContext(HousingContext);
  if (!state) throw new Error('Missing housing context');
  return state;
}
