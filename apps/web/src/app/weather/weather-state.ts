import {useEffect,useState} from 'react';
import {z} from 'zod';
import {loadWeatherCatalog,type WeatherCatalog} from './weather';
const key='ff14-hub:weather-places:v1',changed='ff14-hub:weather-places-changed';
const preferencesSchema=z.object({selected:z.number().int().positive(),favorites:z.array(z.number().int().positive()).max(6).refine(ids=>new Set(ids).size===ids.length)}).strict();
export type WeatherPreferences=z.infer<typeof preferencesSchema>;
export function readWeatherPreferences():WeatherPreferences{
  try{const result=preferencesSchema.safeParse(JSON.parse(localStorage.getItem(key)??'null'));if(result.success){return result.data;}}catch{/* Preferences are optional. */}
  return {selected:134,favorites:[134,148,145]};
}
export function saveWeatherPreferences(value:WeatherPreferences){
  const data=preferencesSchema.parse(value);
  try{localStorage.setItem(key,JSON.stringify(data));}catch{return false;}
  window.dispatchEvent(new Event(changed));return true;
}
export function useWeatherPreferences(){
  const [value,setValue]=useState(readWeatherPreferences);
  useEffect(()=>{
    const update=()=>setValue(readWeatherPreferences());
    const storage=(event:StorageEvent)=>{if(event.key===key||event.key===null){update();}};
    window.addEventListener(changed,update);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener(changed,update);window.removeEventListener('storage',storage);};
  },[]);
  const save=(next:WeatherPreferences)=>{const persisted=saveWeatherPreferences(next);if(!persisted){setValue(next);}return persisted;};
  return [value,save] as const;
}
export function useWeatherCatalog(){
  const [data,setData]=useState<WeatherCatalog|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    let alive=true;
    void loadWeatherCatalog().then(value=>{if(alive){setData(value);setError('');}})
      .catch(()=>{if(alive){setError('地图天气表暂时无法读取，请联网后重试。');}});
    return()=>{alive=false;};
  },[retry]);
  return {data,error,retry:()=>setRetry(value=>value+1)};
}
export function useEorzeaClock(){
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    const update=()=>setNow(Date.now());
    const timer=window.setInterval(update,1000);
    window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
    return()=>{clearInterval(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};
  },[]);
  return now;
}
