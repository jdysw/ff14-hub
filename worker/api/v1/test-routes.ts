/**
 * 自检路由（**仅**用于工程验证，生产不可达）。
 *
 * 存在理由：错误结构、422 校验、500 脱敏这些边界必须在真实 Workers 运行时里被断言，
 * 否则「错误结构一致」「不泄露内部信息」就只是口头承诺。
 *
 * 安全边界：
 * - 只有当 `ENABLE_TEST_ROUTES === '1'` 时可达；该变量只出现在测试运行时与本地 .dev.vars，
 *   生产环境缺省即为不可达（返回结构化 404，而不是 403——不暴露该路由存在过）。
 * - 路由不接触数据库、不接触身份数据，抛出的异常文本就是为了被断言「不应出现在响应中」。
 */
import { ApiError, DEFAULT_ERROR_MESSAGE } from '@ff14-hub/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { validateJsonBody, validateQuery } from '../../middleware/validation';
import type { AppBindings } from '../../types';

/** 仅用于验证「输入校验 → 422」链路的请求体 Schema。 */
export const echoRequestSchema = z
  .object({
    label: z.string().min(1).max(40),
    count: z.number().int().min(0).max(100),
    /**
     * 仅用于体积边界测试：让请求体可以「大而合法」或「超过上限」。
     * 上限刻意留得比 MAX_JSON_BODY_BYTES 大，真正的体积拒绝发生在 write-guard 读取阶段。
     */
    padding: z.string().max(200_000).optional(),
  })
  .strict();

/** 仅用于验证查询参数校验链路。 */
export const echoQuerySchema = z.object({
  region: z.enum(['cn', 'global']),
});

export function createTestRoutes(): Hono<AppBindings> {
  const routes = new Hono<AppBindings>();

  // 开关检查放在最前：未开启时表现为「路径不存在」。
  routes.use('*', async (c, next) => {
    if (!c.get('config').enableTestRoutes) {
      throw new ApiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, 'test_routes_disabled');
    }
    await next();
  });

  // 校验通过：回显已校验的请求体（用于证明 write-guard + Zod 链路真实工作）。
  routes.post('/echo', validateJsonBody(echoRequestSchema), (c) => {
    return c.json({ ok: true, echo: c.get('jsonBody') }, 200);
  });

  // 查询参数校验。
  routes.get('/echo', validateQuery(echoQuerySchema), (c) => {
    return c.json({ ok: true }, 200);
  });

  // 未预期异常：响应必须是脱敏的 internal_error，且不含这里的文本。
  routes.get('/boom', () => {
    throw new Error('内部诊断信息：绝不应出现在响应体中');
  });

  // 已知业务错误：应保持同一错误结构并带 logDetail（logDetail 不进响应）。
  routes.get('/conflict', () => {
    throw new ApiError('conflict', '资源状态冲突。', '内部诊断：不应出现在响应体');
  });

  return routes;
}
