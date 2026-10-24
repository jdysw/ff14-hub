import { z } from 'zod';
export const FISH_SETS=['completed','pinned','alarmFish'] as const;
export type FishSet=typeof FISH_SETS[number];
export const SET_FIELDS={completed:'caught',pinned:'pinned',alarmFish:'alarm'} as const;
const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids=z.array(id).max(5000);
export type Json=z.infer<ReturnType<typeof z.json>>;
export type FishDocument={completed:number[];pinned:number[];alarmFish:number[]}&Record<string,Json>;
const knownSets=z.object({completed:ids,pinned:ids,alarmFish:ids});
// Validate without rebuilding dictionaries: rebuilding can silently drop reserved extension keys.
export const fishDocumentSchema=z.custom<FishDocument>((raw)=>{
  let nodes=0;
  const json=(value:unknown,depth:number):boolean=>{
    if(depth>30||++nodes>100000)return false;
    if(value===null||typeof value==='string'||typeof value==='boolean')return true;
    if(typeof value==='number')return Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value));
    if(typeof value!=='object')return false;
    const proto:unknown=Object.getPrototypeOf(value);
    if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)return false;
    if(Reflect.ownKeys(value).some((key)=>typeof key!=='string'))return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((d)=>!d.get&&!d.set&&json(d.value,depth+1));
  };
  return raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&json(raw,0)&&knownSets.safeParse(raw).success;
},'鱼糕格式或扩展字段不合法');
export const MAX_FISH_DOCUMENT_BYTES=1_048_576;

/** Bounded, data-only parse. Unknown extension fields and unknown numeric IDs survive. */
export function parseBoundedJson(text:string,maxBytes=MAX_FISH_DOCUMENT_BYTES):unknown{
  if(new TextEncoder().encode(text).byteLength>maxBytes)throw new RangeError('JSON文件超过大小上限');
  const raw:unknown=JSON.parse(text);let nodes=0;
  const check=(value:unknown,depth:number):void=>{
    if(depth>30||++nodes>100000)throw new RangeError('JSON结构过深或过大');
    if(Array.isArray(value))for(const item of value)check(item,depth+1);
    else if(value!==null&&typeof value==='object')for(const item of Object.values(value))check(item,depth+1);
  };
  check(raw,0);return raw;
}
export function parseFishDocument(text:string):FishDocument{return fishDocumentSchema.parse(parseBoundedJson(text));}
export function canonicalJson(value:Json|undefined):string{
  if(value===undefined)return 'undefined';
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value!==null&&typeof value==='object'){
    const keys=Object.keys(value).sort((a,b)=>{
      if(a<b){return -1;}
      if(a>b){return 1;}
      return 0;
    });
    const entries=keys.map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',');
    return '{'+entries+'}';
  }
  return JSON.stringify(value);
}
export function serializeFishDocument(document:FishDocument):string{
  const checked=fishDocumentSchema.parse(document);const text=canonicalJson(checked);
  if(new TextEncoder().encode(text).byteLength>MAX_FISH_DOCUMENT_BYTES)throw new RangeError('鱼糕文件超过1MiB上限');return text;
}
export type Replica='local'|'webdav'|'hub';
export interface MergeConflict{key:string;baseline:Json|undefined;values:Partial<Record<Replica,Json|undefined>>}
export interface MergeInput{
  baseline:FishDocument|null;local:FishDocument;webdav:FishDocument;hub:FishDocument;
  /** A changed revision counts as an edit even if its final boolean equals baseline. */
  touched?:Partial<Record<Replica,ReadonlySet<string>>>;
  resolutions?:ReadonlyMap<string,Replica|'baseline'>;
}
export function mergeFishDocuments(input:MergeInput):{document:FishDocument;conflicts:MergeConflict[]}{
  const conflicts:MergeConflict[]=[];
  const choose=(key:string,baseline:Json|undefined,values:Partial<Record<Replica,Json|undefined>>):Json|undefined=>{
    const entries=Object.entries(values) as [Replica,Json|undefined][];
    const edits=input.baseline===null?entries:entries.filter(([replica,value])=>canonicalJson(value)!==canonicalJson(baseline)||input.touched?.[replica]?.has(key));
    const unique=new Set(edits.map(([,value])=>canonicalJson(value)));
    if(unique.size<=1)return edits.length===0?baseline:edits[0]?.[1];
    const resolution=input.resolutions?.get(key);
    if(resolution==='baseline'&&input.baseline!==null)return baseline;
    if(resolution!==undefined&&resolution!=='baseline'&&Object.hasOwn(values,resolution))return values[resolution];
    conflicts.push({key,baseline,values});return baseline;
  };
  const entries:[string,Json][]=[];
  for(const field of FISH_SETS){
    const pool=new Set([...(input.baseline?.[field]??[]),...input.local[field],...input.webdav[field],...input.hub[field]]);
    const selected:number[]=[];
    const sourceSets={local:new Set(input.local[field]),webdav:new Set(input.webdav[field]),hub:new Set(input.hub[field])};
    const baseSet=new Set(input.baseline?.[field]??[]);
    for(const fishId of [...pool].sort((a,b)=>a-b)){
      if(choose(`${field}:${String(fishId)}`,input.baseline===null?undefined:baseSet.has(fishId),
        {local:sourceSets.local.has(fishId),webdav:sourceSets.webdav.has(fishId),hub:sourceSets.hub.has(fishId)})===true)selected.push(fishId);
    }
    entries.push([field,selected]);
  }
  // Hub has no authority over extension fields: they never enter its API.
  const keys=new Set([...Object.keys(input.baseline??{}),...Object.keys(input.local),...Object.keys(input.webdav)]);
  for(const key of keys){
    if((FISH_SETS as readonly string[]).includes(key))continue;
    const value=choose(`extra:${key}`,input.baseline?.[key],{local:input.local[key],webdav:input.webdav[key]});
    if(value!==undefined)entries.push([key,value]);
  }
  return {document:fishDocumentSchema.parse(Object.fromEntries(entries)),conflicts};
}
export interface SyncField{fishId:number;field:'caught'|'pinned'|'alarm';value:boolean;revision:number}
export function changedDocumentKeys(before:FishDocument|null,after:FishDocument):Set<string>{
  const keys=new Set<string>();
  for(const field of FISH_SETS){const old=new Set(before?.[field]??[]);const next=new Set(after[field]);
    for(const fishId of new Set([...old,...next]))if(old.has(fishId)!==next.has(fishId))keys.add(`${field}:${String(fishId)}`);}
  for(const key of new Set([...Object.keys(before??{}),...Object.keys(after)]))if(!(FISH_SETS as readonly string[]).includes(key)&&
    canonicalJson(before?.[key])!==canonicalJson(after[key]))keys.add(`extra:${key}`);
  return keys;
}
export function touchedSince(before:Readonly<Record<string,number>>,after:Readonly<Record<string,number>>):Set<string>{
  return new Set(Object.entries(after).filter(([key,revision])=>revision>(before[key]??0)).map(([key])=>key));
}
export interface SyncChange extends Omit<SyncField,'revision'>{expectedRevision:number}
export function fieldsToDocument(fields:readonly SyncField[],extensions?:FishDocument):FishDocument{
  const extras=Object.entries(extensions??{}).filter(([key])=>!(FISH_SETS as readonly string[]).includes(key));
  return fishDocumentSchema.parse(Object.fromEntries([...extras,...FISH_SETS.map((set)=>[set,fields.filter((f)=>f.field===SET_FIELDS[set]&&f.value).map((f)=>f.fishId).sort((a,b)=>a-b)])]));
}
export function documentChanges(document:FishDocument,fields:readonly SyncField[]):SyncChange[]{
  const changes:SyncChange[]=[];
  for(const set of FISH_SETS){
    const existing=new Map(fields.filter((f)=>f.field===SET_FIELDS[set]).map((f)=>[f.fishId,f]));const wanted=new Set(document[set]);
    for(const fishId of new Set([...wanted,...existing.keys()])){
      const old=existing.get(fishId);const value=wanted.has(fishId);
      if((old?.value??false)!==value)changes.push({fishId,field:SET_FIELDS[set],value,expectedRevision:old?.revision??0});
    }
  }
  return changes;
}
