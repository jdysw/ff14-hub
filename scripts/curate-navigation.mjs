/** One-time reviewed migration of the existing 197 entries; produces an explicit ID map. */
import {readFile,writeFile} from 'node:fs/promises';
const path=new URL('../data/navigation/catalog.json',import.meta.url);
const entries=JSON.parse(await readFile(path,'utf8'));
const defaults={
 '官方服务':'官方与账号 / 官网与公告','新手与百科':'入门与资料 / 百科与数据库','副本与战斗':'职业与副本 / 副本攻略',
 '生产采集与钓鱼':'生产与采集 / 制作与配方','市场与经济':'生产与采集 / 市场与物价',
 '狩猎与探索':'狩猎与探索 / 狩猎与FATE','休闲与成就':'日常与收藏 / 金碟与休闲',
 '幻化与外观':'幻化与摄影 / 幻化与染色','住房装修':'住房与经营 / 买房与装修',
 '开发与辅助工具':'插件与开发 / 插件与启动器','社区与创作':'社区与创作 / 创作者与直播',
};
const reviewed=new Map();
const assign=(category,titles)=>{for(const title of titles.split('|'))reviewed.set(title,category);};
assign('官方与账号 / 充值与商城','道具商城|周边商城|国服-道具商城|游戏充值(盛趣)|游戏充值(腾讯)|积分中心|积分兑换平台|陆行鸟礼物站|后勤补给站');
assign('官方与账号 / 账号与服务','违规处理平台|违规账号处罚公告|莫古站|萌新招待');
assign('官方与账号 / 官网与公告','艾欧泽亚活动中心');
assign('入门与资料 / 新人指南','新人攻略站-新大陆见闻录|艾欧泽亚萌新手册');
assign('入门与资料 / 综合工具','素素攻略站|素素辣鸡排|零的库链|獭爹の工具箱|库啵世界');
assign('入门与资料 / 百科与数据库','任务检索器|FF14文本检索数据|LodeStone|NGA幻想书库|艾欧泽亚地理频道|萨雷安の迦巴勒幻想大图书馆');
assign('职业与副本 / 职业与配装','Zafir的职业攻略|配装计算器|最终幻想14配装器|青魔法师技能学习攻略');
assign('职业与副本 / 战斗日志','CN FFLogs|警察网|导随记录|ACT日志解析|FFReplay');
assign('职业与副本 / 战术与招募','网页战术板|招募查询|国际服招募板共享|XivStrat');
assign('PVP / 入门与攻略','PVP入门指南|5v5水晶冲突PVP指北');
assign('PVP / 排名与资料','💎 水晶冲突');
assign('生产与采集 / 采集与天气','susu采集时钟|宇宙天气预报|天气查询|筹备补给品列表');
assign('生产与采集 / 制作与配方','理符列表|筹备军需品列表|宇宙探索攻略');
assign('钓鱼与海钓 / 鱼窗与资料','鱼糕|晓月之捕鱼人攻略|饥饿的猫|黑猫BlackCat');
assign('钓鱼与海钓 / 海钓攻略','6.0海钓冲分攻略');
assign('狩猎与探索 / 特殊区域','Eureka Tracker|博兹雅监控板|新月岛追踪器|新月岛魔法罐助手|新月岛萌新指南|扎杜诺尔高原攻略|贡希尔德神庙攻略');
assign('狩猎与探索 / 探索笔记','探索笔记时钟|特殊场景探索群号汇总');
assign('日常与收藏 / 特殊武器','古武&魂武流程攻略|义军武器攻略|幻境武器·新月岛攻略');
assign('日常与收藏 / 成就与收藏','光之收藏家|成就检索器|灭本限时奖励|むーむーのネタ帳');
assign('幻化与摄影 / 幻化与染色','mirapi snap|Eorzea Collection|兵装图鉴|姗姗来迟的商城套装(女)测评');
assign('幻化与摄影 / 模型与摄影','FFXIV Web Model Viewer|FF14头像生成器|摄影工具 Anamnesis|GShade画质补丁|FFXIV3Areal画质补丁');
assign('住房与经营 / 买房与装修','WanaHome');
assign('住房与经营 / 无人岛','无人岛工坊模拟器|无人岛攻略|无人岛每周作业|素素无人岛|无人岛动物时钟');
assign('住房与经营 / 潜水艇与工坊','工坊计算器|潜水艇攻略|部队潜水艇小工具');
assign('住房与经营 / 栽培','栽培手册');
assign('社区与创作 / 论坛与社区','NGA艾欧泽亚|百度FF14贴吧|FF14百度贴吧|Reddit/FFXIV|以太之光广场|艾欧泽亚RP情报站|最终幻想14陌迪翁中心|艾欧泽亚吐槽站');
assign('社区与创作 / 音乐与作品','光之演奏家|大合奏|宅爷自制弹琴达人|本站画廊');
assign('插件与开发 / 插件与启动器','TexTools|XIV Mod Archive');
assign('插件与开发 / 开发与数据','XIV API');
const introductions={
 '官网与公告':'游戏资讯与公告入口','充值与商城':'充值、商品或奖励兑换入口','账号与服务':'游戏账号及官方服务入口',
 '新人指南':'入门流程与基础玩法指南','百科与数据库':'游戏资料检索与百科查询','综合工具':'多种游戏查询与实用工具入口',
 '职业与配装':'职业技能、装备搭配与战斗准备','副本攻略':'副本机制与通关资料','战斗日志':'战斗记录、统计与复盘工具','战术与招募':'战术规划或队伍招募相关工具',
 '入门与攻略':'PVP 玩法与入门资料','排名与资料':'PVP 排名与相关信息','制作与配方':'生产制作、配方或材料规划资料','采集与天气':'采集或天气相关查询','市场与物价':'交易与物价相关查询',
 '鱼窗与资料':'鱼类、钓鱼条件与相关资料','海钓攻略':'海钓路线与得分攻略','狩猎与FATE':'狩猎、FATE 与野外目标资料','特殊区域':'特殊探索区域的进度或攻略','探索笔记':'探索目标与相关资料',
 '金碟与休闲':'休闲玩法与金碟相关攻略','成就与收藏':'成就、奖励与收藏查询','特殊武器':'特殊武器制作与收集流程','幻化与染色':'装备外观、幻化或染色资料','模型与摄影':'角色模型、画面与摄影相关工具',
 '买房与装修':'房屋信息、位置或装修作品','无人岛':'无人岛建设与经营资料','潜水艇与工坊':'部队工坊与潜水艇相关资料','栽培':'栽培相关资料',
 '论坛与社区':'玩家交流与社区内容','创作者与直播':'玩家创作、资讯或直播入口','音乐与作品':'玩家音乐与作品展示','插件与启动器':'客户端插件或相关工具资料','开发与数据':'游戏数据接口与开发资料',
};
for(const entry of entries){
 const category=reviewed.get(entry.title)??defaults[entry.category]??(entry.category.includes(' / ')?entry.category:undefined);
 if(!category)throw new Error('Unreviewed entry: '+entry.title);
 entry.category=category;
 entry.tags=entry.tags.filter(tag=>!(/国服官方|国际服官方|相关微博|B站UP主|小开|实用工具|直播站|维基站|官方网站/.test(tag)));
 if(!entry.description)entry.description=introductions[category.split(' / ')[1]];
}
await writeFile(path,JSON.stringify(entries,null,2)+'\n');
await writeFile(new URL('../data/navigation/classification.json',import.meta.url),JSON.stringify(entries.map(({id,title,category})=>({id,title,category})),null,2)+'\n');
console.log(`Reviewed classification saved for ${entries.length} entries.`);
