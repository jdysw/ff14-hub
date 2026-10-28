import type {EventCalendarItem,FishRegion} from '@ff14-hub/shared';
import type {CatalogFish} from '../fish/catalog';
import type {BrowserLink} from './directory-links';
export type FeatureTarget='plan'|'events'|'pvp'|'notes'|'market'|'sync'|'backup'|'notifications';
export const SEARCH_FEATURES:readonly {id:FeatureTarget;title:string;description:string}[]=[
  {id:'notes',title:'我的待办',description:'备忘 笔记 今日计划 任务 提醒 截止时间 倒计时'},
  {id:'events',title:'活动日历',description:'国服 官方 进行中 未来 活动 ICS'},
  {id:'pvp',title:'PVP 地图轮换',description:'纷争前线 水晶冲突 战场 地图'},
  {id:'market',title:'市场行情',description:'Universalis 物价 物品搜索 跨服比价 市场板 交易 在售 成交 HQ NQ'},
  {id:'sync',title:'数据同步',description:'鱼糕 WebDAV S3 跨设备 云端同步'},
  {id:'backup',title:'备份与恢复',description:'导出 导入 本机个人数据'},
  {id:'notifications',title:'通知设置',description:'提醒 邮件 Server 酱 权限'},
];
const normalize=(text:string)=>text.normalize('NFKC').toLocaleLowerCase().trim();
function matched<T>(items:readonly T[],query:string,title:(item:T)=>string,content:(item:T)=>string):T[]{
  const term=normalize(query),parts=term.split(/\s+/).filter(Boolean);
  if(!term)return [];
  const score=(item:T)=>{
    const name=normalize(title(item));
    if(name===term){return 0;}
    if(name.startsWith(term)){return 1;}
    return 2;
  };
  return items.filter(item=>parts.every(part=>normalize(content(item)).includes(part)))
    .sort((a,b)=>score(a)-score(b)||title(a).localeCompare(title(b),'zh-CN'));
}
export function searchSite(query:string,links:readonly BrowserLink[],fish:readonly CatalogFish[],events:readonly EventCalendarItem[]){
  return {links:matched(links,query,l=>l.title,l=>[l.title,l.description,l.category,l.url,...l.tags,...l.aliases].join(' ')),
    fish:matched(fish,query,f=>f.name,f=>[f.name,f.englishName,...(f.aliases??[]),f.acquisitionContext?.label??'',...(f.acquisitionContext?.locations.map(s=>s.name)??[]),String(f.id),f.zone,f.location,...f.bait].join(' ')),
    events:matched(events,query,e=>e.title,e=>[e.title,e.category,e.description].join(' ')),
    features:query.trim()?matched(SEARCH_FEATURES,query,f=>f.title,f=>f.title+' '+f.description):[...SEARCH_FEATURES]};
}
export interface FishSearchTarget{fishId:number;region:FishRegion}
