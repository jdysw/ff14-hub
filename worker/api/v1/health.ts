/**
 * GET /api/v1/health（公开端点）。
 *
 * 语义边界：
 * - 这是**就绪探针**：会真实探测 D1，因此能证明「Worker + D1 绑定 + 迁移后的数据库」确实可用。
 * - 绝不返回密钥、绑定名、数据库名、行数或任何环境变量内容。
 * - D1 不可用时返回 503 + status=degraded，而不是伪造 ok。
 */
import {
  REQUEST_ID_HEADER,
  SERVICE_NAME,
  SERVICE_VERSION,
  type HealthResponse,
} from '@ff14-hub/shared';
import { Hono } from 'hono';
import { logLine } from '../../lib/redact';
import { methodNotAllowed, requestIdOf } from '../../middleware/error-handler';
import type { AppBindings } from '../../types';

export const healthRoutes = new Hono<AppBindings>();

/** 轻量 D1 探活：只做一次常量查询，不触碰任何业务表。 */
async function probeDatabase(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return row?.ok === 1;
  } catch (error) {
    console.error(logLine('error', 'health_db_probe_failed', { message: error }));
    return false;
  }
}

healthRoutes.get('/health', async (c) => {
  const databaseOk = await probeDatabase(c.env.DB);
  const body: HealthResponse = {
    status: databaseOk ? 'ok' : 'degraded',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: c.get('config').environment,
    database: databaseOk ? 'ok' : 'unavailable',
    nowUtcMs: Date.now(),
  };
  return c.json(body, databaseOk ? 200 : 503, { [REQUEST_ID_HEADER]: requestIdOf(c) });
});

// 声明该路径只支持 GET：其他方法返回结构化 405 而不是落入 404。
healthRoutes.all('/health', methodNotAllowed(['GET']));
