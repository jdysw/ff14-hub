
function mappedDirectoryCategory({mappings,main,sub}:Readonly<{mappings:Record<string, string>;main:string;sub:string}>){
if(mappings[main]){return mappings[main]+(sub?' / '+sub:'');}
return undefined;
}
import {z} from 'zod';
export const categoryGroupSchema=z.object({name:z.string().trim().min(1).max(18),children:z.array(z.string().trim().min(1).max(18)).max(20).refine(items=>new Set(items).size===items.length,'子分类名称不能重复')}).strict();
export const DEFAULT_CATEGORIES=[
  {name:'官方与账号',children:['官网与公告','充值与商城','账号与服务']},
  {name:'入门与资料',children:['新人指南','百科与数据库','综合工具']},
  {name:'职业与副本',children:['职业与配装','副本攻略','战斗日志','战术与招募']},
  {name:'PVP',children:['入门与攻略','排名与资料']},
  {name:'生产与采集',children:['制作与配方','采集与天气','市场与物价']},
  {name:'钓鱼与海钓',children:['鱼窗与资料','海钓攻略']},
  {name:'狩猎与探索',children:['狩猎与FATE','特殊区域','探索笔记']},
  {name:'日常与收藏',children:['金碟与休闲','成就与收藏','特殊武器']},
  {name:'幻化与摄影',children:['幻化与染色','模型与摄影']},
  {name:'住房与经营',children:['买房与装修','无人岛','潜水艇与工坊','栽培']},
  {name:'社区与创作',children:['论坛与社区','创作者与直播','音乐与作品']},
  {name:'插件与开发',children:['插件与启动器','开发与数据']},
];
export function splitDirectoryCategory(value:string){const [main,...sub]=value.split(' / ');return {main:main||'个人网站',sub:sub.join(' / ')};}
export const managedHomeSchema=z.object({
  enabled:z.object({events:z.boolean(),fishing:z.boolean(),pvp:z.boolean(),notes:z.boolean()}).strict(),
  layout:z.enum(['auto','balanced','rows']),
  order:z.array(z.enum(['events','fishing','pvp','notes'])).length(4).refine(items=>new Set(items).size===4).default(['events','fishing','pvp','notes']),
}).strict();
export const DEFAULT_HOME={enabled:{events:true,fishing:true,pvp:true,notes:true},layout:'auto' as const,order:['events','fishing','pvp','notes'] as ('events'|'fishing'|'pvp'|'notes')[]};
export const managedPresentationSchema=z.object({categories:z.array(categoryGroupSchema).max(30).refine(groups=>new Set(groups.map(g=>g.name)).size===groups.length,'主分类名称不能重复'),home:managedHomeSchema,categoryAliases:z.record(z.string().max(80),z.string().min(1).max(80)).default({})}).strict();
export function resolveDirectoryCategory(value:string,aliases:Record<string,string>={}){const mappings:Record<string,string>={官方服务:'官方与账号',官方:'官方与账号',新手与百科:'入门与资料',数据工具:'入门与资料',副本与战斗:'职业与副本',生产采集与钓鱼:'生产与采集',市场与经济:'生产与采集 / 市场与物价',休闲与成就:'日常与收藏',幻化与外观:'幻化与摄影',住房装修:'住房与经营',开发与辅助工具:'插件与开发',...aliases};const seen=new Set<string>();let result=value;while(!seen.has(result)){seen.add(result);const {main,sub}=splitDirectoryCategory(result);const next=mappings[result]??(mappedDirectoryCategory({mappings,main,sub}));if(!next){break;}result=next;}return result;}
