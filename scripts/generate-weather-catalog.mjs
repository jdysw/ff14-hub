import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const endpoint='https://xivapi-v2.xivcdn.com/api/sheet/TerritoryType';
const fields='PlaceName.Name,PlaceNameRegion.Name,ExVersion.Name,TerritoryIntendedUse.Name,WeatherRate.Rate,WeatherRate.Weather[].Name';
/** Ordinary towns/fields and residential districts; omit instance/script-controlled territories. */
const supportedUses=new Set([0,1,13]);
export function buildWeatherCatalog(records,version,generatedAt){
 const byName=new Map(),excluded=[];
 for(const row of records){
  const f=row.fields,use=f.TerritoryIntendedUse.row_id,name=f.PlaceName.fields.Name;
  if(!supportedUses.has(use)||!name||!f.WeatherRate.row_id)continue;
  const table=f.WeatherRate.fields;
  const rates=table.Rate.flatMap((chance,index)=>chance>0?[{weather:table.Weather[index]?.fields.Name??'',chance}]:[]);
  if(rates.length===0)continue;
  if(rates.some(rate=>!rate.weather)||rates.reduce((sum,rate)=>sum+rate.chance,0)!==100){
   excluded.push({id:row.row_id,name,reason:'天气概率缺失或合计不为 100'});continue;
  }
  const zone={id:row.row_id,name,region:f.PlaceNameRegion.fields.Name||'其他地区',
    expansion:f.ExVersion.fields.Name||'重生之境',kind:use===1?'field':'town',...(use===13?{kind:'housing'}:{}),rates};
  // Prefer the active residential district over an abandoned town entry sharing its name.
  const old=byName.get(name);
  if(!old||use===13&&old.kind!=='housing'||old.kind===zone.kind&&zone.id<old.id)byName.set(name,zone);
 }
 return {schemaVersion:1,region:'cn',version,generatedAt,source:endpoint,
  scope:'普通城镇、野外和住宅区；不含副本、特殊探索与剧情强制天气。',
  excluded,zones:[...byName.values()].sort((a,b)=>a.id-b.id)};
}
async function download(){
 const rows=[];let after=0,version;
 for(let page=0;page<12;page++){
  const params=new URLSearchParams({language:'chs',limit:'500',fields,...(after?{after:String(after)}:{}),...(version?{version}:{})});
  const response=await fetch(endpoint+'?'+params,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Weather source HTTP '+response.status);
  const body=await response.json();
  if(version&&body.version!==version)throw new Error('Source version changed during pagination');
  version=body.version;rows.push(...body.rows);
  if(body.rows.length<500)return {version,records:rows};
  const next=body.rows.at(-1).row_id;
  if(next<=after)throw new Error('Weather pagination did not advance');
  after=next;
 }
 throw new Error('Weather pagination exceeded its bound');
}
async function main(){
 const input=process.argv.find(arg=>arg.startsWith('--input='))?.slice(8);
 if(!input&&!process.argv.includes('--refresh'))throw new Error('Use --refresh or --input=path; normal builds never access the upstream API.');
 const source=input?JSON.parse(await readFile(input,'utf8')):await download();
 const catalog=buildWeatherCatalog(source.records,source.version,new Date().toISOString());
 if(catalog.zones.length<60)throw new Error('Incomplete weather source; existing snapshot was not replaced');
 const target=new URL('../apps/web/public/weather/catalog-cn.json',import.meta.url);
 await mkdir(new URL('.',target),{recursive:true});
 await writeFile(target,JSON.stringify(catalog,null,2)+'\n');
 console.log('Weather snapshot:',catalog.zones.length,'maps;',catalog.excluded.length,'excluded;',catalog.version);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await main();}
