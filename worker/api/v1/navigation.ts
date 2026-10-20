/**
 * `/api/v1/navigation/catalog` —— 公开推荐目录（阶段 04：HUB-007 / HUB-047）。
 *
 * 安全前提：
 * - **只读**、匿名可读，且只返回 `nav_catalog_links`（系统目录）里的非敏感字段。
 *   没有任何端点能通过它读取或修改个人导航：目录与个人副本是两张表（ADR-0004 D1）。
 * - 不返回任何凭证、工作空间数据或探测结果；在线健康状态在本阶段恒为 `unknown`
 *   （`verificationStatus` 只描述「来源条目本身核对过」，不是「网站现在可用」）。
 * - 查询参数经共享 Schema 校验（区服用 `navRegionSchema`，非法值 → 422）。
 *
 * 懒应用种子：目录种子写在代码里（`worker/modules/nav/catalog.ts`），读取前先做一次
 * 版本化 upsert。这样迁移文件里不需要任何 INSERT，第一次读目录时目录自然就绪；
 * 重复调用 0 行变化，因此并发或重复请求都不会改变数据。
 */
import {
  ApiError,
  DEFAULT_ERROR_MESSAGE,
  MAX_NAV_GROUP_NAME_LENGTH,
  navRegionSchema,
} from '@ff14-hub/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { noStoreJson } from '../../lib/response';
import { describeIssues } from '../../lib/zod-issues';
import { methodNotAllowed } from '../../middleware/error-handler';
import { hashCredential } from '../../modules/identity/credentials';
import { enforceRateLimits } from '../../lib/rate-limit';
import { rateLimited } from '../../lib/response';
import { fetchSiteMetadata } from '../../modules/nav/metadata';
import {
  NAV_CATALOG_VERIFIED_AT,
  applyCatalogSeed,
  readCatalog,
  readCatalogSourceVersion,
} from '../../modules/nav/catalog';
import type { AppBindings } from '../../types';

/** 目录查询参数：字段与取值都受共享契约约束（未知参数一律拒绝，避免静默忽略）。 */
const catalogQuerySchema = z
  .object({
    region: navRegionSchema.optional(),
    category: z.string().min(1).max(MAX_NAV_GROUP_NAME_LENGTH).optional(),
  })
  .strict();

export const navigationRoutes = new Hono<AppBindings>();

/** GET /navigation/catalog —— 系统推荐目录（匿名只读）。 */
navigationRoutes.get('/catalog', async (c) => {
  const raw = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = catalogQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const detail = describeIssues(parsed.error.issues);
    throw new ApiError(
      'validation_failed',
      `${DEFAULT_ERROR_MESSAGE.validation_failed}（${detail}）`,
      `query_invalid:${detail}`,
    );
  }

  const now = Date.now();
  await applyCatalogSeed({ db: c.env.DB, now });
  const [entries, sourceVersion] = await Promise.all([
    readCatalog({
      db: c.env.DB,
      ...(parsed.data.region === undefined ? {} : { region: parsed.data.region }),
      ...(parsed.data.category === undefined ? {} : { category: parsed.data.category }),
    }),
    readCatalogSourceVersion(c.env.DB),
  ]);

  return noStoreJson(c, {
    entries,
    sourceVersion,
    // 目录内容的最后更新时间取自条目自身；目录为空时回落到本阶段核对时间
    // （而不是 `Date.now()`：那会让「目录是什么时候更新的」每次请求都在变）。
    updatedAt: entries.reduce((max, entry) => Math.max(max, entry.updatedAt), NAV_CATALOG_VERIFIED_AT),
  });
});

// 只支持 GET：其他方法给结构化 405。
/**
 * 用户主动触发的站点简介识别，不存用户链接。
 * 双层固定窗口限流：客户端 10 次/分钟 + 全站 120 次/分钟。
 * URL 只放 POST 请求体，不进入请求日志、Referer 或代理缓存键。
 */
navigationRoutes.post('/metadata', async(c)=>{
  let parsed:unknown;
  try{parsed=await c.req.json();}catch{return c.json({message:'请求必须是 JSON'},400);}
  const validated=z.object({url:z.string().min(10).max(2048)}).strict().safeParse(parsed);
  if(!validated.success)return c.json({message:'请输入有效的 HTTPS 网站地址'},422);
  const ip=(c.req.header('CF-Connecting-IP')??'unknown').trim();
  const digest=(await hashCredential(ip)).slice(0,32);
  const limits=await enforceRateLimits(c.env.DB,[
    [`navmeta:c:${digest}`,{limit:10,windowMs:60_000}],
    ['navmeta:global',{limit:120,windowMs:60_000}],
  ]);
  if(!limits.allowed)return rateLimited(c,limits);
  try{
    const metadata=await fetchSiteMetadata(validated.data.url);
    return noStoreJson(c,metadata);
  }catch(error){
    // 仅向客户端返回可解释的失败消息；绝不记录查询 URL。
    const reason=error instanceof Error?error.message:'无法识别该网站';
    return c.json({message:reason.slice(0,150)},422);
  }
});

// 显式限制 navigation 可访问的 HTTP 方法。
navigationRoutes.all('*', methodNotAllowed(['GET','POST']));
