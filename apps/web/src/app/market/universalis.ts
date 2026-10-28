import {z} from 'zod';

const API='https://universalis.app/api/v2';
const ITEM_API='https://xivapi-v2.xivcdn.com/api';
export type Quality='all'|'nq'|'hq';
const id=z.number().int().positive().max(999999);
const price=z.number().finite().nonnegative();
const itemSchema=z.object({row_id:id,fields:z.object({Name:z.string().min(1).max(200),Icon:z.object({path:z.string()}).optional()})});
const worldsSchema=z.array(z.object({id:z.number().int().positive(),name:z.string().min(1)})).max(1000);
const centersSchema=z.array(z.object({name:z.string().min(1),region:z.string(),worlds:z.array(z.number().int().positive())})).max(100);
const listingSchema=z.object({listingID:z.string().max(120).nullish(),pricePerUnit:price,quantity:z.number().int().positive(),hq:z.boolean(),worldName:z.string().optional(),worldID:z.number().optional(),lastReviewTime:z.number().nonnegative().optional()});
const saleSchema=z.object({pricePerUnit:price,quantity:z.number().int().positive(),hq:z.boolean(),timestamp:z.number().nonnegative(),worldName:z.string().optional()});
export const marketSchema=z.object({
  itemID:id,lastUploadTime:z.number().nonnegative(),hasData:z.boolean().optional(),
  listings:z.array(listingSchema).max(1000).default([]),recentHistory:z.array(saleSchema).max(1000).default([]),
});
export type MarketData=z.infer<typeof marketSchema>;
export interface MarketItem {id:number;name:string;icon?:string}
export interface MarketCenter {name:string;region:string;worlds:{id:number;name:string}[]}
const cache=new Map<string,{expires:number;value:unknown}>();

async function request<T>(url:string,schema:z.ZodType<T>,signal:AbortSignal,ttl:number,refresh=false):Promise<T>{
  const cached=cache.get(url);
  if(!refresh&&cached&&cached.expires>Date.now()){signal.throwIfAborted();return cached.value as T;}
  const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:'application/json'}});
  if(!response.ok){
    if(response.status===429){throw new Error('查询过于频繁，请稍后再试。');}
    if(response.status===404){throw new Error('这个物品或服务器暂时没有行情，请换一个试试。');}
    throw new Error('行情服务暂时无法访问，请稍后重试。');
  }
  const parsed=schema.safeParse(await response.json());
  if(!parsed.success){throw new Error('数据格式暂时无法识别，请稍后重试。');}
  if(cache.size>=150){cache.delete(cache.keys().next().value!);}
  cache.set(url,{expires:Date.now()+ttl,value:parsed.data});
  return parsed.data;
}
function marketItem(item:z.infer<typeof itemSchema>):MarketItem{
  const path=item.fields.Icon?.path;
  const icon=path&&/^ui\/icon\/\d+\/\d+(?:_hr1)?\.tex$/.test(path)
    ?'https://v2.xivapi.com/api/asset/'+path+'?format=png':undefined;
  return {id:item.row_id,name:item.fields.Name,...(icon?{icon}:{})};
}
export function parseMarketItemId(input:string):number|null{
  const text=input.trim();
  if(/^\d+$/.test(text)){return id.safeParse(Number(text)).success?Number(text):null;}
  try{
    const url=new URL(text);
    if(url.protocol!=='https:'||url.hostname!=='universalis.app'||url.username||url.password){return null;}
    const match=/^\/market\/(\d+)\/?$/.exec(url.pathname);
    return match&&id.safeParse(Number(match[1])).success?Number(match[1]):null;
  }catch{return null;}
}
export async function loadMarketCenters(signal:AbortSignal):Promise<MarketCenter[]>{
  const [worlds,centers]=await Promise.all([
    request(API+'/worlds',worldsSchema,signal,21600000),
    request(API+'/data-centers',centersSchema,signal,21600000),
  ]);
  const names=new Map(worlds.map(world=>[world.id,world.name]));
  return centers.map(center=>({...center,worlds:center.worlds.flatMap(worldId=>{
    const name=names.get(worldId);return name?[{id:worldId,name}]:[];
  })})).filter(center=>center.worlds.length>0);
}
export async function searchMarketItems(input:string,signal:AbortSignal):Promise<MarketItem[]>{
  const text=input.trim();
  if(!text||text.length>80){throw new Error('请输入 1–80 个字符的物品名称或有效物品 ID。');}
  const itemId=parseMarketItemId(text);
  if(itemId){
    try{return [marketItem(await request(ITEM_API+'/sheet/Item/'+itemId+'?language=chs&fields=Name,Icon',itemSchema,signal,300000))];}
    catch(error){if(signal.aborted){throw error;}return [{id:itemId,name:'物品 #'+itemId}];}
  }
  if(/^\d+$/.test(text)||/^https?:/i.test(text)){throw new Error('请输入有效物品 ID，或 Universalis 的物品页面地址。');}
  const params=new URLSearchParams({sheets:'Item',query:'+Name~'+JSON.stringify(text)+' +ItemSearchCategory>=1',language:'chs',limit:'20',fields:'Name,Icon'});
  const result=await request(ITEM_API+'/search?'+params.toString(),z.object({results:z.array(itemSchema).max(100)}),signal,300000);
  return result.results.map(marketItem);
}
export function loadMarketData(scope:string,itemId:number,quality:Quality,signal:AbortSignal,refresh=false):Promise<MarketData>{
  id.parse(itemId);
  if(!scope||scope.length>60){throw new Error('请选择服务器或大区。');}
  const params=new URLSearchParams({listings:'40',entries:'30',fields:'itemID,lastUploadTime,hasData,listings.listingID,listings.pricePerUnit,listings.quantity,listings.hq,listings.worldName,listings.worldID,listings.lastReviewTime,recentHistory.pricePerUnit,recentHistory.quantity,recentHistory.hq,recentHistory.timestamp,recentHistory.worldName'});
  if(quality!=='all'){params.set('hq',quality==='hq'?'true':'false');}
  return request(API+'/'+encodeURIComponent(scope)+'/'+itemId+'?'+params.toString(),marketSchema,signal,60000,refresh);
}
type PriceRecord=MarketData['listings'][number]|MarketData['recentHistory'][number];
function recordIdentity(row:PriceRecord){
  if('listingID' in row&&row.listingID){return row.listingID;}
  const timestamp='timestamp' in row?row.timestamp:row.lastReviewTime;
  return JSON.stringify([timestamp??0,row.worldName??'',row.hq,row.pricePerUnit,row.quantity]);
}
/** Identical records remain distinct without tying identity to sort position. */
export function keyedMarketRows(rows:readonly PriceRecord[]){
  const occurrences=new Map<string,number>();
  return rows.map(row=>{
    const identity=recordIdentity(row),occurrence=occurrences.get(identity)??0;
    occurrences.set(identity,occurrence+1);
    return {key:identity+':'+occurrence,row};
  });
}
export function marketSummary(data:MarketData){
  const prices=data.listings.map(row=>row.pricePerUnit);
  const sales=data.recentHistory.map(row=>row.pricePerUnit).sort((a,b)=>a-b);
  const minimum=prices.length?Math.min(...prices):null;
  if(!sales.length){return {minimum,median:null};}
  const middle=Math.floor(sales.length/2);
  const median=sales.length%2?sales[middle]!:(sales[middle-1]!+sales[middle]!)/2;
  return {minimum,median};
}
