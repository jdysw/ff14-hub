import {z} from 'zod';
import {fishRuleSchema} from './fish-api';
import {pvpRulesSchema,DEFAULT_PVP_RULES} from './pvp-rotation';
export const fishCorrectionSchema=z.object({region:z.enum(['cn','global']),id:z.number().int().positive(),name:z.string().trim().min(1).max(100),bait:z.array(z.string().min(1).max(120)).max(30),conditions:z.array(z.string().max(300)).max(30),rule:fishRuleSchema.nullable(),sourceUrl:z.url().startsWith('https://').max(2048),reason:z.string().trim().min(1).max(600)}).strict().refine(item=>item.rule===null||item.rule.fishId===item.id,'规则鱼类 ID 不一致');
export const siteGameDataSchema=z.object({pvp:pvpRulesSchema,fish:z.array(fishCorrectionSchema).max(500).refine(items=>new Set(items.map(item=>item.region+':'+item.id)).size===items.length,'鱼类修订重复')}).strict();
export type SiteGameData=ReturnType<typeof siteGameDataSchema.parse>;
export const DEFAULT_GAME_DATA:SiteGameData={pvp:DEFAULT_PVP_RULES,fish:[]};
