import {z} from 'zod';

export const HOUSING_SOURCE = 'https://house.ffxiv.cyou/';
export const housingWorlds = {
  陆行鸟: [[1167,'红玉海'],[1081,'神意之地'],[1042,'拉诺西亚'],[1044,'幻影群岛'],[1060,'萌芽池'],[1173,'宇宙和音'],[1174,'沃仙曦染'],[1175,'晨曦王座']],
  莫古力: [[1172,'白银乡'],[1076,'白金幻象'],[1171,'神拳痕'],[1170,'潮风亭'],[1113,'旅人栈桥'],[1121,'拂晓之间'],[1166,'龙巢神殿'],[1176,'梦羽宝境']],
  猫小胖: [[1043,'紫水栈桥'],[1169,'延夏'],[1106,'静语庄园'],[1045,'摩杜纳'],[1177,'海猫茶屋'],[1178,'柔风海湾'],[1179,'琥珀原']],
  豆豆柴: [[1192,'水晶塔'],[1183,'银泪湖'],[1180,'太阳海岸'],[1186,'伊修加德'],[1201,'红茶川']],
} as const;

export const housingAreas = ['海雾村','薰衣草苗圃','高脚孤丘','白银乡','穹顶皓天'];
export const housingSizes = ['S','M','L'];
export const housingUses = ['用途待确认','部队','个人'];
const timestamp = z.number().int().min(0).max(4_102_444_800);
const plot = z.object({
  Server: z.number().int().positive(), Area: z.number().int().min(0).max(4),
  Slot: z.number().int().min(0).max(29), ID: z.number().int().min(1).max(60),
  Price: z.number().int().nonnegative(), Size: z.number().int().min(-1).max(2),
  LastSeen: timestamp, UpdateTime: timestamp, EndTime: timestamp,
  State: z.number().int().min(0).max(3), PurchaseType: z.number().int().min(0).max(2),
  RegionType: z.number().int().min(0).max(2), Participate: z.number().int().nonnegative(),
  Winner: z.number().int().nonnegative(),
});
export const housingPlotsSchema = z.array(plot).max(9000);
export const housingResponseSchema = z.object({plots: housingPlotsSchema, fetchedAt: z.number().int().positive()});
export type HousingPlot = z.infer<typeof plot>;
