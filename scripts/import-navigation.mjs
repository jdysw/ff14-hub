/** Offline, reviewable importer. Run after fetching the three public source snapshots.
 * Only parses syntax and markup; never executes third-party JavaScript.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import ts from 'typescript';

const input=process.argv[2]??'.wrangler/navigation-sources';
const reviewedCategories=new Map(JSON.parse(await readFile('data/navigation/classification.json','utf8')).map(entry=>[entry.id,entry.category]));
const sources=[
  {file:'cafe.js',url:'https://www.ff14.cafe/',name:'背水咖啡厅'},
  {file:'light.html',url:'https://ff14nav.tianbianyu.com/',name:'光之导航站'},
  {file:'wiki.html',url:'https://ff14.wiki/',name:'FF14.wiki'},
];
const clean=text=>text.replace(/<[^>]*>/g,' ').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0]==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
const raw=[];
for(const source of sources){
  const text=await readFile(`${input}/${source.file}`,'utf8');
  if(source.file.endsWith('.js')){
    const tree=ts.createSourceFile('source.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const literal=node=>{
      if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
      if(ts.isArrayLiteralExpression(node))return node.elements.map(literal);
      if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(tree).replace(/^['"]|['"]$/g,''),literal(p.initializer)]));
      return null;
    };
    let groups=null;
    const visit=node=>{if(ts.isArrayLiteralExpression(node)){const first=node.elements[0];if(first?.getText(tree).startsWith('{id:"cn-official"'))groups=literal(node);}ts.forEachChild(node,visit);};
    visit(tree);
    if(!groups)throw new Error('咖啡厅结构已变化，请人工核对');
    for(const group of groups)for(const link of group.links??[])if(link.name&&link.url)raw.push({title:link.name,url:link.url,section:group.name,source:source.url,sourceName:source.name});
  }else{
    let section='';
    for(const match of text.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>|<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)){
      if(match[1]){section=clean(match[2]);continue;}
      const href=match[3]?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
      if(!href||!section)continue;
      const title=clean(match[4]?.match(/<div[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/div>/)?.[1]??match[4]??'');
      if(!title||/^(Image|代码如诗|辽ICP备|天边鱼)/.test(title))continue;
      raw.push({title,url:clean(href),section,source:source.url,sourceName:source.name});
    }
  }
}
// Explicit, reviewed aliases for the same homepage/function. Do not merge an entire host.
const equivalents=new Map([
 ['https://ff.web.sdo.com/web8/index.html#/home','https://ff.web.sdo.com/'],
 ['https://ff.web.sdo.com/web8/index.html#/index','https://ff.web.sdo.com/'],
 ['https://www.ffxiv.cn/','https://www.ffxiv.cn/v2/'],
 ['https://tools.ffxiv.cn/','https://tools.ffsusu.com/'],
 ['https://ff14.huijiwiki.com/wiki/首页','https://ff14.huijiwiki.com/wiki/%E9%A6%96%E9%A1%B5'],
 ['https://ff14.huijiwiki.com/','https://ff14.huijiwiki.com/wiki/%E9%A6%96%E9%A1%B5'],
]);
function normalize(raw){
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password)throw new Error('仅收录原始 HTTPS 地址');
  if(url.hostname==='www.weibo.com')url.hostname='weibo.com';
  if(['nga.178.com','ngabbs.com'].includes(url.hostname))url.hostname='bbs.nga.cn';
  if(url.hostname==='space.bilibili.com')url.pathname=url.pathname.replace(/\/video\/?$/,'');
  for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||/^(spm|from_spmid|vd_source|fbclid|gclid|visit_id)$/i.test(key)||(url.hostname==='bbs.nga.cn'&&/^(rand|fav)$/.test(key)))url.searchParams.delete(key);
  url.searchParams.sort();
  if(url.hash==='#'||url.hash==='#/')url.hash='';
  return equivalents.get(url.href)??url.href;
}
function category(row){
  const reviewed=reviewedCategories.get('catalog.import.'+createHash('sha256').update(normalize(row.url)).digest('hex').slice(0,20));
  if(reviewed)return reviewed;
  throw new Error('新入口需要先核对分类：'+row.title);
}
/* Historical keyword rules retained for audit only. */
function legacyCategory(row){
  const text=row.title;
  if(/素素攻略站|加兰德数据库|Game8|Consolegameswiki|FF14 Online Wiki/i.test(text))return '新手与百科';
  if(/艾欧泽亚售楼中心/i.test(text))return '住房装修';
  if(/素素辣鸡排/i.test(text))return '开发与辅助工具';
  if(/官网|官方|^道具商城$|^周边商城$|后勤补给|礼物站|招待|充值|积分|违规|莫古站|LodeStone|石之家/i.test(text))return '官方服务';
  if(/房|住宅|家具|装修|Housing/i.test(text))return '住房装修';
  if(/幻化|外观|染色|Model Viewer|捏|头像|mirapri/i.test(text))return '幻化与外观';
  if(/物价|市场|Universalis|经济|罗薇娜/i.test(text))return '市场与经济';
  if(/钓|鱼|生产|采集|配方|制作|天气|栽培|无人岛|俺Tools|Teamcraft|赐福|工坊|潜水艇|筹备/i.test(text))return '生产采集与钓鱼';
  if(/狩猎|大型怪物|Fate/i.test(text))return '狩猎与探索';
  if(/ACT|插件|卫月|XIVLauncher|画质|Reshade|GShade|API|文本检索/i.test(text))return '开发与辅助工具';
  if(/金碟|仙|天书|幻巧|成就|九宫|演奏|音乐|娱乐|弹琴|休闲|时尚|萌宠|陆行鸟赛跑|大合奏/i.test(text))return '休闲与成就';
  if(/新手|新人|新大陆|萌新|WIKI|wiki|数据库|资料库|综合|百科|Garland|ERIONES/i.test(text))return '新手与百科';
  if(/副本|攻略|职业|战斗|配装|FFLogs|Logs|Analysis|警察|PVP|青魔|招募|高难|Raid|导随|绝|Strat|FFReplay/i.test(text))return '副本与战斗';
  if(/Eureka|博兹雅|新月岛|探索笔记/i.test(text))return '狩猎与探索';
  if(/科技|小开|工具插件/i.test(row.section))return '开发与辅助工具';
  return '社区与创作';
}
void legacyCategory;
function region(row){
  if(/国际服|日服|英文|外文|Reddit|Twitch|GamerEscape|Consolegameswiki|Game8|FF14 Online Wiki|mirapri|eorzeaCollection|ERIONES|Etro|Ariyala/i.test(row.title+' '+row.section))return 'global';
  if(/国服|简中|CN |NGA|百度|B站|微博|石之家|新大陆|鱼糕|素素|灰机|中文/i.test(row.title+' '+row.section)||new URL(row.url).hostname.endsWith('sdo.com'))return 'cn';
  return 'both';
}
const items=new Map();const skipped=[];
const descriptions={
  '鱼糕':'钓鱼条件、鱼饵、鱼识与鱼王窗口查询。',
  '新人攻略站-新大陆见闻录':'面向新人的入坑、职业选择与游戏基础指南。',
  '灰机中文WIKI':'查询物品、任务、副本机制与游戏百科。',
  'Universalis':'国际服市场板价格与交易记录查询。',
  '加兰德数据库':'国服物品、配方、采集点与任务数据。',
  'Teamcraft工具箱':'生产配方规划、材料清单与制作协作工具。',
  '警察网':'根据战斗日志查找循环与技能使用问题。',
  'CN FFLogs':'国服战斗记录、统计与团队表现查询。',
  '素素辣鸡排':'风脉、藏宝图、坐骑与宠物等日常查询工具。',
  '艾欧泽亚售楼中心':'查询国服住房地块与在售房屋信息。',
  'Housing Snap':'浏览玩家分享的房屋装修与布置作品。',
  'Eorzea Collection':'浏览国际服玩家的幻化搭配与装备外观。',
};
for(const row of raw){
  let url;try{url=normalize(row.url);}catch{skipped.push({...row,reason:'非 HTTPS 或无效地址，需人工核对'});continue;}
  const key=url;const old=items.get(key);
  const origin={url:row.source,name:row.sourceName,title:row.title,section:row.section};
  if(old){if(!old.sources.some(source=>source.url===origin.url&&source.title===origin.title))old.sources.push(origin);if(old.title!==row.title&&!old.aliases.includes(row.title))old.aliases.push(row.title.slice(0,60));continue;}
  const group=category(row);
  items.set(key,{id:'catalog.import.'+createHash('sha256').update(key).digest('hex').slice(0,20),title:row.title.slice(0,80),url,
    description:descriptions[row.title]??'',category:group,tags:[row.section.slice(0,24)],aliases:[],icon:'🔗',openMode:'new_tab',region:region(row),sources:[origin]});
}
const entries=[...items.values()].map((entry,index)=>({...entry,sortOrder:100+index,aliases:entry.aliases.slice(0,10)}));
const report={checkedAt:'2026-10-20',sources:sources.map(source=>({url:source.url,name:source.name,sha256:null})),rawCount:raw.length,importedCount:entries.length,mergedCount:raw.length-skipped.length-entries.length,skippedCount:skipped.length,categories:Object.fromEntries([...new Set(entries.map(x=>x.category))].map(group=>[group,entries.filter(x=>x.category===group).length])),skipped};
for(const source of report.sources){const file=sources.find(x=>x.url===source.url).file;source.sha256=createHash('sha256').update(await readFile(`${input}/${file}`)).digest('hex');}
await mkdir('data/navigation',{recursive:true});
await writeFile('data/navigation/catalog.json',JSON.stringify(entries,null,2)+'\n');
await writeFile('data/navigation/import-report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,skipped:undefined},null,2));
